import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const tempDirectories = createOwnedTempDirectoryRegistry([join(tmpdir(), "overflow-comment-share-push-")]);

const recordsPath = ".github/comment-share.json";
const roots: string[] = [];
const workflow = parse(readFileSync(resolve(".github/workflows/ratchet-push.yml"), "utf8"));
const push = workflow.jobs.push.steps.find((step: { env?: Record<string, string> }) =>
  Object.hasOwn(step.env ?? {}, "MASTER_PUSH_DEPLOY_KEY"));
const start = push.run.indexOf('scratch="$RUNNER_TEMP/ratchet-repo"');
if (start < 0) throw new Error("the bare Git writer must be present");
// Only transport/authentication is replaced; fetch through push is the real workflow.
const writer = 'remote="$TEST_REMOTE"\n' + push.run.slice(start);
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "scratch repository",
  GIT_AUTHOR_EMAIL: "scratch@example.invalid",
  GIT_COMMITTER_NAME: "scratch repository",
  GIT_COMMITTER_EMAIL: "scratch@example.invalid",
};

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, { cwd, env: gitEnv, encoding: "utf8", timeout: 10_000 });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

type Records = Record<string, [number, number]>;

function source(commentBytes: number): string {
  return "#" + "x".repeat(commentBytes - 1) + '\nv="' + "x".repeat(96 - commentBytes) + '"\n';
}

function fixture() {
  const root = tempDirectories.create(join(tmpdir(), "overflow-comment-share-push-"));
  roots.push(root);
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  mkdirSync(join(repo, ".github"), { recursive: true });
  git(repo, "init", "--quiet", "--initial-branch=main");
  writeFileSync(join(repo, "sample.py"), source(30));
  writeFileSync(join(repo, "other.py"), source(20));
  writeFileSync(join(repo, recordsPath), JSON.stringify({ "other.py": [20, 100], "sample.py": [40, 100] }, null, 2) + "\n");
  git(repo, "add", "sample.py", "other.py", recordsPath);
  git(repo, "commit", "--quiet", "-m", "measurement base");
  const base = git(repo, "rev-parse", "HEAD");
  git(root, "clone", "--quiet", "--bare", repo, remote);
  git(repo, "remote", "add", "origin", remote);
  let runs = 0;
  const head = () => git(remote, "rev-parse", "main");
  const records = (): Records => JSON.parse(git(remote, "show", `main:${recordsPath}`));
  const run = (measuredBase: string, data: Records) => {
    const temp = join(root, `run-${++runs}`);
    mkdirSync(join(temp, "comment-share-data"), { recursive: true });
    writeFileSync(join(temp, "comment-share-data/base.txt"), measuredBase + "\n");
    writeFileSync(join(temp, "comment-share-data/comment-share.json"), JSON.stringify(data, null, 2) + "\n");
    writeFileSync(join(temp, "summary"), "");
    const result = spawnSync("bash", ["--noprofile", "--norc", "-euo", "pipefail", "-c", writer], {
      env: { ...gitEnv, NODE_ENV: "test", TEST_REMOTE: remote, RUNNER_TEMP: temp, GITHUB_STEP_SUMMARY: join(temp, "summary") },
      encoding: "utf8", timeout: 10_000,
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    return { ...result, repository: join(temp, "ratchet-repo"), summary: readFileSync(join(temp, "summary"), "utf8") };
  };
  const onlyRecordsChanged = (before: string) => {
    expect(git(remote, "diff-tree", "--no-commit-id", "--name-only", "-r", head()).split("\n")).toEqual([recordsPath]);
    expect(git(remote, "rev-parse", "main^"), "writer parents the fetched commit").toBe(before);
  };
  return { root, repo, remote, base, head, records, run, onlyRecordsChanged };
}

afterEach(() => {
  for (const root of roots.splice(0)) tempDirectories.dispose(root);
});

describe("the real Git comment-share writer", () => {
  it.each(["older first", "newer first"])("drops changed-source measurements: %s", (order) => {
    const fx = fixture();
    writeFileSync(join(fx.repo, "sample.py"), source(35));
    git(fx.repo, "add", "sample.py");
    git(fx.repo, "commit", "--quiet", "-m", "source advances within existing bounds");
    git(fx.repo, "push", "--quiet", "origin", "main");
    const newerBase = fx.head();
    const applyNewer = () => {
      const before = fx.head();
      fx.run(newerBase, { "other.py": [20, 100], "sample.py": [35, 100] });
      fx.onlyRecordsChanged(before);
    };
    if (order === "newer first") applyNewer();
    const before = fx.head();
    const dropped = fx.run(fx.base, { "other.py": [20, 100], "sample.py": [30, 100] });
    expect(fx.head(), "a stale source measurement must produce no commit").toBe(before);
    const commits = git(dropped.repository, "cat-file", "--batch-all-objects", "--batch-check=%(objectname) %(objecttype)")
      .split("\n").filter((entry) => entry.endsWith(" commit")).map((entry) => entry.split(" ")[0]).sort();
    expect(commits, "the dropped writer creates no extra commit object").toEqual(git(fx.remote, "rev-list", before).split("\n").sort());
    expect(dropped.stdout).toContain("::notice::");
    expect(dropped.summary).toContain("Dropped:");
    expect(fx.records()["sample.py"]).toEqual(order === "older first" ? [40, 100] : [35, 100]);
    if (order === "older first") applyNewer();
    expect(fx.records()["sample.py"]).toEqual([35, 100]);
    expect(git(fx.remote, "show", "main:sample.py")).toBe(source(35).trim());
  });

  it("merges intervening record-only edits without changing source", () => {
    const fx = fixture();
    writeFileSync(join(fx.repo, recordsPath), JSON.stringify({ "other.py": [10, 50], "sample.py": [40, 100] }, null, 2) + "\n");
    git(fx.repo, "add", recordsPath);
    git(fx.repo, "commit", "--quiet", "-m", "equivalent bound in different byte units");
    git(fx.repo, "push", "--quiet", "origin", "main");
    const before = fx.head();
    fx.run(fx.base, { "other.py": [20, 100], "sample.py": [30, 100] });
    fx.onlyRecordsChanged(before);
    expect(fx.records()).toEqual({ "other.py": [10, 50], "sample.py": [30, 100] });
    expect(git(fx.remote, "show", "main:sample.py")).toBe(source(30).trim());
    expect(git(fx.remote, "show", "main:other.py")).toBe(source(20).trim());
  });
});
