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
 * Concurrency is the difference between a superseded pull request branch run
 * (fine to cancel) and a merged SHA's run (never fine): the deploy gate in
 * scripts/deploy-revision.sh reads the check conclusion for the SHA it deploys,
 * and a run cancelled by the next push to main concludes `cancelled`, which the
 * gate refuses. A push to main carries no pull_request number, so the group
 * falls back to the ref and every main push shares one group; a literal
 * `cancel-in-progress: true` then cancelled the previous merged SHA's run on
 * every merge (issue 474). The group stays per-pull-request with a ref
 * fallback, and cancellation itself is gated on the event being a pull request.
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

  it("scopes the group per pull request, falling back to the ref", () => {
    expect(
      concurrency.group,
      "the concurrency group must be ci-${{ github.event.pull_request.number || github.ref }} — per-pull-request, falling back to the ref for push and workflow_dispatch events",
    ).toBe("ci-${{ github.event.pull_request.number || github.ref }}");
  });

  it("cancels in-progress runs only when the event is a pull request", () => {
    expect(
      typeof concurrency["cancel-in-progress"],
      "cancel-in-progress must be a string holding the event expression, not a literal boolean",
    ).toBe("string");
    expect(
      concurrency["cancel-in-progress"],
      "cancel-in-progress must be the expression ${{ github.event_name == 'pull_request' }} — a literal true also cancels main pushes, and a cancelled check makes the deploy gate refuse the merged SHA",
    ).toBe("${{ github.event_name == 'pull_request' }}");
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
 * manual final-gate check: as the LAST step of each required job it issues the
 * freshness certificate only when the advance from the tested base to main's
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

  it("is the last step of each required job", () => {
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
      "Base freshness must be gated by the exact expression ${{ github.event_name == 'pull_request' }} — a substring pin also accepts a sibling event such as pull_request_target, which these workflows never trigger, so the gate would silently stop running",
    ).toBe("${{ github.event_name == 'pull_request' }}");
    expect(
      actionlintStep.if,
      "Base freshness must be gated by the exact expression ${{ github.event_name == 'pull_request' }} — a substring pin also accepts a sibling event such as pull_request_target, which these workflows never trigger, so the gate would silently stop running",
    ).toBe("${{ github.event_name == 'pull_request' }}");
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
