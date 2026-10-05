import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { commitFiles, git, scratchGitEnv } from "../support/scratch-git";

/**
 * The verify job's pull_request_target leg, EXECUTED rather than read.
 *
 * Under that event the job checks out the base branch, materialises the pull
 * request's merge commit as a detached worktree outside the workspace, and
 * runs the base checkout's own gate scripts over that tree as data. The
 * property that matters is that the pull request cannot judge itself: a pull
 * request that edits a gated file AND replaces the gate script that would
 * catch it must still be refused, because the script that runs is the
 * base's.
 *
 * Each case builds an origin repository whose main carries the real gate
 * scripts, a pull request branch, and a merge commit published as
 * refs/pull/1/merge (base tip first parent, head second, the shape GitHub
 * publishes). The workspace is a full clone of main — the checkout the step
 * list starts from — and the steps' own `run:` blocks are executed with the
 * runner's shell flags. Each step's own `env:` is resolved the way the runner
 * would: `${{ steps.pr-tree.outputs.* }}` from what the materialise step wrote
 * to GITHUB_OUTPUT, and any other expression only from a value the case
 * supplies — an expression nobody resolves throws rather than reading empty.
 */

type Step = { name?: string; id?: string; run?: string; env?: Record<string, string> };

let steps: Step[] = [];
let root = "";
let counter = 0;

