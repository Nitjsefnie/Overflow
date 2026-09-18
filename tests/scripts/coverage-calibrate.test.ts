import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { calibration } from "../../scripts/calibrate-coverage.ts";
import { type CoverageFloorDoc } from "../../scripts/check-coverage-floor.ts";

let root: string;
const script = fileURLToPath(
  new URL("../../scripts/calibrate-coverage.ts", import.meta.url),
);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "coverage-calibrate-"));
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

describe("coverage calibration decision", () => {
  it("does nothing while the measurement is within the hysteresis", () => {
    expect(calibration(summary(73.46), doc(73.46, 72.46))).toBeNull();
    expect(calibration(summary(73.96), doc(73.46, 72.46))).toBeNull();
    expect(calibration(summary(72.0), doc(73.46, 72.46))).toBeNull();
  });

  it("recalibrates only upward, past the hysteresis", () => {
    const next = calibration(summary(73.97), doc(73.46, 72.46));
    expect(next).not.toBeNull();
    expect(next!.languages.typescript.measured).toBe(73.97);
    expect(next!.languages.typescript.floor).toBe(72.97);
    expect(next!.gap).toBe(1.0);
    expect(next!.hysteresis).toBe(0.5);
  });

  it("treats an exact hysteresis step as no recalibration", () => {
    expect(calibration(summary(73.96), doc(73.46, 72.46))).toBeNull();
  });

  it("rounds the difference so float noise cannot cross the boundary", () => {
    // 70.8 - 70.3 is 0.5000000000000014 in float arithmetic.
    expect(calibration(summary(70.8), doc(70.3, 69.3))).toBeNull();
    expect(calibration(summary(70.9), doc(70.3, 69.3))).not.toBeNull();
  });
});

describe("coverage calibration CLI", () => {
  const git = (...args: string[]) =>
    spawnSync("git", args, { cwd: root, encoding: "utf8" });

  const seed = (summaryPct: number, measured: number, floor: number) => {
    git("init", "-q");
    mkdirSync(join(root, "scripts"), { recursive: true });
    writeFileSync(
      join(root, "scripts/coverage.json"),
      `${JSON.stringify(doc(measured, floor), null, 2)}\n`,
    );
    mkdirSync(join(root, "coverage"), { recursive: true });
    writeFileSync(
      join(root, "coverage/coverage-summary.json"),
      `${JSON.stringify(summary(summaryPct), null, 2)}\n`,
    );
  };

  const run = () =>
    spawnSync(process.execPath, [script], { cwd: root, encoding: "utf8" });

  it("writes nothing when the measurement is within the hysteresis", () => {
    seed(73.46, 73.46, 72.46);
    const before = readFileSync(join(root, "scripts/coverage.json"), "utf8");
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("unchanged");
    expect(readFileSync(join(root, "scripts/coverage.json"), "utf8")).toBe(before);
  });

  it("rewrites the floor document when coverage outgrows the record", () => {
    seed(76.1, 73.46, 72.46);
    const result = run();
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("wrote scripts/coverage.json");
    const rewritten = JSON.parse(
      readFileSync(join(root, "scripts/coverage.json"), "utf8"),
    ) as CoverageFloorDoc;
    expect(rewritten.languages.typescript.measured).toBe(76.1);
    expect(rewritten.languages.typescript.floor).toBe(75.1);
    expect(rewritten.gap).toBe(1.0);
    expect(rewritten.hysteresis).toBe(0.5);
  });
});
