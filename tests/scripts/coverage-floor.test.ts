import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  floorViolation,
  round2,
  summaryProblems,
  type CoverageFloorDoc,
  type CoverageSummary,
} from "../../scripts/check-coverage-floor.ts";

let root: string;
const script = fileURLToPath(
  new URL("../../scripts/check-coverage-floor.ts", import.meta.url),
);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "coverage-floor-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const doc = (measured: number, floor: number): CoverageFloorDoc => ({
  gap: 1.0,
  hysteresis: 0.5,
  languages: { typescript: { measured, floor } },
});

const summary = (pct: number) => ({
  total: { lines: { pct } },
});

describe("coverage floor", () => {
  it("rounds to the two decimals the summary reports", () => {
    expect(round2(72.459)).toBe(72.46);
  });

  it("violates below the floor and passes at or above it", () => {
    expect(floorViolation(summary(72.9), doc(73.9, 72.9))).toBeNull();
    expect(floorViolation(summary(73.0), doc(74.0, 73.0))).toBeNull();
    expect(floorViolation(summary(72.89), doc(74.0, 72.9))).toMatch(
      /below the 72.9% floor/,
    );
  });

  it("compares against the floor, not the recorded measurement", () => {
    expect(floorViolation(summary(73.5), doc(80.0, 72.5))).toBeNull();
    expect(floorViolation(summary(72.4), doc(80.0, 72.5))).toMatch(
      /below the 72.5% floor/,
    );
  });

  it("fails closed when the measured percentage is missing or not finite", () => {
    const bad = (pct: unknown) => ({ total: { lines: { pct } } });
    for (const pct of [NaN, Infinity, -Infinity, "73", null]) {
      expect(
        floorViolation(bad(pct) as unknown as CoverageSummary, doc(74.0, 73.0)),
      ).toMatch(/missing or not a finite number/);
    }
    expect(
      floorViolation(
        { total: { lines: {} } } as unknown as CoverageSummary,
        doc(74.0, 73.0),
      ),
    ).toMatch(/missing or not a finite number/);
  });
});

describe("summary validation on the --summary path", () => {
  it("returns no problem for the minimal valid shape and the real reporter shape", () => {
    expect(summaryProblems({ total: { lines: { pct: 73 } } })).toEqual([]);
    expect(
      summaryProblems({
        total: {
          lines: { total: 100, covered: 73, skipped: 0, pct: 73 },
          statements: { total: 1, covered: 1, skipped: 0, pct: 100 },
        },
        "src/a.ts": { lines: { total: 10, covered: 7, skipped: 0, pct: 70 } },
      }),
    ).toEqual([]);
  });

  it("accepts the range boundaries 0 and 100", () => {
    expect(summaryProblems({ total: { lines: { pct: 0 } } })).toEqual([]);
    expect(summaryProblems({ total: { lines: { pct: 100 } } })).toEqual([]);
  });

  it("names the field when the path the floor reads is missing or mistyped", () => {
    expect(summaryProblems(null)).toEqual(["the summary is not a JSON object (got null)"]);
    expect(summaryProblems([73])).toEqual(["the summary is not a JSON object (got array)"]);
    expect(summaryProblems({})).toEqual(["total is missing"]);
    expect(summaryProblems({ total: 5 })).toEqual(["total is not an object (got 5)"]);
    expect(summaryProblems({ total: { lines: "x" } })).toEqual([
      'total.lines is not an object (got "x")',
    ]);
    expect(summaryProblems({ total: { lines: {} } })).toEqual(["total.lines.pct is missing"]);
    expect(summaryProblems({ total: { lines: { pct: "73" } } })).toEqual([
      'total.lines.pct must be a finite number (got "73")',
    ]);
    expect(summaryProblems({ total: { lines: { pct: null } } })).toEqual([
      "total.lines.pct must be a finite number (got null)",
    ]);
    expect(summaryProblems({ total: { lines: { pct: NaN } } })).toEqual([
      "total.lines.pct must be a finite number (got NaN)",
    ]);
  });

  it("names the field when the percentage is out of range", () => {
    expect(summaryProblems({ total: { lines: { pct: -1 } } })).toEqual([
      "total.lines.pct -1 is outside 0-100",
    ]);
    expect(summaryProblems({ total: { lines: { pct: 100.01 } } })).toEqual([
      "total.lines.pct 100.01 is outside 0-100",
    ]);
  });
});

describe("coverage floor CLI", () => {
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8" });

  const seed = (summaryPct: number | null, docPct?: [number, number]) => {
    git("init", "-q");
    if (docPct) {
      const [measured, floor] = docPct;
      mkdirSync(join(root, "scripts"), { recursive: true });
      writeFileSync(
        join(root, "scripts/coverage.json"),
        `${JSON.stringify(doc(measured, floor), null, 2)}\n`,
      );
    }
    if (summaryPct !== null) {
      mkdirSync(join(root, "coverage"), { recursive: true });
      writeFileSync(
        join(root, "coverage/coverage-summary.json"),
        `${JSON.stringify(summary(summaryPct), null, 2)}\n`,
      );
    }
  };

  it("passes when the summary meets the floor exactly", () => {
    seed(73.0, [74.0, 73.0]);
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("ok");
  });

  it("exits 1 with the floor named when coverage drops below it", () => {
    seed(72.89, [74.0, 72.9]);
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("below the 72.9% floor");
  });

  it("exits 1 when the summary percentage is missing or not a finite number", () => {
    git("init", "-q");
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts/coverage.json"),
      `${JSON.stringify(doc(74.0, 73.0), null, 2)}\n`,
    );
    mkdirSync(join(root, "coverage"), { recursive: true });
    const raw = (json: string) =>
      writeFileSync(join(root, "coverage/coverage-summary.json"), `${json}\n`);
    const run = () =>
      spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });

    raw('{"total":{"lines":{}}}');
    expect(run().status).toBe(1);

    raw('{"total":{"lines":{"pct":null}}}');
    expect(run().status).toBe(1);

    // JSON carries no NaN or Infinity literal: 1e999 parses to Infinity and
    // a bare NaN parses to null, so the non-finite space is covered by the
    // three shapes above plus the NaN unit case.
    raw('{"total":{"lines":{"pct":1e999}}}');
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("not a finite number");
  });

  it("exits 2 when the summary or the floor document is missing", () => {
    seed(null);
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts/coverage.json"),
      `${JSON.stringify(doc(74.0, 73.0), null, 2)}\n`,
    );
    const missingSummary = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
    });
    expect(missingSummary.status).toBe(2);

    rmSync(join(root, "scripts/coverage.json"));
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(
      join(root, "coverage/coverage-summary.json"),
      `${JSON.stringify(summary(73), null, 2)}\n`,
    );
    const missingDoc = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
    });
    expect(missingDoc.status).toBe(2);
  });
});

