import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { parse } from "yaml";

/**
 * The parsed shape of a verify-job step this suite reads. Steps this suite does
 * not reason about (checkout, setup-node) carry only `uses`, which is why every
 * field is optional. `if` and `continue-on-error` are pinned because either one
 * can leave the step in the file while CI stops gating on it. `env` is pinned
 * for the freshness step because a rewired input silently voids the
 * certificate it issues.
 */
type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  if?: unknown;
  "continue-on-error"?: unknown;
  env?: Record<string, string | undefined>;
};

/**
 * jsdom does no layout, so the component suite stays green while a stylesheet
 * edit pushes the landing page's sign-in button below the fold (issue 111). The
 * behavioral cover for that is a real-browser check in CI, `node
 * scripts/check-page-geometry.mjs`, and this suite pins the wiring so the check
 * cannot silently drop out of the release gate: the step must exist in the
 * verify job, and it must run after the production build it measures — the
 * script starts its own server against the build, so it has nothing to measure
 * without that step ahead of it.
 *
 * Assertions are made on the parsed YAML data (step.name / step.run), never on
 * the raw bytes, so reformatting or reordering unrelated steps does not disturb
 * them and a renamed or removed step fails loudly here instead of quietly
 * narrowing what CI gates on.
 */
describe("the verify workflow's page-geometry step", () => {
  let steps: WorkflowStep[] = [];

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const workflow = parse(source) as {
      jobs?: { verify?: { steps?: WorkflowStep[] } };
    };

    steps = workflow.jobs?.verify?.steps ?? [];
  });

  it("keeps the production build step", () => {
    const builds = steps.filter((step) => step.name === "Production build");

    expect(builds, "the verify job must keep its Production build step").toHaveLength(1);
  });

  it("runs the page geometry check as a step of the verify job", () => {
    const geometry = steps.filter((step) =>
      step.run?.includes("scripts/check-page-geometry.mjs"),
    );

    expect(
      geometry,
      "the verify job must run node scripts/check-page-geometry.mjs",
    ).toHaveLength(1);
  });

  it("orders the page geometry check after the production build it measures", () => {
    const buildIndex = steps.findIndex((step) => step.name === "Production build");
    const geometryIndex = steps.findIndex((step) =>
      step.run?.includes("scripts/check-page-geometry.mjs"),
    );

    expect(buildIndex).toBeGreaterThan(-1);
    expect(geometryIndex).toBeGreaterThan(-1);
    expect(geometryIndex).toBeGreaterThan(buildIndex);
  });

  it("gates the page geometry step unconditionally", () => {
    const [step] = steps.filter((step) =>
      step.run?.includes("scripts/check-page-geometry.mjs"),
    );

    expect(step, "the geometry step must exist to be gated").toBeDefined();
    expect(
      step.if,
      "the geometry step must carry no `if:` — a conditional step does not gate",
    ).toBeUndefined();
    expect(
      Boolean(step["continue-on-error"]),
      "the geometry step must not be continue-on-error — a tolerated failure does not gate",
    ).toBe(false);
  });
});

/**
 * The verify job's "Ratchet documents" step is the pull-request half of the
 * issue 647 gate: it runs the merge ref's copy of scripts/check-ratchets.ts
 * (which the pull request can edit; only ratchet-guard.yml runs main's) against the merge
 * ref's parents — HEAD^1 the base tip, HEAD^2 the pull request head — after
 * completing the history of both sides, because the checkout is shallow at
 * that point and a shallow history can hand git merge-base a wrong base
 * without erroring. The wiring is pinned exactly because a rewiring can be
 * silent: a swapped parent order judges the head against the wrong side, a
 * depth-limited fetch leaves the merge base untrustworthy, and an added `if`
 * or continue-on-error leaves the step in the file while CI stops gating on
 * it. (The pull_request_target half lives in ratchet-guard.yml, pinned by
 * tests/api/ci-workflows.test.ts.)
 *
 * Assertions are made on the parsed YAML data (step.name / step.run / step.if),
 * never on the raw bytes, so reformatting the file does not disturb them and
 * a rewired or un-gated step fails loudly here instead of quietly narrowing
 * what CI gates on.
 */
