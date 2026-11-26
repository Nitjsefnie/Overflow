import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PERF_BUDGET_PATH, perfBudgetRelaxations, checkRatchets } from "../../scripts/check-ratchets.ts";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const tempDirectories = createOwnedTempDirectoryRegistry([join(tmpdir(), "ratchets-")]);

const script = fileURLToPath(new URL("../../scripts/check-ratchets.ts", import.meta.url));

const budget = { board: 2, fold: 20 };

describe("performance budget ratchet", () => {
  it("refuses a raised statement budget with file, workload and both values", () => {
    const findings = perfBudgetRelaxations({ board: 2 }, { board: 3 });
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(PERF_BUDGET_PATH);
    expect(findings[0]).toContain("board");
    expect(findings[0]).toContain("merge base 2, head 3");
  });

  it("accepts a lower statement count", () => {
    expect(perfBudgetRelaxations({ board: 2 }, { board: 1 })).toEqual([]);
  });

  it("accepts a new workload's positive initial budget without relaxing old workloads", () => {
    expect(perfBudgetRelaxations({ board: 2 }, { board: 2, fold: 20 })).toEqual([]);
  });

  it("refuses removing a workload key or its entire document", () => {
    expect(perfBudgetRelaxations({ board: 2, fold: 20 }, { board: 2 })).toEqual([
      expect.stringContaining("fold"),
    ]);
    expect(perfBudgetRelaxations({ board: 2 }, null)).toEqual([expect.stringContaining("deleted")]);
  });

  it("accepts initial budgets when the document is absent at the merge base", () => {
    expect(perfBudgetRelaxations(null, { board: 2 })).toEqual([]);
  });

  it.each([0, -1, 1.5, "2", Number.MAX_SAFE_INTEGER + 1])("refuses invalid added or changed budgets %j", (value) => {
    expect(perfBudgetRelaxations({ board: 2 }, { board: value }).length).toBeGreaterThan(0);
    expect(perfBudgetRelaxations({ board: 2 }, { board: 2, fold: value }).length).toBeGreaterThan(0);
  });
});

