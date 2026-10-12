import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The verify job's conflict-marker gate, executed. Issue 1090 split the
 * pull-request leg into ci-pr.yml, whose only trigger is
 * `pull_request_target`, and both files still carry the gate — over different
 * trees. In ci.yml (push and workflow_dispatch) it searches the checked-out
 * event commit; in ci-pr.yml it always searches the pull request's merge tree,
 * which an earlier step materialises outside the workspace and hands over as
 * PR_TREE. Both legs run here.
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
  /** ci.yml's copy: the checked-out event commit, which is all this file receives. */
  let pushStep: Step | undefined;
  /** ci-pr.yml's copy: the materialised pull request tree, always. */
  let prStep: Step | undefined;
  const pattern = "^(<{7}( |$)|>{7}( |$)|={7}$)";

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "overflow-conflict-markers-"));
    // Reading only ci.yml after the split found the push leg and none of the
    // pull-request tree cases, so each file is read for the leg it owns.
    const gate = async (file: string): Promise<Step> => {
      const workflow = parse(await readFile(resolve(file), "utf8")) as {
        jobs: { verify: { steps: Step[] } };
      };
      const matching = workflow.jobs.verify.steps.filter((candidate) => candidate.name === STEP_NAME);
      expect(matching, `${file}'s verify job must carry exactly one conflict-marker gate`).toHaveLength(1);
      return matching[0]!;
    };
    pushStep = await gate(".github/workflows/ci.yml");
    prStep = await gate(".github/workflows/ci-pr.yml");
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
   * Runs a leg's real run block in `workspace`, with only the variables the
   * runner would give this step: the event name, and PR_TREE when the case
   * supplies the materialise step's output.
   */
  async function run(step: Step, event: string, workspace: string, prTree?: string) {
    expect(step.run, "the verify job must supply the real shell gate").toBeDefined();
    const script = join(tempRoot, `gate-${++counter}.sh`);
    await writeFile(script, step.run!);
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

  it("takes the pull request tree as the materialise step's output in ci-pr.yml", () => {
    expect(prStep?.env).toEqual({ PR_TREE: "${{ steps.pr-tree.outputs.path }}" });
  });

  it("takes no input at all in ci.yml, whose file receives no pull_request_target", () => {
    // Structural, where the pre-split step was guarded by a branch: the
    // materialise step does not exist in ci.yml, so there is no PR_TREE to
    // name, and the run block never mentions one. The stray-value case below
    // therefore cannot be reached by editing this leg — it would have to be
    // reached by ADDING the variable, which this denies.
    expect(
      pushStep?.env,
      "ci.yml's conflict-marker step must declare no env at all — this file receives only " +
        "push and workflow_dispatch, so there is no materialised pull request tree to name, and a " +
        "PR_TREE here would be the materialise step of a workflow that does not have one",
    ).toEqual(undefined);
    expect(pushStep?.run).not.toContain("PR_TREE");
  });

  for (const event of ["push", "workflow_dispatch"]) {
    describe(`on ${event}, over the checked-out event commit`, () => {
      it.each(MARKERS)("rejects a tracked marker: %s", async (marker) => {
        const result = await run(pushStep!, event, await repository(`text\n${marker}\ntext\n`));
        expect(result.status, result.stderr).toBe(1);
        expect(result.stdout).toContain("A merge-conflict marker is committed.");
        expect(result.stdout).toContain(marker);
      });

      it("passes a clean tracked file when grep exits 1 for no matches", async () => {
        const result = await run(pushStep!, event, await repository("Ordinary tracked text\n"));
        expect(result.status, result.stderr).toBe(0);
        expect(result.stdout).not.toContain("A merge-conflict marker is committed.");
      });

      it("searches the checkout, never a PR_TREE this event has no business reading", async () => {
        // The materialise step does not exist in ci.yml, so a stray value can
        // reach the shell only if something named it; the assertion above
        // says nothing does, and this case says the shell would ignore one if
        // it did.
        const dirty = await repository(`text\n${MARKERS[0]}\ntext\n`);
        const result = await run(pushStep!, event, await repository("Ordinary tracked text\n"), dirty);
        expect(result.status, result.stderr).toBe(0);
      });
    });
  }

  describe("on pull_request_target, over the materialised pull request tree", () => {
    it.each(MARKERS)("rejects a marker the pull request tree tracks: %s", async (marker) => {
      const base = await repository("Ordinary base text\n");
      const prTree = await repository(`text\n${marker}\ntext\n`);
      const result = await run(prStep!, "pull_request_target", base, prTree);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain("A merge-conflict marker is committed.");
      expect(result.stdout).toContain(marker);
    });

    it("passes a clean pull request tree", async () => {
      const base = await repository("Ordinary base text\n");
      const prTree = await repository("Ordinary tracked text\n");
      const result = await run(prStep!, "pull_request_target", base, prTree);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).not.toContain("A merge-conflict marker is committed.");
    });

    it("judges the pull request tree, not the base workspace it runs in", async () => {
      const base = await repository(`text\n${MARKERS[1]}\ntext\n`);
      const prTree = await repository("Ordinary tracked text\n");
      const result = await run(prStep!, "pull_request_target", base, prTree);
      expect(result.status, result.stderr).toBe(0);
    });

    it("fails closed when the pull request tree was not materialised", async () => {
      const base = await repository("Ordinary base text\n");
      for (const prTree of [undefined, ""]) {
        const result = await run(prStep!, "pull_request_target", base, prTree);
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
