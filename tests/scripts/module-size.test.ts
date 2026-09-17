import { execFileSync, spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyTighten,
  collectViolations,
  countLines,
  runCheck,
  type ModuleSizeDoc,
} from "../../scripts/check-module-size.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "module-size-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function document(baseline: Record<string, number> = {}): ModuleSizeDoc {
  return {
    ceilings: { src: 800, tests: 2500 },
    module_size_baseline: baseline,
  };
}

function filesWithLines(entries: Record<string, number>): Map<string, number> {
  const files = new Map<string, number>();
  for (const [path, lines] of Object.entries(entries)) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "line\n".repeat(lines));
    files.set(path, countLines(readFileSync(absolute, "utf8")));
  }
  return files;
}

describe("module size ratchet", () => {
  it("accepts a fully consistent baseline and file tree", () => {
    const files = filesWithLines({
      "src/small.ts": 100,
      "src/big.ts": 900,
      "tests/big.test.ts": 2600,
    });
    const doc = document({ "src/big.ts": 900, "tests/big.test.ts": 2600 });
    expect(collectViolations(files, doc)).toEqual([]);
  });

  it("reports only over for an unlisted file above its ceiling", () => {
    const files = filesWithLines({ "src/new.ts": 801 });
    expect(collectViolations(files, document())).toMatchObject([
      { kind: "over", path: "src/new.ts" },
    ]);
  });

  it("reports only grown for a listed file above its recorded count", () => {
    const files = filesWithLines({ "src/big.ts": 950 });
    expect(collectViolations(files, document({ "src/big.ts": 900 }))).toMatchObject([
      { kind: "grown", path: "src/big.ts" },
    ]);
  });

  it("reports only missing for a baseline path absent from files", () => {
    const files = filesWithLines({});
    expect(collectViolations(files, document({ "src/gone.ts": 900 }))).toMatchObject([
      { kind: "missing", path: "src/gone.ts" },
    ]);
  });

  it("reports only graduated for a listed test below its tree ceiling", () => {
    const files = filesWithLines({ "tests/big.test.ts": 2400 });
    const doc = document({ "tests/big.test.ts": 2600 });
    expect(collectViolations(files, doc)).toMatchObject([
      { kind: "graduated", path: "tests/big.test.ts" },
    ]);
  });

  it("accepts files exactly at their ceiling or recorded count", () => {
    const files = filesWithLines({
      "src/boundary.ts": 800,
      "tests/boundary.test.ts": 2500,
      "src/listed.ts": 900,
    });
    const doc = document({ "src/listed.ts": 900 });
    expect(collectViolations(files, doc)).toEqual([]);
  });

  it("accepts shrinkage that remains above the ceiling", () => {
    const files = filesWithLines({ "src/big.ts": 850 });
    expect(collectViolations(files, document({ "src/big.ts": 900 }))).toEqual([]);
  });

  it("leaves an already tight baseline unchanged", () => {
    const files = filesWithLines({ "src/big.ts": 900, "src/small.ts": 100 });
    const doc = document({ "src/big.ts": 900 });
    expect(applyTighten(files, doc)).toEqual({ doc, changes: [] });
  });

  it("lowers shrunken counts without raising grown counts", () => {
    const files = filesWithLines({ "src/grown.ts": 950, "src/shrunk.ts": 860 });
    const doc = document({ "src/grown.ts": 900, "src/shrunk.ts": 900 });
    const original = JSON.stringify(doc);
    const result = applyTighten(files, doc);
    expect(result.doc.module_size_baseline).toEqual({
      "src/grown.ts": 900,
      "src/shrunk.ts": 860,
    });
    expect(result.changes).toHaveLength(1);
    expect(JSON.stringify(doc)).toBe(original);
  });

  it("drops missing and graduated entries without adding unlisted files", () => {
    const files = filesWithLines({
      "tests/graduated.test.ts": 2400,
      "src/unlisted.ts": 1000,
      "src/kept.ts": 900,
    });
    const doc = document({
      "src/missing.ts": 900,
      "tests/graduated.test.ts": 2600,
      "src/kept.ts": 900,
    });
    expect(applyTighten(files, doc).doc.module_size_baseline).toEqual({
      "src/kept.ts": 900,
    });
  });

  it("allows the last entry to graduate to an empty baseline", () => {
    const files = filesWithLines({ "src/graduated.ts": 799 });
    const doc = document({ "src/graduated.ts": 900 });
    expect(applyTighten(files, doc).doc.module_size_baseline).toEqual({});
  });

  it("preserves untouched serialized members and the survivor key order", () => {
    const files = filesWithLines({ "src/z-lowered.ts": 850, "src/a-kept.ts": 950 });
    const doc = document({
      "src/z-lowered.ts": 900,
      "src/m-dropped.ts": 900,
      "src/a-kept.ts": 950,
    });
    const before = JSON.stringify(doc, null, 2);
    const tightened = applyTighten(files, doc).doc;
    const after = JSON.stringify(tightened, null, 2);
    const untouched = '    "src/a-kept.ts": 950';
    expect(before.split("\n")).toContain(untouched);
    expect(after.split("\n")).toContain(untouched);
    expect(Object.keys(tightened.module_size_baseline)).toEqual([
      "src/z-lowered.ts",
      "src/a-kept.ts",
    ]);
    expect(tightened.module_size_baseline).toEqual({
      "src/z-lowered.ts": 850,
      "src/a-kept.ts": 950,
    });
    expect(tightened.ceilings).toEqual({ src: 800, tests: 2500 });
  });

  it("counts newline characters with wc -l semantics", () => {
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(1);
    expect(countLines("")).toBe(0);
  });

  it("checks tracked files end to end, including growth and unstaged deletion", () => {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root });
    git("init", "-q");
    git("config", "user.email", "module-size@example.test");
    git("config", "user.name", "Module Size Test");
    filesWithLines({ "src/big.ts": 850, "src/small.ts": 100 });
    git("add", "-A");
    const doc = document({ "src/big.ts": 850 });
    expect(runCheck(root, doc)).toEqual([]);

    appendFileSync(join(root, "src/big.ts"), "line\n".repeat(60));
    expect(runCheck(root, doc)).toMatchObject([
      { kind: "grown", path: "src/big.ts" },
    ]);

    // git ls-files still includes a file deleted from the working tree.
    unlinkSync(join(root, "src/big.ts"));
    expect(runCheck(root, doc)).toMatchObject([
      { kind: "missing", path: "src/big.ts" },
    ]);

    mkdirSync(join(root, "scripts"));
    writeFileSync(join(root, "scripts/module-size.json"), JSON.stringify(doc));
    const script = fileURLToPath(new URL("../../scripts/check-module-size.ts", import.meta.url));
    const check = spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });
    expect(check.status).toBe(1);
    expect(check.stdout).toContain("missing: src/big.ts");
    expect(check.stderr).toBe("");

    const tighten = spawnSync(process.execPath, [script, "--tighten"], {
      cwd: root,
      encoding: "utf8",
    });
    expect(tighten.status).toBe(0);
    expect(tighten.stderr).toBe("");
    expect(JSON.parse(readFileSync(join(root, "scripts/module-size.json"), "utf8")))
      .toEqual(document());
  });
});
