#!/usr/bin/env node
// Module size ratchet (issue 591): per-tree ceilings plus a committed
// baseline of every file already over its ceiling.
//
//   node scripts/check-module-size.ts           check; exit 1 on any violation
//   node scripts/check-module-size.ts --tighten rewrite the baseline downward
//                                               only (lower shrunken counts,
//                                               drop gone/graduated entries)
//
// Entries are never added by hand and a recorded count is never raised by
// hand. The only remedies for an over-ceiling file are shrinking it or
// relocating code into a new module. The baseline was seeded once from the
// tree that introduced this script; --tighten is the only writer afterwards.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ModuleSizeDoc {
  ceilings: { src: number; tests: number };
  module_size_baseline: Record<string, number>;
}

export const DOC_PATH = "scripts/module-size.json";
export const SCRIPT_PATH = "scripts/check-module-size.ts";

// wc -l semantics: lines are newline-terminated; a final unterminated line
// does not count.
export function countLines(content: string): number {
  let n = 0;
  for (const ch of content) if (ch === "\n") n += 1;
  return n;
}

export function ceilingFor(path: string, doc: ModuleSizeDoc): number {
  if (path.startsWith("src/")) return doc.ceilings.src;
  if (path.startsWith("tests/")) return doc.ceilings.tests;
  throw new Error(`file outside src/ and tests/: ${path}`);
}

export interface Violation {
  kind: "over" | "grown" | "missing" | "graduated";
  path: string;
  detail: string;
  remedy: string;
}

// files: repo-relative path -> current newline count. The CLI enumerates via
// `git ls-files` (tracked files only); tests fabricate the map from real
// temp files.
export function collectViolations(
  files: Map<string, number>,
  doc: ModuleSizeDoc,
): Violation[] {
  const out: Violation[] = [];
  for (const [path, recorded] of Object.entries(doc.module_size_baseline)) {
    const current = files.get(path);
    if (current === undefined) {
      out.push({
        kind: "missing",
        path,
        detail: `listed in ${DOC_PATH} but gone`,
        remedy: `restore the file, or drop the entry: node ${SCRIPT_PATH} --tighten`,
      });
      continue;
    }
    if (current > recorded) {
      out.push({
        kind: "grown",
        path,
        detail: `grew to ${current} lines (recorded ${recorded})`,
        remedy: "shrink it back or relocate code into a new module",
      });
      continue;
    }
    const ceiling = ceilingFor(path, doc);
    if (current < ceiling) {
      out.push({
        kind: "graduated",
        path,
        detail: `shrank to ${current} lines, under the ${ceiling}-line ceiling`,
        remedy: `record it: node ${SCRIPT_PATH} --tighten`,
      });
    }
  }
  for (const [path, current] of files) {
    if (doc.module_size_baseline[path] !== undefined) continue;
    const ceiling = ceilingFor(path, doc);
    if (current > ceiling) {
      out.push({
        kind: "over",
        path,
        detail: `${current} lines, over the ${ceiling}-line ceiling for ${path.startsWith("src/") ? "src/" : "tests/"}`,
        remedy: "shrink the file or relocate code into a new module; entries are never added by hand",
      });
    }
  }
  return out;
}

// Downward-only rewrite: lowers counts that shrank, drops gone and
// graduated entries, never adds or raises. Survivor key order is preserved.
export function applyTighten(
  files: Map<string, number>,
  doc: ModuleSizeDoc,
): { doc: ModuleSizeDoc; changes: string[] } {
  const changes: string[] = [];
  const next: Record<string, number> = {};
  for (const [path, recorded] of Object.entries(doc.module_size_baseline)) {
    const current = files.get(path);
    if (current === undefined) {
      changes.push(`dropped ${path} (gone)`);
      continue;
    }
    let value = recorded;
    if (current < recorded) {
      changes.push(`lowered ${path}: ${recorded} -> ${current}`);
      value = current;
    }
    const ceiling = ceilingFor(path, doc);
    if (value < ceiling) {
      changes.push(`dropped ${path} (graduated: ${value} < ${ceiling})`);
      continue;
    }
    next[path] = value;
  }
  return { doc: { ...doc, module_size_baseline: next }, changes };
}

export function trackedModules(root: string): string[] {
  const res = spawnSync("git", ["ls-files", "src", "tests"], {
    cwd: root,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`git ls-files failed: ${res.stderr}`);
  }
  return res.stdout.split("\n").filter((p) => /\.(ts|tsx)$/.test(p) && p.length > 0);
}

function trackedLineCounts(root: string): Map<string, number> {
  const files = new Map<string, number>();
  for (const rel of trackedModules(root)) {
    try {
      files.set(rel, countLines(readFileSync(join(root, rel), "utf8")));
    } catch (error) {
      // Unstaged deletions remain in git ls-files; let the baseline report them.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return files;
}

export function runCheck(root: string, doc: ModuleSizeDoc): Violation[] {
  return collectViolations(trackedLineCounts(root), doc);
}

function serialize(doc: ModuleSizeDoc): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

function main(): void {
  const root = spawnSync("git", ["rev-parse", "--show-toplevel"], {
    encoding: "utf8",
  });
  if (root.status !== 0) {
    console.error(`not inside a git repository`);
    process.exit(2);
  }
  const repoRoot = root.stdout.trim();
  const doc: ModuleSizeDoc = JSON.parse(
    readFileSync(join(repoRoot, DOC_PATH), "utf8"),
  );
  const files = trackedLineCounts(repoRoot);

  if (process.argv[2] === "--tighten") {
    const { doc: nextDoc, changes } = applyTighten(files, doc);
    if (changes.length === 0) {
      console.log("baseline already tight; nothing to change");
      return;
    }
    writeFileSync(join(repoRoot, DOC_PATH), serialize(nextDoc));
    for (const change of changes) console.log(change);
    console.log(`wrote ${DOC_PATH}`);
    return;
  }

  const violations = collectViolations(files, doc);
  if (violations.length === 0) {
    console.log(
      `module size check: ${files.size} tracked modules, ` +
        `${Object.keys(doc.module_size_baseline).length} baselined — ok`,
    );
    return;
  }
  for (const v of violations) {
    console.log(`${v.kind}: ${v.path} — ${v.detail} — ${v.remedy}`);
  }
  console.log(
    `module size check: ${violations.length} violation(s); ` +
      `the only remedies are shrinking the file or relocating code into a new module`,
  );
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