describe("the verify workflow's ratchet documents step", () => {
  let steps: WorkflowStep[] = [];

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const workflow = parse(source) as {
      jobs?: { verify?: { steps?: WorkflowStep[] } };
    };

    steps = workflow.jobs?.verify?.steps ?? [];
  });

  const ratchet = () => steps.filter((step) => step.name === "Ratchet documents");

  it("exists exactly once in the verify job", () => {
    expect(ratchet(), "the verify job must keep its Ratchet documents step").toHaveLength(1);
  });

  it("fetches full history and checks the base parent against the head parent", () => {
    const [step] = ratchet();

    expect(step, "the verify job must contain the Ratchet documents step").toBeDefined();
    expect(
      step.run,
      "the step must fetch --unshallow (a depth-limited history can make git merge-base " +
        "return a wrong base without erroring) and then compare HEAD^1 — the merge ref's " +
        "base parent — with HEAD^2 — the pull request head — in that order; a swapped " +
        "order judges the base against the head's documents and passes a real relaxation",
    ).toBe(
      'git fetch --unshallow origin main "+refs/pull/${PR_NUMBER}/head:refs/remotes/pr/head"\n' +
        "node scripts/check-ratchets.ts HEAD^1 HEAD^2\n",
    );
  });

  it("gates pull requests only, and gates unconditionally when it runs", () => {
    const [step] = ratchet();

    expect(step, "the verify job must contain the Ratchet documents step").toBeDefined();
    expect(
      step.if,
      "the step must run on pull_request_target events exactly — a push run has no merge ref, " +
        "so HEAD^2 does not exist there",
    ).toBe("${{ github.event_name == 'pull_request_target' }}");
    expect(
      step.env,
      "the pull request number must reach the fetch through env, never ${{ }} interpolation " +
        "in the run block",
    ).toEqual({ PR_NUMBER: "${{ github.event.pull_request.number }}" });
    expect(
      Boolean(step["continue-on-error"]),
      "the step must not be continue-on-error — a tolerated failure does not gate the merge",
    ).toBe(false);
  });
});

describe("the verify workflow's migration immutability step", () => {
  let steps: WorkflowStep[] = [];

  const migrationImmutability = () =>
    steps.filter((step) => step.name === "Migration immutability");

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const workflow = parse(source) as {
      jobs?: { verify?: { steps?: WorkflowStep[] } };
    };

    steps = workflow.jobs?.verify?.steps ?? [];
  });

  it("exists exactly once in the verify job", () => {
    expect(
      migrationImmutability(),
      "the verify job must keep its Migration immutability step",
    ).toHaveLength(1);
  });

  it("runs after Ratchet documents", () => {
    const ratchetIndex = steps.findIndex((step) => step.name === "Ratchet documents");
    const migrationIndex = steps.findIndex((step) => step.name === "Migration immutability");

    expect(ratchetIndex).toBeGreaterThan(-1);
    expect(migrationIndex).toBeGreaterThan(-1);
    expect(migrationIndex).toBeGreaterThan(ratchetIndex);
  });

  it("runs only for pull requests and compares the base tip against the merge ref", () => {
    const [step] = migrationImmutability();

    expect(step, "the verify job must contain the Migration immutability step").toBeDefined();
    expect(step?.if).toBe("${{ github.event_name == 'pull_request_target' }}");
    expect(
      step?.env,
      "the pull request number must reach the fetch through env, never ${{ }} " +
        "interpolation in the run block",
    ).toEqual({ PR_NUMBER: "${{ github.event.pull_request.number }}" });
    expect(step?.run).toBe(
      'git fetch --depth=2 origin "+refs/pull/${PR_NUMBER}/merge"\n' +
        "node scripts/check-migration-edits.ts HEAD^1 HEAD\n",
    );
    expect(Boolean(step?.["continue-on-error"])).toBe(false);
  });
});

