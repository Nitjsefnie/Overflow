import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import { createOwnedTempDirectoryRegistry } from "./owned-temp-directory";

const fixtureDirectories = createOwnedTempDirectoryRegistry(join(tmpdir(), "scratch-git-"));

// Set inherited Git state before importing the environment-reading helper.
describe("scratch-git helpers under an inherited git environment", () => {
  const saved = { ...process.env };
  let root = "";

  beforeAll(async () => {
    root = await realpath(await fixtureDirectories.createAsync());
  });

  afterAll(async () => {
    try {
      if (root) await fixtureDirectories.disposeAsync(root);
    } finally {
      await fixtureDirectories.disposeAsync();
    }
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
    const repo = await fixtureDirectories.createAsync(join(root, "repo-"));
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
    const repo = await fixtureDirectories.createAsync(join(root, "repo-"));
    const elsewhere = await fixtureDirectories.createAsync(join(root, "elsewhere-"));
    spawnSync("git", ["init", "--quiet", elsewhere], { encoding: "utf8" });
    process.env.GIT_DIR = join(elsewhere, ".git");
    process.env.GIT_WORK_TREE = elsewhere;
    const { git } = await freshHelpers();
    git(repo, "init", "--quiet");

    expect(git(repo, "rev-parse", "--absolute-git-dir")).toBe(join(repo, ".git"));
  });

  // Launch errors must throw; coalescing missing stdout would falsely certify a clean repository.
  it("refuses to report a launch failure as a clean read", async () => {
    const { tryGit } = await freshHelpers();
    const missing = join(root, "no-such-directory-938");
    expect(existsSync(missing), "the case must point at a directory that is genuinely absent").toBe(false);

    let thrown: unknown;
    let returned: { status: number; stdout: string; stderr: string } | undefined;
    try {
      returned = tryGit(missing, "log", "--all", "-p");
    } catch (error) {
      thrown = error;
    }
    expect(
      returned,
      "tryGit must not RETURN for a launch that produced no exit status. A returned object makes the failure " +
        "invisible one way or the other — an undefined stdout makes the caller's `not.toContain(secret)` fail " +
        "on an unusable argument, and the empty stdout a TIMEOUT produces makes it PASS on a repository the test " +
        "never opened",
    ).toBeUndefined();
    expect(String(thrown), "and it must say what it was trying to run, and where").toContain("git log --all -p");
    expect(String(thrown), "and name the launch failure rather than reporting an empty result").toMatch(
      /ENOENT|never produced an exit status/,
    );
  });
});
