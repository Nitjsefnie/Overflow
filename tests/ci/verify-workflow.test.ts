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

type VerifyJob = {
  env?: Record<string, string | undefined>;
  steps?: WorkflowStep[];
};

describe("the verify workflow's package-manager step", () => {
  let job: VerifyJob | undefined;

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const workflow = parse(source) as {
      jobs?: { verify?: VerifyJob };
    };

    job = workflow.jobs?.verify;
  });

  const packageManager = () =>
    job?.steps?.filter((step) => step.name === "Enable the pinned package manager") ?? [];

  it("pins Corepack and the package registry", () => {
    expect(
      packageManager(),
      "the verify job must keep exactly one Enable the pinned package manager step",
    ).toHaveLength(1);
    // Actions env is step-scoped; dependency-audit.yml pins both at job scope so every pnpm step inherits them.
    expect(job?.env?.COREPACK_ENABLE_PROJECT_SPEC).toBe("0");
    expect(job?.env?.npm_config_registry).toBe("https://registry.npmjs.org/");
  });
});

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

  it("gates the page geometry step on every event that runs the event commit's own code", () => {
    const [step] = steps.filter((step) =>
      step.run?.includes("scripts/check-page-geometry.mjs"),
    );

    expect(step, "the geometry step must exist to be gated").toBeDefined();
    // The gate moved with the file (issue 1090). The step runs the
    // checked-out commit's build, so it belongs to the leg that checks a commit
    // out and executes it; this file receives only push and workflow_dispatch,
    // which is exactly that set, so the closed trigger set IS the gate and an
    // `if` here would be dead code. A pull request's geometry runs in
    // pr-suite.yml, whose outcome verify awaits as data.
    expect(
      step.if,
      "the geometry step must carry no event gate: ci.yml admits nothing but push and " +
        "workflow_dispatch, the two events whose own code it runs",
    ).toBeUndefined();
    expect(
      Boolean(step["continue-on-error"]),
      "the geometry step must not be continue-on-error — a tolerated failure does not gate",
    ).toBe(false);
  });
});

/**
 * The verify job carries no ratchet-documents step. The ratchet-guard
 * workflows run main's copy of scripts/check-ratchets.ts on every pull request
 * (and every push to main) as its own required context, reading the head only as git
 * objects, so a copy here would add no judge — and the copy that used to sit
 * here executed the pull request's own script.
 */
describe("the verify workflow's ratchet documents", () => {
  it("are judged by the ratchet-guard workflows, not by a step of the verify job", async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const workflow = parse(source) as { jobs?: { verify?: { steps?: WorkflowStep[] } } };
    const steps = workflow.jobs?.verify?.steps ?? [];
    expect(steps.filter((step) => step.name === "Ratchet documents")).toEqual([]);
    expect(steps.filter((step) => (step.run ?? "").includes("check-ratchets.ts"))).toEqual([]);

    // The pull-request leg moved into ratchet-guard-pr.yml under issue 1090,
    // so this reads the ratchet step out of the file that actually holds it
    // rather than out of the push leg, which no longer has one.
    const guard = parse(await readFile(resolve(".github/workflows/ratchet-guard-pr.yml"), "utf8")) as {
      on: Record<string, unknown>;
      jobs: Record<string, { steps: WorkflowStep[] }>;
    };
    expect(
      Object.keys(guard.on),
      "the ratchet step on a pull request reads pull-request data, so the file holding it must be " +
        "reachable by pull_request_target alone (issue 1090)",
    ).toEqual(["pull_request_target"]);
    const ratchet = guard.jobs["ratchet-guard"]?.steps.find((step) => step.name === "Ratchet documents");
    expect(
      ratchet?.if,
      "the step carries no event gate: its file's closed trigger set is the gate",
    ).toBeUndefined();
    expect(ratchet?.run).toBe('node scripts/check-ratchets.ts HEAD "$HEAD_SHA"');
  });
});

