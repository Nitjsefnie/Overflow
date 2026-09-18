#!/usr/bin/env node
// Patch coverage report (issue 592): measures how many of the lines this
// change adds were executed by the test suite. Informational only — never a
// gate; the coverage floor remains the merge criterion.
//
//   git diff HEAD^1 HEAD | node scripts/patch-coverage.ts coverage/cobertura-coverage.xml
//
// stdin carries the unified diff of the checked-out commit against its
// first parent (the merge commit's HEAD^1 — never the event's base SHA);
// the sole argument is the cobertura XML written by the coverage run. A
// line counts only when the cobertura file records it as executable for
// its file; added lines in files or on line numbers the cobertura file
// does not record are excluded entirely. Writes
// coverage/patch-coverage.json — the measured flag, the totals, per-file
// detail, and the rendered markdown comment body, pre-rendered here so the
// comment job never renders anything itself — and prints the markdown.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { repoRoot, round2 } from "./check-coverage-floor.ts";

export const REPORT_PATH = "coverage/patch-coverage.json";

export interface PatchFileCoverage {
  path: string;
  added: number;
  covered: number;
  missed_ranges: [number, number][];
}

export interface PatchCoverageReport {
  measured: boolean;
  total_added: number;
  total_covered: number;
  files: PatchFileCoverage[];
  markdown: string;
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

// Reads a unified diff and returns each file's added lines as new-side
// line numbers. Deleted files produce no entries; a hunks's `\ No newline`
// marker, a context line carrying no leading blank ("" rather than " "),
// and added content that itself begins with plus signs are all survived.
export function parseDiff(diffText: string): Map<string, number[]> {
  const added = new Map<string, number[]>();
  let path: string | null = null;
  let nextLine = 0;
  let inHunk = false;

  for (const raw of diffText.split("\n")) {
    if (raw.startsWith("diff --git ")) {
      path = null;
      inHunk = false;
      continue;
    }
    const hunk = HUNK_HEADER.exec(raw);
    if (hunk) {
      nextLine = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk) {
      // Header area only. Checked here rather than first, because added
      // hunk content starting "++ " renders as a raw "+++ …" line.
      if (raw.startsWith("+++ ")) {
        const target = raw.slice(4).trim();
        path = target === "/dev/null" ? null : target.replace(/^b\//, "");
      }
      continue;
    }
    if (raw.startsWith("+")) {
      if (path !== null) {
        const lines = added.get(path) ?? [];
        lines.push(nextLine);
        added.set(path, lines);
      }
      nextLine += 1;
    } else if (raw.startsWith("-") || raw.startsWith("\\")) {
      // removed line or no-newline marker: the new side does not move
    } else {
      // context; git writes a leading space, but a trailing-blank context
      // line can arrive stripped to ""
      nextLine += 1;
    }
  }

  for (const lines of added.values()) {
    lines.sort((a, b) => a - b);
  }
  return added;
}

// Reads cobertura XML as istanbul-lib-report writes it — class elements
// carrying filename plus line elements with number/hits — into
// filename -> (line number -> hits).
export function parseCobertura(xml: string): Map<string, Map<number, number>> {
  const hits = new Map<string, Map<number, number>>();
  const classBlock = /<class\b([^>]*)>([\s\S]*?)<\/class>/g;
  const attribute = /\b(\w+)="([^"]*)"/g;
  for (const match of xml.matchAll(classBlock)) {
    const attributes = new Map<string, string>();
    for (const attr of match[1]!.matchAll(attribute)) {
      attributes.set(attr[1]!, attr[2]!);
    }
    const filename = attributes.get("filename");
    if (filename === undefined) continue;
    const lines = hits.get(filename) ?? new Map<number, number>();
    for (const line of match[2]!.matchAll(/<line\b([^>]*?)\/?>/g)) {
      const lineAttributes = new Map<string, string>();
      for (const attr of line[1]!.matchAll(attribute)) {
        lineAttributes.set(attr[1]!, attr[2]!);
      }
      const number = lineAttributes.get("number");
      const lineHits = lineAttributes.get("hits");
      if (number === undefined || lineHits === undefined) continue;
      lines.set(Number(number), Number(lineHits));
    }
    hits.set(filename, lines);
  }
  return hits;
}

export function patchCoverage(
  diffText: string,
  xml: string,
): PatchCoverageReport {
  const addedByFile = parseDiff(diffText);
  const hitsByFile = parseCobertura(xml);
  const files: PatchFileCoverage[] = [];
  for (const [path, addedLines] of [...addedByFile.entries()].sort()) {
    const hits = hitsByFile.get(path);
    if (hits === undefined) continue;
    const executable = addedLines.filter((line) => hits.has(line));
    if (executable.length === 0) continue;
    let covered = 0;
    const missedRanges: [number, number][] = [];
    let open: number | null = null;
    let previousLine = Number.NaN;
    for (const line of executable) {
      if ((hits.get(line) ?? 0) > 0) {
        covered += 1;
        if (open !== null) {
          missedRanges.push([open, previousLine]);
          open = null;
        }
      } else if (open === null) {
        open = line;
      }
      previousLine = line;
    }
    if (open !== null) {
      missedRanges.push([open, previousLine]);
    }
    files.push({
      path,
      added: executable.length,
      covered,
      missed_ranges: missedRanges,
    });
  }
  const total_added = files.reduce((sum, file) => sum + file.added, 0);
  const total_covered = files.reduce((sum, file) => sum + file.covered, 0);
  const summary = {
    measured: true as const,
    total_added,
    total_covered,
    files,
  };
  return { ...summary, markdown: renderMarkdown(summary) };
}

export function renderMarkdown(report: {
  total_added: number;
  total_covered: number;
  files: PatchFileCoverage[];
}): string {
  const lines: string[] = [
    "## Patch coverage",
    "",
    "Informational — not a gate; the coverage floor remains the merge criterion.",
    "",
  ];
  if (report.total_added === 0) {
    lines.push(
      "No added line was executable in the cobertura report, so there is " +
        "nothing to measure.",
    );
  } else {
    const pct = round2((report.total_covered / report.total_added) * 100);
    lines.push(
      `**${report.total_covered}** of **${report.total_added}** added ` +
        `lines covered (${pct}%).`,
    );
  }
  if (report.files.length > 0) {
    lines.push("");
    lines.push("| File | Added | Covered | Missed lines |", "|---|---:|---:|---|");
    for (const file of report.files) {
      const missed = file.missed_ranges
        .map(([start, end]) => (start === end ? `${start}` : `${start}-${end}`))
        .join(", ");
      lines.push(`| ${file.path} | ${file.added} | ${file.covered} | ${missed || "—"} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const xmlPath = process.argv[2];
  if (xmlPath === undefined) {
    console.error(
      "usage: git diff HEAD^1 HEAD | node scripts/patch-coverage.ts <cobertura.xml>",
    );
    process.exit(2);
  }
  const root = repoRoot();
  let xml: string;
  try {
    xml = readFileSync(join(root, xmlPath), "utf8");
  } catch (error) {
    console.error(`patch coverage: cannot read ${xmlPath}: ${error}`);
    process.exit(2);
  }
  const report = patchCoverage(readFileSync(0, "utf8"), xml);
  const destination = join(root, REPORT_PATH);
  mkdirSync(join(root, "coverage"), { recursive: true });
  writeFileSync(
    destination,
    `${JSON.stringify(
      {
        measured: report.measured,
        total_added: report.total_added,
        total_covered: report.total_covered,
        files: report.files,
        markdown: report.markdown,
      },
      null,
      2,
    )}\n`,
  );
  process.stdout.write(report.markdown);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
