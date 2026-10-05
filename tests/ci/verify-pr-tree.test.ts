import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { commitFiles, git, hasCommit, scratchGitEnv } from "../support/scratch-git";

/**
 * The verify job's pull_request_target leg, EXECUTED rather than read.
 *
 * Under that event the job checks out the base branch, materialises the pull
 * request's merge tree as a detached worktree outside the workspace, and
 * runs the base checkout's own gate scripts over that tree as data. The
 * property that matters is that the pull request cannot judge itself: a pull
 * request that edits a gated file AND replaces the gate script that would
 * catch it must still be refused, because the script that runs is the
 * base's.
 *
 * Each case builds an origin repository whose main carries the real gate
 * scripts, a pull request branch, and the merge commit GitHub would publish
 * for it as refs/pull/1/merge (base tip first parent, head second). The
 * workspace is a full clone of main — the checkout the step list starts from
 * — and the steps' own `run:` blocks are executed with the runner's shell
 * flags. Each step's own `env:` is resolved the way the runner would:
 * `${{ steps.pr-tree.outputs.* }}` from what the materialise step wrote to
 * GITHUB_OUTPUT, and any other expression only from a value the case supplies
 * — an expression nobody resolves throws rather than reading empty. The event
 * payload's `merge_commit_sha` goes into every case's environment, published
 * or stale, because a step that reads it must fail here rather than in the
 * next push.
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

/**
 * SHAs the origin cannot serve: correctly formed, and not a commit anywhere in
 * the fixture's history — the shape an event's head or base takes when the
 * repository does not hold it. Deliberately not a real revision's tail: the
 * case is that NO such commit exists. Every case that uses one proves that
 * with `hasCommit`, so the value is never the thing under test.
 */
const UNFETCHABLE_HEAD = "0123456789abcdef0123456789abcdef01234567";
const UNFETCHABLE_BASE = "fedcba9876543210fedcba9876543210fedcba98";

type Fixture = { origin: string; workspace: string; merge: string; head: string; base: string };

type FixtureOptions = {
  /**
   * What the head commits AFTER GitHub published the merge ref — the shape a
   * `synchronize` event has when the payload's head SHA has moved on but its
   * asynchronously computed merge commit has not.
   */
  afterPublish?: Record<string, string>;
  /** Whether GitHub published a merge ref at all. It publishes none for a head that does not merge cleanly. */
  publishMerge?: boolean;
  /**
   * The branch the workspace is cloned from, single-branch. `main` is the
   * default and is what a full-history checkout of the base holds; naming a
   * branch that does not reach the base commit gives a workspace that does NOT
   * hold the event's base SHA, which is the case the step's base fetch exists
   * for.
   */
  workspaceBranch?: string;
};

/**
 * An origin whose main carries the real gate scripts, a pull request whose
 * head commits `files`, and the merge ref GitHub would publish for it.
 */
async function fixture(
  files: Record<string, string>,
  message = "pull request change",
  options: FixtureOptions = {},
): Promise<Fixture> {
  counter += 1;
  const origin = join(root, `origin-${counter}`);
  await mkdir(join(origin, "scripts"), { recursive: true });
  git(origin, "init", "--quiet", "--initial-branch=main");
  // The materialise step fetches the event's SHAs by value. The Actions
  // origin serves a fetch for any object it holds; a stock local upload-pack
  // refuses one, so the fixture's origin carries the same allowance.
  git(origin, "config", "uploadpack.allowAnySHA1InWant", "true");
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
  const rootSha = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "--quiet", "-b", "feature");
  let head = await commitFiles(origin, files, message);
  git(origin, "checkout", "--quiet", "main");
  const base = await commitFiles(origin, { "CHANGELOG.md": "# changes\n" }, "base advance");
  git(origin, "update-ref", "refs/pull/1/head", head);
  let merge = "";
  if (options.publishMerge ?? true) {
    git(origin, "checkout", "--quiet", "--detach", "main");
    git(origin, "merge", "--quiet", "--no-ff", "--no-edit", "feature");
    merge = git(origin, "rev-parse", "HEAD");
    git(origin, "update-ref", "refs/pull/1/merge", merge);
  }
  if (options.afterPublish) {
    git(origin, "checkout", "--quiet", "feature");
    head = await commitFiles(origin, options.afterPublish, "head advances");
    git(origin, "update-ref", "refs/pull/1/head", head);
  }
  git(origin, "checkout", "--quiet", "main");
  // A branch that stops before the base advance, so a workspace cloned from it
  // single-branch holds the root commit and nothing after it — the case where
  // the checkout does not carry the event's base SHA.
  git(origin, "branch", "--quiet", "before-base", rootSha);

  const workspace = join(root, `workspace-${counter}`);
  if (options.workspaceBranch) {
    git(
      root,
      "clone",
      "--quiet",
      "--no-local",
      "--single-branch",
      "--branch",
      options.workspaceBranch,
      `file://${origin}`,
      workspace,
    );
  } else {
    git(root, "clone", "--quiet", "--no-local", `file://${origin}`, workspace);
  }
  return { origin, workspace, merge, head, base };
}

