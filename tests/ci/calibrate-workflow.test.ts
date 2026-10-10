import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";

import { parse } from "yaml";

/**
 * The calibrate job raises the recorded coverage floor after a main push, and
 * doubles as the calibrate self-test: a workflow_dispatch carrying the
 * simulate-refused-raise input fabricates a raise so that main's branch
 * protection is guaranteed to refuse the bot push, and a job must then fail
 * VISIBLY — the inline shell a previous wiring replaced exited 0 on a refusal,
 * so a floor that silently stopped rising read as green (issue 684). Issue
 * 1036 splits that single job along its privilege boundary: calibrate computes
 * the recalibrated document with no write token — its scripts run on Node
 * built-ins alone, so it installs nothing — and push-recalibration, the only
 * contents: write holder in the file, commits and pushes the document bytes
 * calibrate exported while running no repository or dependency code. This
 * suite pins the wiring: the trigger, the token boundary, the no-install
 * shape, and the output handoff the push job consumes. The push job's
 * behavioral half — what its shell actually does to a repository — is covered
 * by tests/ci/push-recalibration-step.test.ts, which executes the step's real
 * `run:` text.
 *
 * Assertions are made on the parsed YAML data (job.if / step.name / step.run /
 * step.if), never on the raw bytes, so reformatting the file does not disturb
 * them and a rewired or un-gated step fails loudly here instead of quietly
 * changing what CI raises, and whether a refusal can still read as green.
 */
type WorkflowStep = {
  name?: string;
  id?: string;
  run?: string;
  uses?: string;
  if?: unknown;
  env?: Record<string, string | undefined>;
  with?: Record<string, unknown>;
};

/**
 * The parsed shape of the calibrate job itself: its trigger, its dependency on
 * the verify job's coverage summary, the document outputs the push job
 * consumes, and its steps.
 */
type CalibrateJob = {
  needs?: string | string[];
  if?: unknown;
  permissions?: Record<string, string>;
  outputs?: Record<string, string>;
  env?: Record<string, string | undefined>;
  steps?: WorkflowStep[];
};

/**
 * The parsed shape of the push job: its dependency on calibrate's document
 * outputs, its write permission, and its steps.
 */
type PushJob = {
  needs?: string | string[];
  if?: unknown;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
};

/**
 * The calibrate job still runs after a code push to main and on the dispatch
 * self-test. Pinned byte for byte against the job's `if:` in
 * .github/workflows/ci.yml — read out of the parsed YAML, not hand-copied — so
 * no disjunct, in particular a pull_request_target disjunct, can slip into the
 * trigger without a conscious edit to this constant.
 */
const PUSH_MAIN_CLAUSE =
  "github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.verify.outputs.docs_only != 'true'";
const DISPATCH_CLAUSE =
  "github.event_name == 'workflow_dispatch' && inputs.simulate-refused-raise == true";
const EXACT_CONDITION =
  "${{ (github.event_name == 'push' && github.ref == 'refs/heads/main' && needs.verify.outputs.docs_only != 'true') || (github.event_name == 'workflow_dispatch' && inputs.simulate-refused-raise == true) }}";
const GATED_WHEN_SIMULATING = "${{ inputs.simulate-refused-raise != true }}";
const RUNS_WHEN_SIMULATING = "${{ inputs.simulate-refused-raise == true }}";
/** The push job's whole condition: only a changed document reaches a push. */
const PUSH_JOB_IF = "${{ needs.calibrate.outputs.changed == 'true' }}";

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
      "the job must also run on a workflow_dispatch carrying simulate-refused-raise — that is the self-test half whose refusal must fail a job",
    ).toContain(DISPATCH_CLAUSE);
    expect(
      condition,
      "the calibrate job's if condition is pinned exactly — a new disjunct, in particular a pull_request_target one, must require a conscious edit to EXACT_CONDITION",
    ).toBe(EXACT_CONDITION);
    expect(
      condition,
      "a pull_request-family run must never be able to trigger the calibration — it would feed PR-authored coverage into the record and the push",
    ).not.toMatch(/github\.event_name == 'pull_request/);
  });

  it("holds no write token", () => {
    expect(
      job?.permissions,
      "the calibrate job must declare no permissions block — it inherits the workflow's contents: read, " +
        "which is every scope its steps use; the write token moved to the push-recalibration job, which runs " +
        "no repository code (issue 1036)",
    ).toBeUndefined();
  });

  it("publishes exactly the two outputs the push job consumes", () => {
    expect(
      job?.outputs,
      "the calibrate job must publish the push job's inputs and nothing else — a third output is a " +
        "channel nothing reads",
    ).toEqual({
      changed: "${{ steps.document.outputs.changed }}",
      document: "${{ steps.document.outputs.document }}",
    });
  });
});

