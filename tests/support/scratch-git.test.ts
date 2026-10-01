import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
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

  /**
   * `tryGit` exists so that a read whose NON-ZERO exit is the answer can keep
   * the status. Its other job is the harder half: a launch that never produced a
   * status must not be readable as "looked, found nothing".
   *
   * Measured on this box, `spawnSync` pointed at a working directory that does
   * not exist returns `status: null`, `error: spawnSync git ENOENT`, and a
   * `stdout` that is **null** — not the empty string its type promised. A
   * helper that passed those fields through gave a caller an object whose
   * `.stdout` was null, so `expect(result.stdout).not.toContain(secret)` reads
   * as a PASS: null contains nothing. A scan that never opened the repository
   * would certify it clean. That is the false green this helper's guard exists
   * to prevent, so it is asserted here rather than trusted.
   */
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
      "tryGit must not RETURN for a launch that produced no exit status — a returned object would let " +
        "`not.toContain(secret)` pass on a repository the test never opened",
    ).toBeUndefined();
    expect(String(thrown), "and it must say what it was trying to run, and where").toContain("git log --all -p");
    expect(String(thrown), "and name the launch failure rather than reporting an empty result").toMatch(
      /ENOENT|never produced an exit status/,
    );
  });
});
