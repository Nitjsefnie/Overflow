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
 * directory, and for suites that need to read the AMBIENT checkout's git state
 * without that read being steerable from the environment. The environment is
 * the process environment with every inherited `GIT_*` variable removed — so
 * config passed through GIT_CONFIG_PARAMETERS or GIT_CONFIG_COUNT (which
 * `git -c k=v rebase -x` exports to its command) and repository selectors such
 * as GIT_DIR, GIT_WORK_TREE and GIT_INDEX_FILE cannot reach the scratch
 * repository — plus overrides that ignore the global and system config files
 * and fix the author and committer, so `git commit` needs no configured
 * identity. Repository-level config the test itself writes still applies.
 *
 * The second group — `isShallowCheckout`, `hasCommit`, `showFileLines` — is for
 * the other direction: a suite reading the checkout it is running in. Those
 * reads need the same protection, for the same reason, and the one they most
 * need it against is a suite that decides whether to run a check at all: an
 * inherited `GIT_DIR` there makes two predicates answer about the same wrong
 * repository and agree with each other, which is a check that skips on a green
 * run. `GIT_DIR=/some/shallow/clone/.git` against a full-depth checkout was
 * measured doing exactly that.
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

/**
 * Liveness bounds for the git reads below, and why they differ.
 *
 * A synchronous `spawnSync` cannot be preempted: vitest's `testTimeout` cannot
 * fire while the worker is blocked inside one, so the subprocess bound is the
 * only one available. Without it a hung git takes the worker down to vitest's
 * teardown, which is a far worse failure shape than a red test.
 *
 * 120_000 ms is this repository's `testTimeout` (vitest.config.ts). These bounds
 * sit under it so the timeout fires first and produces a readable failure
 * rather than a wedged run.
 */
const METADATA_READ_TIMEOUT_MS = 10_000;
const BLOB_READ_TIMEOUT_MS = 60_000;

/**
 * Whether the repository `cwd` names is a shallow clone.
 *
 * This is a question about the ENVIRONMENT, and the two things it exists to
 * support are the ones where asking the file under test is the mistake: a
 * predicate derived from a committed artefact can be switched off by editing
 * that artefact, and a predicate that reads an inherited `GIT_DIR` answers
 * about a different repository than the one the test is running in.
 *
 * Every failure mode — git absent from PATH, a directory that is not a
 * repository, a git that cannot answer the option — returns false, which makes
 * callers RUN their check rather than skip it. Failing into "skip" is the shape
 * of defect this repository has been removing for three rounds.
 */
export function isShallowCheckout(cwd?: string): boolean {
  const result = spawnSync("git", ["rev-parse", "--is-shallow-repository"], {
    cwd,
    encoding: "utf8",
    env: scratchGitEnv,
    timeout: METADATA_READ_TIMEOUT_MS,
  });
  return result.status === 0 && result.stdout.trim() === "true";
}

/**
 * Whether the repository at `cwd` carries the commit — used by a suite that has
 * to answer "can this checkout serve the history it is being asked to read?"
 * without the answer being steerable from the file being checked.
 */
export function hasCommit(commit: string, cwd?: string): boolean {
  return (
    spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`], {
      cwd,
      encoding: "utf8",
      env: scratchGitEnv,
      timeout: METADATA_READ_TIMEOUT_MS,
    }).status === 0
  );
}

/**
 * Reads a blob out of the repository at `cwd`, returning its lines.
 *
 * The longer bound is for PARTIAL CLONES specifically: with
 * `clone --filter=blob:none` a missing blob is a lazy fetch, so this call can
 * reach the network and block on an unreachable remote. In a complete
 * repository it is a local read and finishes in single-digit milliseconds.
 */
export function showFileLines(commit: string, path: string, cwd?: string): string[] {
  const result = spawnSync("git", ["show", `${commit}:${path}`], {
    cwd,
    encoding: "utf8",
    env: scratchGitEnv,
    timeout: BLOB_READ_TIMEOUT_MS,
  });
  if (result.status !== 0) {
    throw new Error(`git show ${commit}:${path} failed: ${result.stderr}`);
  }
  return result.stdout.split("\n");
}

/**
 * Runs git in `repo` and returns its exit status and output, WITHOUT throwing on
 * a NON-ZERO exit.
 *
 * For the reads whose failure status is the ANSWER — "does this string appear in
 * this history", "does this path exist at HEAD" — where git says "no" with
 * status 1 while the helpers above throw. Writing those reads as
 * `try { git(...) } catch { }` throws the status away, and status is the whole
 * of the answer.
 *
 * It DOES throw when there is no status at all. `spawnSync` returns
 * `status: null` when the binary cannot be launched or the call times out, and on
 * those two paths `result.stdout` holds DIFFERENT values — measured on this box:
 * a missing binary and a missing working directory both give `undefined`, and a
 * **timeout gives `""`**. The key is present on every one of them; what varies is
 * what it holds.
 *
 * That difference is the whole reason the throw is not cosmetic, because the two
 * value shapes fail in opposite directions. Hand the caller the `undefined` and
 * their `expect(result.stdout).not.toContain(secret)` raises a vitest
 * `AssertionError` — red, but on a message about an unusable argument rather than
 * about the repository. Hand them the `""` and that same assertion **PASSES**:
 * an empty string contains nothing, so a scan that never opened the repository
 * certifies it clean. Coalescing with `?? ""` would therefore convert the second
 * case into exactly the false green this helper exists to prevent, which is why
 * it throws on any null status instead of returning a value.
 *
 * Same environment as `git`: every inherited `GIT_*` variable stripped, so a
 * caller cannot be redirected to a different repository by the environment.
 */
export function tryGit(repo: string, ...args: string[]): { status: number; stdout: string; stderr: string } {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: scratchGitEnv,
    timeout: BLOB_READ_TIMEOUT_MS,
  });
  if (result.status === null) {
    // Measured on this box, and the ternary below is what it reports:
    //
    //   missing binary    → status null, stdout undefined, error ENOENT
    //   missing cwd       → status null, stdout undefined, error ENOENT
    //   timeout           → status null, signal SIGTERM, stdout ""
    //
    // So `undefined` means the call never started and `""` means it started and
    // produced nothing — which is the case that would satisfy a "found nothing"
    // assertion if this returned a value. Both throw here.
    throw new Error(
      `git ${args.join(" ")} never produced an exit status in ${repo} (status null, stdout ` +
        `${result.stdout === undefined ? "absent" : "present"}): ${String(result.error ?? result.signal ?? "unknown")}`,
    );
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
