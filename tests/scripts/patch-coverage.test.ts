import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseCobertura,
  parseDiff,
  patchCoverage,
  REPORT_PATH,
} from "../../scripts/patch-coverage.ts";

const script = fileURLToPath(
  new URL("../../scripts/patch-coverage.ts", import.meta.url),
);

// A diff carrying every shape the parser must survive: two hunks in one
// modified file, a new file, a deleted file, a file with no cobertura
// record at all, an empty context line, and a "no newline" marker.
const DIFF = [
  "diff --git a/src/lib/greet.ts b/src/lib/greet.ts",
  "index 1111111..2222222 100644",
  "--- a/src/lib/greet.ts",
  "+++ b/src/lib/greet.ts",
  "@@ -1,4 +1,7 @@",
  " const a = 1;",
  "+const b = 2;",
  "+const c = 3;",
  " const d = 4;",
  "@@ -20,3 +23,5 @@",
  " const e = 5;",
  "+const f = 6;",
  "",
  "+const g = 7;",
  " const h = 8;",
  "\\ No newline at end of file",
  "diff --git a/src/lib/measure.ts b/src/lib/measure.ts",
  "new file mode 100644",
  "index 0000000..3333333",
  "--- /dev/null",
  "+++ b/src/lib/measure.ts",
  "@@ -0,0 +1,3 @@",
  "+export const one = 1;",
  "+export const two = 2;",
  "+export const three = 3;",
  "diff --git a/src/lib/ghost.ts b/src/lib/ghost.ts",
  "new file mode 100644",
  "index 0000000..4444444",
  "--- /dev/null",
  "+++ b/src/lib/ghost.ts",
  "@@ -0,0 +1,3 @@",
  "+export const phantom = true;",
  "+export const unseen = true;",
  "+export const unmeasured = true;",
  "diff --git a/src/lib/dead.ts b/src/lib/dead.ts",
  "deleted file mode 100644",
  "index 5555555..0000000",
  "--- a/src/lib/dead.ts",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-export const gone = 1;",
  "-export const alsoGone = 2;",
].join("\n");

// Cobertura as istanbul-lib-report writes it: one class per file, line
// elements recording every executable line with its hit count. greet.ts
// does not record line 26 (an added line at 26 is therefore excluded);
// measure.ts records 1 and 3 as hit and 2 as missed; ghost.ts is absent.
const COBERTURA = [
  '<?xml version="1.0" ?>',
  '<coverage lines-valid="9" lines-covered="4" line-rate="0.4444"',
  '         branches-valid="0" branches-covered="0" branch-rate="0"',
  '         timestamp="1758153600" complexity="0" version="0.1">',
  "  <sources>",
  "    <source>/repo</source>",
  "  </sources>",
  "  <packages>",
  '    <package name="lib" line-rate="0.4444" branch-rate="0" complexity="0">',
  "      <classes>",
  '        <class name="greet.ts" filename="src/lib/greet.ts" line-rate="0.25" branch-rate="0" complexity="0">',
  "          <methods></methods>",
  "          <lines>",
  '            <line number="1" hits="3" branch="false"/>',
  '            <line number="2" hits="0" branch="false"/>',
  '            <line number="3" hits="2" branch="false"/>',
  '            <line number="24" hits="0" branch="false"/>',
  '            <line number="25" hits="0" branch="false"/>',
  "          </lines>",
  "        </class>",
  '        <class name="measure.ts" filename="src/lib/measure.ts" line-rate="0.6667" branch-rate="0" complexity="0">',
  "          <methods></methods>",
  "          <lines>",
  '            <line number="1" hits="1" branch="false"/>',
  '            <line number="2" hits="0" branch="false"/>',
  '            <line number="3" hits="1" branch="false"/>',
  "          </lines>",
  "        </class>",
  '        <class name="other.ts" filename="src/lib/other.ts" line-rate="0" branch-rate="0" complexity="0">',
  "          <methods></methods>",
  "          <lines>",
  '            <line number="1" hits="0" branch="false"/>',
  "          </lines>",
  "        </class>",
  "      </classes>",
  "    </package>",
  "  </packages>",
  "</coverage>",
].join("\n");

