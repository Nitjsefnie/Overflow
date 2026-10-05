import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The verify job's conflict-marker gate, executed. The step is shared by
 * every event, and what it searches depends on the event: on push and
 * workflow_dispatch the checked-out event commit, under pull_request_target
 * the pull request's merge tree, which an earlier step materialises outside
 * the workspace and hands over as PR_TREE. Both legs run here.
 *
 * The step's environment is built from scratch rather than inherited. The
 * runner exports GITHUB_EVENT_NAME (and RUNNER_TEMP, GITHUB_WORKSPACE, …) into
 * every step, including the one running this suite, so an inherited
 * environment makes the leg exercised depend on which workflow happens to run
 * the tests rather than on the case.
 */

type Step = { name?: string; run?: string; env?: Record<string, string> };

const STEP_NAME = "Check no tracked file carries a merge-conflict marker";
const MARKERS = ["<<<<<<< HEAD", "=======", ">>>>>>> label"];

/** The process environment with every runner- and leg-shaped variable removed. */
function scrubbedEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(GITHUB_|RUNNER_|GIT_)/.test(key) || key === "PR_TREE" || key === "CI") delete env[key];
  }
  return env;
}

describe("the verify workflow's conflict-marker shell gate", () => {
  let tempRoot = "";
  let counter = 0;
  let step: Step | undefined;
  const pattern = "^(<{7}( |$)|>{7}( |$)|={7}$)";

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "overflow-conflict-markers-"));
    const workflow = parse(await readFile(resolve(".github/workflows/ci.yml"), "utf8")) as {
      jobs: { verify: { steps: Step[] } };
    };
    const matching = workflow.jobs.verify.steps.filter((candidate) => candidate.name === STEP_NAME);
    expect(matching, "the verify job must carry exactly one conflict-marker gate").toHaveLength(1);
    step = matching[0];
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  /** A scratch repository tracking one file with the given contents. */
  async function repository(contents: string): Promise<string> {
    const root = join(tempRoot, `repo-${++counter}`);
    await mkdir(root);
    const env = scrubbedEnvironment();
    const init = spawnSync("git", ["init", "-q", "-b", "main"], { cwd: root, encoding: "utf8", env });
    expect(init.status, init.stderr).toBe(0);
    await writeFile(join(root, "tracked.txt"), contents);
    const add = spawnSync("git", ["add", "tracked.txt"], { cwd: root, encoding: "utf8", env });
    expect(add.status, add.stderr).toBe(0);
    return root;
  }

  /**
   * Runs the step's real run block in `workspace` for `event`, with only the
   * variables the runner would give this step: the event name, and PR_TREE
   * when the case supplies the materialise step's output.
   */
  async function run(event: string, workspace: string, prTree?: string) {
    expect(step?.run, "the verify job must supply the real shell gate").toBeDefined();
    const script = join(tempRoot, `gate-${++counter}.sh`);
    await writeFile(script, step!.run!);
    const env = scrubbedEnvironment();
    env.GITHUB_EVENT_NAME = event;
    if (prTree !== undefined) env.PR_TREE = prTree;
    // GitHub's bash runner uses -e and -o pipefail; rehearse the same guard.
    return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", script], {
      cwd: workspace,
      encoding: "utf8",
      env,
    });
  }

  it("receives the pull request tree as the materialise step's output", () => {
    expect(step?.env).toEqual({ PR_TREE: "${{ steps.pr-tree.outputs.path }}" });
  });

  for (const event of ["push", "workflow_dispatch"]) {
    describe(`on ${event}, over the checked-out event commit`, () => {
      it.each(MARKERS)("rejects a tracked marker: %s", async (marker) => {
        const result = await run(event, await repository(`text\n${marker}\ntext\n`));
        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout).toContain("A merge-conflict marker is committed.");
        expect(result.stdout).toContain(marker);
      });

      it("passes a clean tracked file when grep exits 1 for no matches", async () => {
        const result = await run(event, await repository("Ordinary tracked text\n"));
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).not.toContain("A merge-conflict marker is committed.");
      });

      it("searches the checkout, never a PR_TREE this event has no business reading", async () => {
        // On these events the materialise step does not run, so its output is
        // empty; a stray value must not redirect the search.
        const dirty = await repository(`text\n${MARKERS[0]}\ntext\n`);
        const result = await run(event, await repository("Ordinary tracked text\n"), dirty);
        expect(result.status, result.stderr).toBe(0);
      });
    });
  }

  describe("on pull_request_target, over the materialised pull request tree", () => {
    it.each(MARKERS)("rejects a marker the pull request tree tracks: %s", async (marker) => {
      const base = await repository("Ordinary base text\n");
      const prTree = await repository(`text\n${marker}\ntext\n`);
      const result = await run("pull_request_target", base, prTree);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain("A merge-conflict marker is committed.");
      expect(result.stdout).toContain(marker);
    });

    it("passes a clean pull request tree", async () => {
      const base = await repository("Ordinary base text\n");
      const prTree = await repository("Ordinary tracked text\n");
      const result = await run("pull_request_target", base, prTree);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("A merge-conflict marker is committed.");
    });

    it("judges the pull request tree, not the base workspace it runs in", async () => {
      const base = await repository(`text\n${MARKERS[1]}\ntext\n`);
      const prTree = await repository("Ordinary tracked text\n");
      const result = await run("pull_request_target", base, prTree);
      expect(result.status, result.stderr).toBe(0);
    });

    it("fails closed when the pull request tree was not materialised", async () => {
      const base = await repository("Ordinary base text\n");
      for (const prTree of [undefined, ""]) {
        const result = await run("pull_request_target", base, prTree);
        expect(result.status, `PR_TREE ${JSON.stringify(prTree)}`).not.toBe(0);
        expect(result.stderr).toContain("the pull request tree was not materialised");
      }
    });
  });

  it("finds no markers in this repository's real tracked tree at HEAD", () => {
    const result = spawnSync("git", ["grep", "-nI", "-E", pattern, "HEAD", "--", "."], {
      cwd: resolve("."), encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("finds no markers in this repository's real tracked working tree", () => {
    // Production greps tracked working files, including uncommitted changes.
    const result = spawnSync("git", ["grep", "-nI", "-E", pattern, "--", "."], {
      cwd: resolve("."), encoding: "utf8",
    });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
