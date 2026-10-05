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
// either file is missing, unreadable, or — on the --summary path, whose file
// another run produced — not a summary of the declared shape and range. The
// floor itself is only ever moved by scripts/calibrate-coverage.ts, which
// raises it — never by hand.

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
 * Schema and range problems in a summary document, each naming the exact
 * field at fault. A summary this run did not produce may name any document
 * its producer likes, so the --summary path trusts only the declared shape:
 * the objects on the path the floor reads (total.lines) must be objects, and
 * total.lines.pct must be a finite number in 0-100. Keys the floor logic
 * does not read — the reporter's own counts and the per-file entries — are
 * not validated and not rejected.
 */
export function summaryProblems(summary: unknown): string[] {
  if (summary === null || typeof summary !== "object" || Array.isArray(summary)) {
    return [`the summary is not a JSON object (got ${shown(summary)})`];
  }
  const total: unknown = (summary as Record<string, unknown>).total;
  if (total === undefined) return ["total is missing"];
  if (total === null || typeof total !== "object" || Array.isArray(total)) {
    return [`total is not an object (got ${shown(total)})`];
  }
  const lines: unknown = (total as Record<string, unknown>).lines;
  if (lines === undefined) return ["total.lines is missing"];
  if (lines === null || typeof lines !== "object" || Array.isArray(lines)) {
    return [`total.lines is not an object (got ${shown(lines)})`];
  }
  const pct: unknown = (lines as Record<string, unknown>).pct;
  if (pct === undefined) return ["total.lines.pct is missing"];
  if (typeof pct !== "number" || !Number.isFinite(pct)) {
    return [`total.lines.pct must be a finite number (got ${shown(pct)})`];
  }
  if (pct < 0 || pct > 100) {
    return [`total.lines.pct ${pct} is outside 0-100`];
  }
  return [];
}

/** A value as the message shows it: quoted when a string, named when a
 *  non-JSON object, plain otherwise. */
function shown(value: unknown): string {
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return "array";
  return String(value);
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
  const args = process.argv.slice(2);
  const summaryPath = summaryPathFrom(args, root);
  if (summaryPath === null) {
    console.error("usage: node scripts/check-coverage-floor.ts [--summary <path>]");
    process.exit(2);
  }
  // A summary this run did not produce — the --summary path, which the verify
  // job reads the awaited suite run's artifact through — is validated against
  // the declared shape and the 0-100 range before the floor logic reads any
  // of it; the default path keeps reading this run's own measurement as the
  // reporter wrote it.
  const externalSummary = args.length > 0;
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
  if (externalSummary) {
    const problems = summaryProblems(summary);
    if (problems.length > 0) {
      console.error(
        `coverage floor check: ${summaryPath} is not a coverage summary ` +
          `this check can apply: ${problems.join("; ")}`,
      );
      process.exit(2);
    }
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
