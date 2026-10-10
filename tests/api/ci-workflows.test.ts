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
    expect(workflow.jobs).toEqual({
      claim: {
        if: "github.event.comment.user.type != 'Bot'"
          + " && (contains(github.event.comment.body, '/claim')\n"
          + "    || contains(github.event.comment.body, '/unclaim')\n"
          + "    || contains(github.event.comment.body, '/release'))",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        permissions: { issues: "write", "pull-requests": "write" },
        steps: [{
          uses: expect.stringMatching(/^Nitjsefnie-Actions\/claim@/),
          with: {
            "max-claims": "read=2, triage=4, write=6, maintain=10, admin=-1",
            expire: "7",
          },
        }],
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
    const workflowSha = workflow.jobs.claim!.steps[0]!.uses?.match(
      /^Nitjsefnie-Actions\/claim@([0-9a-f]{40})$/,
    )?.[1];

    expect(contributingClaimHrefs).toHaveLength(1);
    expect(contributingRevision).toBeDefined();
    expect(workflowSha).toBeDefined();
    expect(contributingRevision ?? "").toMatch(/^[0-9a-f]{40}$/);
    expect(contributingRevision).toBe(workflowSha);
  });

  it("runs on a pull request or a closed issue so the action can decline the command in a reply", async () => {
    const condition = (await readWorkflow("claim.yml")).jobs.claim!.if!;
    // Each pre-filter the job condition used to carry is denied separately, so
    // restoring one is named rather than buried in the whole-job diff. A job
    // whose `if` does not match starts NO run, so the commenter is met with
    // silence; the reference condition lets the action answer instead, and the
    // answer is a refusal — which is what tells the author the command reached
    // the workflow at all.
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

  it("caps concurrent claims per account and expires them", async () => {
    const step = (await readWorkflow("claim.yml")).jobs.claim!.steps[0]!;
    // Pinned as a pair with the job equality above, and on its own so a
    // deletion is named: with neither input, one account can hold an unbounded
    // number of claims and a stale claim never releases the reserve on its own.
    expect(step.with).toEqual({
      "max-claims": "read=2, triage=4, write=6, maintain=10, admin=-1",
      expire: "7",
    });
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
    expect(workflow.jobs).toEqual({
      gate: {
        if: "github.event.pull_request.user.type != 'Bot' && github.event.pull_request.draft == false",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        steps: [{
          uses: expect.stringMatching(/^Nitjsefnie-Actions\/pr-gate@/),
          with: expect.objectContaining({
            "github-token": "${{ github.token }}",
            repository: "${{ github.repository }}",
            "pull-request-number": "${{ github.event.pull_request.number }}",
            "pull-request-author": "${{ github.event.pull_request.user.login }}",
          }),
        }],
      },
    });
  });

  it("judges the pull request head only as git data, executed entirely from main", async () => {
    const workflow = await readWorkflow("ratchet-guard-pr.yml");
    // pull_request_target keeps the gate alive when a pull request disables a
    // workflow's own pull_request run: the workflow definition, the checkout
    // and the script that executes all come from main — the ci pull-request
    // leg has fired pull_request_target since issue 822, and since issue 1090
    // that leg is ci-pr.yml's own trigger, so the ci run can no longer be
    // silenced that way. `branches: [main]` keeps a PR retargeted to main
    // (an edited event, which gets no new run) from carrying its stale green
    // over.
    //
    // Issue 1090 moved this leg into a file of its own so its `on:` set is
    // exactly {pull_request_target}: a privileged trigger on a file carrying a
    // `refs/pull` fetch is what CodeQL's cache-poisoning and untrusted-checkout
    // alerts describe. The push and dispatch legs that used to share this file
    // are in ratchet-guard.yml, which reads no pull-request data at all.
    expect(workflow.on).toEqual({
      pull_request_target: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    // Every pull request shares one repository-level group, so the repository's
    // Actions minutes stop scaling with the number of open pull requests;
    // GitHub keeps one PENDING run per group and cancels the superseded one.
    // cancel-in-progress is the literal false because that group is shared by
    // every pull request and this job is a required context — see ci-pr.yml's
    // concurrency block for the full argument.
    expect(workflow.concurrency).toEqual({
      group: "ratchet-guard-pr-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
      "cancel-in-progress": false,
    });
    // The whole job, exactly, in the dependency-audit style. One checkout with
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
    expect(workflow.jobs).toEqual({
      "ratchet-guard": {
        "runs-on": "ubuntu-latest",
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
          {
            uses: expect.stringMatching(/^actions\/checkout@/),
            with: {
              "persist-credentials": false,
              "fetch-depth": 0,
            },
          },
          {
            uses: expect.stringMatching(/^actions\/setup-node@/),
            with: { "node-version": expect.any(String) },
          },
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
    // The whole job, exactly. Two checkouts, each gated on the event name:
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
    expect(workflow.jobs).toEqual({
      "ratchet-guard": {
        "runs-on": "ubuntu-latest",
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
            uses: expect.stringMatching(/^actions\/checkout@/),
            with: {
              ref: "${{ github.event.before }}",
              "persist-credentials": false,
              "fetch-depth": 0,
            },
          },
          {
            if: "${{ github.event_name == 'workflow_dispatch' }}",
            uses: expect.stringMatching(/^actions\/checkout@/),
            with: {
              ref: "${{ inputs.base }}",
              "persist-credentials": false,
              "fetch-depth": 0,
            },
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
          {
            uses: expect.stringMatching(/^actions\/setup-node@/),
            with: { "node-version": expect.any(String) },
          },
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
        file: "ratchet-guard-pr.yml",
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
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      packageManager?: string;
      engines?: Record<string, string>;
    };
    expect(manifest.packageManager).toMatch(/^pnpm@\d+\.\d+\.\d+$/);
    expect(manifest.engines?.node).toMatch(/^\d+\.\d+(\.\d+)?$/);
    expect(manifest.engines?.pnpm).toMatch(/^\d+\.\d+\.\d+$/);
    // Issue 1090 split this workflow, so ci.yml is now the push/dispatch leg
    // and ci-pr.yml the pull-request leg; the trigger set below is asserted
    // WHOLE per file rather than by objectContaining over one, so a trigger
    // re-added to either is a failure rather than a tolerated extra key.
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
    expect(verify.services?.postgres?.image).toMatch(/^postgres:[0-9]+@sha256:[0-9a-f]{64}$/);
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
    const uploadPins = ciSteps
      .filter((step) =>
        step.uses?.startsWith("actions/upload-artifact@"))
      .map((step) => step.uses!.replace(/@[0-9a-f]{40}$/, "@"));
    expect(uploadPins).toEqual([
      "actions/upload-artifact@",
      "actions/upload-artifact@",
    ]);
    expect(ciSteps
      .filter((step) => step.uses?.startsWith("actions/download-artifact@"))
      .map((step) => step.uses!.replace(/@[0-9a-f]{40}$/, "@"))).toEqual([
      "actions/download-artifact@",
    ]);
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
    expect(verifyCheckouts[0]).toEqual({
      uses: expect.stringMatching(/^actions\/checkout@/),
      with: { "persist-credentials": false, "fetch-depth": 0 },
    });
    expect(verify.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with)
      .toEqual(expect.objectContaining({ "node-version": expect.any(String) }));
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
      TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
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
    expect(prSteps
      .filter((step) => step.uses?.startsWith("actions/download-artifact@"))
      .map((step) => step.uses!.replace(/@[0-9a-f]{40}$/, "@"))).toEqual([
      "actions/download-artifact@",
    ]);
    expect(
      prSteps.filter((step) => step.uses?.startsWith("actions/upload-artifact@")),
      "the pull-request leg must upload nothing — the coverage and patch-coverage artifacts on a " +
        "pull request come from pr-suite.yml, and an upload here would overwrite that run's",
    ).toEqual([]);
    // Exactly one checkout, and it is the base branch's tip with full history
    // and no ref input: under pull_request_target that is actions/checkout's
    // default, which is what makes the pull request's own edit to a gated
    // script unable to change the judge (issue 822). It carries no event gate
    // because this file admits nothing else.
    const verifyCheckouts = verify.steps.filter((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(verifyCheckouts, "the verify job must keep exactly one checkout").toHaveLength(1);
    expect(verifyCheckouts[0]).toEqual({
      uses: expect.stringMatching(/^actions\/checkout@/),
      with: { "persist-credentials": false, "fetch-depth": 0 },
    });
    expect(verify.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with)
      .toEqual(expect.objectContaining({ "node-version": expect.any(String) }));
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
      TOKEN_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }));
  });

  it("parses a catalogue-style workflow gate with explicit least privilege", async () => {
    // Both legs of the gate (issue 1090 split this workflow in two), asserted
    // per file. The pin is per-leg rather than shared, because the two legs
    // genuinely differ — the pull-request leg extracts the head ref's workflows
    // with `git show`, the push leg copies its own checked-out tree — and a
    // single equality covering both would have to be loosened to fit.
    const workflow = await readWorkflow("actionlint-pr.yml");
    // pull_request_target executes main's definition and main's tools; the
    // pull request head enters only as git objects extracted with `git show`
    // (issue 822). Same trigger shape as ratchet-guard-pr.yml.
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
      group: "actionlint-pr-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
      "cancel-in-progress": false,
    });
    // The whole job, exactly, in the dependency-audit style: any extra step —
    // a second checkout, a script sourced from the extracted tree — fails this
    // equality. Under pull_request_target the default checkout is main's tip;
    // the checkout step carries no ref input, and the PR head is fetched as
    // git objects and extracted as data, never checked out.
    expect(workflow.jobs.actionlint).toEqual({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 15,
      env: {
        // The fork, not upstream: stock actionlint's newest release is still
        // 1.7.12, and its workflow schema has no `queue` key under
        // `concurrency`, so it rejects claim.yml as an unknown key. The
        // repository and version live in env beside the checksum that pins the
        // fork's own tarball. tests/ci/pr-data-triggers.test.ts and the
        // equality below decide which leg holds pull-request data; the version
        // and checksum are value-free here, so `keeps the actionlint toolchain
        // identical across both legs` holds these three the same in both files.
        ACTIONLINT_REPO: "Nitjsefnie-OSC/actionlint",
        ACTIONLINT_VERSION: expect.any(String),
        ACTIONLINT_SHA256: expect.any(String),
      },
      steps: [
        {
          uses: expect.stringMatching(/^actions\/checkout@/),
          with: { "persist-credentials": false },
        },
        {
          name: "Fetch the pull request head",
          env: { PR_NUMBER: "${{ github.event.pull_request.number }}" },
          run: 'git fetch --no-tags origin "+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/head"',
        },
        {
          uses: expect.stringMatching(/^actions\/setup-python@/),
          with: { "python-version": expect.any(String) },
        },
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
    // The whole job, exactly. No fetch step for a pull request head, and no
    // `Base freshness` step: both belong to the pull-request leg, and a
    // surviving copy here is exactly the failure the split removes.
    expect(workflow.jobs.actionlint).toEqual({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 15,
      env: {
        ACTIONLINT_REPO: "Nitjsefnie-OSC/actionlint",
        ACTIONLINT_VERSION: expect.any(String),
        ACTIONLINT_SHA256: expect.any(String),
      },
      steps: [
        {
          uses: expect.stringMatching(/^actions\/checkout@/),
          with: { "persist-credentials": false },
        },
        {
          uses: expect.stringMatching(/^actions\/setup-python@/),
          with: { "python-version": expect.any(String) },
        },
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
    // Both whole-job equalities read their own leg's env, with the version
    // and checksum value-free in each — so nothing else stops the two files
    // drifting apart on a bump applied to only one. Derived from the
    // workflows themselves, quoting no value (fleet-rules, "Merging and CI"):
    // the three keys must simply be the same in both legs.
    const readEnv = async (file: string) => {
      const workflow = await readWorkflow(file);
      return (workflow.jobs.actionlint?.env ?? {}) as Record<string, string>;
    };
    const prEnv = await readEnv("actionlint-pr.yml");
    const pushEnv = await readEnv("actionlint.yml");
    for (const key of ["ACTIONLINT_REPO", "ACTIONLINT_VERSION", "ACTIONLINT_SHA256"]) {
      expect(prEnv[key], `${key} must be present in actionlint-pr.yml`).toBeDefined();
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
    // is dependency-audit-pr.yml, the issue-1090 split's base-defined
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
    // repository-level bound lives on dependency-audit-pr.yml.
    expect(workflow.concurrency).toEqual({
      group: "dependency-audit-${{ github.sha }}",
      "cancel-in-progress": false,
    });

    // The whole job, exactly, in the claim/pr-gate style: any extra key — a
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
    expect(workflow.jobs["dependency-audit"]).toEqual({
      "runs-on": "ubuntu-latest",
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
        {
          uses: expect.stringMatching(/^actions\/checkout@/),
          // Full history for the audit step's fast-path ancestor check: the
          // previous tip must be present and provably an ancestor of the
          // pushed HEAD, or the classification falls through to the full
          // audit (safe, but never fast).
          with: { "persist-credentials": false, "fetch-depth": 0 },
        },
        {
          name: "Refuse a pull request that changes the audit suppression list",
          if: "github.event_name == 'pull_request'",
          env: { BASE_SHA: "${{ github.event.pull_request.base.sha }}" },
          run: "file=package.json\nws_file=pnpm-workspace.yaml\nnpmrc_file=.npmrc\n\n# Two more suppression surfaces, measured on pnpm 10.33.0 with a real advisory\n# carrying its github_advisory_id (the invalid-first-leg lesson applied): the\n# audit honours auditConfig, auditLevel and the registries mapping from\n# pnpm-workspace.yaml — the mapping BEATS a pinned npm_config_registry, so it\n# redirects the advisory endpoint — and audit-level, registry, strict-ssl,\n# cafile, proxy and https-proxy from .npmrc. Both files are therefore compared\n# alongside package.json; absent compares equal to a file carrying none of the\n# audited keys, and an unparseable CHANGED file is a refusal, never a silent\n# pass.\n\n# Reads a commit's package.json as git objects with the ls-tree single-blob\n# discipline: exactly one mode-100644 blob entry at package.json, or refuse.\n# Prints the blob id on stdout.\nblob_of() {\n  entries=$(git ls-tree \"${1:?}\" -- \"${file}\")\n  count=0\n  entry_mode=\"\"\n  entry_type=\"\"\n  entry_blob=\"\"\n  while IFS=$'\\t' read -r meta _path; do\n    [ -n \"${meta}\" ] || continue\n    count=$((count + 1))\n    entry_mode=${meta%% *}\n    rest=${meta#* }\n    entry_type=${rest%% *}\n    entry_blob=${rest#* }\n  done <<< \"${entries}\"\n  if [ \"${count}\" -ne 1 ] || [ \"${entry_mode}\" != \"100644\" ] || [ \"${entry_type}\" != \"blob\" ]; then\n    echo \"::error::package.json must be exactly one mode-100644 blob entry in a tree; refusing. The suppression list is read from git objects, never from the filesystem, so a symlink leaf, a wrong mode, a non-blob type and an absent file are all refused.\" >&2\n    exit 1\n  fi\n  printf '%s\\n' \"${entry_blob}\"\n}\n\n# Reads a commit's pnpm-workspace.yaml or .npmrc as git objects: absent is a\n# legitimate state — the files are optional — so unlike package.json it prints\n# the ABSENT sentinel instead of refusing. Any PRESENT shape other than exactly\n# one mode-100644 blob is a refusal: pnpm reads these files from the checkout\n# on disk, where a symlink leaf redirects the read outside the tree, so the\n# git-objects read must refuse what a filesystem read would follow.\noptional_entry_of() {\n  entries=$(git ls-tree \"${1:?}\" -- \"${2:?}\")\n  count=0\n  entry_mode=\"\"\n  entry_type=\"\"\n  entry_blob=\"\"\n  while IFS=$'\\t' read -r meta _path; do\n    [ -n \"${meta}\" ] || continue\n    count=$((count + 1))\n    entry_mode=${meta%% *}\n    rest=${meta#* }\n    entry_type=${rest%% *}\n    entry_blob=${rest#* }\n  done <<< \"${entries}\"\n  if [ \"${count}\" -eq 0 ]; then\n    printf 'ABSENT\\n'\n    return 0\n  fi\n  if [ \"${count}\" -ne 1 ] || [ \"${entry_mode}\" != \"100644\" ] || [ \"${entry_type}\" != \"blob\" ]; then\n    echo \"::error::pnpm-workspace.yaml and .npmrc must be absent or exactly one mode-100644 blob entry in a tree; refusing. These files are read from git objects, never from the filesystem — pnpm reads the checkout on disk, where a symlink leaf redirects the read outside the tree, so a symlink leaf, a wrong mode and a non-blob type are all refused.\" >&2\n    exit 1\n  fi\n  printf '%s\\n' \"${entry_blob}\"\n}\n\n# Pipes the named blob through the inline python pre-parse, which emits the\n# CANONICAL form of .pnpm.auditConfig: sort_keys and compact separators make\n# the dump uniquely parseable back to one value, so string equality of the two\n# sides is structural equality - key order, indentation and escaping in\n# package.json never reach the comparison, while every nested value and the\n# order of the ignoreGhsas list itself do.\nvalue_of() {\n  git cat-file blob \"${1:?}\" | python3 -c \"${pre_parse}\"\n}\n\n# Projects one side's pnpm-workspace.yaml (a blob id, or the ABSENT sentinel)\n# to the canonical form of its audit-affecting settings. Absent compares equal\n# to a file carrying none of the audited keys; identical bytes cannot diverge,\n# so identical blob ids never reach the parse — the PyYAML install below runs\n# only when a side actually needs judging, and a runner without a working\n# module only ever reds a pull request that CHANGED the file.\nws_value_of() {\n  if [ \"${1:?}\" = \"ABSENT\" ]; then\n    printf 'absent\\n'\n    return 0\n  fi\n  git cat-file blob \"${1:?}\" | PYTHONPATH=\"${pyyaml_site}${PYTHONPATH:+:${PYTHONPATH}}\" python3 -c \"${ws_pre_parse}\"\n}\n\n# Projects one side's .npmrc to the canonical form of its audit-affecting\n# keys, with the same ABSENT handling as the workspace projection.\nnpmrc_value_of() {\n  if [ \"${1:?}\" = \"ABSENT\" ]; then\n    printf 'absent\\n'\n    return 0\n  fi\n  git cat-file blob \"${1:?}\" | python3 -c \"${npmrc_pre_parse}\"\n}\n\npre_parse=$(cat <<'PY'\nimport json\nimport sys\n\ndata = sys.stdin.buffer.read()\nif 65536 < len(data):\n    sys.stderr.write(\"::error::package.json is larger than the 65536-byte cap; refusing\\n\")\n    sys.exit(1)\nif b\"\\x00\" in data:\n    sys.stderr.write(\"::error::package.json carries a NUL byte, which is invalid content wherever it sits; refusing\\n\")\n    sys.exit(1)\ntry:\n    text = data.decode(\"utf-8\")\nexcept UnicodeDecodeError:\n    sys.stderr.write(\"::error::package.json is not valid UTF-8; refusing\\n\")\n    sys.exit(1)\ntry:\n    parsed = json.loads(text)\nexcept ValueError:\n    sys.stderr.write(\"::error::package.json does not parse as JSON; refusing\\n\")\n    sys.exit(1)\nconfig = None\nif isinstance(parsed, dict):\n    pnpm = parsed.get(\"pnpm\")\n    if isinstance(pnpm, dict):\n        config = pnpm.get(\"auditConfig\")\nif config is None:\n    sys.stdout.write(\"absent\")\nelse:\n    sys.stdout.write(json.dumps(config, sort_keys=True, separators=(\",\", \":\")))\nPY\n)\nws_pre_parse=$(cat <<'PY'\nimport json\nimport sys\n\ndata = sys.stdin.buffer.read()\nif 65536 < len(data):\n    sys.stderr.write(\"::error::pnpm-workspace.yaml and .npmrc are larger than the 65536-byte cap; refusing\\n\")\n    sys.exit(1)\nif b\"\\x00\" in data:\n    sys.stderr.write(\"::error::pnpm-workspace.yaml and .npmrc carry a NUL byte, which is invalid content wherever it sits; refusing\\n\")\n    sys.exit(1)\ntry:\n    text = data.decode(\"utf-8\")\nexcept UnicodeDecodeError:\n    sys.stderr.write(\"::error::pnpm-workspace.yaml and .npmrc are not valid UTF-8; refusing\\n\")\n    sys.exit(1)\ntry:\n    import yaml\nexcept ImportError:\n    sys.stderr.write(\"::error::python3 has no yaml module; refusing to judge pnpm-workspace.yaml without it — the hash-pinned install above provides it, so a missing module means the install failed and is a red run, never a silent pass\\n\")\n    sys.exit(1)\ntry:\n    parsed = yaml.safe_load(text)\nexcept Exception:\n    sys.stderr.write(\"::error::pnpm-workspace.yaml does not parse as a mapping of settings; refusing to judge the audit-affecting settings without a parse\\n\")\n    sys.exit(1)\nif parsed is None:\n    parsed = {}\nif not isinstance(parsed, dict):\n    sys.stderr.write(\"::error::pnpm-workspace.yaml does not parse as a mapping of settings; refusing to judge the audit-affecting settings without a parse\\n\")\n    sys.exit(1)\nprojection = {}\nfor key in (\"auditConfig\", \"auditLevel\", \"registries\"):\n    if key in parsed:\n        projection[key] = parsed[key]\ntry:\n    dump = json.dumps(projection, sort_keys=True, separators=(\",\", \":\"))\nexcept (TypeError, ValueError):\n    sys.stderr.write(\"::error::pnpm-workspace.yaml carries audit-affecting settings that do not serialize to JSON; refusing\\n\")\n    sys.exit(1)\nsys.stdout.write(dump if projection else \"absent\")\nPY\n)\n\nnpmrc_pre_parse=$(cat <<'PY'\nimport json\nimport sys\n\ndata = sys.stdin.buffer.read()\nif 65536 < len(data):\n    sys.stderr.write(\"::error::pnpm-workspace.yaml and .npmrc are larger than the 65536-byte cap; refusing\\n\")\n    sys.exit(1)\nif b\"\\x00\" in data:\n    sys.stderr.write(\"::error::pnpm-workspace.yaml and .npmrc carry a NUL byte, which is invalid content wherever it sits; refusing\\n\")\n    sys.exit(1)\ntry:\n    text = data.decode(\"utf-8\")\nexcept UnicodeDecodeError:\n    sys.stderr.write(\"::error::pnpm-workspace.yaml and .npmrc are not valid UTF-8; refusing\\n\")\n    sys.exit(1)\nALLOWED = (\"audit-level\", \"registry\", \"strict-ssl\", \"cafile\", \"proxy\", \"https-proxy\")\nprojection = {}\nfor line in text.split(\"\\n\"):\n    stripped = line.strip()\n    if not stripped or stripped.startswith(\"#\") or stripped.startswith(\";\"):\n        continue\n    if \"=\" not in stripped:\n        sys.stderr.write(\"::error::.npmrc carries a line that is neither blank, a comment, nor key=value; refusing to judge its audit-affecting keys without a parse\\n\")\n        sys.exit(1)\n    key, _, value = stripped.partition(\"=\")\n    key = key.strip().lower()\n    value = value.strip()\n    if not key:\n        sys.stderr.write(\"::error::.npmrc carries a line that is neither blank, a comment, nor key=value; refusing to judge its audit-affecting keys without a parse\\n\")\n        sys.exit(1)\n    if key in ALLOWED:\n        projection[key] = value\nif projection:\n    sys.stdout.write(json.dumps(projection, sort_keys=True, separators=(\",\", \":\")))\nelse:\n    sys.stdout.write(\"absent\")\nPY\n)\n\n# The workspace parse needs PyYAML, and the runner image does not\n# ship it. The module is installed from the BASE's hash-pinned\n# manifest — the fetched FETCH_HEAD, read from git objects exactly\n# like the audited files, so a pull request can neither substitute\n# the manifest nor the wheel content (--require-hashes). Called only\n# when the two sides' pnpm-workspace.yaml blob ids differ; identical\n# trees skip the install (and its network round trip) entirely.\npyyaml_manifest_of() {\n  entries=$(git ls-tree \"${1:?}\" -- \"${manifest}\")\n  count=0\n  entry_mode=\"\"\n  entry_type=\"\"\n  entry_blob=\"\"\n  while IFS=$'\\t' read -r meta _path; do\n    [ -n \"${meta}\" ] || continue\n    count=$((count + 1))\n    entry_mode=${meta%% *}\n    rest=${meta#* }\n    entry_type=${rest%% *}\n    entry_blob=${rest#* }\n  done <<< \"${entries}\"\n  if [ \"${count}\" -eq 0 ]; then\n    echo \"::error::.github/requirements-pyyaml.txt is missing from the base; the workspace gate judges pnpm-workspace.yaml with a hash-pinned PyYAML install and refuses without it — the manifest moves only through a maintainer-reviewed merge, like the list it installs for\" >&2\n    exit 1\n  fi\n  if [ \"${count}\" -ne 1 ] || [ \"${entry_mode}\" != \"100644\" ] || [ \"${entry_type}\" != \"blob\" ]; then\n    echo \"::error::.github/requirements-pyyaml.txt must be exactly one mode-100644 blob entry in the base; refusing. The manifest is read from git objects, never from the filesystem — a pull request can neither substitute it nor hide it — so a symlink leaf, a wrong mode, a non-blob type and an absent file are all refused.\" >&2\n    exit 1\n  fi\n  printf '%s\\n' \"${entry_blob}\"\n}\n\n# Validates the manifest by the pin grammar (pyyaml==VERSION followed\n# by one to 32 --hash=sha256:HEX64 values) and writes the sanitized\n# copy pip installs from — no includes, index options, URL lines or\n# environment markers ever reach pip.\npyyaml_manifest_pre_parse=$(cat <<'PY'\nimport os\nimport re\nimport sys\n\ndata = sys.stdin.buffer.read()\nif 65536 < len(data):\n    sys.stderr.write(\"::error::the PyYAML manifest is larger than the 65536-byte cap; refusing\\n\")\n    sys.exit(1)\nif b\"\\x00\" in data:\n    sys.stderr.write(\"::error::the PyYAML manifest carries a NUL byte, which is invalid content wherever it sits; refusing\\n\")\n    sys.exit(1)\ntry:\n    text = data.decode(\"utf-8\")\nexcept UnicodeDecodeError:\n    sys.stderr.write(\"::error::the PyYAML manifest is not valid UTF-8; refusing\\n\")\n    sys.exit(1)\npin = re.compile(r\"pyyaml==[A-Za-z0-9][A-Za-z0-9._+-]*( --hash=sha256:[0-9a-f]{64}){1,32}\")\naccepted = None\nfor number, line in enumerate(text.split(\"\\n\"), start=1):\n    if line == \"\" or line.startswith(\"#\"):\n        continue\n    if accepted is not None:\n        sys.stderr.write(f\"::error::line {number}: the PyYAML manifest carries a second requirement line; exactly one is allowed\\n\")\n        sys.exit(1)\n    if pin.fullmatch(line) is None:\n        sys.stderr.write(f\"::error::line {number}: refused by the pin grammar — the one accepted shape is pyyaml==VERSION followed by one to 32 --hash=sha256:HEX64 values; includes, index options, URL lines, environment markers, CRLF and stray whitespace are refused\\n\")\n        sys.exit(1)\n    accepted = line\nif accepted is None:\n    sys.stderr.write(\"::error::the PyYAML manifest carries no requirement line; refusing\\n\")\n    sys.exit(1)\nwith open(os.environ[\"PYAML_SANITIZED_REQUIREMENTS\"], \"w\", encoding=\"utf-8\", newline=\"\\n\") as handle:\n    handle.write(accepted)\n    handle.write(\"\\n\")\nPY\n)\n\ninstall_pyyaml() {\n  manifest=.github/requirements-pyyaml.txt\n  pyyaml_manifest=$(pyyaml_manifest_of \"${1:?}\")\n  sanitized=\"${RUNNER_TEMP}/pyyaml-manifest-check\"\n  if [ -e \"${sanitized}\" ] || [ -L \"${sanitized}\" ]; then\n    echo \"::error::${sanitized} already exists; refusing to write the sanitized pin into a directory this run did not create\"\n    exit 1\n  fi\n  mkdir -- \"${sanitized}\"\n  git cat-file blob \"${pyyaml_manifest}\" | PYAML_SANITIZED_REQUIREMENTS=\"${sanitized}/requirements.txt\" python3 -c \"${pyyaml_manifest_pre_parse}\" || return 1\n  # pip writes its progress to stdout; this function's stdout is the\n  # site path the caller captures, so pip's own output is diverted to\n  # the step log — captured, it would ride inside PYTHONPATH and the\n  # import would fall back to the system module or fail.\n  pip install --no-deps --require-hashes --disable-pip-version-check --no-input --retries 2 --timeout 60 --target \"${sanitized}/site\" -r \"${sanitized}/requirements.txt\" 1>&2 || return 1\n  printf '%s\\n' \"${sanitized}/site\"\n}\n\nif ! git fetch --quiet --depth=1 origin \"${BASE_SHA:?}\"; then\n  echo \"::error::could not fetch the pull request's base commit; refusing to judge the suppression list without it\" >&2\n  exit 1\nfi\nbase_blob=$(blob_of FETCH_HEAD)\nmerge_blob=$(blob_of HEAD)\nbase_value=$(value_of \"${base_blob}\") || exit 1\nmerge_value=$(value_of \"${merge_blob}\") || exit 1\nif [ \"${base_value}\" != \"${merge_value}\" ]; then\n  echo \"::error::this pull request changes pnpm.auditConfig; a pull request cannot change the audit suppression list — the list moves only through a maintainer-reviewed merge\"\n  exit 1\nfi\nbase_ws=$(optional_entry_of FETCH_HEAD \"${ws_file}\")\nmerge_ws=$(optional_entry_of HEAD \"${ws_file}\")\nif [ \"${base_ws}\" != \"${merge_ws}\" ]; then\n  pyyaml_site=$(install_pyyaml FETCH_HEAD) || exit 1\n  base_ws_value=$(ws_value_of \"${base_ws}\") || exit 1\n  merge_ws_value=$(ws_value_of \"${merge_ws}\") || exit 1\n  if [ \"${base_ws_value}\" != \"${merge_ws_value}\" ]; then\n    echo \"::error::this pull request changes audit-affecting settings in pnpm-workspace.yaml; a pull request cannot change the audit suppression list — the list moves only through a maintainer-reviewed merge\"\n    exit 1\n  fi\nfi\n\nbase_npmrc=$(optional_entry_of FETCH_HEAD \"${npmrc_file}\")\nmerge_npmrc=$(optional_entry_of HEAD \"${npmrc_file}\")\nif [ \"${base_npmrc}\" != \"${merge_npmrc}\" ]; then\n  base_npmrc_value=$(npmrc_value_of \"${base_npmrc}\") || exit 1\n  merge_npmrc_value=$(npmrc_value_of \"${merge_npmrc}\") || exit 1\n  if [ \"${base_npmrc_value}\" != \"${merge_npmrc_value}\" ]; then\n    echo \"::error::this pull request changes audit-affecting keys in .npmrc; a pull request cannot change the audit suppression list — the list moves only through a maintainer-reviewed merge\"\n    exit 1\n  fi\nfi\n",
        },
        {
          uses: expect.stringMatching(/^actions\/setup-node@/),
          with: { "node-version": expect.any(String) },
        },
        {
          name: "Enable the pinned package manager",
          run: expect.stringMatching(/^corepack enable\ncorepack install --global pnpm@\d+\.\d+\.\d+\npnpm --version\n$/),
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
    expect(codeqlTrio).toEqual([
      "github/codeql-action/analyze",
      "github/codeql-action/init",
      "github/codeql-action/upload-sarif",
    ]);
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
    // Both actionlint files. Issue 1090 split the gate in two and each leg
    // installs its own copy of zizmor, so pinning one leg's install left the
    // other installing from wherever it liked — a hash-free `pip install
    // zizmor` in the leg nobody read.
    for (const file of ["actionlint-pr.yml", "actionlint.yml"]) {
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
      // The id is load-bearing: the zizmor step's condition skips the scan only
      // when the install failed. The scan targets the extracted PR copies as
      // explicit globbed FILE inputs (.github/workflows-pr/*.yml) — zizmor's
      // directory input only collects a repo root or a path ending in
      // .github/workflows, so the bare directory exits 3 "no inputs collected"
      // (fix round 2, finding C) — and never the checked-out tree's own
      // workflows.
      const zizmor = steps.find((step) => step.run === "zizmor --no-progress .github/workflows-pr/*.yml");
      expect(zizmor, `${file} must run zizmor over the extracted workflow copies`).toBeDefined();
      expect(zizmor!.if).toBe("${{ !cancelled() && steps.install_zizmor.outcome == 'success' }}");
    }
  });

  // zizmor's ref-version-mismatch audit is the mechanism that catches a pin's
  // version comment going stale after a bump — but only once the comment is
  // THERE. Measured against zizmor 1.30.1 at the gate's own invocation: a pin
  // with no version comment is reported at `help` severity, which falls below
  // the `regular` persona floor the gate runs under and exits 0; the same pin
  // carrying a STALE comment is reported at `warning` and exits 13. So the
  // annotation is what puts a pin under that audit, and dropping it is silent —
  // the state issue 1022 found for Nitjsefnie-Actions/pr-gate. Nothing here
  // asserts the annotation any more: fleet-rules, "Merging and CI" reads no
  // release or version comment out of a workflow, so the comment half is left
  // to zizmor — whose missing-comment arm sits BELOW the gate's persona floor,
  // a recorded gap rather than a held property. What remains compares two ways
  // of FINDING a pin, reading the raw text because a YAML parse drops the
  // comment, and it does not assert which release any comment names.
  //
  // Three ways that went wrong the first time round, all of them silent, so the
  // shape below is load-bearing rather than incidental:
  //
  //  - `owner/repo/subpath` is a real shape and this tree uses it three times
  //    (github/codeql-action/init, /analyze, /upload-sarif). A selector written
  //    `[\w.-]+\/[\w.-]+` cannot match two path segments, so all three were
  //    invisible to this case AND to zizmor, whose missing-comment arm is
  //    help-severity and suppressed under the gate's persona. `(?:\/[\w.-]+)*`
  //    takes any number of further segments; a spelling-independent sweep
  //    (detect a pin by `uses:` + an `@` + 40 hex, never by its path shape) puts
  //    the tree at 33 real pins, 33 matched.
  //  - The liveness guard counts PINS, not workflow FILES. A selector that
  //    silently matches nothing sits between the two, and a file-count guard
  //    stays green across that. Rotting `{40}` to `{39}` — one character — used
  //    to pass with a version comment deleted.
  //  - The comment shape WAS anchored to digits. `#\s*v\S+` is satisfied by
  //    `# verify against the action docs`, which zizmor does NOT back up: it
  //    treats any present comment as annotated, so the instrument was widened
  //    to zizmor's own `v\d+\.\d+\.\d+` shape. Both comment-shape arms left
  //    with the annotation assertion (fleet-rules, "Merging and CI"): no
  //    instrument here reads the comment any more.
  //
  // A fourth hole, of a different kind, was left open by that fix round: the
  // guard above proves the pin list is NON-EMPTY, and the property this case is
  // named for is that the two lists are IDENTICAL. `> 0` cannot tell those apart, and a
  // selector that quietly narrows stays green — which is exactly the state the
  // case shipped in for one commit. A number would close it and rot on every
  // dependency bump. So the coverage is asserted by COMPARING TWO INSTRUMENTS
  // instead of quoting a constant: `shapeFree` encodes no path shape at all, so
  // it cannot inherit `pin`'s blind spot, and the two sets are compared for
  // equality. Neither side is a literal, so adding or removing a pin moves both
  // and the assertion holds; narrowing one side only is the defect, and the diff
  // names every pin the selector lost or invented.
  it("agrees with the shape-free sweep on every SHA-pinned action reference", async () => {
    const workflows = (await readdir(resolve(".github/workflows")))
      .filter((name) => name.endsWith(".yml"));

    // `^\s*(?:-\s+)?uses:` in BOTH, not `\buses:`. `\b` matches mid-line, so a
    // commented-out step (`# - uses: owner/repo@<sha>`) was read as a live pin by
    // both instruments — a false red in a required check, reachable by
    // commenting out a disabled step, which is ordinary.
    // Anchoring to the step start also closes the flow-mapping-with-comment form.
    // Measured over every form recorded in any round of this case, the anchor
    // changes exactly four dispositions, all `both` → `neither`, and creates no
    // form that one instrument sees and the other does not.
    const pin = /^\s*(?:-\s+)?uses:\s*[\w.-]+(?:\/[\w.-]+)*@[0-9a-f]{40}\s*(#.*)?$/;
    // Same population, derived without reference to a path SHAPE: `uses:`, a
    // non-space run, an `@`, and 40 hex digits. It carries `pin`'s OWN terminator
    // `\s*(#.*)?$` on purpose, so the two differ in exactly one place — the
    // owner/repo/subpath form, which is the axis under test. A looser terminator
    // was tried first and is wrong: `(?![0-9a-f])` excludes a 41st hex digit but
    // admits a trailing letter, a dot, an `-rc1` suffix and a quoted ref inside
    // a `run:` block — 14 disagreements with `pin` over the adversarial forms
    // measured for this case.
    //
    // The one thing it does NOT encode is a ref SCHEME, and the exclusion is
    // narrower than it first reads: `[a-z][a-z0-9+.-]*://` is lowercase-only and
    // needs two slashes, so it drops `docker://…` and not `DOCKER://…`, `Docker://…`
    // or `docker:/…`. What it buys is that a container ref is not treated as an
    // action pin: such a value carries no version tag and is not an action
    // reference at all. Note a REAL container digest is
    // `docker://img@sha256:<64hex>`, which `{40}` never matched and the lookahead
    // now drops outright — the form the exclusion actually reaches is the bare
    // `@<40hex>` after a scheme, which is not a value GitHub accepts.
    const shapeFree = /^\s*(?:-\s+)?uses:\s*(?![a-z][a-z0-9+.-]*:\/\/)\S+@[0-9a-f]{40}\s*(#.*)?$/;
    const matched: string[] = [];
    const population: string[] = [];

    for (const name of workflows) {
      const source = await readFile(resolve(".github/workflows", name), "utf8");
      // `\r?\n`, not `\n`: a CRLF file would leave a trailing \r that both regexes
      // reject, and both sets would lose the same pins together — a coverage check
      // reporting that nothing was lost while four real pins dropped out.
      for (const [index, line] of source.split(/\r?\n/).entries()) {
        const where = `${name}:${index + 1}`;
        if (shapeFree.test(line)) population.push(where);
        const hit = pin.exec(line);
        if (!hit) continue;
        matched.push(where);
      }
    }

    // What these two assertions do and do not establish, since the previous
    // round's note claimed both directions and only had one:
    //
    //  - `pin`'s set is a SUBSET of `shapeFree`'s, structurally: everything
    //    `[\w.-]+(?:\/[\w.-]+)*` matches is non-space, so `\S+` matches it too,
    //    and the terminators are shared. So `pin` cannot invent a pin, and the
    //    equality below can only ever fail through `population \ matched`.
    //    That containment is a PROPERTY, not a licence: it does not by itself
    //    say the detector is right about what it matched.
    //  - It is why the equality and a one-sided `population \ matched == []` are
    //    the SAME test here, not two grades of strictness — measured over the
    //    adversarial forms, they disagreed on 0 cases. So narrowing the assertion
    //    to the "covered" direction was tried and discarded: it closed nothing,
    //    because the false red this case was fixing lives in the detector
    //    matching something that is not a pin, not in the comparison's strictness.
    //  - What is NOT established. Below is a SAMPLE of forms measured against these
    //    two regexes, not a census of them: an earlier version of this comment
    //    called the list a census, and measuring showed that was false. Three
    //    directions, all open:
    //
    //    (a) Forms NEITHER regex matches. The pins leave both sets together and
    //        nothing here can see them. Measured examples: a `uses:` inside a
    //        comment or prose (the anchor), a `- {uses: …}` flow mapping with or
    //        without a comment, a `docker://img@sha256:<64hex>` container
    //        digest, an `&anchor` on the value, a folded `>-`, and a `.yaml`
    //        workflow file (filtered out at the `readdir`). CRLF is NOT in this
    //        list: the `split(/\r?\n/)` above already covers it.
    //        REACHABLE AND SILENT, and the reason the sample matters: a QUOTED
    //        scalar — `- uses: "owner/repo@<40hex>"` — is legal YAML, matches
    //        neither regex, and a workflow holding only unannotated quoted or
    //        uppercase pins leaves this case green while reporting full
    //        coverage. That is the exact failure this case exists to prevent,
    //        still open, and not fixed here.
    //
    //    (b) Forms `shapeFree` accepts and `pin` rejects — DETECTOR-ONLY. On
    //        any of these the equality fails, naming a pin `pin` cannot read.
    //        Naming the five I happened to try is worse than naming the class:
    //        sweeping every printable ASCII character into a subpath segment
    //        leaves the two disagreeing on TWENTY-EIGHT of them —
    //        `!"#$%&'()*+,:;<=>?@[\]^`{|}~` — because each is outside `[\w.-]`
    //        while `\S+` accepts it. Plus any scheme that is not
    //        lowercase-with-`//` (`DOCKER://`, `Docker://`, `docker:/`). None is
    //        a form GitHub's syntax reference documents or shows an example of;
    //        that reference gives no character grammar for a path segment, so
    //        this is "undocumented", not "impossible", and a red on one of them
    //        is the DETECTOR talking rather than a pin that lost its comment.
    //
    //    (c) A form BOTH regexes read as an action pin: GitHub documents
    //        `{owner}/{repo}/.github/workflows/{filename}@{ref}`, and a SHA ref
    //        matches here. Whether a reusable-workflow call should carry a
    //        version comment is a policy no assertion here states (the
    //        annotation arm left with fleet-rules, "Merging and CI"); zizmor
    //        1.30.1 at `--persona=pedantic` reports no finding on such a line
    //        even with a deliberately wrong version, so nothing else settles
    //        it. If one appears here without a comment, no assertion here
    //        reds it either — the gap is open and recorded here.
    //
    //    These are recorded limits, not closed routes, and the sample is not the
    //    full set of either class. No assertion here pretends otherwise.
    //
    // Liveness first: a selector matching nothing is a better message than a
    // 33-element diff, and the equality cannot fire when both sets are empty.
    expect(matched.length).toBeGreaterThan(0);
    expect(matched).toEqual(population);
  });

  it("hash-pins every artifact in the zizmor requirements file", async () => {
    const text = await readFile(resolve(".github/requirements-zizmor.txt"), "utf8");
    const requirements = text.split("\n").filter((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith("#");
    });

    expect(requirements.length).toBeGreaterThan(0);
    for (const line of requirements) {
      expect(line).toContain("--hash=sha256:");
    }
    // Floor for the all-platform shape the file header claims: a
    // regeneration that collapsed the pin to a single artifact's hash (one
    // wheel) must fail here instead of silently narrowing both the platforms
    // the install resolves on and the pin's tamper-resistance.
    const hashes = new Set(
      requirements.flatMap((line) =>
        [...line.matchAll(/--hash=sha256:([0-9a-f]+)/g)].map((match) => match[1]),
      ),
    );
    expect(hashes.size).toBeGreaterThanOrEqual(2);
    const zizmor = requirements.find((line) => line.startsWith("zizmor=="));
    expect(zizmor).toBeDefined();
    // A version FLOOR, not the exact version (issue 1091). An exact literal
    // made this test the reason Dependabot's own zizmor bump could not pass:
    // every arrival reds here until a human rewrites the string, so the lane
    // that keeps the pin fresh is also the lane that blocks it. The floor is
    // 1.30.0, the release that added the self-repository audit — below it the
    // gate runs an audit set that no longer matches the pinned tool.
    //
    // Compared as three NUMBERS, never as strings: "1.9.0" sorts above
    // "1.30.0" lexically, so a string compare would admit a pin the floor
    // exists to reject. Encoded as major*1e6 + minor*1e3 + patch, which orders
    // correctly while minor and patch are each below 1000 — the bound this
    // encoding needs, stated rather than implied. No prerelease tag resolves
    // through the regex below at all (see the parse-failure message), so the
    // only way past 1000 is a release nobody has cut; a version that large
    // would misorder silently, and the floor is a policy number here, not a
    // general semver comparator. Tightening the claim, not the code: the
    // alternative is a lexicographic compare of zero-padded parts, which buys a
    // total order no release on PyPI needs.
    // Report the version the manifest actually names, not `${zizmor}`: the pin
    // line carries every hash on one line, so interpolating it would dump ~700
    // characters of `--hash=sha256:` into a failure message whose reader needs
    // one fact — which version failed to parse.
    const named = /^zizmor==(\S+)/.exec(zizmor!)?.[1] ?? "(no zizmor== pin)";
    const pinned = /^zizmor==(\d+)\.(\d+)\.(\d+)\b/.exec(zizmor!);
    // A prerelease or any other non-plain pin is a POLICY statement, not a
    // parse accident: this manifest pins a release, and `--require-hashes`
    // installs resolve releases, so say that rather than reporting a null
    // capture the reader has to interpret.
    expect(
      pinned,
      `the zizmor pin must be a plain release, major.minor.patch: the manifest pins ${named}. ` +
        `This manifest exists to install one hash-pinned release for the actionlint gate, ` +
        `and the hashes beside it are that release's — a prerelease or a range would ` +
        `desynchronise the two. See the header's regeneration recipe.`,
    ).not.toBeNull();
    const [major, minor, patch] = pinned!.slice(1, 4).map(Number);
    expect(
      major * 1_000_000 + minor * 1_000 + patch,
      `the zizmor pin is ${major}.${minor}.${patch}, below the 1.30.0 floor`,
    ).toBeGreaterThanOrEqual(1_000_000 + 30 * 1_000);
    // Tracked: the deny-by-default policy must name this exact file back,
    // while other .github/*.txt (the junk counterexamples) stay ignored.
    expect(checkIgnore(".github/requirements-zizmor.txt")).toBe(1);
    expect(checkIgnore(".github/junk.txt")).toBe(0);
  });

  it("hash-pins every artifact in the PyYAML requirements file", async () => {
    // The suppression gate's workspace parse installs PyYAML from this
    // manifest at run time (the runner image does not ship it), read from the
    // pull request's BASE via git objects — the zizmor manifest's discipline.
    // The pin is the same shape: every non-comment line carries --hash, the
    // pin is a plain release at or above 6.0.0 (the first 6.x line; a floor
    // rather than an exact literal, so Dependabot's own bump can pass), and
    // the file is tracked.
    const text = await readFile(resolve(".github/requirements-pyyaml.txt"), "utf8");
    const requirements = text.split("\n").filter((line) => {
      const trimmed = line.trim();
      return trimmed !== "" && !trimmed.startsWith("#");
    });

    expect(requirements.length).toBeGreaterThan(0);
    for (const line of requirements) {
      expect(line).toContain("--hash=sha256:");
    }
    // The runner wheel AND the sdist at minimum: a regeneration that collapsed
    // the pin to one artifact must fail here instead of silently narrowing the
    // interpreters the install resolves on.
    const hashes = new Set(
      requirements.flatMap((line) =>
        [...line.matchAll(/--hash=sha256:([0-9a-f]+)/g)].map((match) => match[1]),
      ),
    );
    expect(hashes.size).toBeGreaterThanOrEqual(2);
    // The runner's interpreter is CPython 3.12 on x86_64 (ubuntu-latest): the
    // cp312 manylinux wheel must be among the pinned hashes, or every runner
    // install builds the sdist from source.
    const named = /^pyyaml==(\S+)/.exec(requirements.find((line) => line.startsWith("pyyaml=="))!)?.[1] ?? "(no pyyaml== pin)";
    const pinned = /^pyyaml==(\d+)\.(\d+)\.(\d+)\b/.exec(requirements.find((line) => line.startsWith("pyyaml=="))!);
    expect(
      pinned,
      `the pyyaml pin must be a plain release, major.minor.patch: the manifest pins ${named}. ` +
        `This manifest exists to install one hash-pinned release for the suppression gate's ` +
        `workspace parse, and the hashes beside it are that release's — a prerelease or a ` +
        `range would desynchronise the two. See the header's regeneration recipe.`,
    ).not.toBeNull();
    const [major, minor, patch] = pinned!.slice(1, 4).map(Number);
    expect(
      major * 1_000_000 + minor * 1_000 + patch,
      `the pyyaml pin is ${major}.${minor}.${patch}, below the 6.0.0 floor`,
    ).toBeGreaterThanOrEqual(6_000_000);
    // Tracked, like its zizmor sibling.
    expect(checkIgnore(".github/requirements-pyyaml.txt")).toBe(1);
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
    expect(checkIgnore(".github/workflows/actionlint-pr.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/ci-pr.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/ratchet-guard-pr.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/secret-scan-pr.yml")).toBe(1);
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
      group: "code-scanning-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
      "cancel-in-progress": false,
    });

    const analyze = workflow.jobs.analyze! as typeof workflow.jobs.analyze & {
      permissions: Record<string, string>;
      strategy: {
        "fail-fast": boolean;
        matrix: { language: string[] };
      };
    };
    // The whole job, exactly: the job-level permissions object is the least
    // privilege uploading SARIF needs, and any extra key — a tolerated
    // failure, a checkout without persist-credentials disabled — fails this
    // equality.
    expect(analyze).toEqual({
      permissions: { contents: "read", "security-events": "write" },
      strategy: {
        "fail-fast": false,
        matrix: { language: ["javascript-typescript", "actions"] },
      },
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 30,
      steps: [
        {
          uses: expect.stringMatching(/^actions\/checkout@/),
          with: { "persist-credentials": false },
        },
        {
          uses: expect.stringMatching(/^github\/codeql-action\/init@/),
          with: {
            languages: "${{ matrix.language }}",
            "config-file": ".github/codeql-config.yml",
            queries: "security-extended",
          },
        },
        {
          uses: expect.stringMatching(/^github\/codeql-action\/analyze@/),
          with: { category: "/language:${{ matrix.language }}" },
        },
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

    // The steps that run an action — the population the SET below reads —
    // with a liveness guard first, so a workflow that runs no action at all
    // is a named failure rather than an empty equality.
    const used = analysis.steps.filter((step) => step.uses);
    expect(used.length, "scorecard.yml must run at least one action").toBeGreaterThan(0);

    // The SET, not only the count. Every assertion above this point reads
    // structure — triggers, guards, permissions, the step count — so a swap
    // of `ossf/scorecard-action` for a different action sails past all of
    // them and the workflow still runs weekly and concludes green while
    // measuring something else; the membership below names the substitution.
    expect(used.map((step) => step.uses!.replace(/@[0-9a-f]{40}$/, "@")).sort()).toEqual([
      "actions/checkout@",
      "actions/upload-artifact@",
      "github/codeql-action/upload-sarif@",
      "ossf/scorecard-action@",
    ]);

    // The checkout leaves no credential on the runner. The analysis only reads
    // the tree, and a persisted token beside a third-party action is a
    // credential the workflow has no reason to hold.
    const checkout = analysis.steps.find((step) => step.uses!.startsWith("actions/checkout@"))!;
    expect(checkout.with).toEqual({ "persist-credentials": false });

    // The three inputs that decide whether the run produces anything at all.
    // A run that wrote no SARIF uploads nothing, so the Security tab stays
    // empty while every run is green.
    const scorecard = analysis.steps.find((step) => step.uses!.startsWith("ossf/scorecard-action@"))!;
    expect(scorecard.with).toEqual({
      results_file: "results.sarif",
      results_format: "sarif",
      publish_results: true,
    });

    // A hung analysis holds a runner and concludes nothing, so the job must
    // carry the bound the reference ships.
    expect(
      analysis["timeout-minutes"],
      "scorecard.yml's job must bound its own runtime, or a hung analysis holds a runner and " +
        "concludes nothing at all",
    ).toBe(15);

    // The whole job, exactly, in the dependency-audit style: the equality is
    // what fails on a step added, removed or reordered, and on an extra
    // permission key the named assertions above would tolerate.
    expect(analysis).toEqual({
      name: "Scorecard analysis",
      if: "${{ !github.event.repository.fork && github.ref == format('refs/heads/{0}', github.event.repository.default_branch) }}",
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 15,
      permissions: { "security-events": "write", "id-token": "write", contents: "read" },
      steps: [
        {
          name: "Checkout code",
          uses: expect.stringMatching(/^actions\/checkout@/),
          with: { "persist-credentials": false },
        },
        {
          name: "Run Scorecard analysis",
          uses: expect.stringMatching(/^ossf\/scorecard-action@/),
          with: { results_file: "results.sarif", results_format: "sarif", publish_results: true },
        },
        {
          name: "Upload Scorecard results artifact",
          uses: expect.stringMatching(/^actions\/upload-artifact@/),
          with: { name: "scorecard-results", path: "results.sarif", "retention-days": 5 },
        },
        {
          name: "Upload Scorecard results to code scanning",
          uses: expect.stringMatching(/^github\/codeql-action\/upload-sarif@/),
          with: { sarif_file: "results.sarif" },
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

    // A trend signal, not a gate. Asserted against the parsed pins, not the
    // prose: a required check naming this workflow would block every pull
    // request on a weekly measurement that is allowed to be flat.
    //
    // The check name GitHub posts for a job is the job's `name:` when set, else
    // its id — which is exactly how tests/ci/required-checks.test.ts resolves
    // producers. So the spellings that could actually appear in this file are
    // derived from the workflow rather than hardcoded: this workflow's own name
    // (the altitude slip) and the analysis job's real check-run name (the
    // realistic promotion). An earlier version of this clause tested only
    // `check === "scorecard"`, which could never fire, because the spelling a
    // human writes when promoting this workflow is the job's name and not the
    // file's — the file clause was carrying the whole guard alone. The path
    // clause still does most of the work and still stays.
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