describe("the verify workflow's migration immutability step", () => {
  let steps: WorkflowStep[] = [];
  let triggers: unknown;

  const migrationImmutability = () =>
    steps.filter((step) => step.name === "Migration immutability");

  beforeAll(async () => {
    // ci-pr.yml, not ci.yml: issue 1090 split the pull-request leg of the
    // verify job into a file whose only trigger is `pull_request_target`, and
    // the merge-range gates moved with it.
    const source = await readFile(resolve(".github/workflows/ci-pr.yml"), "utf8");
    const workflow = parse(source) as {
      on?: unknown;
      jobs?: { verify?: { steps?: WorkflowStep[] } };
    };

    steps = workflow.jobs?.verify?.steps ?? [];
    triggers = workflow.on;
  });

  it("exists exactly once in the verify job", () => {
    expect(
      migrationImmutability(),
      "the verify job must keep its Migration immutability step",
    ).toHaveLength(1);
  });

  it("runs after the merge tree is materialised", () => {
    const materialiseIndex = steps.findIndex((step) => (step.run ?? "").includes("git worktree add"));
    const migrationIndex = steps.findIndex((step) => step.name === "Migration immutability");

    expect(materialiseIndex).toBeGreaterThan(-1);
    expect(migrationIndex).toBeGreaterThan(materialiseIndex);
  });

  it("runs in a file whose only trigger is pull_request_target, so it needs no event gate", () => {
    // The gate moved with the step. Where it used to need `if: github.event_name
    // == 'pull_request_target'` to keep it off the push leg, the split achieves
    // that structurally: the file it now lives in is reachable by nothing else.
    // Asserting the ungated step on its own would be an unbacked licence, so
    // the trigger set is asserted beside it.
    const [step] = migrationImmutability();
    expect(step, "the verify job must contain the Migration immutability step").toBeDefined();
    expect(
      Object.keys((triggers ?? {}) as Record<string, unknown>),
      "the merge-range gates read the pull request's merge commit, so the file holding them must " +
        "be reachable by pull_request_target alone (issue 1090)",
    ).toEqual(["pull_request_target"]);
    expect(
      step?.if,
      "the step carries no event gate: its file's closed trigger set is the gate",
    ).toBeUndefined();
  });

  it("runs from the base checkout, comparing the base tip against the merge commit", () => {
    const [step] = migrationImmutability();

    expect(step, "the verify job must contain the Migration immutability step").toBeDefined();
    expect(
      step?.env,
      "the merge commit's SHA arrives as the materialise step's output, through env:",
    ).toEqual({ MERGE_SHA: "${{ steps.pr-tree.outputs.merge_sha }}" });
    expect(
      step?.run,
      "the base checkout's copy of the script must judge the merge commit's first parent " +
        "against the merge commit — never the pull request tree's copy, and never the raw head " +
        "(issue 841)",
    ).toBe(
      'node "${GITHUB_WORKSPACE}/scripts/check-migration-edits.ts" "${MERGE_SHA:?}^1" "${MERGE_SHA}"',
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
    // The merge-ref gates moved to ci-pr.yml with the rest of the pull-request
    // leg (issue 1090).
    const source = await readFile(resolve(".github/workflows/ci-pr.yml"), "utf8");
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

  it("runs with no event gate, its file's closed trigger set being the gate", () => {
    const [step] = legalRevisionCurrency();

    expect(step, "the verify job must contain the Legal revision currency step").toBeDefined();
    expect(
      step?.if,
      "the step carries no event gate: an `if` naming a sibling event would be dead here and " +
        "would re-open the class ci-pr.yml's split removed",
    ).toBeUndefined();
  });

  it("walks every commit of the merge range", () => {
    const [step] = legalRevisionCurrency();

    expect(step, "the verify job must contain the Legal revision currency step").toBeDefined();
    expect(
      step?.env,
      "the merge commit's SHA arrives as the materialise step's output, through env:",
    ).toEqual({ MERGE_SHA: "${{ steps.pr-tree.outputs.merge_sha }}" });
    expect(
      step?.run,
      "the base checkout's copy of the per-commit walk must judge every commit of the merge " +
        "commit's range, over the full history the base checkout fetched",
    ).toBe(
      'node "${GITHUB_WORKSPACE}/scripts/check-legal-revisions.ts" "${MERGE_SHA:?}^1" "${MERGE_SHA}"',
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
 * Issue 1090 then split that same expression across two FILES, because the
 * pull-request arm is the half that reads a pull request's merge commit. The
 * repository-level group moved to ci-pr.yml (`ci-pr-…`), whose only trigger is
 * `pull_request_target`, and ci.yml keeps the plain per-SHA group (`ci-…`)
 * with no event arm at all — nothing in that file receives a pull-request
 * event, so an arm would be dead code pinning a promise no run exercises.
 * Concurrency group names are repository-global, which is why both literals are
 * asserted rather than one.
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
describe("the verify workflows' concurrency groups", () => {
  // Issue 1090 split the workflow, so the group split by event class is now
  // split by FILE: the repository-level arm lives in ci-pr.yml, which receives
  // nothing but pull_request_target, and ci.yml's group is the plain per-SHA
  // one. Both halves are pinned, because a group that names the other file's
  // prefix would silently share a slot with it — concurrency group names are
  // repository-global.
  let push: { group?: unknown; "cancel-in-progress"?: unknown } = {};
  let pr: { group?: unknown; "cancel-in-progress"?: unknown } = {};

  beforeAll(async () => {
    const read = async (file: string) => {
      const workflow = parse(await readFile(resolve(file), "utf8")) as {
        concurrency?: { group?: unknown; "cancel-in-progress"?: unknown };
      };
      return workflow.concurrency ?? {};
    };
    push = await read(".github/workflows/ci.yml");
    pr = await read(".github/workflows/ci-pr.yml");
  });

  it("puts every pull request in one repository-level group, in the pull-request file", () => {
    expect(
      pr.group,
      "ci-pr.yml's concurrency group must be ci-pr-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }} — one repository-level group for every pull request, whose keys must be parenthesised because && binds tighter than ||",
    ).toBe("ci-pr-${{ (github.event_name == 'pull_request' || github.event_name == 'pull_request_target') && 'repo-wide' || github.sha }}");
  });

  it("keys every push and dispatch leg on its own SHA, in the push file", () => {
    expect(
      push.group,
      "ci.yml's concurrency group must be ci-${{ github.sha }} — with no pull-request trigger " +
        "reachable in this file, the repository-level arm would be dead code, and a per-SHA group " +
        "is what stops one push to main from cancelling a merged SHA's pending run (issue 474)",
    ).toBe("ci-${{ github.sha }}");
    expect(
      push.group,
      "the two files' groups must not be able to collide: group names are repository-global, so a " +
        "ci.yml group of ci-repo-wide would share a slot with ci-pr.yml's",
    ).not.toBe("ci-pr-${{ github.sha }}");
  });

  it("never cancels an in-flight run, in either file", () => {
    for (const [file, concurrency] of [
      ["ci.yml", push],
      ["ci-pr.yml", pr],
    ] as const) {
      expect(
        typeof concurrency["cancel-in-progress"],
        `${file}: cancel-in-progress must be the boolean false, not a string holding an event expression`,
      ).toBe("boolean");
      expect(
        concurrency["cancel-in-progress"],
        `${file}: cancel-in-progress must be false — a true destroys a RUNNING run that may ` +
          "belong to a different pull request, and verify is a required context ledger-relay " +
          "mirrors the conclusion onto. It cannot tighten the bound: GitHub cancels the group's " +
          "pending run by default either way. Note what it does NOT buy either: a pending run is " +
          "still cancelled when a newer arrival claims the single pending slot, and in ci-pr.yml " +
          "that run can be a peer's live head with no replacement, so its author is blocked until " +
          "they push again. That residual is inherent to the shared group.",
      ).toBe(false);
    }
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
 * manual final-gate check: as the last step of each required job it issues
 * the freshness certificate only when
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
  // Issue 1090 split actionlint and then ci into a file per leg. The freshness
  // gate belongs to the pull-request leg, so it moved with it in both cases —
  // reading it out of the push file after a split found nothing there, and
  // every assertion below would have been a vacuous "the step I could not find
  // is absent".
  let actionlintPrTriggers: unknown;
  let ciPrTriggers: unknown;

  const freshness = (steps: WorkflowStep[]) =>
    steps.filter((step) => step.name === "Base freshness");

  beforeAll(async () => {
    const [ciPr, actionlintPr] = await Promise.all([
      readFile(resolve(".github/workflows/ci-pr.yml"), "utf8"),
      readFile(resolve(".github/workflows/actionlint-pr.yml"), "utf8"),
    ]);

    const ciWorkflow = parse(ciPr) as {
      on: unknown;
      jobs?: { verify?: { steps?: WorkflowStep[] } };
    };
    const actionlintWorkflow = parse(actionlintPr) as {
      on: unknown;
      jobs?: { actionlint?: { steps?: WorkflowStep[] } };
    };

    verifySteps = ciWorkflow.jobs?.verify?.steps ?? [];
    actionlintSteps = actionlintWorkflow.jobs?.actionlint?.steps ?? [];
    actionlintPrTriggers = actionlintWorkflow.on;
    ciPrTriggers = ciWorkflow.on;
  });

  it("exists exactly once in each required job", () => {
    expect(
      freshness(verifySteps),
      "the verify job must keep its Base freshness step",
    ).toHaveLength(1);
    expect(
      freshness(actionlintSteps),
      "the actionlint pull-request job must keep its Base freshness step",
    ).toHaveLength(1);
  });

  it("lives in a file whose only trigger is pull_request_target, so it needs no event gate", () => {
    // The gate moved with the step, in both files. Where the step used to need
    // `if: github.event_name == 'pull_request_target'` to keep it off the push
    // leg, the split achieves that structurally: the file it now lives in is
    // reachable by nothing else. Asserting the ungated step on its own would
    // be an unbacked licence, so the trigger set is asserted beside it — and
    // the pairing is what makes "ungated" safe rather than a regression.
    for (const [label, triggers, steps] of [
      ["verify", ciPrTriggers, verifySteps],
      ["actionlint", actionlintPrTriggers, actionlintSteps],
    ] as const) {
      const [step] = freshness(steps);
      expect(step, `the ${label} pull-request job must contain the Base freshness step`).toBeDefined();
      expect(
        Object.keys((triggers ?? {}) as Record<string, unknown>),
        `${label}: the Base freshness step is ungated, which is only correct while this file ` +
          "receives nothing but pull_request_target. An added push or workflow_dispatch trigger " +
          "here would make the step run on main's own pushes, where github.event.pull_request.* " +
          "resolves to nothing.",
      ).toEqual(["pull_request_target"]);
      expect(
        step.if,
        `${label}: the step carries no event gate: its file's closed trigger set is the gate, and ` +
          "an expression naming a sibling event here would be either dead or would re-open the " +
          "class the split removed",
      ).toBeUndefined();
    }
  });

  it("keeps freshness the last step of both required jobs", () => {
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
      "Base freshness must be the LAST step of the verify job — an earlier step re-opens the whole run duration as the stale-base window",
    ).toBe(verifySteps.length - 1);
    expect(
      actionlintIndex,
      "Base freshness must be the LAST step of the actionlint job — an earlier step re-opens the whole run duration as the stale-base window",
    ).toBe(actionlintSteps.length - 1);
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
      "the gate's logic must live in scripts/ci-base-freshness.sh, where tests/ci/base-freshness.test.ts can execute it against a stubbed gh — an inline run block has no behavioral cover, and issue 510 showed an untested gate decaying into an unsatisfiable one. verify runs the base checkout's copy by absolute path",
    ).toBe('bash "${GITHUB_WORKSPACE}/scripts/ci-base-freshness.sh"');
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
 * this suite pins ci-pr.yml's side of it — ci.yml no longer runs under
 * pull_request_target at all (issue 1090) — with no secret, a read-only token,
 * and a checkout of the base branch whose scripts judge the pull request's
 * merge tree as data (tests/ci/verify-step-reachability.test.ts pins that no
 * reachable step executes pull-request code). The contexts themselves are
 * posted by the ledger relay alone; the App key exists only in that relay's
 * environment, never here.
 *
 * ci.yml is asserted alongside it, because the split moved a permission with
 * the steps: verify's `actions: read` existed only to read the pull request
 * suite's runs and its coverage artifact, and no step left in ci.yml needs it.
 * A pin on one file alone would let the other drift.
 */
describe("the verify workflows' untrusted-code boundary", () => {
  type Parsed = {
    permissions?: unknown;
    jobs?: Record<string, { permissions?: unknown; steps?: WorkflowStep[] }>;
  };
  let workflow: Parsed = {};
  let prWorkflow: Parsed = {};

  beforeAll(async () => {
    const [ci, ciPr] = await Promise.all([
      readFile(resolve(".github/workflows/ci.yml"), "utf8"),
      readFile(resolve(".github/workflows/ci-pr.yml"), "utf8"),
    ]);
    workflow = parse(ci);
    prWorkflow = parse(ciPr);
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

  it("references no secret anywhere in either workflow", () => {
    const secretRefs: string[] = [];
    for (const [label, parsed] of [["ci.yml", workflow], ["ci-pr.yml", prWorkflow]] as const) {
      visitStrings(parsed, (text) => {
        if (text.includes("secrets.")) secretRefs.push(`${label}: ${text}`);
      });
    }

    expect(
      secretRefs,
      "ci-pr.yml runs pull_request_target and must therefore reference no secret — " +
        "a `${{ secrets.… }}` in any with:/env: value would hand PR-authored input " +
        "the run's secret context; only the ledger relay holds the App key. ci.yml is " +
        "asserted on the same terms: it is the sibling that keeps the calibrate job's " +
        "contents: write, so a secret added beside it would be one step away from " +
        "a workflow the pull-request leg runs beside.",
    ).toEqual([]);
  });

  it("grants each workflow exactly contents: read", () => {
    for (const [label, parsed] of [["ci.yml", workflow], ["ci-pr.yml", prWorkflow]] as const) {
      expect(
        parsed.permissions,
        `${label}: the workflow-level permissions must be exactly { contents: read } — the ` +
          "token a pull_request_target run carries must stay read-only over contents, with no " +
          "extra scope added anywhere",
      ).toEqual({ contents: "read" });
    }
  });

  it("carries exactly one ungated checkout in each leg, each shaped for what it checks out", () => {
    // One checkout per file, and neither carries an `if`: before the split both
    // checkouts shared one job and the event test was the only thing telling
    // them apart. Two ungated checkouts of different shapes in one job is
    // impossible — the second would run against the first's working directory —
    // so the file is now what tells them apart, and an `if` here would be dead
    // or would re-open the class the split removed.
    const checkouts = (parsed: Parsed) =>
      (parsed.jobs?.verify?.steps ?? []).filter((step) =>
        step.uses?.startsWith("actions/checkout@"),
      );

    const [prCheckout, ...prRest] = checkouts(prWorkflow);
    expect(
      checkouts(prWorkflow),
      "ci-pr.yml's verify job must keep exactly one checkout",
    ).toHaveLength(1);
    expect(prRest, "and only one").toEqual([]);
    expect(
      prCheckout?.if,
      "the base checkout must carry no event gate: this file's whole `on:` set is " +
        "{pull_request_target}",
    ).toBeUndefined();
    expect(
      prCheckout?.with,
      "under pull_request_target the checkout must carry NO ref input — the default " +
        "checkout is the base branch's tip, whose scripts are the judge — with full history " +
        "for the range-walking gates and persist-credentials: false. The pull request's " +
        "merge commit enters only as git objects, materialised outside the workspace",
    ).toEqual({ "persist-credentials": false, "fetch-depth": 0 });

    const [pushCheckout] = checkouts(workflow);
    expect(
      checkouts(workflow),
      "ci.yml's verify job must keep exactly one checkout",
    ).toHaveLength(1);
    expect(
      pushCheckout?.if,
      "the plain checkout must carry no event gate: this file receives only push and " +
        "workflow_dispatch, so its ref input is absent and cannot go null",
    ).toBeUndefined();
    expect(
      pushCheckout?.with,
      "the plain checkout must carry persist-credentials: false and no ref input",
    ).toEqual({ "persist-credentials": false });
  });

  it("confines each job's permissions: override to what its steps actually need", () => {
    // ci.yml keeps calibrate's contents: write and nothing else — verify there
    // downloads no artifact and awaits no run, so it inherits the workflow's
    // contents: read rather than adding a scope no step of it uses.
    expect(
      Object.entries(workflow.jobs ?? {})
        .filter(([, job]) => job !== undefined && "permissions" in job)
        .map(([name]) => name),
      "only calibrate may carry a permissions: override in ci.yml (its contents: write is pinned " +
        "by tests/ci/calibrate-workflow.test.ts and it runs only on push and dispatch); a verify " +
        "override here would be a scope no step in that job uses",
    ).toEqual(["calibrate"]);

    // ci-pr.yml keeps verify's read-only actions: read — the base copy of the
    // suite awaiter lists the pull request suite's runs and downloads its
    // coverage summary — and nothing that writes.
    expect(
      Object.entries(prWorkflow.jobs ?? {})
        .filter(([, job]) => job !== undefined && "permissions" in job)
        .map(([name]) => name),
      "ci-pr.yml has no calibrate job, so only verify may carry a permissions: override",
    ).toEqual(["verify"]);
    expect(
      prWorkflow.jobs?.verify?.permissions,
      "verify may add exactly actions: read — to read the pull request suite's runs and " +
        "artifact — and nothing that writes",
    ).toEqual({ contents: "read", actions: "read" });
  });
});

/** Issue 988 ports both gates into the existing required verify context. */
describe("the verify workflow's conflict-marker and commit-scope gates", () => {
  // The marker gate lives in BOTH files after issue 1090's split — over the
  // pull request's tree in one and the checked-out commit in the other — but
  // the commit-scope gate only ever judged the pull request's merge tree, so it
  // is asserted here against ci-pr.yml alone. Reading ci.yml for either found
  // none, and every assertion below would have been a vacuous "the step I could
  // not find is absent".
  let steps: WorkflowStep[] = [];
  let pushSteps: WorkflowStep[] = [];
  const markerName = "Check no tracked file carries a merge-conflict marker";
  const scopeName = "Refuse a commit whose scope names a workflow outside the ci type";

  beforeAll(async () => {
    const read = async (file: string) => {
      const workflow = parse(await readFile(resolve(file), "utf8")) as {
        jobs?: { verify?: { steps?: WorkflowStep[] } };
      };
      return workflow.jobs?.verify?.steps ?? [];
    };
    steps = await read(".github/workflows/ci-pr.yml");
    pushSteps = await read(".github/workflows/ci.yml");
  });

  it("contains exactly one conflict-marker gate in each leg", () => {
    expect(steps.filter((step) => step.name === markerName)).toHaveLength(1);
    expect(pushSteps.filter((step) => step.name === markerName)).toHaveLength(1);
  });

  it("checks markers immediately after the checkout and the merge tree, before setup-node", () => {
    const checkouts = steps.flatMap((step, index) =>
      step.uses?.startsWith("actions/checkout@") ? [index] : [],
    );
    const materialiseIndex = steps.findIndex((step) => (step.run ?? "").includes("git worktree add"));
    const markerIndex = steps.findIndex((step) => step.name === markerName);
    expect(checkouts).toHaveLength(1);
    expect(materialiseIndex).toBe(checkouts[0] + 1);
    expect(markerIndex).toBeGreaterThan(-1);
    expect(markerIndex).toBe(materialiseIndex + 1);
    expect(steps[markerIndex + 1]?.uses).toMatch(/^actions\/setup-node@/);
  });

  it("runs the tracked-text marker grep over the materialised tree without tolerating failure", () => {
    const step = steps.find((step) => step.name === markerName);
    expect(step).toBeDefined();
    expect(step?.run).toContain("git grep -nI -E '^(<{7}( |$)|>{7}( |$)|={7}$)' -- .");
    // This file receives nothing but pull_request_target, so the tree searched
    // is always the pull request's and its path is the materialise step's
    // output — the step no longer branches on the event to decide that.
    expect(step?.env).toEqual({ PR_TREE: "${{ steps.pr-tree.outputs.path }}" });
    expect(step?.run).toContain(
      'cd "${PR_TREE:?the pull request tree was not materialised}"\n',
    );
    expect(step?.run).not.toContain("GITHUB_EVENT_NAME");
    expect(step?.if).toBeUndefined();
    expect(Boolean(step?.["continue-on-error"])).toBe(false);
  });

  it("searches the checked-out commit in the push leg, with no pull-request tree to name", () => {
    const step = pushSteps.find((step) => step.name === markerName);
    expect(step).toBeDefined();
    expect(step?.run).toContain("git grep -nI -E '^(<{7}( |$)|>{7}( |$)|={7}$)' -- .");
    expect(step?.env, "ci.yml has no materialise step, so there is no PR_TREE to pass").toEqual(
      undefined,
    );
    expect(step?.run).not.toContain("PR_TREE");
    expect(step?.if).toBeUndefined();
    expect(Boolean(step?.["continue-on-error"])).toBe(false);
  });

  it("contains exactly one commit-scope gate", () => {
    expect(steps.filter((step) => step.name === scopeName)).toHaveLength(1);
  });

  it("runs the commit-scope gate before Base freshness, which stays the last step", () => {
    const freshnessIndex = steps.findIndex((step) => step.name === "Base freshness");
    const scopeIndex = steps.findIndex((step) => step.name === scopeName);
    expect(freshnessIndex).toBeGreaterThan(-1);
    expect(scopeIndex).toBeGreaterThan(-1);
    expect(scopeIndex).toBeLessThan(freshnessIndex);
    expect(freshnessIndex).toBe(steps.length - 1);
  });

  it("runs the Python gate with no event gate, its file's trigger set being the gate", () => {
    const step = steps.find((step) => step.name === scopeName);
    expect(step).toBeDefined();
    expect(
      step?.run,
      "the base checkout's copy judges the merge tree's outgoing range",
    ).toBe('python3 "${GITHUB_WORKSPACE}/scripts/commit_scopes.py" --root "${PR_TREE:?}"');
    expect(step?.env).toEqual({ PR_TREE: "${{ steps.pr-tree.outputs.path }}" });
    expect(
      step?.if,
      "the step carries no event gate: an `if` naming a sibling event would be dead here, and the " +
        "file's closed pull_request_target trigger set is what keeps it off a push",
    ).toBeUndefined();
    expect(Boolean(step?.["continue-on-error"])).toBe(false);
  });
});
