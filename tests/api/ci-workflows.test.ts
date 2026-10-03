import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
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

// The exact-value pins below are CONSISTENCY checks, not correctness checks: they
// prove the tree still says what it said, not that the value is the right one.
// Substituting a well-shaped wrong SHA at every site at once leaves this file
// green, because proving that a pin names the real upstream fork would need a
// network fetch that a suite reading the tree does not make. The `uses` shape
// checks and the pre-filter guards are correctness checks and do go red on a
// wrong value. Read a green run as "nothing drifted", never as "this pin is the
// right fork".

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
        permissions: { issues: "write" },
        steps: [{
          uses: "Nitjsefnie-Actions/claim@8abff4f2f27d59b984528cb736f64b9391952a25",
          with: {
            "max-claims": "read=2, triage=4, write=6, maintain=10, admin=-1",
            expire: "7",
          },
        }],
      },
    });
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
    expect(job.permissions).toEqual({ issues: "write" });
  });

  it("checks admission through the reviewed shared action without a consumer checkout", async () => {
    const workflow = await readWorkflow("pr-gate.yml");
    expect(workflow.on).toEqual({ pull_request_target: { types: ["opened", "edited", "reopened"] } });
    expect(workflow.permissions).toEqual({ contents: "read", "pull-requests": "write", issues: "read" });
    expect(workflow.concurrency).toEqual({
      group: "pr-gate-${{ github.event.pull_request.number }}",
      "cancel-in-progress": false,
    });
    expect(workflow.jobs).toEqual({
      gate: {
        if: "github.event.pull_request.user.type != 'Bot'",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 5,
        steps: [{
          uses: "Nitjsefnie-Actions/pr-gate@679744b0807472d5fd681e42759f081494f2f562",
          with: {
            "github-token": "${{ github.token }}",
            repository: "${{ github.repository }}",
            "pull-request-number": "${{ github.event.pull_request.number }}",
            "pull-request-author": "${{ github.event.pull_request.user.login }}",
          },
        }],
      },
    });
  });

  it("judges the pull request head only as git data, executed entirely from main", async () => {
    const workflow = await readWorkflow("ratchet-guard.yml");
    // pull_request_target keeps the gate alive when a pull request disables
    // a workflow's own pull_request run: the workflow definition, the
    // checkout and the script that executes all come from main — ci.yml's
    // PR leg fires pull_request_target since issue 822, so the ci run can
    // no longer be silenced that way. `branches: [main]` keeps a PR
    // retargeted to main (an edited event, which gets no new run) from
    // carrying its stale green over. push covers the commits main itself
    // lands: the repo merges with --rebase, so a merged SHA is a brand-new
    // commit no pull_request run covered, and every push to main must carry
    // a ratchet-guard run for the check to be required and for the deploy
    // gate (scripts/deploy-revision.sh) to pass on the tip it lands. No
    // paths filter: a push without one of the compared files still needs its
    // own run, or deploys of the tip it lands hang on `(absent)`. Dispatch
    // recovers a main tip when the push event launched no runs (issue 796).
    expect(workflow.on).toEqual({
      push: { branches: ["main"] },
      pull_request_target: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
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
    // push its own group; every pull request shares one repository-level
    // group, so the repository's Actions minutes stop scaling with the number
    // of open pull requests. cancel-in-progress is the literal false on every
    // leg because that group is shared by every pull request and this job is a
    // required context — see ci.yml's concurrency block for the argument.
    expect(workflow.concurrency).toEqual({
      group: "ratchet-guard-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
      "cancel-in-progress": false,
    });
    // The whole job, exactly, in the dependency-audit style. Three checkouts,
    // each gated on the event name: under pull_request_target the checkout
    // has no ref input at all — actions/checkout's default, main's last
    // commit, the checkout its fork guard exempts; under push its ref is
    // github.event.before, the previous main tip, whose copy of
    // scripts/check-ratchets.ts executes. Splitting the steps on the event
    // name keeps each checkout's ref visible without evaluating an
    // expression: the pull_request_target step has no ref input at all, so
    // it is visibly the default checkout (main's tip, exempt from
    // checkout's fork guard), and the push step visibly pins the previous
    // main tip. Dispatch takes the last certified main tip as input, validates
    // its format before checkout, then fetches the dispatched tip and checks
    // ancestry before setup-node can probe checkout-controlled Yarn files.
    // On a push GitHub always sets `before` to a 40-hex SHA. No step installs
    // or builds anything. The PR head and pushed tip enter only as git
    // objects; dispatch checks out the candidate base but runs only git
    // commands until it proves main ancestry. The ratchet script then comes
    // from the trusted checked-out base and reads the target with `git show`.
    // The base of the comparison is the
    // checked-out commit itself (HEAD) under all three events, never the event's
    // base.sha: under pull_request_target that value is recorded when the
    // pull request opens and can trail main, and after a rebase onto a newer
    // main the merge base of the stale base and the head sits below the real
    // fork point, so a real relaxation would pass against the looser
    // document there. Under push the checked-out previous tip is, for a
    // non-forced push, a direct ancestor of the pushed SHA, so the merge
    // base is the previous tip
    // itself and the comparison is exactly "did this push relax a ratchet
    // document relative to the main it replaced". Dispatch judges the
    // interval from the last certified tip to main's tip as one endpoint
    // change, like a multi-commit push. It is coarser than separate push
    // runs when consecutive pushes were dropped: an intermediate relaxation
    // later re-tightened past the base is not flagged. Every event value
    // travels through env, never ${{ }} in run:.
    expect(workflow.jobs).toEqual({
      "ratchet-guard": {
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 10,
        steps: [
          {
            name: "Refuse unhandled events",
            run: `if [[ "$GITHUB_EVENT_NAME" != "pull_request_target" && "$GITHUB_EVENT_NAME" != "push" && "$GITHUB_EVENT_NAME" != "workflow_dispatch" ]]; then
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
            if: "${{ github.event_name == 'pull_request_target' }}",
            uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            with: {
              "persist-credentials": false,
              "fetch-depth": 0,
            },
          },
          {
            if: "${{ github.event_name == 'push' }}",
            uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
            with: {
              ref: "${{ github.event.before }}",
              "persist-credentials": false,
              "fetch-depth": 0,
            },
          },
          {
            if: "${{ github.event_name == 'workflow_dispatch' }}",
            uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
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
            uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
            with: { "node-version": "24.17.0" },
          },
          {
            if: "${{ github.event_name == 'pull_request_target' }}",
            name: "Fetch the pull request head",
            env: { PR_NUMBER: "${{ github.event.pull_request.number }}" },
            run: 'git fetch --no-tags origin "+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/head"',
          },
          {
            if: "${{ github.event_name == 'pull_request_target' }}",
            name: "Ratchet documents",
            env: { HEAD_SHA: "${{ github.event.pull_request.head.sha }}" },
            run: 'node scripts/check-ratchets.ts HEAD "$HEAD_SHA"',
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
    const workflow = await readWorkflow("ratchet-guard.yml");
    const guard = workflow.jobs["ratchet-guard"]!.steps[0]!.run!;
    const unknown = spawnSync("bash", ["-e", "-c", guard], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: "schedule" },
    });
    expect(unknown.status).toBe(1);
    expect(unknown.stdout).toContain("::error::Unhandled ratchet-guard event: schedule");

    const push = spawnSync("bash", ["-e", "-c", guard], {
      encoding: "utf8",
      env: { ...process.env, GITHUB_EVENT_NAME: "push" },
    });
    expect(push.status).toBe(0);
  });

  it("parses a complete PostgreSQL 17 gate with pinned actions and every release command", async () => {
    const workflow = await readWorkflow("ci.yml");
    const manifest = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      packageManager?: string;
      engines?: Record<string, string>;
    };
    expect(manifest).toMatchObject({
      packageManager: "pnpm@10.33.0",
      engines: { node: "24.17.0", pnpm: "10.33.0" },
    });
    expect(workflow.on).toEqual(expect.objectContaining({
      push: { branches: ["main"] },
      // pull_request_target executes main's workflow definition, so a pull
      // request that edits its own ci.yml cannot shape the job that judges it
      // (issue 822). Same trigger shape as ratchet-guard.yml.
      pull_request_target: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
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
            description: "calibrate self-test: fabricate a coverage raise so the push is refused by branch protection and the job fails visibly (issue 684)",
            type: "boolean",
            default: false,
          },
        },
      },
    }));
    expect(workflow.on.push).not.toHaveProperty("paths");
    expect(workflow.on.pull_request_target).not.toHaveProperty("paths");
    // The migration's whole point: no pull_request trigger beside
    // pull_request_target. objectContaining tolerates a re-added trigger, so
    // the absence is pinned on its own — a re-add silently reopens the hole
    // this branch closes (final-review mutant M1).
    expect(workflow.on).not.toHaveProperty("pull_request");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "ci-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
      "cancel-in-progress": false,
    });

    const verify = workflow.jobs.verify!;
    expect(verify.services?.postgres?.image).toBe("postgres:17@sha256:67f41722b7a8cbdb868a44a4995c846eddfdc2973bccb291ce937dce88ad5675");
    expect(verify.services?.postgres?.options).toContain("pg_isready");
    expect(verify.steps.filter((step) => step.uses).every((step) => /@[0-9a-f]{40}$/.test(step.uses!))).toBe(true);
    // Keep the reviewed artifact actions exact across jobs: verify uploads
    // the pair, then the calibration job downloads the summary. The generic
    // SHA-format check above would accept a different, valid pin.
    const ciSteps = Object.values(workflow.jobs).flatMap((job) => job.steps);
    const uploadPins = ciSteps
      .filter((step) =>
        step.uses?.startsWith("actions/upload-artifact@"))
      .map((step) => step.uses);
    expect(uploadPins).toEqual([
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
    ]);
    expect(ciSteps
      .filter((step) => step.uses?.startsWith("actions/download-artifact@"))
      .map((step) => step.uses)).toEqual([
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    ]);
    // Exactly two checkouts, each gated to its event. Under pull_request_target
    // the merge-ref checkout tests the pull request's change (persist-
    // credentials: false is what actions/checkout's fork guard requires before
    // it admits a PR ref); under push and workflow_dispatch the plain default
    // checkout takes the event's own commit — an unconditional ref built from
    // github.event.pull_request.number resolves null there and broke the
    // push and dispatch legs (fix round 1, finding A).
    const verifyCheckouts = verify.steps.filter((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );
    expect(verifyCheckouts, "the verify job must keep exactly two checkouts").toHaveLength(2);
    expect(verifyCheckouts[0]).toEqual({
      if: "${{ github.event_name == 'pull_request_target' }}",
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: {
        ref: "refs/pull/${{ github.event.pull_request.number }}/merge",
        "persist-credentials": false,
      },
    });
    expect(verifyCheckouts[1]).toEqual({
      if: "${{ github.event_name != 'pull_request_target' }}",
      uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      with: { "persist-credentials": false },
    });
    expect(verify.steps.find((step) => step.uses?.startsWith("actions/setup-node@"))?.with)
      .toEqual(expect.objectContaining({ "node-version": "24.17.0" }));
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

  it("parses a catalogue-style workflow gate with explicit least privilege and pinned actions", async () => {
    const workflow = await readWorkflow("actionlint.yml");
    // pull_request_target executes main's definition and main's tools; the
    // pull request head enters only as git objects extracted with `git show`
    // (issue 822). Same trigger shape as ratchet-guard.yml.
    expect(workflow.on).toEqual(expect.objectContaining({
      push: { branches: ["main"] },
      pull_request_target: { branches: ["main"], types: ["opened", "synchronize", "reopened"] },
      workflow_dispatch: null,
    }));
    expect(workflow.on.push).not.toHaveProperty("paths");
    expect(workflow.on.pull_request_target).not.toHaveProperty("paths");
    // Same RE-ADD guard as the ci.yml pin: objectContaining tolerates a
    // pull_request trigger beside pull_request_target, so the absence is
    // pinned on its own (final-review mutant M1).
    expect(workflow.on).not.toHaveProperty("pull_request");
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "actionlint-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}",
      "cancel-in-progress": false,
    });
    const steps = workflow.jobs.actionlint!.steps;
    expect(steps.filter((step) => step.uses).every((step) => /@[0-9a-f]{40}$/.test(step.uses!))).toBe(true);
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
        // fork's own tarball.
        ACTIONLINT_REPO: "Nitjsefnie-OSC/actionlint",
        ACTIONLINT_VERSION: "1.7.12-queue.1",
        ACTIONLINT_SHA256: "dcc2c42a7caaa197dfe63584a3851f62ef260f80b2cf221baaf05479661e1521",
      },
      steps: [
        {
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: { "persist-credentials": false },
        },
        {
          name: "Fetch the pull request head",
          if: "${{ github.event_name == 'pull_request_target' }}",
          env: { PR_NUMBER: "${{ github.event.pull_request.number }}" },
          run: 'git fetch --no-tags origin "+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/head"',
        },
        {
          uses: "actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97",
          with: { "python-version": "3.13" },
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
if [ "\${GITHUB_EVENT_NAME}" = pull_request_target ]; then
  git ls-tree -z --name-only refs/remotes/pr/head:.github/workflows/ |
    while IFS= read -r -d '' f; do
      git show "refs/remotes/pr/head:.github/workflows/$f" > ".github/workflows-pr/$f"
    done
else
  cp .github/workflows/*.yml .github/workflows-pr/
fi
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
          if: "${{ github.event_name == 'pull_request_target' }}",
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

  it("parses a scheduled lockfile audit whose gate is the bare audit command's exit code", async () => {
    const workflow = await readWorkflow("dependency-audit.yml");
    expect(workflow.on).toEqual({
      schedule: [{ cron: "37 6 * * 1" }],
      workflow_dispatch: null,
    });
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "dependency-audit-${{ github.event.pull_request.number || github.ref }}",
      "cancel-in-progress": "${{ github.event_name == 'pull_request' }}",
    });

    // The whole job, exactly, in the claim/pr-gate style: any extra key — a
    // step-level continue-on-error tolerating a red audit, or a job-level
    // permissions override — fails this equality. The gate is the audit
    // command's own exit code, exactly as verified against pnpm 10.33.0:
    // bare `pnpm audit` exits 1 iff advisories exist. No install and no
    // build precede it — pnpm audit reads pnpm-lock.yaml directly.
    expect(workflow.jobs.audit).toEqual({
      "runs-on": "ubuntu-latest",
      "timeout-minutes": 10,
      steps: [
        {
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: { "persist-credentials": false },
        },
        {
          uses: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
          with: { "node-version": "24.17.0" },
        },
        {
          name: "Enable the pinned package manager",
          run: "corepack enable\ncorepack install --global pnpm@10.33.0\npnpm --version\n",
        },
        {
          name: "Audit lockfile advisories",
          run: "pnpm audit",
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

  it("adds the github-actions and docker ecosystems to the weekly dependabot schedule", async () => {
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
    ]);
    // One slot per ecosystem, not one shared literal: a shared `{ interval:
    // "weekly" }` cannot tell three lanes apart, so it stayed green while all
    // three landed on Monday — the busiest slot, shared with the dependency
    // audit. Keyed by ecosystem, one lane's day drifting fails on its own key.
    const expectedSchedules: Record<string, Schedule> = {
      "github-actions": {
        interval: "weekly",
        day: "friday",
        time: "04:23",
        timezone: "Etc/UTC",
      },
      docker: { interval: "weekly", day: "sunday", time: "05:31", timezone: "Etc/UTC" },
    };
    for (const ecosystem of ["github-actions", "docker"]) {
      const update = config.updates.find((u) => u["package-ecosystem"] === ecosystem)!;
      expect(update.directory, ecosystem).toBe("/");
      expect(update.schedule, ecosystem).toEqual(expectedSchedules[ecosystem]);
      // Per-entry cap: each updates entry opens at most five pull requests a
      // week (the npm lane included), so three entries could reach fifteen —
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
    const workflowDirectory = resolve(".github/workflows");
    const workflowFiles = (await readdir(workflowDirectory)).filter((file) =>
      /\.ya?ml$/.test(file));
    expect(workflowFiles.length).toBeGreaterThan(0);
    const actionNames = new Set<string>();
    // The weekday every scheduled workflow in this repository fires on, read
    // from the workflows themselves rather than transcribed, so the
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
          // A weekly cron is `m h * * d`; anything narrower fires on a
          // schedule dependabot's weekly lanes need not dodge.
          if (fields.length === 5 && fields[2] === "*" && fields[3] === "*" && fields[4] !== "*") {
            cronDays.add(CRON_DAYS[Number(fields[4])]!);
          }
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

    // All three lanes carry an explicit weekday, an explicit clock and a
    // timezone. No lane's day may be Monday — the default an unset `day`
    // resolves to, and this repository's busiest slot — nor any weekday a
    // scheduled workflow in this repository already fires on: dependency-audit
    // Monday, secret-scan and code-scanning Wednesday, scorecard Saturday. Two
    // jobs on one runner minute is the contention the explicit days remove, so
    // the property is asserted against the crons read above, not transcribed.
    for (const ecosystem of ["npm", "github-actions", "docker"]) {
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
    const workflow = await readWorkflow("actionlint.yml");
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
    expect(zizmor).toBeDefined();
    expect(zizmor!.if).toBe("${{ !cancelled() && steps.install_zizmor.outcome == 'success' }}");
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
    expect(zizmor).toContain("zizmor==1.29.0");
    // Tracked: the deny-by-default policy must name this exact file back,
    // while other .github/*.txt (the junk counterexamples) stay ignored.
    expect(checkIgnore(".github/requirements-zizmor.txt")).toBe(1);
    expect(checkIgnore(".github/junk.txt")).toBe(0);
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
    expect(checkIgnore(".github/workflows/dependency-audit.yml")).toBe(1);
    expect(checkIgnore(".github/workflows/ratchet-guard.yml")).toBe(1);
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
    expect(analyze.steps.filter((step) => step.uses).every((step) => /@[0-9a-f]{40}$/.test(step.uses!))).toBe(true);

    // The whole job, exactly, in the dependency-audit style: the job-level
    // permissions object is the least privilege uploading SARIF needs, and
    // any extra key — a tolerated failure, a checkout without
    // persist-credentials disabled — fails this equality.
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
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: { "persist-credentials": false },
        },
        {
          uses: "github/codeql-action/init@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2",
          with: {
            languages: "${{ matrix.language }}",
            "config-file": ".github/codeql-config.yml",
            queries: "security-extended",
          },
        },
        {
          uses: "github/codeql-action/analyze@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2",
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
   * 7. **A step that is not pinned, or is pinned to the wrong action.** A tag
   *    or branch ref moves under the workflow, so the action that produced a
   *    Security-tab finding is not the one that was reviewed. A substitution at
   *    a VALID digest is the shape the digest regex cannot see.
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

    // Every step that runs an action, pinned to a commit digest: a tag or
    // branch ref moves under the workflow, so the action that produced a
    // Security-tab finding is not the one that was reviewed.
    const used = analysis.steps.filter((step) => step.uses);
    expect(used.length, "scorecard.yml must run at least one action").toBeGreaterThan(0);
    for (const step of used) {
      expect(
        step.uses,
        `scorecard.yml's "${step.name ?? "unnamed"}" step must be pinned to a 40-character ` +
          "commit digest, so the action that ran is the one that was reviewed",
      ).toMatch(/@[0-9a-f]{40}$/);
    }

    // The SET, not only the shape. Swapping `ossf/scorecard-action` for a
    // different action at a valid 40-hex digest satisfies every assertion above
    // and would sail past them, leaving a workflow that still runs weekly and
    // still concludes green while measuring something else.
    expect(used.map((step) => step.uses!).sort()).toEqual([
      "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
      "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
      "github/codeql-action/upload-sarif@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2",
      "ossf/scorecard-action@2d1146689b8cda280b9bc96326124645441f03bc",
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
          uses: "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
          with: { "persist-credentials": false },
        },
        {
          name: "Run Scorecard analysis",
          uses: "ossf/scorecard-action@2d1146689b8cda280b9bc96326124645441f03bc",
          with: { results_file: "results.sarif", results_format: "sarif", publish_results: true },
        },
        {
          name: "Upload Scorecard results artifact",
          uses: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
          with: { name: "scorecard-results", path: "results.sarif", "retention-days": 5 },
        },
        {
          name: "Upload Scorecard results to code scanning",
          uses: "github/codeql-action/upload-sarif@2892aa5e19bbd11bc0cff5427e3b750a04d9e3c2",
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
    ) as Record<string, string>;
    const promotableCheckNames = [workflow.name, analysis.name ?? "analysis"];
    expect(
      Object.entries(requiredChecks).filter(
        ([check, file]) => promotableCheckNames.includes(check) || String(file).endsWith("scorecard.yml"),
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
