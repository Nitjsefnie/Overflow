import { spawnSync } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";

/**
 * The scratch-git helpers must hold their repository to itself even when the
 * test process inherits git state through the environment — as it does under
 * `git -c k=v rebase -x '<cmd>'`, which exports GIT_CONFIG_PARAMETERS to the
 * command. The module reads process.env when it loads, so each case sets the
 * variables first and then imports a fresh copy of it.
 */
describe("scratch-git helpers under an inherited git environment", () => {
  const saved = { ...process.env };
  let root = "";

  beforeAll(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "scratch-git-")));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
    vi.resetModules();
  });

  async function freshHelpers() {
    vi.resetModules();
    return import("./scratch-git");
  }

  it("ignores config passed through GIT_CONFIG_PARAMETERS and GIT_CONFIG_COUNT", async () => {
    const repo = await mkdtemp(join(root, "repo-"));
    process.env.GIT_CONFIG_PARAMETERS = "'scratch.parameters'='leaked'";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "scratch.count";
    process.env.GIT_CONFIG_VALUE_0 = "leaked";
    const { git, scratchGitEnv } = await freshHelpers();
    git(repo, "init", "--quiet");

    for (const key of ["scratch.parameters", "scratch.count"]) {
      const lookup = spawnSync("git", ["config", "--get", key], {
        cwd: repo,
        encoding: "utf8",
        env: scratchGitEnv,
      });
      expect(lookup.status, `${key} resolved to ${JSON.stringify(lookup.stdout)}`).toBe(1);
    }
  });

  it("operates on the repository it is given, not one named by GIT_DIR", async () => {
    const repo = await mkdtemp(join(root, "repo-"));
    const elsewhere = await mkdtemp(join(root, "elsewhere-"));
    spawnSync("git", ["init", "--quiet", elsewhere], { encoding: "utf8" });
    process.env.GIT_DIR = join(elsewhere, ".git");
    process.env.GIT_WORK_TREE = elsewhere;
    const { git } = await freshHelpers();
    git(repo, "init", "--quiet");

    expect(git(repo, "rev-parse", "--absolute-git-dir")).toBe(join(repo, ".git"));
  });
});
