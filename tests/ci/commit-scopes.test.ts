import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Real local origins exercise the anonymous fetch and outgoing range too. */
describe("scripts/commit_scopes.py", () => {
  const script = resolve("scripts/commit_scopes.py");
  let tempRoot = "";
  let counter = 0;

  function git(root: string, ...args: string[]): string {
    const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    return result.stdout.trim();
  }

  function commit(root: string, subject: string): string {
    git(root, "add", ".github/workflows/ci.yml");
    git(root, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit", "--allow-empty", "-m", subject);
    return git(root, "rev-parse", "HEAD");
  }

  async function fixture(name = "ci", baseSubject = "Initial tree") {
    const folder = join(tempRoot, String(++counter));
    const origin = join(folder, "origin");
    const root = join(folder, "head");
    await mkdir(join(origin, ".github/workflows"), { recursive: true });
    git(origin, "init", "-b", "main");
    await writeFile(join(origin, ".github/workflows/ci.yml"),
      `name: ${name}\non: push\njobs:\n  check:\n    name: nested name\n`);
    commit(origin, baseSubject);
    git(folder, "clone", origin, root);
    git(root, "checkout", "-b", "change");
    return { root, origin };
  }

  function run(root: string) {
    return spawnSync("python3", [script, "--root", root], { encoding: "utf8" });
  }

  beforeAll(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), "overflow-commit-scopes-"));
  });

  afterAll(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it("passes an empty outgoing range without rejudging a bad subject on main", async () => {
    const { root } = await fixture("ci", "fix(ci): already merged");
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Examined 0 commit subjects in origin/main..HEAD");
    expect(result.stdout).toContain("Only the OUTGOING range");
  });

  it.each(["ci(ci): change workflow", "ci!(ci)!: breaking change"])(
    "passes a ci-typed workflow-scope subject: %s", async (subject) => {
      const { root } = await fixture();
      commit(root, subject);
      const result = run(root);
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Examined 1 commit subject");
    },
  );

  it.each(["ci", "claim"])("rejects a non-ci type on workflow %s, naming its commit", async (name) => {
    const { root } = await fixture(name);
    const subject = `fix(${name}): wrong type`;
    const sha = commit(root, subject);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(`${sha} ${subject}`);
    expect(result.stdout).toContain(`scope \`${name}\` is the name of a workflow`);
  });

  it("lists an unparseable subject on stdout without failing", async () => {
    const { root } = await fixture();
    const sha = commit(root, "Update the workflow wiring");
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("1 not examined");
    expect(result.stdout).toContain(`${sha} Update the workflow wiring`);
  });

  it("uses the workflow name rather than its filename or nested names", async () => {
    const { root } = await fixture("build");
    commit(root, "fix(ci): filename is outside the rule");
    commit(root, "fix(check): job name is outside the rule");
    expect(run(root).status).toBe(0);
    const sha = commit(root, "fix(build): actual workflow name");
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(sha);
  });

  it.each([
    ['"ci"', "not a plain scalar"],
    ["&workflow ci", "not a plain scalar"],
    ["|\n  ci", "not a plain scalar"],
    ["ci # comment", "trailing comment"],
    ["ci\n  continued", "continues onto an indented line"],
    ["", "carries no value"],
  ])("refuses an unreadable top-level name: %s", async (name, reason) => {
    const { root } = await fixture(name);
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".github/workflows/ci.yml");
    expect(result.stderr).toContain(reason);
  });

  it("refuses a comment-only workflow name instead of passing a violating commit", async () => {
    const { root } = await fixture("# workflow omitted");
    commit(root, "fix(ci): wrong type");
    const result = run(root);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(".github/workflows/ci.yml");
    expect(result.stderr).toContain("top-level `name:` at line 1 carries no value");
  });

  it("fetches main freshly instead of judging already merged outgoing commits", async () => {
    const { root, origin } = await fixture();
    commit(root, "fix(ci): now merged");
    git(origin, "fetch", root, "change");
    git(origin, "merge", "--ff-only", "FETCH_HEAD");
    const result = run(root);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("Examined 0 commit subjects");
  });

  // This list deliberately fails when a workflow is added, so update the pin in
  // the same change, like tests/support/applied-migrations.ts for migrations.
  it("reads every real workflow at HEAD and derives the complete name set", () => {
    const result = spawnSync("python3", ["-c", [
      "import importlib.util, json, pathlib, sys",
      "spec = importlib.util.spec_from_file_location('commit_scopes', sys.argv[1])",
      "gate = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(gate)",
      "print(json.dumps(sorted(gate.workflow_name_set(pathlib.Path(sys.argv[2])))))",
    ].join("\n"), script, resolve(".")], { encoding: "utf8" });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      "actionlint", "ci", "claim", "code scanning", "coverage comment",
      "dependency audit", "ledger relay", "pr gate", "ratchet guard", "scorecard", "secret scan",
    ]);
  });
});
