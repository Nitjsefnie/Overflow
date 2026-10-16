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
    // pr-suite.yml, whose completed outcome verify reads as data.
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

describe("the verify workflow's ratchet documents", () => {
  it("are judged by the ratchet-guard workflows, not by a step of the verify job", async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const workflow = parse(source) as { jobs?: { verify?: { steps?: WorkflowStep[] } } };
    const steps = workflow.jobs?.verify?.steps ?? [];
    expect(steps.filter((step) => step.name === "Ratchet documents")).toEqual([]);
    expect(steps.filter((step) => (step.run ?? "").includes("check-ratchets.ts"))).toEqual([]);

    // pr-gates.yml's ratchet-guard job judges the PR head as git-object data.
    // Read its step directly from the privileged aggregate.
    const guard = parse(await readFile(resolve(".github/workflows/pr-gates.yml"), "utf8")) as {
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

  it("runs in a file whose only trigger is workflow_run, so it needs no event gate", () => {
    const [step] = migrationImmutability();
    expect(step, "the verify job must contain the Migration immutability step").toBeDefined();
    expect(
      Object.keys((triggers ?? {}) as Record<string, unknown>),
      "the merge-range gates read the pull request's merge commit, so the file holding them must " +
        "be reachable by workflow_run alone (issue 1090)",
    ).toEqual(["workflow_run"]);
    expect(
      step?.if,
      "the step skips only API-proven superseded cancellations",
    ).toBe("${{ steps.pr.outputs.superseded != 'true' }}");
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
      "the step skips only API-proven superseded cancellations",
    ).toBe("${{ steps.pr.outputs.superseded != 'true' }}");
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

describe("the verify workflows' concurrency groups", () => {
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

  it("isolates each triggering suite head so stale completions cannot cancel a current head", () => {
    expect(
      pr.group,
      "ci-pr.yml's concurrency group must be ci-pr-${{ github.event.workflow_run.head_sha }} — each triggering head has its own group",
    ).toBe("ci-pr-${{ github.event.workflow_run.head_sha }}");
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
        `${file}: cancel-in-progress must be false to preserve running verify attempts; ` +
          "head-SHA isolation prevents out-of-order suite completions from cancelling another head",
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
  let actionlintPrTriggers: unknown;
  let ciPrTriggers: unknown;

  const freshness = (steps: WorkflowStep[]) =>
    steps.filter((step) => step.name === "Base freshness");

  beforeAll(async () => {
    const [ciPr, actionlintPr] = await Promise.all([
      readFile(resolve(".github/workflows/ci-pr.yml"), "utf8"),
      readFile(resolve(".github/workflows/pr-gates.yml"), "utf8"),
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

  it("lives in its producer file with exactly the admitted trigger, so it needs no event gate", () => {
    for (const [label, triggers, steps] of [
      ["verify", ciPrTriggers, verifySteps],
      ["actionlint", actionlintPrTriggers, actionlintSteps],
    ] as const) {
      const [step] = freshness(steps);
      expect(step, `the ${label} pull-request job must contain the Base freshness step`).toBeDefined();
      expect(
        Object.keys((triggers ?? {}) as Record<string, unknown>),
        `${label}: the Base freshness step is ungated, which is only correct while this file ` +
          "receives only its admitted trigger. An added push or workflow_dispatch trigger " +
          "here would make the step run on main's own pushes, where github.event.pull_request.* " +
          "resolves to nothing.",
      ).toEqual(label === "verify" ? ["workflow_run"] : ["pull_request_target"]);
      expect(
        step.if,
        `${label}: only verify skips an API-proven superseded cancellation`,
      ).toBe(label === "verify" ? "${{ steps.pr.outputs.superseded != 'true' }}" : undefined);
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

  it("wires verify from resolver outputs and actionlint from its PR event, through env", () => {
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
    ).toEqual({ ...expectedEnv,
      BASE_SHA: "${{ steps.pr-tree.outputs.freshness_base_sha }}",
      BASE_REF: "${{ steps.pr.outputs.base_ref }}",
      PR_NUMBER: "${{ steps.pr.outputs.pr_number }}",
      HEAD_SHA: "${{ steps.pr.outputs.head_sha }}",
    });
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

  it("confines secrets to ci.yml's push-recalibration job and references none in ci-pr.yml", () => {
    const secretRefs: string[] = [];
    const ciOutsidePush = {
      ...workflow,
      jobs: Object.fromEntries(
        Object.entries(workflow.jobs ?? {}).filter(([name]) => name !== "push-recalibration"),
      ),
    };
    for (const [label, parsed] of [["ci.yml", ciOutsidePush], ["ci-pr.yml", prWorkflow]] as const) {
      visitStrings(parsed, (text) => {
        if (text.includes("secrets.")) secretRefs.push(`${label}: ${text}`);
      });
    }

    expect(
      secretRefs,
      "ci-pr.yml runs workflow_run and must therefore reference no secret — " +
        "a `${{ secrets.… }}` in any with:/env: value would hand PR-authored input " +
        "the run's secret context. ci.yml may reference secrets only inside " +
        "push-recalibration: calibrate gates it on a push to main or workflow_dispatch, " +
        "and the push job executes no repository code. No other job or workflow-level " +
        "setting may reference a secret.",
    ).toEqual([]);
  });

  it("grants each workflow exactly contents: read", () => {
    for (const [label, parsed] of [["ci.yml", workflow], ["ci-pr.yml", prWorkflow]] as const) {
      expect(
        parsed.permissions,
        `${label}: the workflow-level permissions must be exactly { contents: read } — the ` +
          "token a base-defined run carries must stay read-only over contents, with no " +
          "extra scope added anywhere",
      ).toEqual({ contents: "read" });
    }
  });

  it("carries exactly one ungated checkout in each leg, each shaped for what it checks out", () => {
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
        "{workflow_run}",
    ).toBeUndefined();

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
  });

  it("confines each job's permissions: override to what its steps actually need", () => {
    expect(
      Object.entries(workflow.jobs ?? {})
        .filter(([, job]) => job !== undefined && "permissions" in job)
        .map(([name]) => name),
      "only push-recalibration may carry a permissions: override in ci.yml (its contents: write is pinned " +
        "by tests/ci/calibrate-workflow.test.ts and it runs only when calibrate exported a changed " +
        "document); a verify " +
        "override here would be a scope no step in that job uses",
    ).toEqual(["push-recalibration"]);

    // ci-pr.yml keeps verify's read-only actions: read — the base copy of the
    // suite awaiter reads the triggering run and downloads its
    // coverage summary — and nothing that writes.
    expect(
      Object.entries(prWorkflow.jobs ?? {})
        .filter(([, job]) => job !== undefined && "permissions" in job)
        .map(([name]) => name),
      "ci-pr.yml has no calibrate job, so only verify may carry a permissions: override",
    ).toEqual(["verify"]);
    expect(
      prWorkflow.jobs?.verify?.permissions,
      "verify adds actions: read for the suite and artifact, pull-requests: read for binding, and no write grant",
    ).toEqual({ contents: "read", actions: "read", "pull-requests": "read" });
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

  it("sets up Node before resolving the PR, then materialises and immediately checks markers", () => {
    const checkouts = steps.flatMap((step, index) =>
      step.uses?.startsWith("actions/checkout@") ? [index] : [],
    );
    const materialiseIndex = steps.findIndex((step) => (step.run ?? "").includes("git worktree add"));
    const resolverIndex = steps.findIndex((step) => (step.run ?? "").includes("/scripts/resolve-suite-pull-request.ts"));
    const nodeIndex = steps.findIndex((step) => step.uses?.startsWith("actions/setup-node@"));
    const markerIndex = steps.findIndex((step) => step.name === markerName);
    expect(checkouts).toHaveLength(1);
    expect(nodeIndex).toBe(checkouts[0]! + 1);
    expect(resolverIndex).toBe(nodeIndex + 1);
    expect(materialiseIndex).toBe(resolverIndex + 1);
    expect(markerIndex).toBeGreaterThan(-1);
    expect(markerIndex).toBe(materialiseIndex + 1);
  });

  it("runs the tracked-text marker grep over the materialised tree without tolerating failure", () => {
    const step = steps.find((step) => step.name === markerName);
    expect(step).toBeDefined();
    expect(step?.run).toContain("git grep -nI -E '^(<{7}( |$)|>{7}( |$)|={7}$)' -- .");
    // This file receives nothing but workflow_run, so the tree searched
    // is always the pull request's and its path is the materialise step's
    // output — the step no longer branches on the event to decide that.
    expect(step?.env).toEqual({ PR_TREE: "${{ steps.pr-tree.outputs.path }}" });
    expect(step?.run).toContain(
      'cd "${PR_TREE:?the pull request tree was not materialised}"\n',
    );
    expect(step?.run).not.toContain("GITHUB_EVENT_NAME");
    expect(step?.if).toBe("${{ steps.pr.outputs.superseded != 'true' }}");
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
      "the step skips only API-proven superseded cancellations",
    ).toBe("${{ steps.pr.outputs.superseded != 'true' }}");
    expect(Boolean(step?.["continue-on-error"])).toBe(false);
  });
});


describe("the verify workflow's prerender step", () => {
  let steps: WorkflowStep[] = [];
  beforeAll(async () => {
    const workflow = parse(await readFile(resolve(".github/workflows/ci.yml"), "utf8"));
    steps = workflow.jobs.verify.steps;
  });

  it("runs the SQL statement budget gate beside geometry after database migration", () => {
    const checks = steps.filter((step) => step.name === "SQL statement budget check");
    expect(checks).toHaveLength(1);
    const step = checks[0]!;
    expect(step.run).toBe("node scripts/check-perf-budget.ts");
    const migration = steps.findIndex((entry) => entry.name === "Apply PostgreSQL migrations");
    expect(migration).toBeGreaterThan(-1);
    expect(steps.indexOf(step)).toBeGreaterThan(migration);
    expect(Math.abs(steps.indexOf(step) - steps.findIndex((entry) => entry.name === "Page geometry check"))).toBe(1);
    expect(step.if).toBeUndefined();
    expect((step as { "continue-on-error"?: unknown })["continue-on-error"]).toBeFalsy();
  });

  it("runs the prerender check after the production build, beside geometry, as a required gate", () => {
    const checks = steps.filter((step) => step.name === "Prerendered routes check");
    expect(checks).toHaveLength(1);
    const step = checks[0]!;
    expect(step.run).toBe("node scripts/check-prerendered-routes.ts");
    const build = steps.findIndex((entry) => entry.name === "Production build");
    expect(build).toBeGreaterThan(-1);
    expect(steps.indexOf(step)).toBeGreaterThan(build);
    expect(Math.abs(steps.indexOf(step) - steps.findIndex((entry) => entry.name === "Page geometry check"))).toBe(1);
    expect(step.if).toBeUndefined();
    expect(step["continue-on-error"]).toBeFalsy();
  });
});