/**
 * The verify job's "Legal revision currency" step runs the per-commit
 * legal-revision gate (scripts/check-legal-revisions.ts, issue 955) over the
 * merge ref's range — HEAD^1 the base tip, HEAD the merge ref — after
 * completing the history of both sides. The wiring is pinned exactly because a
 * rewiring can be silent: a depth-limited fetch leaves the range's ancestry
 * incomplete and the per-commit walk misses commits, a swapped endpoint judges
 * the head against the wrong side, and an added `if` or continue-on-error
 * leaves the step in the file while CI stops gating on it.
 *
 * Assertions are made on the parsed YAML data (step.name / step.run / step.if),
 * never on the raw bytes, so reformatting the file does not disturb them and
 * a rewired or un-gated step fails loudly here instead of quietly narrowing
 * what CI gates on.
 */
describe("the verify workflow's legal revision currency step", () => {
  let steps: WorkflowStep[] = [];

  const legalRevisionCurrency = () =>
    steps.filter((step) => step.name === "Legal revision currency");

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const workflow = parse(source) as {
      jobs?: { verify?: { steps?: WorkflowStep[] } };
    };

    steps = workflow.jobs?.verify?.steps ?? [];
  });

  it("exists exactly once in the verify job", () => {
    expect(
      legalRevisionCurrency(),
      "the verify job must keep its Legal revision currency step",
    ).toHaveLength(1);
  });

  it("runs immediately after Migration immutability", () => {
    const migrationIndex = steps.findIndex((step) => step.name === "Migration immutability");
    const legalIndex = steps.findIndex((step) => step.name === "Legal revision currency");

    expect(migrationIndex).toBeGreaterThan(-1);
    expect(legalIndex).toBeGreaterThan(-1);
    expect(
      legalIndex,
      "the legal-revision gate must run immediately after Migration immutability — the " +
        "wiring issue 955 mandated, keeping the two merge-ref revision gates adjacent. " +
        "A step inserted between them is a silent rewiring of the mandated order.",
    ).toBe(migrationIndex + 1);
  });

  it("runs only for pull requests and walks every commit of the merge range", () => {
    const [step] = legalRevisionCurrency();

    expect(step, "the verify job must contain the Legal revision currency step").toBeDefined();
    expect(step?.if).toBe("${{ github.event_name == 'pull_request_target' }}");
    expect(
      step?.env,
      "the pull request number must reach the fetch through env, never ${{ }} " +
        "interpolation in the run block",
    ).toEqual({ PR_NUMBER: "${{ github.event.pull_request.number }}" });
    expect(step?.run).toBe(
      'git fetch --unshallow origin main "+refs/pull/${PR_NUMBER}/merge"\n' +
        "node scripts/check-legal-revisions.ts HEAD^1 HEAD\n",
    );
    expect(Boolean(step?.["continue-on-error"])).toBe(false);
  });
});

