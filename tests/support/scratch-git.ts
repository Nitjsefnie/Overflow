import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * Helpers for suites that build throwaway git repositories in a temp
 * directory. The environment ignores the machine's global and system git
 * config, so a signing key, a hook path or a rename setting on the box cannot
 * change what the scratch repository records, and it fixes the author and
 * committer so `git commit` needs no configured identity.
 */
export const scratchGitEnv: NodeJS.ProcessEnv = {
  ...process.env,
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
