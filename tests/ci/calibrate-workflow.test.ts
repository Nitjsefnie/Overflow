import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { parse } from "yaml";

/**
 * The parsed shape of a calibrate-job step this suite reads. Steps this suite
 * does not reason about (checkout, setup-node, corepack) carry only `uses` or
 * `run`, which is why every field is optional. `if` is pinned on both the
 * fabrication and the measurement steps because an inverted or dropped
 * condition either fabricates during a real calibration or silently stops
 * measuring. `with` is pinned for the checkout because the refusal message
 * reads HEAD^1, which a depth-1 checkout does not fetch.
 */
type WorkflowStep = {
  name?: string;
  run?: string;
  uses?: string;
  if?: unknown;
  env?: Record<string, string | undefined>;
  with?: Record<string, unknown>;
};

/**
 * The parsed shape of the calibrate job itself: its trigger, its dependency on
 * the verify job's coverage summary, its write permission, and its steps.
 */
type CalibrateJob = {
  needs?: string | string[];
  if?: unknown;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

/**
 * The calibrate job raises the recorded coverage floor after a main push, and
 * doubles as the calibrate self-test: a workflow_dispatch carrying the
 * simulate-refused-raise input fabricates a raise so that main's branch
 * protection is guaranteed to refuse the bot push, and the job must then fail
 * VISIBLY — the inline shell this wiring replaces exited 0 on a refusal, so a
 * floor that silently stopped rising read as green (issue 684). The push half
 * lives in scripts/push-recalibration.ts, whose refusal behavior
 * tests/scripts/push-recalibration.test.ts covers; this suite pins the wiring
 * so the job cannot quietly go back to swallowing a refusal or stop being
 * dispatchable.
 *
 * Assertions are made on the parsed YAML data (job.if / step.name / step.run /
 * step.if), never on the raw bytes, so reformatting the file does not disturb
 * them and a rewired or un-gated step fails loudly here instead of quietly
 * changing what CI raises, and whether a refusal can still read as green.
 */
const PUSH_MAIN_CLAUSE =
  "github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.verify.outputs.docs_only != 'true'";
const DISPATCH_CLAUSE =
  "github.event_name == 'workflow_dispatch' && inputs.simulate-refused-raise == true";
const GATED_WHEN_SIMULATING = "${{ inputs.simulate-refused-raise != true }}";
const RUNS_WHEN_SIMULATING = "${{ inputs.simulate-refused-raise == true }}";

describe("the calibrate workflow's trigger", () => {
  let job: CalibrateJob | undefined;

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const workflow = parse(source) as { jobs?: { calibrate?: CalibrateJob } };

    job = workflow.jobs?.calibrate;
  });

  it("exists in the workflow", () => {
    expect(job, "the workflow must keep its calibrate job").toBeDefined();
  });

  it("still depends on the verify job's coverage summary", () => {
    expect(
      job?.needs,
      "the calibrate job must need verify — its coverage summary artifact is the calibration input",
    ).toBe("verify");
  });

  it("admits a main push and the dispatch self-test, never a pull request", () => {
    const condition = job?.if;

    expect(
      typeof condition,
      "the calibrate job must gate itself with an if condition",
    ).toBe("string");
    expect(
      condition,
      "the job must still run after a code push to main — that is the raise half",
    ).toContain(PUSH_MAIN_CLAUSE);
    expect(
      condition,
      "the job must also run on a workflow_dispatch carrying simulate-refused-raise — that is the self-test half whose refusal must fail the job",
    ).toContain(DISPATCH_CLAUSE);
    expect(
      condition,
      "a pull_request run must never be able to trigger the calibrate job — it would write to the branch it targets",
    ).not.toMatch(/github\.event_name == 'pull_request'/);
  });

  it("keeps write permission over contents", () => {
    expect(
      job?.permissions?.contents,
      "the push half needs contents:write — without it every push fails for the wrong reason",
    ).toBe("write");
  });
});

describe("the simulate-refused-raise input", () => {
  let input:
    | {
        description?: string;
        type?: string;
        default?: unknown;
      }
    | undefined;

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const workflow = parse(source) as {
      on?: {
        workflow_dispatch?: {
          inputs?: Record<
            string,
            { description?: string; type?: string; default?: unknown }
          >;
        };
      };
    };

    input = workflow.on?.workflow_dispatch?.inputs?.["simulate-refused-raise"];
  });

  it("is declared as a boolean input defaulting to false", () => {
    expect(
      input,
      "the workflow must declare the simulate-refused-raise input on workflow_dispatch — without it the self-test cannot be requested",
    ).toBeDefined();
    expect(
      input?.type,
      "the input must be typed boolean so the dispatch UI offers a checkbox and the job's if can compare against true",
    ).toBe("boolean");
    expect(
      input?.default,
      "the input must default to false — an accidental dispatch without the checkbox must take the ordinary raise path, never fabricate",
    ).toBe(false);
  });
});