/**
 * Concurrency is the difference between a run that may be superseded and a
 * merged SHA's run, which may not: the deploy gate in
 * scripts/deploy-revision.sh reads the check conclusion for the SHA it deploys,
 * and a run cancelled by the next push to main concludes `cancelled`, which the
 * gate refuses. Under a per-pull-request group with a ref fallback every main
 * push shared one group, so a literal `cancel-in-progress: true` cancelled the
 * previous merged SHA's run on every merge (issue 474).
 *
 * The group is now split by event class instead: a pull request enters one
 * repository-level group, and every other leg keys on its own `github.sha`, so
 * no push to main shares a group with anything at all. The parentheses around
 * the event-name test are load-bearing — `&&` binds tighter than `||` in a
 * GitHub expression, and without them the pull_request arm falls through to
 * `github.sha` and the group is per-SHA again.
 *
 * `cancel-in-progress` is the literal boolean `false` on every leg, and the
 * reason is the shared group rather than the deploy gate. GitHub's documented
 * behaviour is that the PENDING run in a group is cancelled by default
 * whatever this flag says, and that the flag's only effect is whether the
 * RUNNING job is cancelled too — so it cannot tighten the bound at all. Under a
 * per-pull-request group the running job belonged to the same pull request and
 * destroying it was the benign self-supersede. Here it can belong to a
 * DIFFERENT pull request, and `verify` is a required context in
 * `.github/required-checks.json` that `ledger-relay` mirrors a run conclusion
 * onto, so a cancelling flag would let one contributor's push knock down a
 * peer's required check. Measured over the 370 pull-request arrivals of the
 * 6.13-day window ending 2026-09-30 — the 106 push and 7 dispatch runs key their
 * own SHA and never contend — that would be ~15 destroyed running runs a day at
 * the window mean and ~98 on the busiest measured day.
 *
 * What `false` does NOT do, and this comment used to imply it did: it does not
 * prevent cancellation. GitHub still cancels the group's PENDING run when a
 * newer arrival claims the single pending slot, and on a shared group that run
 * can be a peer's current head with no replacement — the relay mirrors the
 * cancelled conclusion onto `verify`, and these workflows trigger on
 * opened/synchronize/reopened with no `edited`, so that pull request is blocked
 * until its author pushes again. That residual is inherent to sharing one
 * group; `false` removes the in-flight half only, and `true` would add it back
 * on top. The honest rates, from the same 483-run window (mean service 6.58
 * min, load not steady — per-day arrivals 5, 0, 215, 122, 78, 17, 46):
 * pending-cancelled ~3/day at the window mean, ~11 on 2026-09-27, ~43 on
 * 2026-09-26's rho=0.76; against 9 such cancellations in the whole window on
 * main, every one a same-PR self-supersede. Those are a lower bound: a Poisson
 * fit understates a bursty arrival process, and replays of the real arrival
 * timestamps ran materially higher, so the residual is not smaller than stated.
 * On runner minutes the direction is
 * counter-intuitive: `true` would bill FEWER minutes, because a destroyed run
 * stops accruing, so `false` costs minutes and is bought deliberately. The bound
 * is unaffected either way — one running slot caps concurrency at 1 — and a run
 * dropped from the pending slot never started, so it costs 0 minutes.
 *
 * Assertions are made on the parsed YAML data (workflow.concurrency), never on
 * the raw bytes, so reformatting the block does not disturb them and a change
 * to either key fails loudly here instead of quietly changing what CI cancels.
 */
describe("the verify workflow's concurrency group", () => {
  let concurrency: {
    group?: unknown;
    "cancel-in-progress"?: unknown;
  } = {};

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const workflow = parse(source) as {
      concurrency?: { group?: unknown; "cancel-in-progress"?: unknown };
    };

    concurrency = workflow.concurrency ?? {};
  });

  it("puts every pull request in one repository-level group and keys every other leg on its own SHA", () => {
    expect(
      concurrency.group,
      "the concurrency group must be ci-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }} — one repository-level group for every pull request, and a per-SHA group for push and workflow_dispatch, whose keys must be parenthesised because && binds tighter than ||",
    ).toBe("ci-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}");
  });

  it("never cancels an in-flight run, on any leg", () => {
    expect(
      typeof concurrency["cancel-in-progress"],
      "cancel-in-progress must be the boolean false, not a string holding an event expression",
    ).toBe("boolean");
    expect(
      concurrency["cancel-in-progress"],
      "cancel-in-progress must be false — the group is shared by every pull request, so a true " +
        "destroys a RUNNING run that may belong to a different pull request, and verify is a " +
        "required context ledger-relay mirrors the conclusion onto. It cannot tighten the bound: " +
        "GitHub cancels the group's pending run by default either way. Note what it does NOT buy " +
        "either: a pending run is still cancelled when a newer arrival claims the single pending " +
        "slot, and here that run can be a peer's live head with no replacement, so its author is " +
        "blocked until they push again. That residual is inherent to the shared group.",
    ).toBe(false);
  });
});