describe("ratchet check against a real git repository", () => {
  let root: string;

  beforeEach(() => {
    root = tempDirectories.create(join(tmpdir(), "ratchets-"));
  });

  afterEach(() => {
    tempDirectories.dispose(root);
  });

  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
    return result.stdout.trim();
  };

  const writeDoc = (path: string, content: unknown) => {
    mkdirSync(join(root, "scripts"), { recursive: true });
    const text = typeof content === "string" ? content : `${JSON.stringify(content, null, 2)}\n`;
    writeFileSync(join(root, path), text);
  };

  const commit = (message: string) => {
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", message);
  };

  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });

  // main: base docs; feature forks; feature applies `onFeature`; main then
  // advances with a LOWERED budget, so the tip is stricter than the merge base.
  const seed = (onFeature: () => void) => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ratchets@example.test");
    git("config", "user.name", "Ratchets Test");
    git("config", "commit.gpgsign", "false");
    writeDoc(PERF_BUDGET_PATH, budget);
    commit("base documents");
    git("checkout", "-q", "-b", "feature");
    onFeature();
    commit("feature change");
    git("checkout", "-q", "main");
    writeDoc(PERF_BUDGET_PATH, { board: 1, fold: 20 });
    commit("main tightens a budget");
  };

  it.each([
    ["raise", { board: 3, fold: 20 }, 1],
    ["lower", { board: 1, fold: 20 }, 0],
    ["add", { board: 2, fold: 20, webhook: 10 }, 0],
    ["remove", { board: 2 }, 1],
  ])("registers performance budgets as git documents: %s", (_label, document, status) => {
    seed(() => writeDoc(PERF_BUDGET_PATH, document));
    const result = run("main", "feature");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(status);
    if (status === 1) expect(result.stdout).toContain(PERF_BUDGET_PATH);
  });

  it("compares against the merge base, not the advanced base tip", () => {
    seed(() => writeFileSync(join(root, "unrelated.txt"), "change\n"));
    const result = run("main", "feature");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  // The push shape: the previous tip of main is a direct
  // ancestor of the pushed head, so the merge base is the previous tip
  // itself and the comparison is the pushed commit against the main it
  // replaced. The base is passed as a resolved SHA, the way the workflow
  // passes github.event.before.
  const seedLinear = (onHead: () => void) => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ratchets@example.test");
    git("config", "user.name", "Ratchets Test");
    git("config", "commit.gpgsign", "false");
    writeDoc(PERF_BUDGET_PATH, budget);
    commit("base documents");
    onHead();
    commit("pushed commit");
    return git("rev-parse", "HEAD~1");
  };

  it("exits 1 when a pushed commit relaxes against its direct parent", () => {
    const base = seedLinear(() => writeDoc(PERF_BUDGET_PATH, { board: 3, fold: 20 }));
    const result = run(base, "HEAD");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(PERF_BUDGET_PATH);
    expect(result.stdout).toContain("board");
    expect(result.stdout).toContain("merge base 2, head 3");
  });

  it("exits 0 when a pushed commit only tightens against its direct parent", () => {
    const base = seedLinear(() => writeDoc(PERF_BUDGET_PATH, { board: 1, fold: 20 }));
    const result = run(base, "HEAD");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("exits 1 when the branch deletes a ratchet document", () => {
    seed(() => git("rm", "-q", PERF_BUDGET_PATH));
    const result = run("main", "feature");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(PERF_BUDGET_PATH);
  });

  it("exits 1 when the branch replaces a document with a symlink", () => {
    // The link's target text is the merge base's JSON, so reading the blob
    // would see an unchanged document while the checks read a raised budget.
    const target = JSON.stringify(budget);
    seed(() => {
      rmSync(join(root, PERF_BUDGET_PATH));
      symlinkSync(target, join(root, PERF_BUDGET_PATH));
      writeDoc(join("scripts", target), { board: 99, fold: 20 });
    });
    expect(git("ls-tree", "feature", "--", PERF_BUDGET_PATH)).toMatch(/^120000 blob /);
    const result = run("main", "feature");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(PERF_BUDGET_PATH);
    expect(result.stdout).toContain("120000");
  });

  it("exits 1 when the branch makes a document executable", () => {
    seed(() => chmodSync(join(root, PERF_BUDGET_PATH), 0o755));
    expect(git("ls-tree", "feature", "--", PERF_BUDGET_PATH)).toMatch(/^100755 blob /);
    const result = run("main", "feature");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(PERF_BUDGET_PATH);
    expect(result.stdout).toContain("100755");
  });

  it("exits 2 when the merge base holds a document that is not a regular file", () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ratchets@example.test");
    git("config", "user.name", "Ratchets Test");
    git("config", "commit.gpgsign", "false");
    mkdirSync(join(root, "scripts"));
    // Valid JSON as the link text, so a blob read would parse and compare.
    symlinkSync('{"board":1}', join(root, PERF_BUDGET_PATH));
    commit("symlinked document");
    git("checkout", "-q", "-b", "feature");
    rmSync(join(root, PERF_BUDGET_PATH));
    writeDoc(PERF_BUDGET_PATH, budget);
    commit("regular document");
    const result = run("main", "feature");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("not a regular file");
  });

  it("reads committed revisions, never the working tree", () => {
    seed(() => writeFileSync(join(root, "unrelated.txt"), "change\n"));
    git("checkout", "-q", "feature");
    writeDoc(PERF_BUDGET_PATH, { board: 99, fold: 20 });
    expect(run("main", "feature").status).toBe(0);
  });

  it("accepts whatever the head has when the merge base had no document", () => {
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ratchets@example.test");
    git("config", "user.name", "Ratchets Test");
    git("config", "commit.gpgsign", "false");
    commit("empty base");
    git("checkout", "-q", "-b", "feature");
    writeDoc(PERF_BUDGET_PATH, { board: 2 });
    commit("introduce documents");
    const result = run("main", "feature");
    expect(result.status).toBe(0);
    expect(checkRatchets(root, "main", "feature").findings).toEqual([]);
  });

  it("exits 1 when the head has a non-regular document and the merge base had none", () => {
    // Valid JSON as the link text, so a blob read would parse and compare.
    // What this pins is the classification: a non-regular head document is
    // a finding (exit 1) even when the merge base has no document — not the
    // exit-2 error readDocument would raise for the same entry.
    git("init", "-q", "-b", "main");
    git("config", "user.email", "ratchets@example.test");
    git("config", "user.name", "Ratchets Test");
    git("config", "commit.gpgsign", "false");
    commit("empty base");
    git("checkout", "-q", "-b", "feature");
    mkdirSync(join(root, "scripts"), { recursive: true });
    symlinkSync('{"board":1}', join(root, PERF_BUDGET_PATH));
    commit("symlinked document with no merge-base document");
    expect(git("ls-tree", "feature", "--", PERF_BUDGET_PATH)).toMatch(/^120000 blob /);
    const result = run("main", "feature");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(PERF_BUDGET_PATH);
    expect(result.stdout).toContain("120000");
  });

  it("exits 2 when the two revisions share no merge base", () => {
    seed(() => writeFileSync(join(root, "unrelated.txt"), "change\n"));
    git("checkout", "-q", "--orphan", "island");
    writeDoc(PERF_BUDGET_PATH, budget);
    commit("unrelated history");
    const result = run("main", "island");
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("merge base");
  });

  it("exits 2 in a shallow clone, naming the fix", () => {
    seed(() => writeFileSync(join(root, "unrelated.txt"), "change\n"));
    const shallow = join(root, "shallow");
    const clone = spawnSync("git", ["clone", "-q", "--depth=1", `file://${root}`, shallow], {
      encoding: "utf8",
    });
    expect(clone.status, `clone failed: ${clone.stderr}`).toBe(0);
    // Even the trivially answerable HEAD-vs-HEAD comparison must refuse to
    // run: a shallow history can make git merge-base return a wrong base
    // without erroring, so its answer cannot be trusted at all.
    const result = spawnSync(process.execPath, [script, "origin/main", "HEAD"], {
      cwd: shallow,
      encoding: "utf8",
    });
    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("shallow");
    expect(result.stderr).toContain("unshallow");
  });

  it("exits 2 on a missing argument or an unknown revision", () => {
    seed(() => writeFileSync(join(root, "unrelated.txt"), "change\n"));
    expect(run().status).toBe(2);
    expect(run("main").status).toBe(2);
    expect(run("main", "feature", "extra").status).toBe(2);
    expect(run("main", "no-such-branch").status).toBe(2);
    expect(run("--help", "feature").status).toBe(2);
  });

  it("exits 2 when a document at head is not valid JSON", () => {
    seed(() => writeDoc(PERF_BUDGET_PATH, "{ not json\n"));
    const result = run("main", "feature");
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(PERF_BUDGET_PATH);
  });
});
