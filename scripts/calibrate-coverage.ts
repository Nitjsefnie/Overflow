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

function main(): void {
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
