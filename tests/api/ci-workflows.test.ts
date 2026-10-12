import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import MarkdownIt from "markdown-it";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

// A dependabot schedule. `day`, `time` and `timezone` are the keys that move
// the lane off the default Monday slot and pin its clock, so every consumer of
// a parsed schedule declares them rather than reading them as absent.
type Schedule = {
  interval: string;
  day?: string;
  time?: string;
  timezone?: string;
};

// Cron's day-of-week field is 0-6 starting at Sunday; dependabot's `day:` keys
// are the names. Mapping through this table is what lets a parsed cron be
// compared with a schedule's day directly.
const CRON_DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

type Workflow = {
  on: Record<
    string,
    { branches?: string[]; paths?: string[]; types?: string[]; inputs?: Record<string, unknown> } | Array<{ cron: string }> | null
  >;
  // Optional: a workflow that scopes its permission to the job carries no
  // workflow-level block at all, and that absence is what claim.yml now has.
  permissions?: Record<string, string>;
  concurrency: { group: string; "cancel-in-progress": boolean | string; queue?: string };
  jobs: Record<string, {
    if?: string;
    "runs-on"?: string;
    "timeout-minutes"?: number;
    permissions?: Record<string, string>;
    services?: Record<string, { image?: string; options?: string }>;
    env?: Record<string, string>;
    steps: Array<{
      if?: string;
      id?: string;
      name?: string;
      uses?: string;
      run?: string;
      with?: Record<string, unknown>;
      env?: Record<string, string>;
    }>;
  }>;
};

// What this file asserts is derived structure, never a dependency value: the
// workflows' triggers, permissions, step identities, behavioural commands, and
// the cross-file agreements (one revision per action family across the
// workflow files, both actionlint legs' toolchain env, the CONTRIBUTING claim
// pin). A legitimate dependency bump moves the tree and these follow it
// (fleet-rules, "Merging and CI"); which revision is the RIGHT one is zizmor's
// and Dependabot's to hold — no network fetch happens here. Read a green run
// as "structure intact", never as "this pin is the right fork".

