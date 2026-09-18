import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  floorViolation,
  round2,
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
