import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CoverageFloorDoc } from "../../scripts/check-coverage-floor.ts";

let root: string;
let origin: string;
let worktree: string;
const script = fileURLToPath(
  new URL("../../scripts/push-recalibration.ts", import.meta.url),
);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "push-recalibration-"));
  origin = join(root, "origin.git");
  worktree = join(root, "wt");
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const doc = (measured: number, floor: number): CoverageFloorDoc => ({
  gap: 1.0,
  hysteresis: 0.5,
  languages: { typescript: { measured, floor } },
});

const git = (cwd: string, ...args: string[]): string => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout.trim();
};

const writeDoc = (path: string, measured: number, floor: number): void => {
  writeFileSync(path, `${JSON.stringify(doc(measured, floor), null, 2)}\n`);
};

// A bare origin holding one seed commit, an optional pre-receive hook, and a
// fresh clone at wt/ — the state the calibrate job's push step starts from.
// The recalibrated doc is left uncommitted separately.
const seedRemote = (hook: string): void => {
  const seed = join(root, "seed");
  git(root, "init", "--bare", "-q", "-b", "main", origin);
  git(root, "init", "-q", "-b", "main", seed);
  git(seed, "config", "user.email", "seed@example.com");
  git(seed, "config", "user.name", "seed");
  mkdirSync(join(seed, "scripts"), { recursive: true });
  writeDoc(join(seed, "scripts/coverage.json"), 73.46, 72.46);
  writeFileSync(join(seed, "other.txt"), "seed\n");
  git(seed, "add", "scripts/coverage.json", "other.txt");
  git(seed, "commit", "-qm", "seed");
  git(seed, "push", "-q", origin, "HEAD:refs/heads/main");
  // The hook guards recalibration pushes only, so it goes in after the
  // seed push — before the clone the tests drive the script from.
  if (hook !== "") {
    const hookPath = join(origin, "hooks", "pre-receive");
    writeFileSync(hookPath, hook);
    chmodSync(hookPath, 0o755);
  }
  git(root, "clone", "-q", origin, worktree);
};

// The recalibration calibrate-coverage.ts would have just written.
const recalibrate = (): void => {
  writeDoc(join(worktree, "scripts/coverage.json"), 78.46, 77.46);
};

// Refuses every push, the way branch protection refuses GITHUB_TOKEN.
const rejectAlways =
  "#!/bin/sh\necho 'branch protection refuses this push' >&2\nexit 1\n";

// Refuses the first push only — and a racing commit lands on main first, so
// the retry has to rebase for real. The hook clears the quarantine
// variables for the two commands that must write outside it: the racing
// commit's objects and the ref update itself.
const rejectOnceWithRace = (marker: string): string =>
  [
    "#!/bin/sh",
    `if [ -f '${marker}' ]; then exit 0; fi`,
    `touch '${marker}'`,
    "read old new ref",
    'tree=$(git rev-parse "$old^{tree}")',
    "racing=$(env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY \\",
    "  -u GIT_ALTERNATE_OBJECT_DIRECTORIES \\",
    "  GIT_AUTHOR_NAME=racing GIT_AUTHOR_EMAIL=racing@example.com \\",
    "  GIT_COMMITTER_NAME=racing GIT_COMMITTER_EMAIL=racing@example.com \\",
    '  git commit-tree "$tree" -p "$old" -m "racing commit lands first")',
    "env -u GIT_QUARANTINE_PATH -u GIT_OBJECT_DIRECTORY \\",
    "  -u GIT_ALTERNATE_OBJECT_DIRECTORIES \\",
    '  git update-ref refs/heads/main "$racing" "$old"',
    'echo "racing commit landed on main; first push refused" >&2',
    "exit 1",
    "",
  ].join("\n");

// Minimal environment: anything the script needs beyond PATH/HOME it must
// take from the arguments passed here.
const childEnv = (extra: Record<string, string>): NodeJS.ProcessEnv => ({
  PATH: process.env.PATH ?? "",
  HOME: process.env.HOME ?? "",
  NODE_ENV: process.env.NODE_ENV,
  ...extra,
});