describe("the calibrate job's steps", () => {
  let steps: WorkflowStep[] = [];

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const workflow = parse(source) as {
      jobs?: { calibrate?: CalibrateJob };
    };

    steps = workflow.jobs?.calibrate?.steps ?? [];
  });

  const named = (name: string) => steps.filter((step) => step.name === name);

  it("pushes the floor through the recalibration script, with the token through env", () => {
    const [step] = named("Push the recalibrated floor");

    expect(step, "the calibrate job must keep its push step").toBeDefined();
    expect(named("Push the recalibrated floor")).toHaveLength(1);
    expect(
      step?.run,
      "the push must run node scripts/push-recalibration.ts — the script fails the job on a refused push, which the inline shell it replaced did not",
    ).toBe("node scripts/push-recalibration.ts");
    expect(
      step?.env?.GH_TOKEN,
      "the push token must reach the script through env, never ${{ }} interpolation inside the run block",
    ).toBe("${{ github.token }}");
    expect(
      step?.if,
      "the push step must be unconditional within the job — it is exactly the step whose visible failure the self-test exists to exercise",
    ).toBeUndefined();
  });

  it("fabricates the simulated raise from the calibrate script's self-test mode", () => {
    const [step] = named("Fabricate the simulated raise");

    expect(step, "the calibrate job must keep its fabrication step").toBeDefined();
    expect(named("Fabricate the simulated raise")).toHaveLength(1);
    expect(
      step?.run,
      "the fabrication must run node scripts/calibrate-coverage.ts --simulate-refused-raise — the self-test's fabricated +5 raise computed from the recorded document alone",
    ).toBe("node scripts/calibrate-coverage.ts --simulate-refused-raise");
    expect(
      step?.if,
      "the fabrication step must run only when simulate-refused-raise is true — on an ordinary push it must never rewrite the record",
    ).toBe(RUNS_WHEN_SIMULATING);
  });

  it("gates the measurement steps off while simulating", () => {
    for (const name of ["Download coverage summary", "Calibrate the coverage floor"]) {
      const [step] = named(name);

      expect(step, `the calibrate job must keep its ${name} step`).toBeDefined();
      expect(
        step?.if,
        `${name} must be gated by ${GATED_WHEN_SIMULATING} — a simulated run has no coverage summary, and the real calibrate step would overwrite the fabricated document`,
      ).toBe(GATED_WHEN_SIMULATING);
    }
  });

  it("orders fabrication between the measurement it replaces and the push it feeds", () => {
    const calibrateIndex = steps.findIndex(
      (step) => step.name === "Calibrate the coverage floor",
    );
    const fabricateIndex = steps.findIndex(
      (step) => step.name === "Fabricate the simulated raise",
    );
    const pushIndex = steps.findIndex(
      (step) => step.name === "Push the recalibrated floor",
    );

    expect(calibrateIndex).toBeGreaterThan(-1);
    expect(fabricateIndex).toBeGreaterThan(-1);
    expect(pushIndex).toBeGreaterThan(-1);
    expect(
      fabricateIndex,
      "the fabrication must come after the real calibration so the two can never both run",
    ).toBeGreaterThan(calibrateIndex);
    expect(
      pushIndex,
      "the push must come after the fabrication so the self-test pushes the fabricated document",
    ).toBeGreaterThan(fabricateIndex);
  });

  it("checks out depth 2 so the refusal message can read HEAD^1", () => {
    const [checkout] = steps.filter((step) => step.uses?.includes("actions/checkout"));

    expect(checkout, "the calibrate job must check out the repository").toBeDefined();
    expect(
      checkout?.with?.["fetch-depth"],
      "the checkout must set fetch-depth: 2 — scripts/push-recalibration.ts reads the recorded floor from HEAD^1 for its refusal message, and a depth-1 checkout degrades the message to its unreadable-floors fallback",
    ).toBe(2);
    expect(
      checkout?.with?.["persist-credentials"],
      "the checkout must still leave no credentials in .git/config",
    ).toBe(false);
  });
});