/**
 * Branch protection requires the actionlint and verify contexts with strict
 * up-to-date checking disabled, so a pull_request run can go green against a
 * base that has since advanced: the run tests refs/pull/N/merge — the head
 * merged with the base as it stood at event time — and nothing re-runs the
 * checks when main moves underneath them, so the tree GitHub actually lands
 * (its rebase onto current main) was never tested by a required check (PR 290
 * is the worked example). The base-freshness step is the automated form of the
 * manual final-gate check: at the end of each required job (followed only by
 * verify's commit-scope gate) it issues the freshness certificate only when
 * the advance from the tested base to main's
 * current tip is disjoint from the files the pull request changes (issue 510's
 * relevant-advance condition, replacing issue 441's unsatisfiable
 * main-frozen-for-the-whole-run demand). The step delegates to the committed
 * script scripts/ci-base-freshness.sh, whose behavior tests/ci/
 * base-freshness.test.ts covers against a stubbed gh.
 *
 * Assertions are made on the parsed YAML data (step.name / step.run), never on
 * the raw bytes, so reformatting or reordering unrelated steps does not
 * disturb them and a renamed, moved, or removed step fails loudly here
 * instead of quietly un-gating the merge.
 */
describe("the required workflows' base-freshness step", () => {
  let verifySteps: WorkflowStep[] = [];
  let actionlintSteps: WorkflowStep[] = [];

  const freshness = (steps: WorkflowStep[]) =>
    steps.filter((step) => step.name === "Base freshness");

  beforeAll(async () => {
    const [ci, actionlint] = await Promise.all([
      readFile(resolve(".github/workflows/ci.yml"), "utf8"),
      readFile(resolve(".github/workflows/actionlint.yml"), "utf8"),
    ]);

    const ciWorkflow = parse(ci) as {
      jobs?: { verify?: { steps?: WorkflowStep[] } };
    };
    const actionlintWorkflow = parse(actionlint) as {
      jobs?: { actionlint?: { steps?: WorkflowStep[] } };
    };

    verifySteps = ciWorkflow.jobs?.verify?.steps ?? [];
    actionlintSteps = actionlintWorkflow.jobs?.actionlint?.steps ?? [];
  });

  it("exists exactly once in each required job", () => {
    expect(
      freshness(verifySteps),
      "the verify job must keep its Base freshness step",
    ).toHaveLength(1);
    expect(
      freshness(actionlintSteps),
      "the actionlint job must keep its Base freshness step",
    ).toHaveLength(1);
  });

  it("keeps freshness last except for verify's final commit-scope gate", () => {
    const verifyIndex = verifySteps.findIndex(
      (step) => step.name === "Base freshness",
    );
    const actionlintIndex = actionlintSteps.findIndex(
      (step) => step.name === "Base freshness",
    );

    expect(verifyIndex, "the verify job must contain the Base freshness step").toBeGreaterThan(-1);
    expect(
      actionlintIndex,
      "the actionlint job must contain the Base freshness step",
    ).toBeGreaterThan(-1);
    expect(
      verifyIndex,
      "Only the final commit-scope gate may follow Base freshness in verify (issue 988)",
    ).toBe(verifySteps.length - 2);
    expect(verifySteps[verifyIndex + 1]?.name).toBe(
      "Refuse a commit whose scope names a workflow outside the ci type",
    );
    expect(
      actionlintIndex,
      "Base freshness must be the LAST step of the actionlint job — an earlier step re-opens the whole run duration as the stale-base window",
    ).toBe(actionlintSteps.length - 1);
  });

  it("runs only when the event is a pull request", () => {
    const [verifyStep] = freshness(verifySteps);
    const [actionlintStep] = freshness(actionlintSteps);

    expect(verifyStep, "the verify job must contain the Base freshness step").toBeDefined();
    expect(
      actionlintStep,
      "the actionlint job must contain the Base freshness step",
    ).toBeDefined();
    expect(
      verifyStep.if,
      "Base freshness must be gated by the exact expression ${{ github.event_name == 'pull_request_target' }} — the required contexts are produced from the pull_request_target leg (issue 822); an expression naming a sibling event would leave the gate silently unrun",
    ).toBe("${{ github.event_name == 'pull_request_target' }}");
    expect(
      actionlintStep.if,
      "Base freshness must be gated by the exact expression ${{ github.event_name == 'pull_request_target' }} — the required contexts are produced from the pull_request_target leg (issue 822); an expression naming a sibling event would leave the gate silently unrun",
    ).toBe("${{ github.event_name == 'pull_request_target' }}");
  });

  it("does not tolerate its own failure", () => {
    const [verifyStep] = freshness(verifySteps);
    const [actionlintStep] = freshness(actionlintSteps);

    expect(verifyStep, "the verify job must contain the Base freshness step").toBeDefined();
    expect(
      actionlintStep,
      "the actionlint job must contain the Base freshness step",
    ).toBeDefined();
    expect(
      Boolean(verifyStep["continue-on-error"]),
      "Base freshness must not be continue-on-error — a tolerated failure does not gate the merge",
    ).toBe(false);
    expect(
      Boolean(actionlintStep["continue-on-error"]),
      "Base freshness must not be continue-on-error — a tolerated failure does not gate the merge",
    ).toBe(false);
  });

  it("interpolates no untrusted input into the run block", () => {
    const [verifyStep] = freshness(verifySteps);
    const [actionlintStep] = freshness(actionlintSteps);

    expect(verifyStep, "the verify job must contain the Base freshness step").toBeDefined();
    expect(
      actionlintStep,
      "the actionlint job must contain the Base freshness step",
    ).toBeDefined();
    expect(
      verifyStep.run,
      "Base freshness must carry a run block — the comparison is shell, not an actions expression",
    ).toBeDefined();
    expect(
      actionlintStep.run,
      "Base freshness must carry a run block — the comparison is shell, not an actions expression",
    ).toBeDefined();
    expect(
      verifyStep.run?.includes("${{"),
      "the run block must reference env names, never ${{ }} interpolation — untrusted-input interpolation in run: blocks is exactly what zizmor flags",
    ).toBe(false);
    expect(
      actionlintStep.run?.includes("${{"),
      "the run block must reference env names, never ${{ }} interpolation — untrusted-input interpolation in run: blocks is exactly what zizmor flags",
    ).toBe(false);
  });

  it("wires its inputs from the pull_request base through env", () => {
    const [verifyStep] = freshness(verifySteps);
    const [actionlintStep] = freshness(actionlintSteps);

    expect(verifyStep, "the verify job must contain the Base freshness step").toBeDefined();
    expect(
      actionlintStep,
      "the actionlint job must contain the Base freshness step",
    ).toBeDefined();

    const expectedEnv = {
      GH_TOKEN: "${{ github.token }}",
      REPO_SLUG: "${{ github.repository }}",
      BASE_SHA: "${{ github.event.pull_request.base.sha }}",
      BASE_REF: "${{ github.event.pull_request.base.ref }}",
      PR_NUMBER: "${{ github.event.pull_request.number }}",
      HEAD_SHA: "${{ github.event.pull_request.head.sha }}",
    };

    expect(
      verifyStep.env,
      "Base freshness must take exactly these six inputs from these sources — a rewired BASE_SHA (github.sha is the HEAD of the pull request, not the base) makes the gate compare the wrong SHA source, and missing PR_NUMBER or HEAD_SHA leaves the script unable to fetch the PR's file list or to name the head on the certificate it issues",
    ).toEqual(expectedEnv);
    expect(
      actionlintStep.env,
      "Base freshness must take exactly these six inputs from these sources — a rewired BASE_SHA (github.sha is the HEAD of the pull request, not the base) makes the gate compare the wrong SHA source, and missing PR_NUMBER or HEAD_SHA leaves the script unable to fetch the PR's file list or to name the head on the certificate it issues",
    ).toEqual(expectedEnv);
  });

  it("invokes the committed freshness script", () => {
    const [verifyStep] = freshness(verifySteps);
    const [actionlintStep] = freshness(actionlintSteps);

    expect(verifyStep, "the verify job must contain the Base freshness step").toBeDefined();
    expect(
      actionlintStep,
      "the actionlint job must contain the Base freshness step",
    ).toBeDefined();
    expect(
      verifyStep.run,
      "Base freshness must carry a run block — the comparison is shell, not an actions expression",
    ).toBeDefined();
    expect(
      actionlintStep.run,
      "Base freshness must carry a run block — the comparison is shell, not an actions expression",
    ).toBeDefined();
    expect(
      verifyStep.run,
      "the gate's logic must live in scripts/ci-base-freshness.sh, where tests/ci/base-freshness.test.ts can execute it against a stubbed gh — an inline run block has no behavioral cover, and issue 510 showed an untested gate decaying into an unsatisfiable one",
    ).toBe("bash scripts/ci-base-freshness.sh");
    expect(
      actionlintStep.run,
      "the gate's logic must live in scripts/ci-base-freshness.sh, where tests/ci/base-freshness.test.ts can execute it against a stubbed gh — an inline run block has no behavioral cover, and issue 510 showed an untested gate decaying into an unsatisfiable one",
    ).toBe("bash scripts/ci-base-freshness.sh");
  });
});