beforeAll(async () => {
  const workflow = parse(await readFile(resolve(".github/workflows/ci.yml"), "utf8")) as {
    jobs: { verify: { steps: Step[] } };
  };
  steps = workflow.jobs.verify.steps;
  root = await mkdtemp(join(tmpdir(), "verify-pr-tree-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

function stepRunning(needle: string): Step {
  const matching = steps.filter((step) => (step.run ?? "").includes(needle));
  expect(matching.map((step) => step.name), `exactly one verify step runs ${needle}`).toHaveLength(1);
  return matching[0]!;
}

const GATE_SCRIPTS = [
  "scripts/docs-only.ts",
  "scripts/check-migration-edits.ts",
  "scripts/check-module-size.ts",
  "scripts/check-coverage-floor.ts",
  "scripts/commit_scopes.py",
];

const MODULE_SIZE_DOC = `${JSON.stringify(
  {
    ceilings: { src: 800, tests: 2500, tooling: 800, stylesheets: 800, migrations: 400 },
    module_size_baseline: {},
  },
  null,
  2,
)}\n`;

const NEUTERED = "process.exit(0);\n";

type Fixture = { origin: string; workspace: string; merge: string; head: string };

/**
 * An origin whose main carries the real gate scripts, a pull request whose
 * head commits `files`, and the merge ref GitHub would publish for it.
 */
async function fixture(files: Record<string, string>, message = "pull request change"): Promise<Fixture> {
  counter += 1;
  const origin = join(root, `origin-${counter}`);
  await mkdir(join(origin, "scripts"), { recursive: true });
  git(origin, "init", "--quiet", "--initial-branch=main");
  for (const script of GATE_SCRIPTS) {
    await copyFile(resolve(script), join(origin, script));
  }
  await commitFiles(
    origin,
    {
      "README.md": "# scratch\n",
      "src/a.ts": "export const a = 0;\n",
      "db/migrations/001_initial.sql": "create table t (id int);\n",
      "scripts/module-size.json": MODULE_SIZE_DOC,
      "scripts/coverage.json": await readFile(resolve("scripts/coverage.json"), "utf8"),
      ".github/workflows/lint.yml": "name: lint\non: push\njobs: {}\n",
    },
    "root",
  );
  git(origin, "checkout", "--quiet", "-b", "feature");
  const head = await commitFiles(origin, files, message);
  git(origin, "checkout", "--quiet", "main");
  await commitFiles(origin, { "CHANGELOG.md": "# changes\n" }, "base advance");
  git(origin, "checkout", "--quiet", "--detach", "main");
  git(origin, "merge", "--quiet", "--no-ff", "--no-edit", "feature");
  const merge = git(origin, "rev-parse", "HEAD");
  git(origin, "update-ref", "refs/pull/1/merge", merge);
  git(origin, "update-ref", "refs/pull/1/head", head);
  git(origin, "checkout", "--quiet", "main");

  const workspace = join(root, `workspace-${counter}`);
  git(root, "clone", "--quiet", "--no-local", `file://${origin}`, workspace);
  return { origin, workspace, merge, head };
}

type StepResult = { status: number | null; stdout: string; stderr: string; output: string };

/**
 * A step's `env:` as the runner would present it: each value that is exactly
 * a pr-tree output expression resolves from `outputs`; every other
 * expression must be supplied by the case through `given`.
 */
function stepEnv(
  step: Step,
  outputs: Record<string, string>,
  given: Record<string, string>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(step.env ?? {})) {
    const output = /^\$\{\{ steps\.pr-tree\.outputs\.([\w-]+) \}\}$/.exec(value);
    if (output) {
      if (outputs[output[1]!] === undefined) throw new Error(`${key}: no pr-tree output ${output[1]}`);
      resolved[key] = outputs[output[1]!]!;
    } else if (key in given) {
      resolved[key] = given[key]!;
    } else if (value.includes("${{")) {
      throw new Error(`${step.name}: ${key} is ${value}, which this case does not supply`);
    } else {
      resolved[key] = value;
    }
  }
  for (const key of Object.keys(given)) {
    if (!(key in resolved)) resolved[key] = given[key]!;
  }
  return resolved;
}

/** Runs one step's `run:` block the way the runner does. */
async function runStep(
  step: Step,
  fx: Fixture,
  given: Record<string, string>,
  outputs: Record<string, string>,
): Promise<StepResult> {
  counter += 1;
  const script = join(root, `step-${counter}.sh`);
  const output = join(root, `output-${counter}`);
  await writeFile(script, step.run ?? "exit 99\n");
  await writeFile(output, "");
  const result = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    cwd: fx.workspace,
    encoding: "utf8",
    env: {
      ...scratchGitEnv,
      ...stepEnv(step, outputs, given),
      GITHUB_WORKSPACE: fx.workspace,
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_OUTPUT: output,
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: await readFile(output, "utf8") };
}

/** GITHUB_OUTPUT's `key=value` lines as a map. */
function readOutputs(text: string): Record<string, string> {
  const entries: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const at = line.indexOf("=");
    if (at > 0) entries[line.slice(0, at)] = line.slice(at + 1);
  }
  return entries;
}

/** Materialises the merge tree; returns the outputs later steps read. */
async function materialise(fx: Fixture, headSha = fx.head) {
  counter += 1;
  const runnerTemp = join(root, `runner-temp-${counter}`);
  await mkdir(runnerTemp);
  const result = await runStep(
    stepRunning("git worktree add --detach"),
    fx,
    { PR_NUMBER: "1", HEAD_SHA: headSha, RUNNER_TEMP: runnerTemp },
    {},
  );
  return { result, outputs: readOutputs(result.output), runnerTemp };
}

describe("the pull request tree the pull_request_target leg judges", () => {
  it("is the merge commit, checked out outside the workspace and exported to later steps", async () => {
    const fx = await fixture({ "src/a.ts": "export const a = 1;\n" });
    const { result, outputs, runnerTemp } = await materialise(fx);

    expect(result.status, result.stderr).toBe(0);
    expect(outputs.merge_sha).toBe(fx.merge);
    expect(outputs.path?.startsWith(`${runnerTemp}/`)).toBe(true);
    expect(git(outputs.path!, "rev-parse", "HEAD")).toBe(fx.merge);
    // The workspace itself stays on the base tip: that is the copy that runs.
    expect(git(fx.workspace, "rev-parse", "HEAD")).toBe(git(fx.origin, "rev-parse", "main"));
  });

  it("fails closed when the merge commit's second parent is not the event's head", async () => {
    const fx = await fixture({ "src/a.ts": "export const a = 1;\n" });
    const stale = git(fx.origin, "rev-parse", "main");
    const { result, outputs } = await materialise(fx, stale);

    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("::error::");
    expect(outputs).toEqual({});
  });
});

describe("a pull request that replaces the gate script guarding what it changed", () => {
  it("is still refused by migration immutability, because the base copy runs", async () => {
    const fx = await fixture({
      "db/migrations/001_initial.sql": "create table t (id int);\n-- edited\n",
      "scripts/check-migration-edits.ts": NEUTERED,
    });
    const { result: made, outputs } = await materialise(fx);
    expect(made.status, made.stderr).toBe(0);

    const result = await runStep(stepRunning("/scripts/check-migration-edits.ts"), fx, {}, outputs);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("db/migrations is append-only");
  });

  it("is still classified as code by the base copy of the docs-only detection", async () => {
    const fx = await fixture({
      "src/a.ts": "export const a = 2;\n",
      "scripts/docs-only.ts": 'process.stdout.write("true\\n");\n',
    });
    const { outputs } = await materialise(fx);

    const detect = stepRunning("/scripts/docs-only.ts");
    const result = await runStep(
      detect,
      fx,
      { EVENT_NAME: "pull_request_target", PUSH_BEFORE: "", DISPATCH_BASE: "", PR_NUMBER: "1" },
      outputs,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("docs_only=false\n");
  });

  it("is classified docs-only by the base copy when it changes only documentation", async () => {
    const fx = await fixture({ "README.md": "# scratch, edited\n" });
    const { outputs } = await materialise(fx);

    const result = await runStep(
      stepRunning("/scripts/docs-only.ts"),
      fx,
      { EVENT_NAME: "pull_request_target", PUSH_BEFORE: "", DISPATCH_BASE: "", PR_NUMBER: "1" },
      outputs,
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.output).toBe("docs_only=true\n");
  });

  it("is still refused by the module size ceilings, read over the pull request's tree", async () => {
    const fx = await fixture({
      "src/big.ts": "export const x = 0;\n".repeat(801),
      "scripts/check-module-size.ts": NEUTERED,
    });
    const { outputs } = await materialise(fx);

    const result = await runStep(stepRunning("/scripts/check-module-size.ts"), fx, {}, outputs);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("src/big.ts");
  });

  it("is still refused by the coverage floor over the downloaded summary", async () => {
    const fx = await fixture({ "scripts/check-coverage-floor.ts": NEUTERED });
    const { outputs } = await materialise(fx);
    // What the download step places there: the awaited suite run's summary.
    await mkdir(join(outputs.path!, "coverage"));
    await writeFile(
      join(outputs.path!, "coverage/coverage-summary.json"),
      JSON.stringify({ total: { lines: { total: 100, covered: 50, skipped: 0, pct: 50 } } }),
    );

    const floor = steps.filter(
      (step) => (step.run ?? "").includes("/scripts/check-coverage-floor.ts"),
    );
    expect(floor).toHaveLength(1);
    const result = await runStep(floor[0]!, fx, {}, outputs);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("below the");
  });

  it("is refused by the coverage floor when no summary was downloaded", async () => {
    const fx = await fixture({ "src/a.ts": "export const a = 3;\n" });
    const { outputs } = await materialise(fx);

    const floor = steps.filter((step) => (step.run ?? "").includes("/scripts/check-coverage-floor.ts"))[0]!;
    const result = await runStep(floor, fx, {}, outputs);
    expect(result.status).not.toBe(0);
  });

  it("is still refused by the commit scope rule", async () => {
    const fx = await fixture(
      { "scripts/commit_scopes.py": "import sys\nsys.exit(0)\n" },
      "fix(lint): neuter the scope check",
    );
    const { outputs } = await materialise(fx);

    const result = await runStep(stepRunning("/scripts/commit_scopes.py"), fx, {}, outputs);
    expect(result.status, result.stderr).toBe(1);
    expect(result.stdout).toContain("scope `lint` is the name of a workflow");
  });

  it("is refused for a conflict marker in its own tree, not the base's", async () => {
    const fx = await fixture({ "notes.md": "<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs\n" });
    const { outputs } = await materialise(fx);

    const result = await runStep(stepRunning("git grep -nI"), fx, {}, outputs);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("notes.md");
  });

  it("passes every tree gate for a clean pull request", async () => {
    const fx = await fixture({ "src/a.ts": "export const a = 4;\n" }, "change a");
    const { outputs } = await materialise(fx);

    for (const needle of [
      "git grep -nI",
      "/scripts/check-migration-edits.ts",
      "/scripts/check-module-size.ts",
      "/scripts/commit_scopes.py",
    ]) {
      const result = await runStep(stepRunning(needle), fx, {}, outputs);
      expect(result.status, `${needle}: ${result.stdout}${result.stderr}`).toBe(0);
    }
  });
});