describe("added-line parsing", () => {
  it("counts added lines per new-side line number across hunks", () => {
    const added = parseDiff(DIFF);
    expect(added.get("src/lib/greet.ts")).toEqual([2, 3, 24, 26]);
    expect(added.get("src/lib/measure.ts")).toEqual([1, 2, 3]);
    expect(added.get("src/lib/ghost.ts")).toEqual([1, 2, 3]);
    expect(added.has("src/lib/dead.ts")).toBe(false);
  });

  it("returns an empty map for an empty diff", () => {
    expect(parseDiff("").size).toBe(0);
  });

  it("reads added lines whose content starts with plus signs as content", () => {
    // An added line whose content begins "++ " renders as a raw "+++ …"
    // line — indistinguishable from a file header unless the parser knows
    // it is inside a hunk. The line after each proves the hunk recovered.
    const tricky = [
      "diff --git a/src/lib/plus.ts b/src/lib/plus.ts",
      "index 0000000..6666666",
      "--- /dev/null",
      "+++ b/src/lib/plus.ts",
      "@@ -0,0 +1,4 @@",
      "+plus first",
      "+++ header-looking",
      "++++ triple-header",
      "+plus last",
    ].join("\n");
    const added = parseDiff(tricky);
    expect(added.size).toBe(1);
    expect(added.get("src/lib/plus.ts")).toEqual([1, 2, 3, 4]);
  });
});

describe("cobertura parsing", () => {
  it("records hits per file and line", () => {
    const hits = parseCobertura(COBERTURA);
    expect(hits.get("src/lib/greet.ts")?.get(2)).toBe(0);
    expect(hits.get("src/lib/greet.ts")?.get(3)).toBe(2);
    expect(hits.get("src/lib/greet.ts")?.has(26)).toBe(false);
    expect(hits.get("src/lib/measure.ts")?.get(1)).toBe(1);
  });
});

describe("join against executable lines", () => {
  it("excludes added lines in files or on line numbers cobertura does not record", () => {
    const report = patchCoverage(DIFF, COBERTURA);
    expect(report.measured).toBe(true);
    expect(report.files.map((file) => file.path)).toEqual([
      "src/lib/greet.ts",
      "src/lib/measure.ts",
    ]);
    const greet = report.files[0]!;
    expect(greet.added).toBe(3);
    expect(greet.covered).toBe(1);
    expect(greet.missed_ranges).toEqual([[2, 2], [24, 24]]);
  });

  it("computes missed ranges as contiguous runs of uncovered added lines", () => {
    const report = patchCoverage(DIFF, COBERTURA);
    const measure = report.files[1]!;
    expect(measure.added).toBe(3);
    expect(measure.covered).toBe(2);
    expect(measure.missed_ranges).toEqual([[2, 2]]);
    expect(report.total_added).toBe(6);
    expect(report.total_covered).toBe(3);
  });

  it("measures nothing when no added line is executable", () => {
    const report = patchCoverage(DIFF, "");
    expect(report.measured).toBe(true);
    expect(report.files).toEqual([]);
    expect(report.total_added).toBe(0);
    expect(report.total_covered).toBe(0);
  });
});

describe("markdown rendering", () => {
  it("renders totals and per-file rows with missed ranges", () => {
    const report = patchCoverage(DIFF, COBERTURA);
    expect(report.markdown).toContain("## Patch coverage");
    expect(report.markdown).toContain("not a gate");
    expect(report.markdown).toContain("**3** of **6** added lines covered (50%)");
    expect(report.markdown).toContain("| src/lib/greet.ts | 3 | 1 | 2, 24 |");
    expect(report.markdown).toContain("| src/lib/measure.ts | 3 | 2 | 2 |");
    expect(report.markdown).not.toContain("ghost");
  });

  it("renders a nothing-to-measure body when no added line is executable", () => {
    const report = patchCoverage(DIFF, "");
    expect(report.markdown).toContain("nothing to measure");
    expect(report.markdown).not.toContain("| src/lib/greet.ts");
  });
});

describe("patch-coverage CLI", () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "patch-coverage-"));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const seed = () => {
    const git = (...args: string[]) =>
      spawnSync("git", args, { cwd: root, encoding: "utf8" });
    git("init", "-q");
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(join(root, "coverage/cobertura-coverage.xml"), `${COBERTURA}\n`);
  };

  it("writes the report json and prints the markdown body", () => {
    seed();
    const result = spawnSync(
      process.execPath,
      [script, "coverage/cobertura-coverage.xml"],
      { cwd: root, encoding: "utf8", input: DIFF },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("## Patch coverage");
    const written = JSON.parse(
      readFileSync(join(root, REPORT_PATH), "utf8"),
    ) as { measured: boolean; total_added: number; total_covered: number };
    expect(written.measured).toBe(true);
    expect(written.total_added).toBe(6);
    expect(written.total_covered).toBe(3);
  });

  it("exits 2 when the cobertura argument is missing", () => {
    seed();
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      input: DIFF,
    });
    expect(result.status).toBe(2);
  });

  it("exits 2 when the cobertura file is unreadable", () => {
    seed();
    rmSync(join(root, "coverage/cobertura-coverage.xml"));
    const result = spawnSync(
      process.execPath,
      [script, "coverage/cobertura-coverage.xml"],
      { cwd: root, encoding: "utf8", input: DIFF },
    );
    expect(result.status).toBe(2);
  });
});