/**
 * Issue 822 moved the required workflows' pull-request legs to
 * pull_request_target so the executed definition is always main's. Under that
 * event a workflow can reach repository secrets and runs with the caller's
 * checkout context, so the move is only as good as the boundary it keeps:
 * this suite pins ci.yml's side of it. The contexts themselves are posted by
 * the ledger relay alone; the App key exists only in that relay's
 * environment, never here.
 */
describe("the verify workflow's untrusted-code boundary", () => {
  let workflow: {
    permissions?: unknown;
    jobs?: Record<string, { permissions?: unknown; steps?: WorkflowStep[] }>;
  } = {};

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    workflow = parse(source);
  });

  /** Calls visit on every string reachable inside `value`. */
  function visitStrings(value: unknown, visit: (text: string) => void): void {
    if (typeof value === "string") {
      visit(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visitStrings(entry, visit);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const entry of Object.values(value)) visitStrings(entry, visit);
    }
  }

  it("references no secret anywhere in the workflow", () => {
    const secretRefs: string[] = [];
    visitStrings(workflow, (text) => {
      if (text.includes("secrets.")) secretRefs.push(text);
    });

    expect(
      secretRefs,
      "ci.yml runs pull_request_target and must therefore reference no secret — " +
        "a `${{ secrets.… }}` in any with:/env: value would hand PR-authored input " +
        "the run's secret context; only the ledger relay holds the App key",
    ).toEqual([]);
  });

  it("grants the workflow exactly contents: read", () => {
    expect(
      workflow.permissions,
      "the workflow-level permissions must be exactly { contents: read } — the token " +
        "a pull_request_target run carries must stay read-only over contents, with no " +
        "extra scope added anywhere",
    ).toEqual({ contents: "read" });
  });

  it("carries exactly two checkouts, each gated to its event", () => {
    const checkouts = (workflow.jobs?.verify?.steps ?? []).filter(
      (step) => step.uses?.startsWith("actions/checkout@"),
    );

    expect(
      checkouts,
      "the verify job must keep exactly two checkouts",
    ).toHaveLength(2);
    expect(
      checkouts[0]?.if,
      "the PR-tree checkout must be gated to pull_request_target exactly — its ref " +
        "input reads github.event.pull_request.number, which is null on push and " +
        "workflow_dispatch and broke those legs (fix round 1, finding A)",
    ).toBe("${{ github.event_name == 'pull_request_target' }}");
    expect(
      checkouts[0]?.with,
      "the PR-tree checkout must carry persist-credentials: false (actions/checkout's " +
        "fork guard requires it before admitting a PR ref under pull_request_target) " +
        "AND the merge-ref ref input (under pull_request_target the default checkout " +
        "is main's tip; the suite must test the pull request's change)",
    ).toEqual({
      ref: "refs/pull/${{ github.event.pull_request.number }}/merge",
      "persist-credentials": false,
    });
    expect(
      checkouts[1]?.if,
      "the plain checkout must be gated to every non-PR event — the pushed main tip " +
        "and the dispatched ref are checked out by the default checkout, whose ref " +
        "input is absent and so cannot go null",
    ).toBe("${{ github.event_name != 'pull_request_target' }}");
    expect(
      checkouts[1]?.with,
      "the plain checkout must carry persist-credentials: false and no ref input",
    ).toEqual({ "persist-credentials": false });
  });

  it("confines job-level permission overrides to the calibrate job", () => {
    const overridden = Object.entries(workflow.jobs ?? {})
      .filter(([, job]) => job !== undefined && "permissions" in job)
      .map(([name]) => name);

    expect(
      overridden,
      "the only job in ci.yml that may carry its own permissions: override is calibrate " +
        "(its contents: write is pinned by tests/ci/calibrate-workflow.test.ts and it runs " +
        "only on push and dispatch); every other job — the PR-reachable verify job included " +
        "— must inherit the workflow-level { contents: read }, so a job-level elevation " +
        "anywhere else fails here",
    ).toEqual(["calibrate"]);
  });
});

