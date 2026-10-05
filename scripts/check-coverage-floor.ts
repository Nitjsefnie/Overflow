#!/usr/bin/env node
// Coverage floor ratchet (issue 592): fails when line coverage drops below
// the floor recorded in scripts/coverage.json.
//
//   node scripts/check-coverage-floor.ts [--summary <path>]
//
// Reads the vitest json-summary output — coverage/coverage-summary.json under
// the repository, or exactly the file --summary names — and the committed
// floor document at scripts/coverage.json. --summary lets a caller keep the
// measurement outside the tree being judged. Exit 0 when
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
  const floor = doc.languages.typescript.floor;
  // JSON.parse hands back whatever the summary carries, so the declared
  // number type is not proof: a missing, null or out-of-range percentage
  // must fail the check, never pass it vacuously.
  const measured: unknown = summary.total.lines.pct;
  if (typeof measured !== "number" || !Number.isFinite(measured)) {
    const shown =
      typeof measured === "number" ? String(measured) : JSON.stringify(measured) ?? "absent";
    return (
      `line coverage is missing or not a finite number (got ${shown}) — ` +
      "refusing to pass"
    );
  }
  if (measured < floor) {
    return `line coverage ${measured}% is below the ${floor}% floor`;
  }
  return null;
}

export function readDoc(root: string): CoverageFloorDoc {
  return JSON.parse(readFileSync(join(root, DOC_PATH), "utf8"));
}

export function readSummary(root: string, summaryPath = join(root, SUMMARY_PATH)): CoverageSummary {
  return JSON.parse(readFileSync(summaryPath, "utf8"));
}

/**
 * The summary location the command line names, or the default under `root`.
 * Returns null on a malformed command line: an unknown argument or a
 * --summary with no path is refused rather than read as the default.
 */
export function summaryPathFrom(args: readonly string[], root: string): string | null {
  if (args.length === 0) return join(root, SUMMARY_PATH);
  if (args.length === 2 && args[0] === "--summary" && (args[1] ?? "") !== "") {
    return args[1]!;
  }
  return null;
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
  const summaryPath = summaryPathFrom(process.argv.slice(2), root);
  if (summaryPath === null) {
    console.error("usage: node scripts/check-coverage-floor.ts [--summary <path>]");
    process.exit(2);
  }
  let doc: CoverageFloorDoc;
  let summary: CoverageSummary;
  try {
    doc = readDoc(root);
    summary = readSummary(root, summaryPath);
  } catch (error) {
    console.error(
      `coverage floor check: cannot read ${DOC_PATH} or ${summaryPath}: ${error}`,
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