const runPush = (env: Record<string, string>) =>
  spawnSync(process.execPath, [script], {
    cwd: worktree,
    encoding: "utf8",
    env: childEnv(env),
  });

const pushEnv = (): Record<string, string> => ({
  GH_TOKEN: "token-1",
  GITHUB_REPOSITORY: "Nitjsefnie/Overflow",
  PUSH_REMOTE_URL: origin,
});

const assertClean = (): void => {
  expect(git(worktree, "status", "--porcelain")).toBe("");
  expect(existsSync(join(worktree, ".git", "rebase-merge"))).toBe(false);
  expect(existsSync(join(worktree, ".git", "rebase-apply"))).toBe(false);
};

describe("push-recalibration", () => {
  it("commits as the bot and pushes to a permissive remote", () => {
    seedRemote("");
    recalibrate();
    const before = git(origin, "rev-parse", "main");
    const result = runPush(pushEnv());
    expect(result.status).toBe(0);
    const after = git(origin, "rev-parse", "main");
    expect(after).not.toBe(before);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(after);
    expect(git(worktree, "log", "-1", "--format=%an <%ae>")).toBe(
      "github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
    );
    expect(git(worktree, "log", "-1", "--format=%s")).toBe(
      "ci: update CI ratchets",
    );
    // The token rides in the push URL only; .git/config stays clean of it.
    expect(readFileSync(join(worktree, ".git", "config"), "utf8")).not.toContain(
      "token-1",
    );
    assertClean();
  });

  it("fails with ::error:: naming both floors and leaves the repo clean when the remote refuses twice", () => {
    seedRemote(rejectAlways);
    recalibrate();
    const before = git(origin, "rev-parse", "main");
    const result = runPush(pushEnv());
    expect(result.status).not.toBe(0);
    const output = `${result.stdout}\n${result.stderr}`;
    expect(output).toContain("::error::");
    // Recorded floor at HEAD^1 and measured floor in the committed doc.
    expect(output).toContain("72.46");
    expect(output).toContain("77.46");
    expect(output).toContain("refuses pushes from GITHUB_TOKEN");
    expect(output).toContain("node scripts/calibrate-coverage.ts");
    expect(git(origin, "rev-parse", "main")).toBe(before);
    assertClean();
  });

  it("rebases onto the advanced remote and lands on the retry after one refusal", () => {
    seedRemote(rejectOnceWithRace(join(origin, "rejected.once")));
    recalibrate();
    const before = git(origin, "rev-parse", "main");
    const result = runPush(pushEnv());
    expect(result.status).toBe(0);
    const after = git(origin, "rev-parse", "main");
    expect(after).not.toBe(before);
    expect(git(worktree, "rev-parse", "HEAD")).toBe(after);
    expect(git(origin, "log", "--format=%s", "-2", "main")).toBe(
      "ci: update CI ratchets\nracing commit lands first",
    );
    assertClean();
  });

  it("pushes nothing when the floor document is already current", () => {
    seedRemote("");
    const before = git(origin, "rev-parse", "main");
    // No GH_TOKEN: the token is required only when a push will be attempted.
    const result = runPush({
      GITHUB_REPOSITORY: "Nitjsefnie/Overflow",
      PUSH_REMOTE_URL: origin,
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      "coverage floor already current; nothing to push",
    );
    expect(git(origin, "rev-parse", "main")).toBe(before);
    expect(git(worktree, "log", "--format=%s", "-1")).toBe("seed");
    assertClean();
  });

  it("never echoes the token when the push itself fails", () => {
    seedRemote("");
    recalibrate();
    // Nothing listens on 127.0.0.1:1; the URL carries the token so any
    // unredacted git error output would name it.
    const result = runPush({
      GH_TOKEN: "token-1",
      GITHUB_REPOSITORY: "Nitjsefnie/Overflow",
      PUSH_REMOTE_URL: "https://x-access-token:token-1@127.0.0.1:1/Nitjsefnie/Overflow.git",
    });
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("token-1");
    assertClean();
  });
});