describe("GitHub Actions release gates", () => {
  it("carries the shared action's reference block: condition, queued concurrency, permission scope and claim policy", async () => {
    const workflow = await readWorkflow("claim.yml");
    expect(workflow.on).toEqual({ issue_comment: { types: ["created"] } });
    // The action's own reference block scopes `issues: write` to the job, and
    // a workflow-level block is denied on its own: leaving it there is the
    // coarse shape this move exists to drop.
    expect(workflow.permissions).toBeUndefined();
    // `queue: max` is load-bearing, not a stylistic choice: GitHub keeps one
    // PENDING run per concurrency group and cancels the older pending one even
    // at cancel-in-progress false, so without it the second of three /claim
    // comments landing while a run is in progress is dropped unanswered.
    expect(workflow.concurrency).toEqual({
      group: "claim-${{ github.event.issue.number }}",
      "cancel-in-progress": false,
      queue: "max",
    });
    expect(gateBehavior(workflow.jobs)).toEqual({
      claim: {
        if: "github.event.comment.user.type != 'Bot'"
          + " && (contains(github.event.comment.body, '/claim')\n"
          + "    || contains(github.event.comment.body, '/unclaim')\n"
          + "    || contains(github.event.comment.body, '/release'))",
        "timeout-minutes": 5,
        permissions: { issues: "write", "pull-requests": "write" },
        steps: [{}],
      },
    });
  });

  it("keeps the CONTRIBUTING claim revision aligned with the workflow pin", async () => {
    const contributing = await readFile(resolve(process.cwd(), "CONTRIBUTING.md"), "utf8");
    // Markdown determines the destination boundary: quotes can be part of
    // an unquoted destination, so treating them as delimiters truncates refs.
    // The whole matching SET, not its first member: `.find()` took whichever
    // claim-tree link came first, so a second one elsewhere in the file was
    // silently ignored and this guard stayed green while the link CONTRIBUTING
    // actually documents had drifted. An ambiguous set fails instead.
    const contributingClaimHrefs = new MarkdownIt().parse(contributing, {})
      .flatMap((token) => token.children ?? [])
      .filter((token) => token.type === "link_open")
      .map((token) => token.attrGet("href"))
      .filter((href): href is string => typeof href === "string"
        && href.startsWith("https://github.com/Nitjsefnie-Actions/claim/tree/"));
    const [contributingRevision] = contributingClaimHrefs.map(
      (href) => new URL(href).pathname.split("/")[4],
    );
    const workflow = await readWorkflow("claim.yml");
    const workflowSha = workflow.jobs.claim!.steps[0]!.uses?.split("@").at(-1);

    expect(contributingClaimHrefs).toHaveLength(1);
    expect(contributingRevision).toBeDefined();
    expect(workflowSha).toBeDefined();
    expect(contributingRevision).toBe(workflowSha);
  });

  it("runs on a pull request or a closed issue so the action can decline the command in a reply", async () => {
    const condition = (await readWorkflow("claim.yml")).jobs.claim!.if!;
    expect(
      condition,
      "claim.yml must not pre-filter pull requests on github.event.issue.pull_request: a job " +
        "condition that skips starts no run, so /claim on a pull request gets no reply at all " +
        "where the shared action answers with a decline.",
    ).not.toContain("github.event.issue.pull_request");
    expect(
      condition,
      "claim.yml must not pre-filter closed issues on github.event.issue.state: the same skip " +
        "silence applies, and the action's reply is what says the issue is closed.",
    ).not.toContain("github.event.issue.state");
  });

  it("keeps the write permission on the job that issues the assignment", async () => {
    const job = (await readWorkflow("claim.yml")).jobs.claim!;
    expect(job.permissions).toEqual({ issues: "write", "pull-requests": "write" });
  });

  it("checks admission through the reviewed shared action without a consumer checkout", async () => {
    const workflow = await readWorkflow("pr-gate.yml");
    expect(workflow.on).toEqual({ pull_request_target: { types: ["opened", "edited", "reopened", "ready_for_review"] } });
    expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "write", issues: "read" });
    expect(workflow.concurrency).toEqual({
      group: "pr-gate-${{ github.event.pull_request.number }}",
      "cancel-in-progress": false,
    });
    expect(gateBehavior(workflow.jobs)).toEqual({
      gate: {
        if: "github.event.pull_request.user.type != 'Bot' && github.event.pull_request.draft == false",
        "timeout-minutes": 5,
        steps: [{}],
      },
    });
  });

  it("judges the pull request head only as git data, executed entirely from main", async () => {
    const workflow = await readWorkflow("pr-gates.yml");
    expect(workflow.on).toEqual({
      pull_request_target: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    // Each newer PR event replaces only that PR's four privileged gates.
    expect(workflow.concurrency).toEqual({
      group: "pr-gates-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
    // The job logic and grants, excluding action/tool/runner configuration, in the dependency-audit style. One checkout with
    // no ref input at all — actions/checkout's default, main's last commit, the
    // checkout its fork guard exempts. No step installs or builds anything. The
    // PR head enters only as a git object; the ratchet script comes from the
    // trusted checked-out base and reads the target with `git show`. The base of
    // the comparison is the checked-out commit itself (HEAD), never the event's
    // base.sha: that value is recorded when the pull request opens and can
    // trail main, and after a rebase onto a newer main the merge base of the
    // stale base and the head sits below the real fork point, so a real
    // relaxation would pass against the looser document there. Every event value
    // travels through env, never ${{ }} in run:.
    expect(gateBehavior(workflow.jobs)).toMatchObject({
      "ratchet-guard": {
        permissions: { contents: "read" },
        "timeout-minutes": 10,
        steps: [
          {
            name: "Refuse unhandled events",
            run: `if [[ "$GITHUB_EVENT_NAME" != "pull_request_target" ]]; then
  echo "::error::Unhandled ratchet-guard event: $GITHUB_EVENT_NAME"
  exit 1
fi
`,
          },
          {},
          {},
          {
            name: "Fetch the pull request head",
            env: { PR_NUMBER: "${{ github.event.pull_request.number }}" },
            run: 'git fetch --no-tags origin "+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/head"',
          },
          {
            name: "Ratchet documents",
            env: { HEAD_SHA: "${{ github.event.pull_request.head.sha }}" },
            run: 'node scripts/check-ratchets.ts HEAD "$HEAD_SHA"',
          },
        ],
      },
    });
  });

  it("judges main's own commits against the ratchet documents they replaced", async () => {
    const workflow = await readWorkflow("ratchet-guard.yml");
    // The other half of the split (issue 1090). push covers the commits main
    // itself lands: the repo merges with --rebase, so a merged SHA is a
    // brand-new commit no pull_request run covered, and every push to main must
    // carry a ratchet-guard run for the check to be required and for the deploy
    // gate (scripts/deploy-revision.sh) to pass on the tip it lands. No paths
    // filter: a push without one of the compared files still needs its own run,
    // or deploys of the tip it lands hang on `(absent)`. Dispatch recovers a
    // main tip when the push event launched no runs (issue 796).
    //
    // This file reads NO pull-request data — no `refs/pull` fetch, and no
    // `pull_request.*` value in any step's run or env — which is the property
    // the split exists to establish. Asserted on the parsed job below, where
    // every event value is a push/dispatch spelling (`${{ github.sha }}`,
    // `${{ github.event.before }}`, `${{ inputs.base }}`), and on the absence of
    // a step fetching a pull request head at all.
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      workflow_dispatch: {
        inputs: {
          base: {
            description: "Full SHA of the newest main commit carrying a successful ratchet-guard run",
            required: true,
            type: "string",
          },
        },
      },
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    // Pushes to main must never share a group: GitHub keeps only one PENDING
    // run per concurrency group and cancels the older pending one even with
    // cancel-in-progress false, and a cancelled conclusion on a merged SHA
    // makes the deploy gate refuse immediately. Keying on the SHA gives each
    // push its own group. There is no pull-request leg in this file, so there is
    // no repository-level arm to bound here.
    expect(workflow.concurrency).toEqual({
      group: "ratchet-guard-${{ github.sha }}",
      "cancel-in-progress": false,
    });
    // The job logic and grants, excluding action/tool/runner configuration. Two checkouts, each gated on the event name:
    // under push its ref is github.event.before, the previous main tip, whose
    // copy of scripts/check-ratchets.ts executes; dispatch takes the last
    // certified main tip as input, validates its format before checkout, then
    // fetches the dispatched tip and checks ancestry before setup-node can probe
    // checkout-controlled Yarn files. On a push GitHub always sets `before` to
    // a 40-hex SHA. No step installs or builds anything. The pushed tip and the
    // dispatched tip enter only as git objects; dispatch checks out the
    // candidate base but runs only git commands until it proves main ancestry.
    // Under push the checked-out previous tip is, for a non-forced push, a
    // direct ancestor of the pushed SHA, so the merge base is the previous tip
    // itself and the comparison is exactly "did this push relax a ratchet
    // document relative to the main it replaced". Dispatch judges the interval
    // from the last certified tip to main's tip as one endpoint change, like a
    // multi-commit push. It is coarser than separate push runs when consecutive
    // pushes were dropped: an intermediate relaxation later re-tightened past
    // the base is not flagged. Every event value travels through env, never
    // ${{ }} in run:.
    expect(gateBehavior(workflow.jobs)).toEqual({
      "ratchet-guard": {
        "timeout-minutes": 10,
        steps: [
          {
            name: "Refuse unhandled events",
            run: `if [[ "$GITHUB_EVENT_NAME" != "push" && "$GITHUB_EVENT_NAME" != "workflow_dispatch" ]]; then
  echo "::error::Unhandled ratchet-guard event: $GITHUB_EVENT_NAME"
  exit 1
fi
`,
          },
          {
            name: "Validate dispatch base and ref",
            if: "${{ github.event_name == 'workflow_dispatch' }}",
            env: { BASE_SHA: "${{ inputs.base }}" },
            run: `if [[ "$GITHUB_REF" != "refs/heads/main" ]]; then
  echo "::error::Dispatch must target refs/heads/main"
  exit 1
fi
if [[ ! "$BASE_SHA" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::Dispatch base must be a full lowercase 40-character SHA"
  exit 1
fi
`,
          },
          {
            if: "${{ github.event_name == 'push' }}",
          },
          {
            if: "${{ github.event_name == 'workflow_dispatch' }}",
          },
          {
            name: "Fetch the dispatched commit",
            if: "${{ github.event_name == 'workflow_dispatch' }}",
            env: { DISPATCHED_SHA: "${{ github.sha }}" },
            run: 'git fetch --no-tags origin "$DISPATCHED_SHA"',
          },
          {
            name: "Validate dispatch ancestry",
            if: "${{ github.event_name == 'workflow_dispatch' }}",
            env: { DISPATCHED_SHA: "${{ github.sha }}" },
            run: `if [[ "$(git rev-parse HEAD)" == "$DISPATCHED_SHA" ]]; then
  echo "::error::Dispatch base must differ from the dispatched commit"
  exit 1
fi
if ! git merge-base --is-ancestor HEAD "$DISPATCHED_SHA"; then
  echo "::error::Dispatch base must be an ancestor of the dispatched commit"
  exit 1
fi
`,
          },
          {},
          {
            if: "${{ github.event_name == 'push' }}",
            name: "Fetch the pushed commit",
            env: { PUSHED_SHA: "${{ github.sha }}" },
            run: 'git fetch --no-tags origin "$PUSHED_SHA"',
          },
          {
            if: "${{ github.event_name == 'push' }}",
            name: "Ratchet documents against the previous main",
            env: { PUSHED_SHA: "${{ github.sha }}" },
            run: 'node scripts/check-ratchets.ts HEAD "$PUSHED_SHA"',
          },
          {
            name: "Ratchet documents against the last certified main tip",
            if: "${{ github.event_name == 'workflow_dispatch' }}",
            env: { DISPATCHED_SHA: "${{ github.sha }}" },
            run: 'node scripts/check-ratchets.ts HEAD "$DISPATCHED_SHA"',
          },
        ],
      },
    });
  });

  it("fails an unhandled ratchet-guard event before checkout", async () => {
    // Both files, each against the events IT accepts. The pull-request leg's
    // guard no longer mentions push at all — its file has no push trigger — so
    // reading the guard out of only one file would test one leg's gate twice
    // and the other's not at all.
    const cases: Array<{ file: string; accepted: string[]; refused: string[] }> = [
      {
        file: "pr-gates.yml",
        accepted: ["pull_request_target"],
        refused: ["push", "schedule", "workflow_dispatch"],
      },
      {
        file: "ratchet-guard.yml",
        accepted: ["push", "workflow_dispatch"],
        refused: ["pull_request_target", "schedule"],
      },
    ];
    for (const { file, accepted, refused } of cases) {
      const workflow = await readWorkflow(file);
      const guard = workflow.jobs["ratchet-guard"]!.steps.find((step) => step.name === "Refuse unhandled events")?.run;
      expect(guard, `${file} must refuse an event it has no comparison path for`).toBeDefined();
      for (const event of accepted) {
        const result = spawnSync("bash", ["-e", "-c", guard!], {
          encoding: "utf8",
          env: { ...process.env, GITHUB_EVENT_NAME: event },
        });
        expect(result.status, `${file} must accept ${event}: ${result.stdout} ${result.stderr}`).toBe(0);
      }
      for (const event of refused) {
        const result = spawnSync("bash", ["-e", "-c", guard!], {
          encoding: "utf8",
          env: { ...process.env, GITHUB_EVENT_NAME: event },
        });
        expect(result.status, `${file} must refuse ${event}: ${result.stdout} ${result.stderr}`).toBe(1);
        expect(result.stdout).toContain(`::error::Unhandled ratchet-guard event: ${event}`);
      }
    }
  });

  it("parses a complete PostgreSQL gate with every release command", async () => {
    const workflow = await readWorkflow("ci.yml");
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      // The dispatch trigger carries the calibrate self-test's input: a
      // boolean, defaulting false, whose fabricated raise must be refused by
      // branch protection so the calibrate job fails visibly (issue 684).
      // Pinned in full so a retyped, re-defaulted or renamed input — the
      // difference between a self-test dispatch and an accidental
      // fabrication — fails here.
      workflow_dispatch: {
        inputs: {
          base: {
            description: "Full SHA of the main commit to measure this dispatch against",
            required: false,
            type: "string",
          },
          "simulate-refused-raise": {
            description: "calibrate self-test: fabricate a coverage raise so the push is refused by branch protection and the push-recalibration job fails visibly (issue 684)",
            type: "boolean",
            default: false,
          },
        },
      },
    });
    expect(workflow.on.push).not.toHaveProperty("paths");
    expect(workflow.on).not.toHaveProperty("pull_request");
    // Nor a pull_request_target: the pull-request leg of this gate is
    // ci-pr.yml, whose `on:` is exactly {pull_request_target}. A trigger
    // re-added here would put pull-request data back under a privileged
    // trigger, which is the class the split exists to close.
    expect(workflow.on).not.toHaveProperty("pull_request_target");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "ci-${{ github.sha }}",
      "cancel-in-progress": false,
    });

    const verify = workflow.jobs.verify!;
    expect(verify.services?.postgres?.options).toContain("pg_isready");
    // Keep the reviewed artifact actions' counts and identities exact across
    // jobs: verify uploads the pair on push and dispatch, then the calibration
    // job downloads the summary. Which REVISION they share across files is
    // held by `keeps each action family to one revision across all workflow
    // files`; within this file the family sets below pin the counts. The
    // pull-request leg's one download is asserted in ci-pr.yml's own case
    // below, so neither file's artifact actions are checked by a derivation
    // that only reads this one.
    const ciSteps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    const uploads = ciSteps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
    const downloads = ciSteps.filter((step) => step.uses?.startsWith("actions/download-artifact@"));
    expect(uploads).toHaveLength(2);
    expect(downloads).toHaveLength(1);
    // Exactly one checkout: under push and workflow_dispatch the default
    // checkout takes the event's own commit, at full history (issue 1098) so
    // the suite's secret-scan provenance check has the history its baseline
    // names. It carries no event gate because this file admits nothing else —
    // no pull_request trigger and no pull_request.* value, so the depth pulls
    // in no pull-request data. The pull_request_target checkout, with full
    // history and no ref input, is in ci-pr.yml.
    const verifyCheckouts = verify.steps.filter((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(verifyCheckouts, "the verify job must keep exactly one checkout").toHaveLength(1);
    expect(verify.steps.map((step) => step.run).filter(Boolean)).toEqual(expect.arrayContaining([
      "pnpm install --frozen-lockfile",
      "pnpm db:migrate",
      "pnpm test --run",
      "pnpm lint",
      "pnpm typecheck",
      "pnpm build",
    ]));
    expect(verify.env).toEqual(expect.objectContaining({
      DATABASE_URL: "postgresql://overflow:overflow@127.0.0.1:5432/overflow_ci",
      GITHUB_WEBHOOK_URL: "https://overflow.invalid/api/github/webhooks",
      TOKEN_ENCRYPTION_KEY: "A".repeat(43),
    }));
  });

  it("parses the pull-request leg of the release gate with no privileged trigger beside it", async () => {
    // The other half of the split ci.yml into two (issue 1090). Every property
    // is asserted here per file rather than over the pair, because the two legs
    // genuinely differ and a single equality covering both would have to be
    // loosened to fit: this one has no PostgreSQL service, no package manager
    // and no build, because the pull request's own code runs in pr-suite.yml.
    const workflow = await readWorkflow("ci-pr.yml");
    // The whole `on:` set is pinned, and it is exactly one event. This file
    // materialises the pull request's merge commit, so a privileged trigger
    // here is the shape CodeQL's cache-poisoning and untrusted-checkout alerts
    // report. Asserted whole rather than by objectContaining, which would
    // tolerate a second event sitting beside the one this leg needs.
    expect(workflow.on).toEqual({
      pull_request_target: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
    });
    expect(workflow.on.pull_request_target).not.toHaveProperty("paths");
    expect(workflow.on, "a pull_request trigger would execute the PR's own workflow files").not.toHaveProperty("pull_request");
    expect(workflow.permissions).toEqual({ contents: "read" });
    // Concurrency group names are repository-global, so this one must not be
    // ci.yml's: a collision would let a pull request cancel a merged SHA's
    // pending push run, which the deploy gate refuses on (issue 474).
    expect(workflow.concurrency).toEqual({
      group: "ci-pr-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
      "cancel-in-progress": false,
    });
    const verify = workflow.jobs.verify!;
    // No PostgreSQL service: nothing in this leg applies a migration, because
    // the pull request's own code — which is what would need the schema — runs
    // in pr-suite.yml under `pull_request`.
    expect(verify.services, "the pull-request leg must not pay for a database it never connects to")
      .toEqual(undefined);
    expect(verify.permissions).toEqual({ contents: "read", actions: "read" });
    // One download — the awaited pull request suite run's coverage summary —
    // and no upload: the artifacts a pull request's coverage report is built
    // from are pr-suite.yml's, not this job's.
    const prSteps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    const uploads = prSteps.filter((step) => step.uses?.startsWith("actions/upload-artifact@"));
    const downloads = prSteps.filter((step) => step.uses?.startsWith("actions/download-artifact@"));
    expect(uploads).toHaveLength(0);
    expect(downloads).toHaveLength(1);
    // Exactly one checkout, and it is the base branch's tip with full history
    // and no ref input: under pull_request_target that is actions/checkout's
    // default, which is what makes the pull request's own edit to a gated
    // script unable to change the judge (issue 822). It carries no event gate
    // because this file admits nothing else.
    const verifyCheckouts = verify.steps.filter((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(verifyCheckouts, "the verify job must keep exactly one checkout").toHaveLength(1);
    // The trust boundary, as data: no package manager, no install, no suite,
    // no build — the base checkout's copies of the gate scripts over the pull
    // request's materialised tree are the whole job.
    expect(verify.steps.map((step) => step.run).filter(Boolean)).toEqual(expect.arrayContaining([
      'node "${GITHUB_WORKSPACE}/scripts/check-migration-edits.ts" "${MERGE_SHA:?}^1" "${MERGE_SHA}"',
      'node "${GITHUB_WORKSPACE}/scripts/check-legal-revisions.ts" "${MERGE_SHA:?}^1" "${MERGE_SHA}"',
      'node "${GITHUB_WORKSPACE}/scripts/await-pr-suite.ts"',
      'bash "${GITHUB_WORKSPACE}/scripts/ci-base-freshness.sh"',
    ]));
    // The issue-1035 suppression gate is the one sanctioned exception, by
    // exact name — the same sanction the reachability suite grants it (its run
    // text is pinned byte-identical there, and any drift re-arms this pin).
    // The step must NAME the pnpm.auditConfig key in its fixed refusals, so the
    // bare-word scan would flag prose; it is instead held to executing no
    // package-manager COMMAND, and it shells out to git and python3 only.
    const suppressionGate = "Refuse a pull request that changes the audit suppression list";
    expect(
      verify.steps
        .filter((step) => step.name !== suppressionGate)
        .map((step) => step.run ?? "")
        .join("\n"),
      "the pull-request leg must run no package manager at all — the pull request's install, " +
        "migrations, tests and build run in pr-suite.yml, whose outcome this job awaits as data",
    ).not.toMatch(/\b(pnpm|npm|npx|yarn|corepack)\b/);
    expect(
      verify.steps.filter((step) => step.name === suppressionGate),
      "the sanctioned suppression gate must exist; without it the exemption above is dead",
    ).toHaveLength(1);
    expect(
      verify.steps.find((step) => step.name === suppressionGate)!.run ?? "",
      "the sanctioned suppression gate executes no package-manager command — git and python3 only",
    ).not.toMatch(
      /\b(pnpm|npm|npx|yarn|corepack)\s+(install|ci|i|add|update|remove|run|exec|dlx|audit|config|test|info|view|publish|--version)\b/,
    );
    // Base freshness last, over the materialised merge tree.
    expect(verify.steps.at(-1)?.name).toBe("Base freshness");
    expect(verify.env).toEqual(expect.objectContaining({
      DATABASE_URL: "postgresql://overflow:overflow@127.0.0.1:5432/overflow_ci",
      GITHUB_WEBHOOK_URL: "https://overflow.invalid/api/github/webhooks",
      TOKEN_ENCRYPTION_KEY: "A".repeat(43),
    }));
  });

  it("parses a catalogue-style workflow gate with explicit least privilege", async () => {
    const workflow = await readWorkflow("pr-gates.yml");
    // pull_request_target executes main's definition and main's tools; the
    // pull request head enters only as git objects extracted with `git show`
    // (issue 822). Same trigger shape as pr-gates.yml.
    //
    // The whole `on:` set is pinned, and it is exactly one event: the file
    // holds a `refs/pull` fetch, so a privileged trigger here is the shape
    // CodeQL's cache-poisoning and untrusted-checkout alerts report. Asserted
    // whole rather than by objectContaining, which would tolerate a second
    // event sitting beside the one this leg needs.
    expect(workflow.on).toEqual({
      pull_request_target: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
    });
    expect(workflow.on.pull_request_target).not.toHaveProperty("paths");
    expect(workflow.on, "a pull_request trigger would execute the PR's own workflow files").not.toHaveProperty("pull_request");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "pr-gates-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    });
    // The job logic and grants, excluding action/tool/runner configuration, in the dependency-audit style: any extra step —
    // a second checkout, a script sourced from the extracted tree — fails this
    // equality. Under pull_request_target the default checkout is main's tip;
    // the checkout step carries no ref input, and the PR head is fetched as
    // git objects and extracted as data, never checked out.
    expect(gateBehavior(workflow.jobs.actionlint)).toEqual({
      permissions: { contents: "read" },
      "timeout-minutes": 15,
      env: {},
      steps: [
        {},
        {
          name: "Fetch the pull request head",
          env: { PR_NUMBER: "${{ github.event.pull_request.number }}" },
          run: 'git fetch --no-tags origin "+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/head"',
        },
        {},
        {
          name: "Install actionlint",
          run: `tarball="actionlint_\${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
curl -fsSL --retry 3 -o "$tarball" \\
  "https://github.com/\${ACTIONLINT_REPO}/releases/download/v\${ACTIONLINT_VERSION}/\${tarball}"
echo "\${ACTIONLINT_SHA256}  \${tarball}" | sha256sum -c -
tar -xzf "$tarball" actionlint
./actionlint --version
`,
        },
        {
          name: "Install zizmor",
          id: "install_zizmor",
          run: "pip install --require-hashes -r .github/requirements-zizmor.txt\n",
        },
        {
          name: "Collect the workflow files to lint",
          run: `mkdir -p .github/workflows-pr
git ls-tree -z --name-only refs/remotes/pr/head:.github/workflows/ |
  while IFS= read -r -d '' f; do
    git show "refs/remotes/pr/head:.github/workflows/$f" > ".github/workflows-pr/$f"
  done
`,
        },
        {
          name: "actionlint",
          id: "actionlint",
          run: "./actionlint -color .github/workflows-pr/*.yml",
        },
        {
          name: "zizmor",
          if: "${{ !cancelled() && steps.install_zizmor.outcome == 'success' }}",
          env: { GH_TOKEN: "${{ github.token }}" },
          run: "zizmor --no-progress .github/workflows-pr/*.yml",
        },
        {
          name: "Base freshness",
          env: {
            GH_TOKEN: "${{ github.token }}",
            REPO_SLUG: "${{ github.repository }}",
            BASE_SHA: "${{ github.event.pull_request.base.sha }}",
            BASE_REF: "${{ github.event.pull_request.base.ref }}",
            PR_NUMBER: "${{ github.event.pull_request.number }}",
            HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
          },
          run: "bash scripts/ci-base-freshness.sh",
        },
      ],
    });
  });

  it("lints main's own workflows on push and dispatch, reading no pull-request data", async () => {
    const workflow = await readWorkflow("actionlint.yml");
    // The other half of the split (issue 1090). `on:` is pinned whole, and it
    // names no pull-request event at all: this file's remaining legs lint the
    // checked-out, trusted tree, so a `refs/pull` fetch or a
    // `github.event.pull_request.*` value here would be a privileged trigger
    // reaching untrusted content.
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      workflow_dispatch: null,
    });
    expect(workflow.on.push).not.toHaveProperty("paths");
    expect(workflow.on, "this leg reads no pull-request data, so no pull-request trigger may reach it")
      .not.toHaveProperty("pull_request_target");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "actionlint-${{ github.sha }}",
      "cancel-in-progress": false,
    });
    // The job logic and grants, excluding action/tool/runner configuration. No fetch step for a pull request head, and no
    // `Base freshness` step: both belong to the pull-request leg, and a
    // surviving copy here is exactly the failure the split removes.
    expect(gateBehavior(workflow.jobs.actionlint)).toEqual({
      "timeout-minutes": 15,
      env: {},
      steps: [
        {},
        {},
        {
          name: "Install actionlint",
          run: `tarball="actionlint_\${ACTIONLINT_VERSION}_linux_amd64.tar.gz"
curl -fsSL --retry 3 -o "$tarball" \\
  "https://github.com/\${ACTIONLINT_REPO}/releases/download/v\${ACTIONLINT_VERSION}/\${tarball}"
echo "\${ACTIONLINT_SHA256}  \${tarball}" | sha256sum -c -
tar -xzf "$tarball" actionlint
./actionlint --version
`,
        },
        {
          name: "Install zizmor",
          id: "install_zizmor",
          run: "pip install --require-hashes -r .github/requirements-zizmor.txt\n",
        },
        {
          name: "Collect the workflow files to lint",
          run: `mkdir -p .github/workflows-pr
cp .github/workflows/*.yml .github/workflows-pr/
`,
        },
        {
          name: "actionlint",
          id: "actionlint",
          run: "./actionlint -color .github/workflows-pr/*.yml",
        },
        {
          name: "zizmor",
          if: "${{ !cancelled() && steps.install_zizmor.outcome == 'success' }}",
          env: { GH_TOKEN: "${{ github.token }}" },
          run: "zizmor --no-progress .github/workflows-pr/*.yml",
        },
      ],
    });
  });

  it("keeps the actionlint toolchain identical across both legs", async () => {
    // Derive both toolchains from the workflows. A coordinated bump stays
    // green; changing only one producer breaks their agreement.
    const readEnv = async (file: string) => {
      const workflow = await readWorkflow(file);
      return (workflow.jobs.actionlint?.env ?? {}) as Record<string, string>;
    };
    const prEnv = await readEnv("pr-gates.yml");
    const pushEnv = await readEnv("actionlint.yml");
    for (const key of ["ACTIONLINT_REPO", "ACTIONLINT_VERSION", "ACTIONLINT_SHA256"]) {
      expect(prEnv[key], `${key} must be present in pr-gates.yml`).toBeDefined();
      expect(pushEnv[key], `${key} must be present in actionlint.yml`).toBeDefined();
      expect(prEnv[key], `${key} must be identical in both actionlint legs`).toBe(pushEnv[key]);
    }
  });

  it("keeps each action family to one revision across all workflow files", async () => {
    // The consistency check fleet-rules "Merging and CI" explicitly RETAINS:
    // "one revision per action across the workflows, derived from the
    // workflows themselves (pr-gate#77's `_shipped_action_pin`)". Identity
    // matchers elsewhere fold a revision away, so a bump landing in only one
    // file — the half-applied edit — is invisible to them; this sweep is what
    // names it. No revision value is quoted here: both sides come out of the
    // workflow files, so a coordinated bump moves them together and stays
    // green.
    const files = (await readdir(resolve(".github/workflows")))
      .filter((name) => name.endsWith(".yml"));
    const revisionsByFamily = new Map<string, Map<string, string[]>>();
    const usesRef = /^\s*(?:-\s+)?uses:\s*([^\s@]+)@(\S+)/;
    for (const name of files) {
      const source = await readFile(resolve(".github/workflows", name), "utf8");
      for (const [index, line] of source.split(/\r?\n/).entries()) {
        const hit = usesRef.exec(line);
        if (!hit) continue;
        const [, refPath, revision] = hit;
        // Local (`./…`) and container (`docker://…`) refs carry no upstream
        // revision to agree on; only `owner/repo[/subpath]@ref` does.
        if (refPath.startsWith(".") || refPath.includes(":")) continue;
        const family = refPath.split("/").slice(0, 2).join("/");
        const revisions = revisionsByFamily.get(family) ?? new Map();
        revisions.set(revision, [...(revisions.get(revision) ?? []), `${name}:${index + 1}`]);
        revisionsByFamily.set(family, revisions);
      }
    }
    expect(revisionsByFamily.size, "no action refs found — the sweep would pass vacuously")
      .toBeGreaterThan(0);
    for (const [family, revisions] of revisionsByFamily) {
      expect(
        [...revisions.keys()],
        `${family} must run exactly one revision across the workflow files: a bump in only ` +
          `one of them is a half-applied change — ${[...revisions.values()].flat().join(", ")}`,
      ).toHaveLength(1);
    }
  });

  it("parses a lockfile audit that fires on every push to main, daily, and on demand", async () => {
    const workflow = await readWorkflow("dependency-audit.yml");
    // The whole `on`, because the shape IS the fix (issue 985 gave the audit
    // its first pull-request trigger; issue 1149's rounds finished the job).
    // The push trigger carries NO paths filter, deliberately: once branch
    // protection requires `dependency-audit`, the deploy gate derives its
    // required set from protection, so a push whose diff touched no manifest
    // must still leave a green check-run — a filter would strand it with a
    // MISSING context, which protection refuses, and every such deploy would
    // be refused. The audit step itself classifies no-manifest pushes (an
    // outcome, never a skip; tests/ci/dependency-audit-push.test.ts holds
    // that). The pull_request trigger is gone entirely: the pull-request leg
    // is pr-gates.yml, the issue-1090 split's base-defined
    // pull_request_target file.
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      schedule: [{ cron: "37 6 * * *" }],
      workflow_dispatch: null,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    // The issue-1090 split is complete for this file: no pull-request trigger
    // reaches it, so the per-SHA group is the sibling push files' shape — no
    // two pushes share a group, so a cancelled conclusion on a merged SHA
    // makes the deploy gate refuse immediately (issue 474). The
    // PR gates share pr-gates.yml's per-PR cancelling group.
    expect(workflow.concurrency).toEqual({
      group: "dependency-audit-${{ github.sha }}",
      "cancel-in-progress": false,
    });

    // The job logic and grants, excluding action/tool/runner configuration, in the claim/pr-gate style: any extra key — a
    // step-level continue-on-error tolerating a red audit, or a job-level
    // permissions override — fails this equality. No install and no build
    // precede the audit, so pnpm reads pnpm-lock.yaml directly and nothing a
    // pull request authored is ever EXECUTED: the pull_request trigger makes the
    // checkout the pull request, so a `node scripts/…` step or a checkout
    // `ref:` would cross that line, and corepack would otherwise download the
    // pnpm the pull request's own `packageManager` names. Both steps' `env`
    // blocks are pinned here for the same reason — they are what holds those
    // two inputs — and tests/ci/dependency-audit-retry.test.ts denies all five
    // by name and asserts the env values.
    //
    // On pinning this 78-line script verbatim, at roughly eight times the
    // largest run string this file pinned before it: the duplication stands,
    // and the reason is the opposite of redundancy. When this copy was written
    // it was the ONLY thing holding seven classifier mutations dead —
    // `every`/`some` on the status set, the `< 600` bound, the exit-0 conjunct
    // on the clean verdict, the retry budget, the sleep — because the executing
    // suite had no fixture for a split endpoint answer, an out-of-range status,
    // or an empty advisories map with a nonzero exit. Those fixtures now exist,
    // so the string is a second line of defence rather than the only one, and
    // it is worth keeping anyway because it fails for a different reason than
    // the behavioural suite: exact equality makes drift impossible, so the only
    // cost of the copy is a partial edit leaving one side stale, which fails
    // loudly and immediately instead of quietly.
    expect(gateBehavior(workflow.jobs["dependency-audit"])).toEqual({
      "timeout-minutes": 10,
      // The env block is JOB-level and that is load-bearing, not tidiness:
      // Actions `env:` is step-scoped, so this pair pinned on the step that
      // INSTALLS pnpm left the step that EXECUTES `pnpm audit` resolving
      // whatever version the pull request's `packageManager` named. Here it is
      // in effect for every step that runs pnpm, including one added later, so
      // there is no step left on which to forget it. The comment in the
      // workflow records the measurement; this equality is what would have
      // caught the misplacement.
      env: {
        COREPACK_ENABLE_PROJECT_SPEC: "0",
        npm_config_registry: "https://registry.npmjs.org/",
        npm_config_strict_ssl: "true",
        npm_config_cafile: "/etc/ssl/certs/ca-certificates.crt",
        npm_config_audit_level: "low",
      },
      steps: [
        {},
        {
          name: "Refuse a pull request that changes the audit suppression list",
          if: "github.event_name == 'pull_request'",
          env: { BASE_SHA: "${{ github.event.pull_request.base.sha }}" },
          run: expect.any(String),
        },
        {},
        {
          name: "Enable the pinned package manager",
          run: expect.stringContaining("corepack install --global pnpm@"),
        },
        {
          name: "Audit lockfile advisories",
          // The fast path's two inputs, delivered through env like every
          // event value (no ${{ }} in run blocks). github.event.before is
          // the previous tip on main for a push, and the all-zeros SHA when
          // there is no previous tip — a new branch or a force push.
          env: {
            EVENT_NAME: "${{ github.event_name }}",
            BEFORE_SHA: "${{ github.event.before }}",
          },
          run: `# THE FAST PATH IS AN OUTCOME, NOT A SKIP (issue 1149 fix round 2).
# The deploy gate derives its required set from branch protection,
# so a push whose diff touched no manifest must still leave a green
# dependency-audit check-run — a skipped audit would strand it. The
# manifest and the lockfile ARE the audit's inputs, so a push that
# changed neither cannot have changed what the audit reads, and the
# green verdict is recorded here without asking the registry. The
# branch is gated to push events, and EVERY ambiguity falls through
# to the full audit below: a before-SHA that is not 40 hex, the
# all-zeros SHA, a before commit missing from the checkout, a before
# that is not an ancestor of the pushed HEAD, and a diff error are
# all ambiguity, and ambiguity audits. The schedule and dispatch
# legs never enter this branch — they audit unconditionally.
if [ "\${EVENT_NAME:?}" = "push" ] \\
  && [[ "\${BEFORE_SHA:?}" =~ ^[0-9a-f]{40}$ ]] \\
  && [ "\${BEFORE_SHA}" != "0000000000000000000000000000000000000000" ] \\
  && git cat-file -e "\${BEFORE_SHA}^{commit}" 2>/dev/null \\
  && git merge-base --is-ancestor "\${BEFORE_SHA}" HEAD 2>/dev/null \\
  && git diff --quiet "\${BEFORE_SHA}" HEAD -- package.json pnpm-lock.yaml; then
  echo "no manifest change since the previous push — audit skipped, context green"
  exit 0
fi
set -uo pipefail
attempts=3
delay="\${DEPENDENCY_AUDIT_RETRY_DELAY_SECONDS:-30}"
for attempt in $(seq 1 "$attempts"); do
  code=0
  pnpm audit --json > audit.json 2> audit.err || code=$?
  result=$(AUDIT_EXIT="$code" node -e '
const fs = require("node:fs");
let report;
try {
  report = JSON.parse(fs.readFileSync("audit.json", "utf8"));
} catch {
  console.log("unreadable|the audit produced no JSON report");
  process.exit(0);
}
if (report && report.error) {
  const statuses = [...String(report.error.message ?? "").matchAll(/responded with (\\d{3})/g)]
    .map((match) => Number(match[1]));
  const transient = statuses.length > 0
    && statuses.every((status) => status === 429 || (status >= 500 && status < 600));
  const first = (message) => String(message).split("\\n")[0];
  const reported = first(report.error.message ?? "the advisory endpoint did not answer");
  console.log(String(report.error.code ?? "") === "ERR_PNPM_AUDIT_NO_LOCKFILE"
    ? "unreadable|" + reported
    : transient
      ? "transient|" + first("the advisory endpoint answered " + statuses.join(" and "))
      : "unreachable|" + reported);
  process.exit(0);
}
const advisories = report && report.advisories ? Object.keys(report.advisories).length : -1;
if (advisories > 0) {
  const counts = report.metadata?.vulnerabilities ?? {};
  const summary = ["critical", "high", "moderate", "low", "info"]
    .map((severity) => (counts[severity] ?? 0) + " " + severity)
    .filter((entry) => !entry.startsWith("0 "))
    .join(", ");
  console.log("advisories|" + advisories + " advisories (" + (summary || "severities unreported") + ")");
  process.exit(0);
}
console.log(advisories === 0
  ? process.env.AUDIT_EXIT === "0"
    ? "clean|no known vulnerabilities found"
    : "unreadable|the audit report carried an empty advisories map and exited " + process.env.AUDIT_EXIT
  : "unreadable|the audit report carried no advisories field and exited " + process.env.AUDIT_EXIT);
')
  verdict="\${result%%|*}"
  detail="\${result#*|}"
  echo "attempt $attempt of $attempts, pnpm audit --json exited $code: $verdict — $detail"
  case "$verdict" in
    clean)
      echo "$detail"
      exit 0
      ;;
    advisories)
      echo "$detail"
      echo "advisory ids and patched versions:"
      node -e '
const report = JSON.parse(require("node:fs").readFileSync("audit.json", "utf8"));
for (const advisory of Object.values(report.advisories ?? {})) {
  console.log("  " + advisory.module_name + " " + advisory.severity + ": " + advisory.title
    + " (vulnerable " + advisory.vulnerable_versions + ", patched " + advisory.patched_versions + ")");
}
'
      exit 1
      ;;
    transient)
      cat audit.err
      if [ "$attempt" -lt "$attempts" ]; then
        echo "$detail — a registry outage, not a finding; retrying"
        sleep "$delay"
        continue
      fi
      echo "$detail — the advisory endpoint was still unavailable after $attempts attempts"
      exit 1
      ;;
    *)
      cat audit.err
      echo "$detail — the lockfile was NOT audited, so this run reports nothing about it"
      exit 1
      ;;
  esac
done
exit 1
`,
        },
      ],
    });
  });

  it("keeps the dependabot update policy excluding the locally patched postgres", async () => {
    const config = parse(await readFile(resolve(".github/dependabot.yml"), "utf8")) as {
      version: number;
      updates: Array<{
        "package-ecosystem": string;
        directory: string;
        schedule: Schedule;
        "open-pull-requests-limit": number;
        ignore?: Array<{ "dependency-name": string }>;
      }>;
    };

    expect(config.version).toBe(2);
    const npm = config.updates.find((update) => update["package-ecosystem"] === "npm");
    expect(npm).toBeDefined();
    expect(npm!.directory).toBe("/");
    expect(npm!.schedule).toEqual({
      interval: "weekly",
      day: "tuesday",
      time: "03:17",
      timezone: "Etc/UTC",
    });
    expect(npm!["open-pull-requests-limit"]).toBe(5);
    // An automated postgres bump invalidates patches/postgres@3.4.9.patch and
    // its pnpm-lock.yaml patchedDependencies hash, breaking
    // `pnpm install --frozen-lockfile` — bumps stay by-hand.
    expect(npm!.ignore).toEqual([{ "dependency-name": "postgres" }]);
  });

  it("adds the github-actions, docker, and pip ecosystems to the weekly dependabot schedule", async () => {
    const config = parse(await readFile(resolve(".github/dependabot.yml"), "utf8")) as {
      updates: Array<{
        "package-ecosystem": string;
        directory: string;
        schedule: Schedule;
        "open-pull-requests-limit": number;
        ignore?: Array<{ "dependency-name": string; "update-types"?: string[] }>;
        groups?: Record<
          string,
          {
            "applies-to"?: string;
            "update-types"?: string[];
            patterns?: string[];
            "exclude-patterns"?: string[];
          }
        >;
      }>;
    };

    expect(config.updates.map((update) => update["package-ecosystem"])).toEqual([
      "npm",
      "github-actions",
      "docker",
      "pip",
    ]);
    // One slot per ecosystem, not one shared literal: a shared `{ interval:
    // "weekly" }` cannot tell four lanes apart, so it stayed green while all
    // four defaulted to Monday. Keyed by ecosystem, one lane's day drifting
    // fails on its own key.
    const expectedSchedules: Record<string, Schedule> = {
      "github-actions": {
        interval: "weekly",
        day: "friday",
        time: "04:23",
        timezone: "Etc/UTC",
      },
      docker: { interval: "weekly", day: "sunday", time: "05:31", timezone: "Etc/UTC" },
      pip: { interval: "weekly", day: "thursday", time: "05:07", timezone: "Etc/UTC" },
    };
    const expectedDirectories: Record<string, string> = {
      "github-actions": "/",
      docker: "/",
      pip: "/.github/",
    };
    for (const ecosystem of ["github-actions", "docker", "pip"]) {
      const update = config.updates.find((u) => u["package-ecosystem"] === ecosystem)!;
      expect(update.directory, ecosystem).toBe(expectedDirectories[ecosystem]);
      expect(update.schedule, ecosystem).toEqual(expectedSchedules[ecosystem]);
      // Per-entry cap: each updates entry opens at most five pull requests a
      // week (the npm lane included), so four entries could reach twenty —
      // no single lane floods, but the cap does not pool across ecosystems.
      expect(update["open-pull-requests-limit"], ecosystem).toBe(5);
    }
    // Only the Docker Node major is declined until it reaches LTS; keep that
    // exact scope so the ignore cannot drift to another update type.
    const docker = config.updates.find((u) => u["package-ecosystem"] === "docker")!;
    expect(docker.ignore).toEqual([{
      "dependency-name": "node",
      "update-types": ["version-update:semver-major"],
    }]);
    // The two Nitjsefnie-Actions workflows are SHA-pinned by maintainer
    // decision and dependabot now proposes their SHA bumps; one group per lane
    // collects every action — major bumps included — into a single weekly pull
    // request. This is the exact-value pin: on its own it catches any edit to
    // the groups object. The coverage gate below is what still holds if this
    // pin is ever loosened, and it is the one that resolves the patterns
    // against the workflows' real `uses:` inventory rather than restating them.
    const actions = config.updates.find((u) => u["package-ecosystem"] === "github-actions")!;
    expect(actions.groups).toEqual({
      "github-actions": { patterns: ["*"] },
      "github-actions-security": { "applies-to": "security-updates", patterns: ["*"] },
    });
  });

  it("pins the pip ecosystem to the hash-pinned zizmor requirements file", async () => {
    const source = await readFile(resolve(".github/dependabot.yml"), "utf8");
    const config = parse(source) as {
      updates: Array<{
        "package-ecosystem": string;
        directory: string;
        schedule: Schedule;
        "open-pull-requests-limit": number;
        ignore?: Array<{ "dependency-name": string; "update-types"?: string[] }>;
        groups?: Record<string, unknown>;
      }>;
    };
    const pip = config.updates.find((update) => update["package-ecosystem"] === "pip");

    expect(pip).toBeDefined();
    expect(pip!.directory).toBe("/.github/");
    expect(pip!.schedule).toEqual({
      interval: "weekly",
      day: "thursday",
      time: "05:07",
      timezone: "Etc/UTC",
    });
    expect(pip!["open-pull-requests-limit"]).toBe(5);
    expect(pip!.groups).toBeUndefined();
    expect(pip!.ignore).toBeUndefined();
    const expectedPipBlock = `  - package-ecosystem: "pip"
    directory: "/.github/"
    schedule:
      interval: "weekly"
      day: "thursday"
      time: "05:07"
      timezone: "Etc/UTC"
    open-pull-requests-limit: 5\n`;
    expect(source).toContain(expectedPipBlock);
    expect(source.endsWith(expectedPipBlock)).toBe(true);
  });

  it("collects every workflow action into one version and one security dependabot group", async () => {
    const config = parse(await readFile(resolve(".github/dependabot.yml"), "utf8")) as {
      updates: Array<{
        "package-ecosystem": string;
        schedule: Schedule;
        groups?: Record<
          string,
          {
            "applies-to"?: string;
            "update-types"?: string[];
            patterns?: string[];
            "exclude-patterns"?: string[];
          }
        >;
      }>;
    };

    // The real `uses:` inventory, read from the shipped workflows, so a group
    // that silently stopped covering an action dies here instead of splitting
    // that action's bump into its own pull request.
    //
    // Both walks dereference a key every shipped workflow carries, and both are
    // left to THROW when one is absent — `Object.values(workflow.on)` and
    // `for (const step of job.steps)` each raise a TypeError. That is a
    // deliberate choice, matching the job-level `uses:` case this file already
    // crashes on: a loud failure forces a maintainer to look, where a silent
    // `?? {}` would shrink the inventory or the cron set and let the gate pass
    // on less coverage than it claims to have read.
    const workflowDirectory = resolve(".github/workflows");
    const workflowFiles = (await readdir(workflowDirectory)).filter((file) =>
      /\.ya?ml$/.test(file));
    expect(workflowFiles.length).toBeGreaterThan(0);
    const actionNames = new Set<string>();
    // The weekday each weekday-pinned workflow in this repository fires on,
    // read from the workflows themselves rather than transcribed, so the
    // dependabot lanes' collision check cannot drift from the real crons.
    const cronDays = new Set<string>();
    for (const file of workflowFiles) {
      const workflow = parse(await readFile(resolve(workflowDirectory, file), "utf8")) as Workflow;
      for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps) {
          // A local action (`./path`) is not in the dependency graph dependabot
          // groups; a `uses:` without `@` is not a pinned external reference.
          if (step.uses && !step.uses.startsWith(".") && step.uses.includes("@")) {
            actionNames.add(step.uses.slice(0, step.uses.lastIndexOf("@")));
          }
        }
      }
      for (const trigger of Object.values(workflow.on)) {
        for (const entry of Array.isArray(trigger) ? trigger : []) {
          const fields = entry.cron.trim().split(/\s+/);
          if (fields.length !== 5 || fields[2] !== "*" || fields[3] !== "*") continue;
          // `m h * * d` occupies its pinned weekday. A daily cron (`*` weekday)
          // occupies no specific weekday in this model: secret-scan runs daily
          // at 04:41 and dependency-audit daily at 06:37. This checks only
          // weekly-lane collisions with weekday-pinned workflows. Not modelled
          // here: a day-of-month or month field (monthly crons), and a day field
          // naming a RANGE or a list (`1-5`), which this weekday-only check does
          // not resolve.
          // No cron of either shape ships in this repository.
          if (fields[4] === "*") continue;
          cronDays.add(CRON_DAYS[Number(fields[4])]!);
        }
      }
    }
    expect(actionNames.size).toBeGreaterThan(0);
    expect(cronDays.size).toBeGreaterThan(0);

    // Dependabot group patterns are globs where `*` matches any run of
    // characters, resolved against the ACTION NAME — `owner/repo` for a whole
    // action, `owner/repo/subaction` for one of its sub-actions, which is why a
    // sub-action is only collected by a pattern that reaches its path.
    const globMatches = (pattern: string, name: string) =>
      new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`)
        .test(name);

    const actions = config.updates.find((u) => u["package-ecosystem"] === "github-actions")!;
    const groups = Object.entries(actions.groups ?? {});
    // Declaration order is load-bearing: dependabot resolves membership
    // FIRST-MATCH-WINS ("if a dependency matches more than one rule, it's
    // included in the first group that it matches"), so the groups are walked in
    // order and only the first match counts as a carrier.
    const carriersOf = (action: string, lane: string) => {
      for (const [name, group] of groups) {
        if ((group["applies-to"] ?? "version-updates") !== lane) continue;
        // `exclude-patterns` subtracts from the group's own `patterns`, so a
        // group that excludes an action does not carry it however well its
        // patterns match. Both keys are read here because dependabot reads
        // both; reading patterns alone would report coverage the config does
        // not actually deliver.
        const included = (group.patterns ?? []).some((pattern) => globMatches(pattern, action));
        const excluded = (group["exclude-patterns"] ?? [])
          .some((pattern) => globMatches(pattern, action));
        if (included && !excluded) return [name];
      }
      return [];
    };

    // Every action is carried by a group in each lane: zero leaves the action's
    // bump on its own. A second group overlapping the first is not a second
    // carrier either — first-match-wins makes it shadowed, dead configuration
    // that no dependabot run and no other assertion reports. Security updates
    // are enabled on this repository, and a group without `applies-to` covers
    // version updates only — so a lane with no group reopens the
    // single-package security pull request this grouping exists to prevent.
    for (const lane of ["version-updates", "security-updates"]) {
      for (const action of [...actionNames].sort()) {
        expect(carriersOf(action, lane), `${lane} ${action}`).toHaveLength(1);
      }
    }

    // The trio is pinned to one SHA and used as a matched set — init and analyze
    // are two steps of the same analyze job in code-scanning.yml — so a split
    // bump could leave one job running two versions of the same action against
    // each other. All three sub-actions must therefore ride in ONE version group
    // together; the per-action uniqueness above alone would pass with three
    // separate codeql-only groups.
    const codeqlTrio = [...actionNames].filter((name) =>
      name.startsWith("github/codeql-action/")).sort();
    // Each member's carrier count is asserted HERE rather than by indexing
    // `carriersOf(...)[0]`: an empty carrier list would otherwise yield
    // `undefined` three times, and `new Set([undefined, undefined, undefined])`
    // has size 1 — the shared-carrier check would pass having proved nothing.
    const codeqlCarriers = codeqlTrio.map((action) => {
      const carriers = carriersOf(action, "version-updates");
      expect(carriers, action).toHaveLength(1);
      return carriers[0]!;
    });
    expect(new Set(codeqlCarriers).size).toBe(1);

    // No version group may narrow itself with update-types: that key is what
    // held the old `minor-and-patch` group, which left every major bump
    // (codeql-action v4 to v5) as one pull request per `uses:` line.
    for (const [name, group] of groups) {
      if ((group["applies-to"] ?? "version-updates") === "version-updates") {
        expect(group["update-types"], name).toBeUndefined();
      }
    }

    // All four lanes carry an explicit weekday, an explicit clock and a
    // timezone. No lane's day may be Monday — the default an unset `day`
    // resolves to — nor any weekday a weekday-pinned workflow in this
    // repository already fires on: code-scanning Wednesday, scorecard Saturday.
    // Secret-scan and dependency-audit are DAILY and excluded from the
    // weekday-occupation model.
    // The explicit days spread weekly lanes away from weekly workflow slots;
    // the property is asserted against the crons read above, not transcribed.
    for (const ecosystem of ["npm", "github-actions", "docker", "pip"]) {
      const update = config.updates.find((u) => u["package-ecosystem"] === ecosystem)!;
      const { schedule } = update;
      expect(schedule.interval, ecosystem).toBe("weekly");
      expect(schedule.timezone, ecosystem).toBe("Etc/UTC");
      expect(schedule.time, ecosystem).toMatch(/^\d{2}:\d{2}$/);
      expect(schedule.day, ecosystem).toBeDefined();
      expect(schedule.day, ecosystem).not.toBe("monday");
      expect(cronDays.has(schedule.day ?? ""), `${ecosystem} runs on ${schedule.day}, a cron day`)
        .toBe(false);
    }
  });

  it("hash-pins the zizmor install through the tracked requirements file", async () => {
    for (const file of ["pr-gates.yml", "actionlint.yml"]) {
      const workflow = await readWorkflow(file);
      const steps = workflow.jobs.actionlint!.steps;

      const install = steps.find((step) => step.id === "install_zizmor");
      expect(install).toBeDefined();
      expect(install!.name).toBe("Install zizmor");
      // The hashed requirements file is the only install path: no bare
      // `pip install zizmor` and no pip upgrade step — upgrading pip itself is
      // exactly the unhashed supply-chain lane this gate closes.
      expect(install!.run?.trim()).toBe(
        "pip install --require-hashes -r .github/requirements-zizmor.txt",
      );
      expect(install!.run).not.toContain("upgrade pip");
      expect(install!.run).not.toContain("pip install zizmor");
      const zizmor = steps.find((step) => step.run === "zizmor --no-progress .github/workflows-pr/*.yml");
      expect(zizmor, `${file} must run zizmor over the extracted workflow copies`).toBeDefined();
      expect(zizmor!.if).toBe("${{ !cancelled() && steps.install_zizmor.outcome == 'success' }}");
    }
  });
  it("tracks the nonempty zizmor requirements file", async () => {
    const file = ".github/requirements-zizmor.txt";
    const requirements = (await readFile(resolve(file), "utf8")).split("\n")
      .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    expect(requirements.length).toBeGreaterThan(0);
    expect(checkIgnore(file)).toBe(1);
  });
  it("tracks the nonempty pyyaml requirements file", async () => {
    const file = ".github/requirements-pyyaml.txt";
    const requirements = (await readFile(resolve(file), "utf8")).split("\n")
      .filter((line) => line.trim() !== "" && !line.trim().startsWith("#"));
    expect(requirements.length).toBeGreaterThan(0);
    expect(checkIgnore(file)).toBe(1);
  });

  it("groups the React family so dependabot bumps it in lockstep", async () => {
    const config = parse(await readFile(resolve(".github/dependabot.yml"), "utf8")) as {
      updates: Array<{
        "package-ecosystem": string;
        groups?: Record<string, Record<string, unknown> & { patterns?: string[] }>;
      }>;
    };
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const dependencyNames = [
      ...Object.keys(manifest.dependencies),
      ...Object.keys(manifest.devDependencies),
    ];
    // Dependabot group patterns are globs where `*` matches any run of
    // characters; resolve them against the real manifest so an over-broad
    // pattern is caught by what it sweeps in today.
    const globMatches = (pattern: string, name: string) =>
      new RegExp(`^${pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")).join(".*")}$`)
        .test(name);

    const npm = config.updates.find((update) => update["package-ecosystem"] === "npm");
    expect(npm).toBeDefined();
    const groups = Object.values(npm!.groups ?? {});
    const reactFamily = ["@types/react", "@types/react-dom", "react", "react-dom"];

    // A group without `applies-to` covers version updates only, and security
    // updates are enabled on this repository, so a React advisory would still
    // open a single-package pull request unless a second group covers that
    // lane. Each lane needs exactly one React group.
    for (const lane of ["version-updates", "security-updates"]) {
      const laneGroups = groups.filter((group) => (group["applies-to"] ?? "version-updates") === lane);
      expect(laneGroups, lane).toHaveLength(1);
      const [group] = laneGroups;
      // Any key beyond the lane (update-types, dependency-type,
      // exclude-patterns, ...) narrows which bumps the group collects, so a
      // React bump could arrive split again.
      expect(Object.keys(group!).filter((key) => key !== "applies-to"), lane).toEqual(["patterns"]);
      const patterns = group!.patterns ?? [];
      const members = dependencyNames.filter((name) =>
        patterns.some((pattern) => globMatches(pattern, name)));

      // react-dom refuses to load beside any other react version, so a bump
      // that moves one member alone breaks every test file.
      expect(members.sort(), lane).toEqual(reactFamily);
      // Exact names, not wildcards: `react*` + `@types/react*` resolves to the
      // four today but would also collect a future react-is.
      expect([...patterns].sort(), lane).toEqual(reactFamily);
    }
  });

  it("reopens only shipped yml workflows in the deny-by-default ignore policy", () => {
    expect(checkIgnore(".github/workflows/ci.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/actionlint.yml")).toBe(1);
    // The split's new producer files (issue 1090). A workflow file that exists
    // on disk and is invisible to git ships nothing, and the check that would
    // notice is the one this line stands in for.
    expect(checkIgnore(".github/workflows/pr-gates.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/ci-pr.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/pr-gates.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/pr-gates.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/dependency-audit.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/ratchet-guard.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/secret-scan.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/pr-suite.yml")).toBe(1);
    expect(checkIgnore(".github/dependabot.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/unshipped.yaml")).toBe(0);
    expect(checkIgnore(".github/junk.txt")).toBe(0);
  });

  it("parses a source-only CodeQL scan that installs and builds nothing", async () => {
    const workflow = await readWorkflow("code-scanning.yml") as Workflow & { name: string };
    expect(workflow.name).toBe("code scanning");
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      pull_request: { branches: ["main"] },
      schedule: [{ cron: "43 5 * * 3" }],
      workflow_dispatch: null,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "code-scanning-${{ github.event.pull_request.number || github.sha }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });

    const analyze = workflow.jobs.analyze! as typeof workflow.jobs.analyze & {
      permissions: Record<string, string>;
      strategy: {
        "fail-fast": boolean;
        matrix: { language: string[] };
      };
    };
    // The job logic and grants: the job-level permissions object is the least
    // privilege uploading SARIF needs, and any extra key — a tolerated
    // failure, a checkout without persist-credentials disabled — fails this
    // equality.
    expect(gateBehavior(analyze)).toEqual({
      permissions: { contents: "read", "security-events": "write" },
      strategy: {
        "fail-fast": false,
        matrix: { language: ["javascript-typescript", "actions"] },
      },
      "timeout-minutes": 30,
      steps: [
        {},
        {},
        {},
      ],
    } satisfies typeof analyze);

    // The no-build principle as its own named assertion, so a "helpful"
    // install or build step fails a pin that says so rather than only a
    // shape diff: CodeQL for JS/TS extracts from source.
    for (const command of analyze.steps.map((step) => step.run).filter(Boolean)) {
      expect(command).not.toMatch(/pnpm (install|build)/);
    }
  });

  /**
   * OpenSSF Scorecard is the instrument that MEASURES this repository's
   * supply-chain hardening — hash-pinned actions, explicit workflow
   * permissions, CodeQL, Dependabot — so a regression in that regime is
   * otherwise invisible: every other workflow keeps passing while the practice
   * that produced them quietly stops. The ways below are the ones where every
   * run concludes SUCCESS and the Security tab is still empty, which is why
   * "the workflow exists" is not a pin and no assertion here accepts one.
   *
   * 1. **A trigger that never fires.** A `push` or `pull_request` trigger
   *    carrying a branch filter yields a workflow GitHub schedules and never
   *    runs: every conclusion is green and no score is ever produced.
   * 2. **A cron that fires on the wrong tick.** A different mechanism and a
   *    different consequence, so it is a separate case rather than a clause of
   *    the one above: a valid-but-mistyped slot is not silence, it is a reading
   *    taken at an hour nobody looks, INVISIBLE in a run history rather than
   *    absent from it. The `on` equality below catches it as a value mismatch,
   *    not as a missing run — that equality is the only thing catching it.
   * 3. **A contribution-event trigger.** The opposite failure, and the one the
   *    `on` equality exists to prevent: a `pull_request` arm makes Scorecard a
   *    second gate on a commit `ci` already checks, spending a pull-request
   *    run on a signal that is allowed to be flat.
   * 4. **A job that never starts.** The `if` guard is where a skip hides,
   *    because a skipped job is indistinguishable from a green one in a run
   *    summary. A fork's run, or a manual dispatch on any ref but the default
   *    branch, publishes findings for a tree this repository is not
   *    responsible for, and a score describing a different tree than the badge.
   * 5. **A run that produces no SARIF.** `results_format` other than `sarif`,
   *    or `publish_results` off, leaves the Security tab empty while every run
   *    is green — an instrument that measures nothing is indistinguishable
   *    from one measuring a healthy repository.
   * 6. **A SARIF upload that cannot succeed, and a score that cannot be
   *    attributed.** Without `security-events: write` the upload step fails
   *    while the workflow still reports; without `id-token: write` the
   *    published result carries no signature, so a consumer cannot verify the
   *    score came from this repository's own run.
   * 7. **A step running an action this workflow was not reviewed for.** A
   *    substitution swaps `ossf/scorecard-action` for a different action and
   *    the workflow still runs weekly and concludes green while measuring
   *    something else; the SET assertion below is what names it. Which
   *    REVISION of each action runs is zizmor's audit and Dependabot's bumps
   *    to hold — fleet-rules, "Merging and CI".
   * 8. **A key nobody reads.** Every assertion in this test reads a key this
   *    workflow is expected to carry, so a key they do NOT read is a hole
   *    rather than a coverage gap — and the same is true one level down of a
   *    key that IS read. Both of these shipped and both read green under
   *    actionlint and zizmor: an unpinned top-level `env:` block, and a second
   *    job carrying `contents: write` beside the one this suite pins. The two
   *    key-set equalities are what close them.
   * 9. **A run that never ends.** With no `timeout-minutes` a hung analysis
   *    holds a runner and concludes nothing at all.
   * 10. **A gate that is not a gate.** Promoting `scorecard` into
   *    `.github/required-checks.json` turns a weekly trend signal into a
   *    blocking check on every pull request; this is the last place that shows
   *    up before the deploy gate refuses the merge.
   */
  it("measures supply-chain hardening weekly without becoming a second gate on a commit", async () => {
    const workflow = await readWorkflow("scorecard.yml") as Workflow & { name: string };
    expect(workflow.name).toBe("scorecard");

    // The WHOLE `on` object, so an added trigger fails rather than passing
    // unnoticed beside the ones that are still correct. Schedule plus manual
    // dispatch, and nothing else: the cron is the only automatic tick, so a
    // mistyped slot is caught here rather than as a workflow that quietly never
    // runs again.
    expect(workflow.on).toEqual({
      schedule: [{ cron: "23 3 * * 6" }],
      workflow_dispatch: null,
    });

    // Least privilege at the top. The workflow only reads the tree; the two
    // write scopes Scorecard genuinely needs are granted on the job, so a
    // workflow-level broadening is an extra key on this equality.
    expect(workflow.permissions).toEqual({ contents: "read" });

    // Carried verbatim from the file. tests/ci/concurrency.test.ts is what
    // holds the classification, and it pins these same two values, so the two
    // suites cannot drift apart on the block.
    expect(workflow.concurrency).toEqual({
      group: "scorecard-${{ github.ref }}",
      "cancel-in-progress": true,
    });

    // Widened for `name`, which the shared job type omits: every workflow pinned
    // above this point leaves its job unnamed, so the field was never needed.
    // The whole-job equality below does need it, because a job's `name` is the
    // check-run name branch protection sees — a renamed job is a real change,
    // not a cosmetic one.
    const analysis = workflow.jobs.analysis! as typeof workflow.jobs.analysis & { name?: string };

    // The guard, in the two halves that matter, asserted separately so a half
    // that is removed is named. `fork` stops a fork's run publishing findings
    // for a tree nobody here is responsible for; the default-branch test stops
    // a manual run on another ref publishing a score for a different tree than
    // the one the badge describes.
    expect(
      analysis.if,
      "scorecard.yml's job must skip forks: a fork run publishes findings for a tree this " +
        "repository is not responsible for, and a skipped job is indistinguishable from a green one",
    ).toContain("!github.event.repository.fork");
    // This one pins the EXPRESSION, not the rule, and the message says so on
    // purpose. `github.ref_name == github.event.repository.default_branch` is a
    // semantically equivalent spelling of the same guard, and rewriting to it
    // turns this red without weakening anything — so a message claiming the
    // workflow had stopped default-branch-only would be stating a falsehood
    // about a refactor that did not happen. The whole-job equality below pins
    // the same string verbatim, exactly as the sibling CodeQL and
    // dependency-audit tests do; amending the expression is therefore a
    // coordinated edit to both, not a rule that was broken.
    expect(
      analysis.if,
      "scorecard.yml's default-branch guard must be the exact expression the reference ships: " +
        "this assertion pins the expression, not the rule it expresses. A semantically equivalent " +
        "rewrite (github.ref_name == ... .default_branch, say) fails here and at the whole-job " +
        "equality below without weakening the guard, so treat changing it as a coordinated edit to " +
        "both, not as a broken rule.",
    ).toContain("github.ref == format('refs/heads/{0}', github.event.repository.default_branch)");

    // Exactly these three, and no more. `security-events: write` is what puts
    // findings in the Security tab — drop it and the SARIF upload fails while
    // the run still reports. `id-token: write` is what lets Scorecard sign its
    // published result over OIDC, without which a consumer cannot verify the
    // published score came from this repository's own run.
    expect(analysis.permissions).toEqual({
      "security-events": "write",
      "id-token": "write",
      contents: "read",
    });

    // Require actual action steps so the job's metadata cannot stand in for
    // work. Action identities and inputs are outside this fixture comparison.
    const used = analysis.steps.filter((step) => step.uses);
    expect(used.length, "scorecard.yml must run at least one action").toBeGreaterThan(0);

    // A hung analysis holds a runner and concludes nothing, so the job must
    // carry the bound the reference ships.
    expect(
      analysis["timeout-minutes"],
      "scorecard.yml's job must bound its own runtime, or a hung analysis holds a runner and " +
        "concludes nothing at all",
    ).toBe(15);

    // The job logic and grants, excluding action/tool/runner configuration, in the dependency-audit style: the equality is
    // what fails on a step added, removed or reordered, and on an extra
    // permission key the named assertions above would tolerate.
    expect(gateBehavior(analysis)).toEqual({
      name: "Scorecard analysis",
      if: "${{ !github.event.repository.fork && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}",
      "timeout-minutes": 15,
      permissions: { "security-events": "write", "id-token": "write", contents: "read" },
      steps: [
        {
          name: "Checkout code",
        },
        {
          name: "Run Scorecard analysis",
        },
        {
          name: "Upload Scorecard results artifact",
        },
        {
          name: "Upload Scorecard results to code scanning",
        },
      ],
    } satisfies typeof analysis);

    // The exact top-level key set, and the assertion that closes the one hole
    // every other assertion here leaves. Each of them reads a key this workflow
    // is EXPECTED to carry, so a key none of them reads is not a gap in coverage
    // — it is a silent channel. An unpinned top-level `env:` block planting a
    // `${{ github.repository }}` survives all of them, and survives actionlint
    // and zizmor as well: all three read it clean, because a key nobody asserts
    // on is a key nobody is looking at.
    expect(
      Object.keys(workflow).sort(),
      "scorecard.yml's top-level key set is the contract, not a suggestion: every assertion above " +
        "reads a key this workflow is expected to carry, so a key outside that set is not " +
        "something merely unasserted — it is a channel nothing reads. An unpinned top-level env: " +
        "block survives this whole test and both actionlint and zizmor with it, because a key " +
        "nobody asserts on is a key nobody is looking at. If you are adding a legitimate key " +
        "such as run-name, add it HERE as well: the fix for this failure is the assertion, not " +
        "the deletion of your key from the workflow.",
    ).toEqual([
      "concurrency",
      "jobs",
      "name",
      "on",
      "permissions",
    ]);

    // The same argument one level down, and this is the gap that survived the
    // whole-branch review's eight mutants: the pin above is a single lookup of
    // `analysis`, and the whole-job equality is scoped to that one job, so a
    // SECOND job on this file was invisible to everything here. It carried
    // `permissions: contents: write` and a `run:` step interpolating
    // `${{ github.repository }}`, and passed 34/34 green with actionlint and
    // zizmor both reporting nothing. One assertion enumerates the jobs key
    // rather than looking one entry up, which is what turns "a job nobody
    // reviewed" into a named failure.
    expect(
      Object.keys(workflow.jobs).sort(),
      "scorecard.yml must carry exactly the one job this suite pins. Every job assertion above " +
        "reads `analysis` specifically and the whole-job equality is scoped to it, so a second " +
        "job is invisible to all of them: one carrying contents: write and a run step " +
        "interpolating an expression would ship with this file reviewed only for the job beside " +
        "it, and both actionlint and zizmor read that clean. If a second job is legitimate, it " +
        "needs its own pins here, not just an entry in this array.",
    ).toEqual(["analysis"]);

    const requiredChecks = JSON.parse(
      await readFile(resolve(".github/required-checks.json"), "utf8"),
    ) as Record<string, string | string[]>;
    const promotableCheckNames = [workflow.name, analysis.name ?? "analysis"];
    // A pin may name several files (issue 1090's split), so the path clause
    // reads every path of a pin: stringifying a list would compare
    // ".github/workflows/a.yml,.github/workflows/b.yml" and find no
    // ".yml" suffix, letting a scorecard pin through this guard.
    expect(
      Object.entries(requiredChecks).filter(
        ([check, pin]) =>
          promotableCheckNames.includes(check) ||
          (Array.isArray(pin) ? pin : [pin]).some((file) => file.endsWith("scorecard.yml")),
      ),
      "scorecard is a weekly trend signal, not a per-commit gate: a required check naming it — " +
        "by its workflow name, by the analysis job's check-run name, or by pinning its file — " +
        "would block every pull request on a signal that is allowed to stay flat",
    ).toEqual([]);
  });
});

async function readWorkflow(name: string): Promise<Workflow> {
  return parse(await readFile(resolve(".github/workflows", name), "utf8")) as Workflow;
}

function checkIgnore(pathname: string): number | null {
  return spawnSync("git", ["check-ignore", "--no-index", "--quiet", pathname], {
    cwd: resolve("."),
  }).status;
}

/** Compare gate logic and grants independently of action/tool configuration. */
function gateBehavior(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(gateBehavior);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !["uses", "with", "image", "runs-on"].includes(key) && !key.startsWith("ACTIONLINT_"))
      .map(([key, entry]) => [key, gateBehavior(entry)]));
  }
  return value;
}
