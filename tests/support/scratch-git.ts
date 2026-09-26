import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function withoutGitVariables(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  for (const key of Object.keys(copy)) {
    if (key.startsWith("GIT_")) delete copy[key];
  }
  return copy;
}

/**
 * Helpers for suites that build throwaway git repositories in a temp
 * directory. The environment is the process environment with every inherited
 * `GIT_*` variable removed — so config passed through GIT_CONFIG_PARAMETERS
 * or GIT_CONFIG_COUNT (which `git -c k=v rebase -x` exports to its command)
 * and repository selectors such as GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE
 * cannot reach the scratch repository — plus overrides that ignore the global
 * and system config files and fix the author and committer, so `git commit`
 * needs no configured identity. Repository-level config the test itself
 * writes still applies.
 */
export const scratchGitEnv: NodeJS.ProcessEnv = {
  ...withoutGitVariables(process.env),
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "scratch repository",
  GIT_AUTHOR_EMAIL: "scratch@example.invalid",
  GIT_COMMITTER_NAME: "scratch repository",
  GIT_COMMITTER_EMAIL: "scratch@example.invalid",
};

/** Runs git in `repo` and returns its trimmed stdout, throwing on a non-zero exit. */
export function git(repo: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd: repo, encoding: "utf8", env: scratchGitEnv });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
}

/** Writes `files` (repo-relative path to content), commits them all, and returns the new HEAD SHA. */
export async function commitFiles(
  repo: string,
  files: Record<string, string>,
  message: string,
): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    await mkdir(dirname(join(repo, path)), { recursive: true });
    await writeFile(join(repo, path), content);
  }
  git(repo, "add", "--all");
  git(repo, "commit", "--quiet", "--message", message);
  return git(repo, "rev-parse", "HEAD");
}