describe("coverage floor CLI --summary", () => {
  let elsewhere: string;
  beforeEach(() => {
    elsewhere = mkdtempSync(join(tmpdir(), "coverage-floor-summary-"));
    spawnSync("git", ["init", "-q"], { cwd: root, encoding: "utf8" });
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(join(root, "scripts/coverage.json"), `${JSON.stringify(doc(74.0, 73.0), null, 2)}\n`);
  });
  afterEach(() => {
    rmSync(elsewhere, { recursive: true, force: true });
  });

  const write = (path: string, pct: number) => {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, `${JSON.stringify(summary(pct), null, 2)}\n`);
  };
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8" });

  it("reads the summary it is given, not the one under coverage/", () => {
    // A passing summary in the default location must not mask a failing one
    // at the named location, and the reverse.
    write(join(root, "coverage/coverage-summary.json"), 99);
    write(join(elsewhere, "coverage-summary.json"), 50);
    const failing = run("--summary", join(elsewhere, "coverage-summary.json"));
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain("below the 73% floor");

    write(join(root, "coverage/coverage-summary.json"), 10);
    write(join(elsewhere, "coverage-summary.json"), 80);
    const passing = run("--summary", join(elsewhere, "coverage-summary.json"));
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain("80% against the 73% floor");
  });

  it("exits 2 when the named summary is missing, even with one under coverage/", () => {
    write(join(root, "coverage/coverage-summary.json"), 99);
    const result = run("--summary", join(elsewhere, "absent.json"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(join(elsewhere, "absent.json"));
  });

  /**
   * A summary this run did not produce — the --summary path — is validated
   * before the floor logic reads any of it: the exact field the floor applies
   * to must carry a finite number in 0-100, and anything else fails closed
   * naming that field instead of being measured.
   */
  const writeRaw = (json: string) => {
    mkdirSync(elsewhere, { recursive: true });
    writeFileSync(join(elsewhere, "coverage-summary.json"), `${json}\n`);
  };
  const runNamed = () => run("--summary", join(elsewhere, "coverage-summary.json"));

  it("exits 2 naming the field when the percentage is missing", () => {
    writeRaw('{"total":{"lines":{}}}');
    const result = runNamed();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("total.lines.pct");
  });

  it("exits 2 naming the field when the percentage is not a number", () => {
    writeRaw('{"total":{"lines":{"pct":"73"}}}');
    const result = runNamed();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("total.lines.pct");
  });

  it("exits 2 naming the field when the percentage is above 100", () => {
    writeRaw('{"total":{"lines":{"pct":500}}}');
    const result = runNamed();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("total.lines.pct");
    expect(result.stderr).toContain("100");
  });

  it("exits 2 naming the field when the percentage is negative", () => {
    writeRaw('{"total":{"lines":{"pct":-1}}}');
    const result = runNamed();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("total.lines.pct");
  });

  it("exits 2 when the document is not JSON at all", () => {
    writeRaw("not json");
    expect(runNamed().status).toBe(2);
  });

  it("accepts 0 and 100 and the real reporter shape's extra keys", () => {
    // vitest's json-summary carries total.lines.{total,covered,skipped,pct},
    // sibling measurements beside lines, and a per-file entry per file; the
    // validation reads the field the floor applies to and tolerates the rest.
    writeRaw(
      JSON.stringify({
        total: {
          lines: { total: 100, covered: 100, skipped: 0, pct: 100 },
          statements: { total: 1, covered: 1, skipped: 0, pct: 100 },
          functions: { total: 1, covered: 1, skipped: 0, pct: 100 },
          branches: { total: 1, covered: 1, skipped: 0, pct: 100 },
        },
        "src/a.ts": { lines: { total: 100, covered: 100, skipped: 0, pct: 100 } },
      }),
    );
    const passing = runNamed();
    expect(passing.status).toBe(0);
    expect(passing.stdout).toContain("100% against the 73% floor");

    writeRaw(
      JSON.stringify({
        total: { lines: { total: 100, covered: 0, skipped: 100, pct: 0 } },
      }),
    );
    const failing = runNamed();
    expect(failing.status).toBe(1);
    expect(failing.stdout).toContain("below the 73% floor");
  });

  it("exits 2 on --summary without a path or on an unknown argument", () => {
    write(join(root, "coverage/coverage-summary.json"), 99);
    expect(run("--summary").status).toBe(2);
    expect(run("--summary", "").status).toBe(2);
    expect(run("--sumary", join(elsewhere, "x.json")).status).toBe(2);
  });
});