type StepResult = { status: number | null; stdout: string; stderr: string; output: string };

/**
 * A step's `env:` as the runner would present it: each value that is exactly
 * a step output expression resolves from `outputs` (pr-tree) or `byStep`;
 * every other
 * expression must be supplied by the case through `given`.
 */
function stepEnv(
  step: Step,
  outputs: Record<string, string>,
  given: Record<string, string>,
  byStep: Record<string, Record<string, string>>,
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [key, value] of Object.entries(step.env ?? {})) {
    const output = /^\$\{\{ steps\.([\w-]+)\.outputs\.([\w-]+) \}\}$/.exec(value);
    if (output) {
      const source = output[1] === "pr-tree" ? outputs : byStep[output[1]!] ?? {};
      if (source[output[2]!] === undefined) throw new Error(`${key}: no ${output[1]} output ${output[2]}`);
      resolved[key] = source[output[2]!]!;
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
  byStep: Record<string, Record<string, string>> = {},
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
      ...stepEnv(step, outputs, given, byStep),
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

/**
 * How long `runStepOnOpenStdin` waits before calling a step blocked. It only
 * elapses when the step is wrong; a step that finishes does so in well under a
 * second here, so this is generous rather than tight.
 */
const OPEN_STDIN_BUDGET_MS = 20_000;

/**
 * Runs one step's `run:` block with a stdin that is OPEN and never written to,
 * which is what a runner that leaves a step's stdin inherited hands it. A step
 * that reads stdin blocks on this pipe forever — the failure this exists to
 * catch — so the wait is bounded and the child is killed rather than left
 * behind: `runStep` above cannot express this at all, because `spawnSync`
 * closes stdin by default, and both ubuntu-latest and vitest do exactly that.
 * Two environments agreeing to hide a hang is not a property of the step.
 */
async function runStepOnOpenStdin(
  step: Step,
  fx: Fixture,
): Promise<{ status: number | null; stdout: string; stderr: string; blocked: boolean }> {
  counter += 1;
  const script = join(root, `open-stdin-${counter}.sh`);
  const output = join(root, `open-stdin-output-${counter}`);
  const runnerTemp = join(root, `open-stdin-temp-${counter}`);
  await mkdir(runnerTemp);
  await writeFile(script, step.run ?? "exit 99\n");
  await writeFile(output, "");
  const child = spawn("bash", ["--noprofile", "--norc", "-eo", "pipefail", script], {
    cwd: fx.workspace,
    env: {
      ...scratchGitEnv,
      ...stepEnv(step, {}, {
        BASE_SHA: fx.base,
        HEAD_SHA: fx.head,
        MERGE_BIND_SHA: fx.merge,
        RUNNER_TEMP: runnerTemp,
      }, {}),
      GITHUB_WORKSPACE: fx.workspace,
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_OUTPUT: output,
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}`,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  // Never written to and never ended before the step has finished reading.
  child.stdin.on("error", () => {});
  const collected: { stdout: string; stderr: string } = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    collected.stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    collected.stderr += chunk;
  });

  const closed = once(child, "close").then(([code]) => code as number | null);
  const budget = new Promise<"still running">((resolve) => {
    setTimeout(() => resolve("still running"), OPEN_STDIN_BUDGET_MS);
  });
  const outcome = await Promise.race([closed.then((code) => ({ code })), budget]);
  let blocked = false;
  let status: number | null;
  if (outcome === "still running") {
    blocked = true;
    child.kill("SIGKILL");
    status = await closed;
  } else {
    status = outcome.code;
  }
  child.stdin.destroy();
  return { status, stdout: collected.stdout, stderr: collected.stderr, blocked };
}

/** The two parents of `sha` in `repo`, first and second, as git lists them. */
function parents(repo: string, sha: string): string[] {
  return git(repo, "rev-list", "--parents", "-n", "1", sha).split(" ").slice(1);
}

/**
 * The step's workflow-command annotations, one entry per line, in the order it
 * emitted them. Two refusals that produce DIFFERENT lists are distinguishable
 * to whoever reads the run, without any case having to know what either of
 * them says.
 */
function annotations(result: StepResult): string[] {
  return `${result.stdout}\n${result.stderr}`
    .split("\n")
    .filter((line) => line.includes("::error::"));
}

/**
 * The same annotations with every SHA they name masked out, so two refusals
 * can be compared on WHAT THEY SAY rather than on which commits they name.
 * Without the mask this comparison is vacuous: two cases in two fixtures have
 * different SHAs, so even a message shared verbatim would render differently
 * and look distinct.
 */
function maskedAnnotations(result: StepResult): string[] {
  return annotations(result).map((line) => line.replace(/[0-9a-f]{40}/g, "<sha>"));
}

/**
 * Materialises the merge tree from the event's head and base; returns the
 * outputs later steps read.
 *
 * The event's payload `merge_commit_sha` goes into the environment of every
 * case, published or not, whether or not the step declares it: a step that
 * reads it must fail here rather than in the next `synchronize` event, because
 * GitHub computes that field asynchronously and it can name the merge of the
 * head this event has already moved past.
 */
async function materialise(
  fx: Fixture,
  options: { step?: Step; env?: Record<string, string> } = {},
) {
  counter += 1;
  const runnerTemp = join(root, `runner-temp-${counter}`);
  await mkdir(runnerTemp);
  const result = await runStep(
    options.step ?? stepRunning("git worktree add --detach"),
    fx,
    {
      BASE_SHA: fx.base,
      HEAD_SHA: fx.head,
      MERGE_BIND_SHA: fx.merge,
      RUNNER_TEMP: runnerTemp,
      ...options.env,
    },
    {},
  );
  return { result, outputs: readOutputs(result.output), runnerTemp };
}

describe("the pull request tree the pull_request_target leg judges", () => {
  it("is the two-parent merge of the event's head into the event's base, outside the workspace", async () => {
    const fx = await fixture({ "src/a.ts": "export const a = 1;\n" });
    const { result, outputs, runnerTemp } = await materialise(fx);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(outputs.path?.startsWith(`${runnerTemp}/`)).toBe(true);
    expect(git(outputs.path!, "rev-parse", "HEAD")).toBe(outputs.merge_sha);
    expect(parents(outputs.path!, "HEAD")).toEqual([fx.base, fx.head]);
    // The tree carries both sides of the merge, which is what makes it the
    // tree the gates have to judge.
    expect(await readFile(join(outputs.path!, "src/a.ts"), "utf8")).toBe("export const a = 1;\n");
    expect(await readFile(join(outputs.path!, "CHANGELOG.md"), "utf8")).toBe("# changes\n");
    // The workspace itself stays on the base tip: that is the copy that runs.
    expect(git(fx.workspace, "rev-parse", "HEAD")).toBe(git(fx.origin, "rev-parse", "main"));
  });

  it("is built from the head THIS event carries, when the payload's merge commit names the PREVIOUS head", async () => {
    // GitHub computes pull_request.merge_commit_sha asynchronously: the push
    // that advanced the head can still arrive with the merge of the head
    // before it in the payload. Reading that commit judges a tree this event
    // is not about, and on a synchronize event it names the previous head.
    const fx = await fixture(
      { "src/a.ts": "export const a = 1;\n" },
      "first head",
      { afterPublish: { "src/b.ts": "export const b = 2;\n" } },
    );
    const { result, outputs } = await materialise(fx);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(parents(outputs.path!, "HEAD")).toEqual([fx.base, fx.head]);
    // Only the CURRENT head's change is in the tree: the commit the payload
    // named as merged is the merge of a head that no longer exists.
    expect(await readFile(join(outputs.path!, "src/b.ts"), "utf8")).toBe("export const b = 2;\n");
  });

  it("merges into the event's base even when the checkout does not hold it", async () => {
    // The workspace here is a single-branch clone of a branch that stops
    // before the base advance, so the base commit is not in it — what a
    // checkout sees when the base branch was rewritten between the event and
    // the checkout. The step has to fetch the base itself and still bind the
    // merge to it.
    const fx = await fixture(
      { "src/c.ts": "export const c = 3;\n" },
      "pull request change",
      { workspaceBranch: "before-base" },
    );
    expect(hasCommit(fx.base, fx.workspace), "the workspace must NOT already hold the base").toBe(false);

    const { result, outputs } = await materialise(fx);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(parents(outputs.path!, "HEAD")).toEqual([fx.base, fx.head]);
  });

  it("refuses an unfetchable head with an annotation, and writes nothing", async () => {
    const fx = await fixture({ "src/a.ts": "export const a = 7;\n" });
    // The premise, established rather than assumed: this value is a
    // well-formed SHA that neither the origin nor the workspace holds, so what
    // the step meets is a fetch that cannot succeed — not a case that would
    // have materialised the merge anyway.
    expect(hasCommit(UNFETCHABLE_HEAD, fx.origin), "the origin must NOT hold this head").toBe(false);
    expect(hasCommit(UNFETCHABLE_HEAD, fx.workspace), "the workspace must NOT hold this head").toBe(false);

    const { result, outputs, runnerTemp } = await materialise(fx, {
      env: { HEAD_SHA: UNFETCHABLE_HEAD },
    });

    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(annotations(result)).toHaveLength(1);
    expect(outputs).toEqual({});
    expect(existsSync(join(runnerTemp, "pr-tree")), "nothing may be materialised").toBe(false);
  });

  it("refuses a base the origin cannot serve, and names the BASE fetch as the cause", async () => {
    const fx = await fixture(
      { "src/e.ts": "export const e = 5;\n" },
      "pull request change",
      { workspaceBranch: "before-base" },
    );
    // Same premise as above, for the other end of the merge, and the same
    // precondition the step's own guard has: the base is not already in the
    // checkout, so it must be fetched, and there is nothing to fetch.
    expect(hasCommit(UNFETCHABLE_BASE, fx.origin), "the origin must NOT hold this base").toBe(false);
    expect(hasCommit(fx.base, fx.workspace), "the workspace must NOT already hold the base").toBe(false);

    const { result, outputs, runnerTemp } = await materialise(fx, {
      env: { BASE_SHA: UNFETCHABLE_BASE },
    });

    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(annotations(result)).toHaveLength(1);
    expect(outputs).toEqual({});
    expect(existsSync(join(runnerTemp, "pr-tree")), "nothing may be materialised").toBe(false);

    // Message fidelity, pinned by the DIFFERENCE and not by the wording: a
    // reader of the annotation during an incident has to be told which of the
    // two fetches failed, because the step's other refusal — a head that does
    // not merge cleanly — is a completely different incident. An annotation
    // shared between them would send that reader to the wrong cause, so the
    // two are compared against each other instead of against a phrase.
    const conflicting = await fixture(
      { "CHANGELOG.md": "# pulled request\n" },
      "conflicting change",
      { publishMerge: false },
    );
    const { result: conflicted } = await materialise(conflicting);
    expect(
      maskedAnnotations(result),
      "the base-fetch refusal must not be the annotation a conflicting head produces",
    ).not.toEqual(maskedAnnotations(conflicted));
  });

  it("is refused by the two-parent bind when the merge is built from a head other than the event's", async () => {
    const fx = await fixture({ "src/a.ts": "export const a = 3;\n" });
    const step = stepRunning("git worktree add --detach");
    // The mutant: build the merge from the base's PARENT instead of the
    // event's head — a commit that is present, that merges cleanly, and whose
    // merge tree is the base's own tree. Nothing about it is malformed, so
    // nothing but the bind can refuse it, and without the bind the gates
    // would judge the base and every pull request would pass vacuously. The
    // fetch is left alone: it names a revision git cannot fetch, so a
    // mutation there would be refused by the wrong command.
    const wrong = '"${BASE_SHA:?}^"';
    const mutant: Step = {
      ...step,
      run: (step.run ?? "")
        .replace(
          'git merge-tree --write-tree "${BASE_SHA:?}" "${HEAD_SHA:?}"',
          'git merge-tree --write-tree "${BASE_SHA:?}" ' + wrong,
        )
        .replace('-p "${BASE_SHA:?}" -p "${HEAD_SHA:?}"', '-p "${BASE_SHA:?}" -p ' + wrong),
    };
    expect(mutant.run, "the mutant must have replaced the head the merge is built from").not.toBe(step.run);
    expect(mutant.run, "the fetch must still name the event's head").toContain(
      'git fetch --no-tags origin "${HEAD_SHA:?}"',
    );

    const { result, outputs } = await materialise(fx, { step: mutant });

    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(result.stdout + result.stderr).toContain("::error::");
    expect(outputs).toEqual({});
  });

  it("is refused by the two-parent bind when the merge commit is bound to a base other than the event's", async () => {
    const fx = await fixture({ "src/a.ts": "export const a = 3;\n" });
    const step = stepRunning("git worktree add --detach");
    // The mirror of the case above. The TREE is still merged from the right two
    // commits and the second parent is still the event's head, so the head leg
    // of the bind passes and nothing about the commit is malformed: only the
    // base leg can refuse it. Without that leg the step would materialise a
    // commit whose first parent is not the base this event is about — which is
    // why deleting the base leg leaves the whole suite green unless a case
    // exercises exactly this.
    const mutant: Step = {
      ...step,
      run: (step.run ?? "").replace(
        '-p "${BASE_SHA:?}" -p "${HEAD_SHA:?}"',
        '-p "${BASE_SHA:?}^" -p "${HEAD_SHA:?}"',
      ),
    };
    expect(mutant.run, "the mutant must have replaced the base the merge commit is bound to").not.toBe(step.run);

    const { result, outputs } = await materialise(fx, { step: mutant });

    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(annotations(result)).toHaveLength(1);
    expect(outputs).toEqual({});
  });

  it("does not read the runner's stdin to write the merge commit's message", async () => {
    const fx = await fixture({ "src/a.ts": "export const a = 8;\n" });
    const result = await runStepOnOpenStdin(stepRunning("git worktree add --detach"), fx);

    expect(result.blocked, `the step waited on an open stdin: ${result.stdout}${result.stderr}`).toBe(false);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it("reports a git that cannot write a merge tree as a tool failure, not as a conflict", async () => {
    const fx = await fixture({ "src/a.ts": "export const a = 9;\n" });
    const step = stepRunning("git worktree add --detach");
    // An old git has no --write-tree and answers the option with a usage
    // error, which is a different failure from the exit 1 that means
    // "conflicts". The mutation produces that answer from a git that does
    // support it, which is the same thing the step has to tell apart.
    const mutant: Step = { ...step, run: (step.run ?? "").replace("--write-tree", "--write-tree-unsupported") };
    expect(mutant.run, "the mutant must have made merge-tree reject its option").not.toBe(step.run);

    const { result, outputs, runnerTemp } = await materialise(fx, { step: mutant });

    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    expect(annotations(result)).toHaveLength(1);
    expect(outputs).toEqual({});
    expect(existsSync(join(runnerTemp, "pr-tree")), "nothing may be materialised").toBe(false);

    // The two failures are different incidents and must not read alike: a
    // reader told to rebase over a git that cannot write a merge tree loses
    // the run. Compared by difference, SHAs masked, so nothing here knows
    // what either annotation says.
    const conflicting = await fixture(
      { "CHANGELOG.md": "# pulled request\n" },
      "conflicting change",
      { publishMerge: false },
    );
    const { result: conflicted } = await materialise(conflicting);
    expect(
      maskedAnnotations(result),
      "a merge-tree failure must not be reported with the conflicting head's annotation",
    ).not.toEqual(maskedAnnotations(conflicted));
  });
});

/**
 * The cause of a refusal, pinned by the PAIR rather than by the wording of the
 * annotation. "Did not exit 0 and wrote no outputs" is what every refusal
 * looks like — a fetch that failed, a base that is missing, anything — so the
 * two cases here differ in exactly one thing, what the head commits, and they
 * land on opposite sides of the same boundary. That is what says the refusal
 * above is the conflict and not the next thing that would also have failed.
 */
describe("a head that does not merge cleanly into its base", () => {
  /** Both fixtures are built with `publishMerge: false`; only the files differ. */
  const SHAPE = { publishMerge: false } as const;

  it("is refused, and materialises nothing", async () => {
    const fx = await fixture(
      { "CHANGELOG.md": "# pulled request\n" },
      "conflicting change",
      SHAPE,
    );
    const { result, outputs, runnerTemp } = await materialise(fx);

    expect(result.status, `${result.stdout}${result.stderr}`).not.toBe(0);
    // A workflow command, not prose: the annotation is what the runner
    // surfaces on the run, and its presence is structural.
    expect(result.stdout + result.stderr).toContain("::error::");
    expect(outputs).toEqual({});
    expect(existsSync(join(runnerTemp, "pr-tree")), "no worktree may be materialised").toBe(false);
  });

  it("is the conflict that refuses it — the same shape with a mergeable head succeeds", async () => {
    const fx = await fixture(
      { "src/d.ts": "export const d = 4;\n" },
      "mergeable change",
      SHAPE,
    );
    const { result, outputs, runnerTemp } = await materialise(fx);

    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(outputs.path).toBeDefined();
    expect(outputs.path?.startsWith(`${runnerTemp}/`)).toBe(true);
    expect(parents(outputs.path!, "HEAD")).toEqual([fx.base, fx.head]);
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

  /** The step that creates the download destination, found by its id in the download's path. */
  function prepareStep(): Step {
    const download = steps.filter((step) =>
      ((step as { uses?: string }).uses ?? "").startsWith("actions/download-artifact@"),
    );
    expect(download).toHaveLength(1);
    const path = String((download[0] as { with?: Record<string, unknown> }).with?.path ?? "");
    const id = /^\$\{\{ steps\.([\w-]+)\.outputs\.dir \}\}$/.exec(path)?.[1];
    expect(id, `the download path ${path} must be a creating step's dir output`).toBeDefined();
    const prepare = steps.filter((step) => step.id === id);
    expect(prepare).toHaveLength(1);
    return prepare[0]!;
  }

  function floorStep(): Step {
    const floor = steps.filter((step) => (step.run ?? "").includes("/scripts/check-coverage-floor.ts"));
    expect(floor).toHaveLength(1);
    return floor[0]!;
  }

  it("is still refused by the coverage floor over the downloaded summary, whatever its tree carries", async () => {
    // The pull request neuters the floor script and commits a passing summary
    // where the old layout read one; neither is what the base copy reads.
    const fx = await fixture({
      "scripts/check-coverage-floor.ts": NEUTERED,
      "coverage/coverage-summary.json": JSON.stringify({ total: { lines: { pct: 99 } } }),
    });
    const { outputs, runnerTemp } = await materialise(fx);
    const prepared = await runStep(prepareStep(), fx, { RUNNER_TEMP: runnerTemp }, outputs);
    expect(prepared.status, prepared.stderr).toBe(0);
    const dir = readOutputs(prepared.output).dir!;
    expect(dir.startsWith(`${runnerTemp}/`)).toBe(true);
    expect(dir.startsWith(`${outputs.path}/`)).toBe(false);
    expect(dir.startsWith(`${fx.workspace}/`)).toBe(false);
    // What the download step places there: the awaited suite run's summary.
    await writeFile(
      join(dir, "coverage-summary.json"),
      JSON.stringify({ total: { lines: { total: 100, covered: 50, skipped: 0, pct: 50 } } }),
    );

    const result = await runStep(floorStep(), fx, {}, outputs, { [prepareStep().id!]: { dir } });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("below the");
  });

  it("is refused by the coverage floor when no summary was downloaded", async () => {
    const fx = await fixture({
      "coverage/coverage-summary.json": JSON.stringify({ total: { lines: { pct: 99 } } }),
    });
    const { outputs, runnerTemp } = await materialise(fx);
    const prepared = await runStep(prepareStep(), fx, { RUNNER_TEMP: runnerTemp }, outputs);
    const dir = readOutputs(prepared.output).dir!;

    const result = await runStep(floorStep(), fx, {}, outputs, { [prepareStep().id!]: { dir } });
    expect(result.status).not.toBe(0);
  });

  it("refuses a download destination that already exists, a symlink included", async () => {
    const fx = await fixture({ "src/a.ts": "export const a = 5;\n" });
    const { outputs, runnerTemp } = await materialise(fx);
    const first = await runStep(prepareStep(), fx, { RUNNER_TEMP: runnerTemp }, outputs);
    expect(first.status, first.stderr).toBe(0);
    const dir = readOutputs(first.output).dir!;

    const again = await runStep(prepareStep(), fx, { RUNNER_TEMP: runnerTemp }, outputs);
    expect(again.status).not.toBe(0);
    expect(again.output).toBe("");

    await rm(dir, { recursive: true });
    await symlink(outputs.path!, dir);
    const linked = await runStep(prepareStep(), fx, { RUNNER_TEMP: runnerTemp }, outputs);
    expect(linked.status).not.toBe(0);
    expect(linked.output).toBe("");
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

describe("the awaited suite run's id the pull_request_target leg requires", () => {
  /**
   * On a docs-only change nothing downstream reads the run id, so this step is
   * the only thing between an awaiter that exits 0 without writing one and a
   * green verify. Its real run block is executed with the id resolved from
   * the awaiter's output the way the runner would.
   */
  function requireStep(): Step {
    const awaiter = stepRunning("/scripts/await-pr-suite.ts");
    expect(awaiter.id).toBeDefined();
    const required = steps.filter(
      (step) => step.env?.RUN_ID === `\${{ steps.${awaiter.id}.outputs.run_id }}`,
    );
    expect(required.map((step) => step.name)).toHaveLength(1);
    return required[0]!;
  }

  async function runWith(runId: string): Promise<StepResult> {
    const fx = await fixture({ "README.md": "# scratch, edited\n" });
    const awaiter = stepRunning("/scripts/await-pr-suite.ts");
    return runStep(requireStep(), fx, {}, {}, { [awaiter.id!]: { run_id: runId } });
  }

  for (const runId of ["", "0", "12a", "-1", " 123", "123\n"]) {
    it(`refuses the id ${JSON.stringify(runId)}`, async () => {
      const result = await runWith(runId);
      expect(result.status, result.stdout).not.toBe(0);
      expect(result.stdout).toContain("::error::");
    });
  }

  it("accepts a positive integer id", async () => {
    const result = await runWith("123");
    expect(result.status, result.stdout + result.stderr).toBe(0);
  });
});