describe("the push-recalibration job", () => {
  let job: PushJob | undefined;
  let steps: WorkflowStep[] = [];

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const workflow = parse(source) as {
      jobs?: { "push-recalibration"?: PushJob };
    };

    job = workflow.jobs?.["push-recalibration"];
    steps = job?.steps ?? [];
  });

  const named = (name: string) => steps.filter((step) => step.name === name);

  it("exists in the workflow", () => {
    expect(job, "the workflow must keep its push-recalibration job").toBeDefined();
  });

  it("runs only when calibrate exported a changed document", () => {
    expect(
      job?.needs,
      "the push job must need calibrate — its changed output is the only warrant to push, and a " +
        "docs-only push skips calibrate and must skip this job with it",
    ).toBe("calibrate");
    expect(
      job?.if,
      "the push job's if condition is pinned exactly — only a changed document may reach a push",
    ).toBe(PUSH_JOB_IF);
  });

  it("holds the only write token, scoped to contents", () => {
    expect(
      job?.permissions,
      "the push job needs exactly contents:write — without it every push fails for the wrong reason, " +
        "and anything wider grants the push more than it can use",
    ).toEqual({ contents: "write" });
  });

  it("carries no action besides the checkout and exactly one run step", () => {
    const actions = steps.filter((step) => step.uses !== undefined);
    const runs = steps.filter((step) => step.run !== undefined);

    expect(
      actions.map((step) => step.uses!.replace(/@[0-9a-f]{40}$/, "@")),
      "the push job's only action is the checkout — a setup-node or a download action here would be " +
        "a dependency the push does not need",
    ).toEqual(["actions/checkout@"]);
    expect(runs, "the push job must carry exactly one run step").toHaveLength(1);
  });

  it("checks out the triggering commit at depth 2, leaving no credentials", () => {
    const [checkout] = steps.filter((step) => step.uses !== undefined);

    expect(
      checkout?.with,
      "persist-credentials: false keeps the token out of .git/config, and fetch-depth: 2 is what the " +
        "refusal message reads — the recorded floor from HEAD^1, which a depth-1 checkout degrades to " +
        "the unreadable-floors fallback",
    ).toEqual({ "persist-credentials": false, "fetch-depth": 2 });
  });

  it("receives the document and the token through env, never interpolated into the shell", () => {
    const [step] = named("Commit and push the recalibrated floor");

    expect(step, "the push job must keep its push step").toBeDefined();
    expect(named("Commit and push the recalibrated floor")).toHaveLength(1);
    expect(
      step?.env,
      "the token and the document reach the shell through env, never through ${{ }} in the run block, " +
        "and the network-git pins mirror what the script set",
    ).toEqual({
      GH_TOKEN: "${{ github.token }}",
      DOCUMENT: "${{ needs.calibrate.outputs.document }}",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "true",
    });
    expect(
      step?.run,
      "a ${{ }} in the run block would let a context value become shell text; every input arrives via env",
    ).not.toContain("${{");
  });

  it("executes no repository or dependency code", () => {
    const [step] = named("Commit and push the recalibrated floor");
    const lines = (step?.run ?? "").split("\n");
    const interpreters = [
      "node",
      "npm",
      "npx",
      "pnpm",
      "pnpx",
      "yarn",
      "corepack",
      "tsx",
      "deno",
      "python",
      "python3",
    ];

    for (const line of lines) {
      const command = line.trim().split(/\s+/)[0] ?? "";
      expect(
        interpreters.includes(command),
        `the push job must run no repository or dependency code; its run block invokes "${command}"`,
      ).toBe(false);
    }
  });

  it("mirrors the script's refusal semantics in shell", () => {
    const run = named("Commit and push the recalibrated floor")[0]?.run ?? "";

    expect(
      run,
      "the bot identity is set per command, never persisted to the repository's config",
    ).toContain('user.name="github-actions[bot]"');
    expect(run).toContain(
      'user.email="41898282+github-actions[bot]@users.noreply.github.com"',
    );
    expect(run, "the commit message is the script's").toContain(
      'commit -m "ci: update CI ratchets"',
    );
    expect(run, "the refspec is the script's").toContain("HEAD:refs/heads/main");
    expect(run, "a refusal must fail the job visibly (issue 684)").toContain(
      "::error::coverage-floor recalibration refused",
    );
    expect(run, "the one retry replays onto the fetched remote main").toContain(
      "git fetch --depth=2",
    );
    expect(run, "a failed replay aborts, never leaves a rebase in progress").toContain(
      "git rebase --abort",
    );
    expect(
      run,
      "the no-op half of the script is kept: a document already at the record pushes nothing",
    ).toContain("coverage floor already current; nothing to push");
    expect(
      run,
      "the token must be replaced in git's output before any of it prints",
    ).toContain("redact");
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
  let job: CalibrateJob | undefined;
  let steps: WorkflowStep[] = [];

  beforeAll(async () => {
    const source = await readFile(resolve(".github/workflows/ci.yml"), "utf8");
    const workflow = parse(source) as {
      jobs?: { calibrate?: CalibrateJob };
    };

    job = workflow.jobs?.calibrate;
    steps = job?.steps ?? [];
  });

  const named = (name: string) => steps.filter((step) => step.name === name);

  it("installs nothing, because its scripts run on Node built-ins alone", () => {
    // The issue's own reproduction: git-archive the three scripts plus the
    // floor document into a directory with no node_modules and
    // calibrate-coverage.ts loads and runs — it imports node:fs, node:path,
    // node:url and node:child_process, and the one module beside it. The
    // install this job used to run repeated the one verify had just done for
    // the same push, on a job that measures a JSON document.
    for (const name of ["Install dependencies", "Enable the pinned package manager"]) {
      expect(
        named(name),
        `the calibrate job must no longer carry a ${name} step — it runs no pnpm, so the install and ` +
          "the corepack pins it needed are gone (issue 1036)",
      ).toHaveLength(0);
    }
    for (const step of steps) {
      expect(
        step.run ?? "",
        `no step of the calibrate job may invoke pnpm: "${step.name}" does`,
      ).not.toContain("pnpm");
    }
    expect(
      job?.env?.COREPACK_ENABLE_PROJECT_SPEC,
      "the job-level corepack pin existed only for pnpm steps; with none left it is gone",
    ).toBeUndefined();
    expect(
      job?.env?.npm_config_registry,
      "the job-level registry pin existed only for pnpm steps; with none left it is gone",
    ).toBeUndefined();
  });

  it("keeps the calibration run off while the self-test fabricates its raise", () => {
    for (const name of ["Download coverage summary", "Calibrate the coverage floor"]) {
      const [step] = named(name);

      expect(step, `the calibrate job must keep its ${name} step`).toBeDefined();
      expect(
        step?.if,
        `${name} must be gated by ${GATED_WHEN_SIMULATING} — a simulated run has no coverage summary, and the real calibrate step would overwrite the fabricated document`,
      ).toBe(GATED_WHEN_SIMULATING);
    }
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

  it("exports the document once, unconditionally, with the diff as the changed gate", () => {
    const [step] = named("Export the recalibrated document");

    expect(step, "the calibrate job must keep its export step").toBeDefined();
    expect(named("Export the recalibrated document")).toHaveLength(1);
    expect(
      step?.id,
      "the job's outputs read the step by the id `document`",
    ).toBe("document");
    expect(
      step?.if,
      "the export must be unconditional within the job — a simulated run exports the fabricated document, " +
        "an ordinary one exports whatever the measurement wrote",
    ).toBeUndefined();
    expect(
      step?.run,
      "changed is the diff of the document against the record HEAD carries",
    ).toContain("git diff --quiet -- scripts/coverage.json");
    expect(
      step?.run,
      "the document leaves through a heredoc whose delimiter cannot occur in the machine-written JSON",
    ).toContain("document<<COVERAGE_FLOOR_DOCUMENT_END");
  });

  it("carries no push step — the push half moved to push-recalibration", () => {
    expect(
      named("Push the recalibrated floor"),
      "the calibrate job must not push: it holds no write token, and the push step lives in " +
        "push-recalibration (issue 1036)",
    ).toHaveLength(0);
    expect(
      steps.some((step) => (step.run ?? "").includes("push-recalibration")),
      "the calibrate job's run blocks must not reference the push script — the push is shell in the other job",
    ).toBe(false);
  });

  it("orders fabrication between the measurement it replaces and the export it feeds", () => {
    const calibrateIndex = steps.findIndex(
      (step) => step.name === "Calibrate the coverage floor",
    );
    const fabricateIndex = steps.findIndex(
      (step) => step.name === "Fabricate the simulated raise",
    );
    const exportIndex = steps.findIndex(
      (step) => step.name === "Export the recalibrated document",
    );

    expect(calibrateIndex).toBeGreaterThan(-1);
    expect(fabricateIndex).toBeGreaterThan(-1);
    expect(exportIndex).toBeGreaterThan(-1);
    expect(
      fabricateIndex,
      "the fabrication must come after the real calibration so the two can never both run",
    ).toBeGreaterThan(calibrateIndex);
    expect(
      exportIndex,
      "the export must come after the fabrication so the self-test exports the fabricated document",
    ).toBeGreaterThan(fabricateIndex);
  });

  it("checks out the tree it measures at depth 1, leaving no credentials", () => {
    const [checkout] = steps.filter((step) => step.uses?.includes("actions/checkout"));

    expect(checkout, "the calibrate job must check out the repository").toBeDefined();
    expect(
      checkout?.with?.["fetch-depth"],
      "depth 1: the job diffs the document against HEAD, and the HEAD^1 read the old depth-2 checkout " +
        "served moved to the push job with the refusal message",
    ).toBe(1);
    expect(
      checkout?.with?.["persist-credentials"],
      "the checkout must still leave no credentials in .git/config",
    ).toBe(false);
  });
});
