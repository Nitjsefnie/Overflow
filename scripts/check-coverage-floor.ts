#!/usr/bin/env node
// Coverage floor ratchet (issue 592): fails when line coverage drops below
// the floor recorded in scripts/coverage.json.
//
//   node scripts/check-coverage-floor.ts
//
// Reads the vitest json-summary output at coverage/coverage-summary.json and
// the committed floor document at scripts/coverage.json. Exit 0 when
// total.lines.pct is at or above the floor, 1 when it is below it, 2 when
// either file is missing or unreadable. The floor itself is only ever moved
// by scripts/calibrate-coverage.ts, which raises it — never by hand.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SUMMARY_PATH = "coverage/coverage-summary.json";
export const DOC_PATH = "scripts/coverage.json";

export interface CoverageFloorDoc {
  gap: number;
  hysteresis: number;
  languages: {
    typescript: {
      measured: number;
      floor: number;
    };
  };
}

export interface CoverageSummary {
  total: {
    lines: {
      pct: number;
    };
  };
}

// Percentages carry at most two decimals; rounding to the same precision
// keeps the comparison exact where float subtraction would inject noise.
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function floorViolation(
  summary: CoverageSummary,
  doc: CoverageFloorDoc,
): string | null {
  const measured = summary.total.lines.pct;
  const floor = doc.languages.typescript.floor;
  if (measured < floor) {
    return `line coverage ${measured}% is below the ${floor}% floor`;
  }
  return null;
}

export function readDoc(root: string): CoverageFloorDoc {
  return JSON.parse(readFileSync(join(root, DOC_PATH), "utf8"));
}

export function readSummary(root: string): CoverageSummary {
  return JSON.parse(readFileSync(join(root, SUMMARY_PATH), "utf8"));
}

export function repoRoot(): string {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    console.error("not inside a git repository");
    process.exit(2);
  }
  return result.stdout.trim();
}

function main(): void {
  const root = repoRoot();
  let doc: CoverageFloorDoc;
  let summary: CoverageSummary;
  try {
    doc = readDoc(root);
    summary = readSummary(root);
  } catch (error) {
    console.error(
      `coverage floor check: cannot read ${DOC_PATH} or ${SUMMARY_PATH}: ${error}`,
    );
    process.exit(2);
  }
  const violation = floorViolation(summary, doc);
  if (violation !== null) {
    console.log(`coverage floor check: ${violation}`);
    process.exit(1);
  }
  console.log(
    `coverage floor check: ${summary.total.lines.pct}% against the ` +
      `${doc.languages.typescript.floor}% floor — ok`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