/** Issue 988 ports both gates into the existing required verify context. */
describe("the verify workflow's conflict-marker and commit-scope gates", () => {
  let steps: WorkflowStep[] = [];
  const markerName = "Check no tracked file carries a merge-conflict marker";
  const scopeName = "Refuse a commit whose scope names a workflow outside the ci type";

  beforeAll(async () => {
    const workflow = parse(await readFile(resolve(".github/workflows/ci.yml"), "utf8")) as {
      jobs?: { verify?: { steps?: WorkflowStep[] } };
    };
    steps = workflow.jobs?.verify?.steps ?? [];
  });

  it("contains exactly one conflict-marker gate", () => {
    expect(steps.filter((step) => step.name === markerName)).toHaveLength(1);
  });

  it("checks markers immediately after both checkouts and before setup-node", () => {
    const checkouts = steps.flatMap((step, index) =>
      step.uses?.startsWith("actions/checkout@") ? [index] : [],
    );
    const markerIndex = steps.findIndex((step) => step.name === markerName);
    expect(checkouts).toHaveLength(2);
    expect(markerIndex).toBeGreaterThan(-1);
    expect(markerIndex).toBe(checkouts[1] + 1);
    expect(steps[markerIndex + 1]?.uses).toMatch(/^actions\/setup-node@/);
  });

  it("runs the tracked-text marker grep on every event without tolerating failure", () => {
    const step = steps.find((step) => step.name === markerName);
    expect(step).toBeDefined();
    expect(step?.run).toContain("git grep -nI -E '^(<{7}( |$)|>{7}( |$)|={7}$)' -- .");
    expect(step?.if).toBeUndefined();
    expect(Boolean(step?.["continue-on-error"])).toBe(false);
  });

  it("contains exactly one commit-scope gate", () => {
    expect(steps.filter((step) => step.name === scopeName)).toHaveLength(1);
  });

  it("runs the commit-scope gate immediately after Base freshness as the last step", () => {
    const freshnessIndex = steps.findIndex((step) => step.name === "Base freshness");
    const scopeIndex = steps.findIndex((step) => step.name === scopeName);
    expect(freshnessIndex).toBeGreaterThan(-1);
    expect(scopeIndex).toBeGreaterThan(-1);
    expect(scopeIndex).toBe(freshnessIndex + 1);
    expect(scopeIndex).toBe(steps.length - 1);
  });

  it("runs the Python gate only for pull_request_target without tolerating failure", () => {
    const step = steps.find((step) => step.name === scopeName);
    expect(step).toBeDefined();
    expect(step?.run).toBe("python3 scripts/commit_scopes.py");
    expect(step?.if).toBe("${{ github.event_name == 'pull_request_target' }}");
    expect(Boolean(step?.["continue-on-error"])).toBe(false);
  });
});
