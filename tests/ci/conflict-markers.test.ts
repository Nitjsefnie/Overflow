import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";

describe("the verify workflow's conflict-marker shell gate", () => {
  let tempRoot = "";
  let counter = 0;
  let runScript: string | undefined;
  const pattern = "^(<{7}( |$)|>{7}( |$)|={7}$)";

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "overflow-conflict-markers-"));
    const workflow = parse(await readFile(resolve(".github/workflows/ci.yml"), "utf8"));
    runScript = workflow.jobs.verify.steps.find((step: { name?: string }) =>
      step.name === "Check no tracked file carries a merge-conflict marker",
    )?.run;
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  async function run(contents: string) {
    expect(runScript, "the verify job must supply the real shell gate").toBeDefined();
    const root = join(tempRoot, String(++counter));
    await mkdir(root);
    const init = spawnSync("git", ["init", "-b", "main"], { cwd: root, encoding: "utf8" });
    expect(init.status, init.stderr).toBe(0);
    await writeFile(join(root, "tracked.txt"), contents);
    const add = spawnSync("git", ["add", "tracked.txt"], { cwd: root, encoding: "utf8" });
    expect(add.status, add.stderr).toBe(0);
    const script = join(tempRoot, `gate-${counter}.sh`);
    await writeFile(script, runScript!);
    // GitHub's bash runner uses -e and -o pipefail; rehearse the same guard.
    return spawnSync("bash", ["-e", "-o", "pipefail", script], { cwd: root, encoding: "utf8" });
  }

  it.each(["<<<<<<< HEAD", "=======", ">>>>>>> label"])(
    "rejects a tracked marker: %s", async (marker) => {
      const result = await run(`text\n${marker}\ntext\n`);
      expect(result.status, result.stderr).toBe(1);
      expect(result.stdout).toContain("A merge-conflict marker is committed.");
      expect(result.stdout).toContain(marker);
    },
  );

  it("passes a clean tracked file when grep exits 1 for no matches", async () => {
    const result = await run("Ordinary tracked text\n");
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("A merge-conflict marker is committed.");
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
