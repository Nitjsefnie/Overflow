#!/usr/bin/env node
// Coverage floor calibrator (issue 592): raises the recorded measurement
// and floor when real coverage has outgrown the record by more than the
// hysteresis. CI runs this on main after the coverage report; the same run
// by hand against a fresh summary does the same job.
//
//   node scripts/calibrate-coverage.ts
//
// Reads coverage/coverage-summary.json and scripts/coverage.json. When the
// measured percentage minus the recorded one exceeds the hysteresis —
// upward only, so a drop never loosens the floor — the document is
// rewritten with the new measurement and floor = measurement minus gap.
// Any other comparison writes nothing at all.
//
// With --simulate-refused-raise the summary is ignored entirely: the script
// writes a fabricated +5 raise computed from the recorded document alone
// (measured = recorded + 5, floor = measured - gap), for the calibrate
// self-test whose push branch protection must refuse.

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  DOC_PATH,
  readDoc,
  readSummary,
  repoRoot,
  round2,
  type CoverageFloorDoc,
  type CoverageSummary,
} from "./check-coverage-floor.ts";

export function calibration(
  summary: CoverageSummary,
  doc: CoverageFloorDoc,
): CoverageFloorDoc | null {
  const measured = summary.total.lines.pct;
  const recorded = doc.languages.typescript.measured;
  if (round2(measured - recorded) <= doc.hysteresis) {
    return null;
  }
  return {
    ...doc,
    languages: {
      ...doc.languages,
      typescript: {
        measured: round2(measured),
        floor: round2(measured - doc.gap),
      },
    },
  };
}

// The workflow_dispatch self-test needs a raise that branch protection is
// guaranteed to refuse, without measuring anything: +5 points off the
// recorded document, same gap rule as a real calibration.
export function simulateRaise(doc: CoverageFloorDoc): CoverageFloorDoc {
  const measured = round2(doc.languages.typescript.measured + 5);
  return {
    ...doc,
    languages: {
      ...doc.languages,
      typescript: {
        measured,
        floor: round2(measured - doc.gap),
      },
    },
  };
}

function writeDoc(root: string, next: CoverageFloorDoc): void {
  writeFileSync(join(root, DOC_PATH), `${JSON.stringify(next, null, 2)}\n`);
}

function simulateMain(): void {
  const root = repoRoot();
  let doc: CoverageFloorDoc;
  try {
    doc = readDoc(root);
  } catch (error) {
    console.error(`coverage calibration: cannot read ${DOC_PATH}: ${error}`);
    process.exit(2);
  }
  const next = simulateRaise(doc);
  writeDoc(root, next);
  console.log(
    `coverage calibration: simulated raise for the calibrate self-test: ` +
      `measured ${doc.languages.typescript.measured}% -> ` +
      `${next.languages.typescript.measured}%, floor ` +
      `${doc.languages.typescript.floor}% -> ` +
      `${next.languages.typescript.floor}%; wrote ${DOC_PATH}`,
  );
}

function main(): void {
  if (process.argv.slice(2).includes("--simulate-refused-raise")) {
    simulateMain();
    return;
  }
  const root = repoRoot();
  let doc: CoverageFloorDoc;
  let summary: CoverageSummary;
  try {
    doc = readDoc(root);
    summary = readSummary(root);
  } catch (error) {
    console.error(
      `coverage calibration: cannot read ${DOC_PATH} or the coverage summary: ${error}`,
    );
    process.exit(2);
  }
  const next = calibration(summary, doc);
  const measured = summary.total.lines.pct;
  const recorded = doc.languages.typescript.measured;
  if (next === null) {
    console.log(
      `coverage calibration: measured ${measured}% against recorded ` +
        `${recorded}%, within the ${doc.hysteresis} hysteresis; ` +
        `${DOC_PATH} unchanged`,
    );
    return;
  }
  writeFileSync(join(root, DOC_PATH), `${JSON.stringify(next, null, 2)}\n`);
  console.log(
    `coverage calibration: measured ${recorded}% -> ${measured}%, floor ` +
      `${doc.languages.typescript.floor}% -> ${next.languages.typescript.floor}%; ` +
      `wrote ${DOC_PATH}`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
