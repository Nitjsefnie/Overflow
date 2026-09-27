#!/usr/bin/env node
// Module size ratchet (issues 591, 653): per-family ceilings plus a committed
// baseline of every file already over its family's ceiling.
//
//   node scripts/check-module-size.ts           check; exit 1 on any violation,
//                                               exit 2 on a configuration error
//   node scripts/check-module-size.ts --tighten rewrite the baseline downward
//                                               only (lower shrunken counts,
//                                               drop gone, graduated and
//                                               excluded entries); refuses
//                                               with exit 2, writing nothing,
//                                               while any tracked file is
//                                               unclassified
//
// Every tracked file (`git ls-files`, the whole repository) lands in exactly
// one class, both defined below by exact name:
//   - a measured family (MEASURED_FAMILIES), capped by the ceilings key of the
//     same name: src, tests, tooling, stylesheets, migrations;
//   - a recorded exclusion (EXCLUSIONS), each carrying the reason it is not
//     measured.
// A tracked file in neither is reported `unclassified`, so a new file type
// cannot ship unmeasured by accident: it is added to a family or recorded as
// an exclusion. --tighten will not run until it is, because an entry whose
// file fell out of every family through a predicate change would otherwise
// be dropped as if it no longer needed a cap. A ceilings key naming no family is reported `unknown-ceiling`,
// and a family with no ceilings key is a configuration error (exit 2) — the
// check cannot say what that family's files may weigh.
//
// Recorded counts are never raised by hand. An entry is added only when a
// family starts being measured, at the file's current count, and the ratchet
// guard (scripts/check-ratchets.ts) verifies it against the merge base.
// Otherwise the only remedies for an over-ceiling file are shrinking it or
// relocating code into a new module, and --tighten is the only writer.
//
// Each recorded count must equal its file's current count, so a shrink is
// recorded with --tighten in the same change that made it. A recorded count
// above the current one is headroom the file could silently regrow into.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export interface ModuleSizeDoc {
  ceilings: Record<string, number>;
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

export interface PathClass {
  name: string;
  matches(path: string): boolean;
}

// Patterns use the `s` flag so a newline inside a tracked filename is matched
// like any other character. Families and exclusions must stay disjoint; the
// suite asserts it over every tracked file.
const oneOf = (names: string[]) => (path: string) => names.includes(path);

// Measured families. Each name is also its ceilings key in DOC_PATH.
export const MEASURED_FAMILIES: readonly PathClass[] = [
  { name: "src", matches: (p) => /^src\/.+\.tsx?$/s.test(p) },
  { name: "tests", matches: (p) => /^tests\/.+\.tsx?$/s.test(p) },
  {
    name: "tooling",
    matches: (p) => /^scripts\/[^/]+\.(ts|mjs|sh)$/s.test(p) || /^[^/]+\.(ts|mjs)$/s.test(p),
  },
  { name: "stylesheets", matches: (p) => /^src\/.+\.css$/s.test(p) },
  { name: "migrations", matches: (p) => /^db\/migrations\/[^/]+\.sql$/s.test(p) },
];

// Recorded exclusions: tracked files deliberately left unmeasured.
export const EXCLUSIONS: readonly PathClass[] = [
  // Prose, reviewed as documents; a long reference page is not a long module.
  { name: "documentation", matches: (p) => /\.md$/s.test(p) || p === "LICENSE" },
  // Declarative GitHub and repository settings, not program code.
  {
    name: "repository metadata",
    matches: (p) =>
      /^\.github\/.+\.(yml|json)$/s.test(p)
      || oneOf([
        ".gitignore",
        ".dockerignore",
        ".env.example",
        // The hashed pip requirements file the actionlint workflow installs
        // zizmor from: reviewed artifact pins, not program code.
        ".github/requirements-zizmor.txt",
      ])(p),
  },
  // Package manifests and the lockfile, which pnpm generates.
  {
    name: "package manifests",
    matches: oneOf(["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json"]),
  },
  // Ratchet documents: data written and checked by their own scripts.
  { name: "ratchet documents", matches: (p) => /^scripts\/[^/]+\.json$/s.test(p) },
  // Vendored dependency patch: its size is the upstream diff it carries.
  { name: "dependency patches", matches: (p) => /^patches\/[^/]+\.patch$/s.test(p) },
  // systemd units and container definitions: declarative deployment config.
  {
    name: "deployment units",
    matches: (p) =>
      /^deploy\/[^/]+\.(service|timer)$/s.test(p) || oneOf(["Dockerfile", "docker-compose.yml"])(p),
  },
  // Static assets served as-is.
  { name: "static assets", matches: (p) => /^public\/.+\.svg$/s.test(p) },
];

const FAMILY_NAMES = new Set(MEASURED_FAMILIES.map((f) => f.name));

export interface Classification {
  kind: "measured" | "excluded";
  name: string;
}

export function classify(path: string): Classification | undefined {
  const family = MEASURED_FAMILIES.find((f) => f.matches(path));
  if (family) return { kind: "measured", name: family.name };
  const exclusion = EXCLUSIONS.find((e) => e.matches(path));
  if (exclusion) return { kind: "excluded", name: exclusion.name };
  return undefined;
}

// Measured families with no ceilings key. The CLI exits 2 on any.
export function configurationErrors(doc: ModuleSizeDoc): string[] {
  return MEASURED_FAMILIES.filter((f) => !Object.hasOwn(doc.ceilings, f.name)).map(
    (f) => `measured family ${f.name} has no ceilings key in ${DOC_PATH}`,
  );
}

function familyCeiling(family: string, doc: ModuleSizeDoc): number {
  if (!Object.hasOwn(doc.ceilings, family)) {
    throw new Error(`measured family ${family} has no ceilings key in ${DOC_PATH}`);
  }
  return doc.ceilings[family] as number;
}

// The ceiling of the path's measured family, or undefined for a path in no
// measured family.
export function ceilingFor(path: string, doc: ModuleSizeDoc): number | undefined {
  const cls = classify(path);
  return cls?.kind === "measured" ? familyCeiling(cls.name, doc) : undefined;
}

export interface Violation {
  kind:
    | "over"
    | "grown"
    | "missing"
    | "graduated"
    | "shrunk"
    | "unclassified"
    | "unknown-ceiling"
    | "unmeasured-entry";
  path: string;
  detail: string;
  remedy: string;
}

// files: repo-relative path -> current newline count, for every tracked path
// outside the recorded exclusions (excluded paths, if present, are ignored).
// The CLI enumerates via `git ls-files`; tests fabricate the map from real
// temp files.
export function collectViolations(
  files: Map<string, number>,
  doc: ModuleSizeDoc,
): Violation[] {
  const out: Violation[] = [];
  for (const key of Object.keys(doc.ceilings)) {
    if (FAMILY_NAMES.has(key)) continue;
    out.push({
      kind: "unknown-ceiling",
      path: DOC_PATH,
      detail: `ceilings key ${JSON.stringify(key)} names no measured family`,
      remedy: `remove the key, or define the family in ${SCRIPT_PATH}`,
    });
  }
  for (const [path, recorded] of Object.entries(doc.module_size_baseline)) {
    const ceiling = ceilingFor(path, doc);
    if (ceiling === undefined) {
      const droppable = classify(path)?.kind === "excluded" || !files.has(path);
      out.push({
        kind: "unmeasured-entry",
        path,
        detail: `listed in ${DOC_PATH} but in no measured family`,
        remedy: droppable
          ? `drop the entry: node ${SCRIPT_PATH} --tighten`
          : `add the file to a measured family or to the recorded exclusions in ${SCRIPT_PATH}`,
      });
      continue;
    }
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
    if (current < ceiling) {
      out.push({
        kind: "graduated",
        path,
        detail: `shrank to ${current} lines, under the ${ceiling}-line ceiling`,
        remedy: `record it: node ${SCRIPT_PATH} --tighten`,
      });
      continue;
    }
    if (current < recorded) {
      out.push({
        kind: "shrunk",
        path,
        detail: `shrank to ${current} lines (recorded ${recorded})`,
        remedy: `record it: node ${SCRIPT_PATH} --tighten`,
      });
    }
  }
  for (const [path, current] of files) {
    const cls = classify(path);
    if (cls === undefined) {
      out.push({
        kind: "unclassified",
        path,
        detail: "tracked, but in no measured family and no recorded exclusion",
        remedy: `add it to a measured family or to the recorded exclusions in ${SCRIPT_PATH}`,
      });
      continue;
    }
    if (cls.kind === "excluded") continue;
    if (doc.module_size_baseline[path] !== undefined) continue;
    const ceiling = familyCeiling(cls.name, doc);
    if (current > ceiling) {
      out.push({
        kind: "over",
        path,
        detail: `${current} lines, over the ${ceiling}-line ceiling for the ${cls.name} family`,
        remedy:
          "shrink the file or relocate code into a new module; an entry is added only when " +
          "a family starts being measured, at the file's current count",
      });
    }
  }
  return out;
}

// Downward-only rewrite: lowers counts that shrank, drops gone, graduated and
// excluded entries, never adds or raises. An entry whose file is tracked but
// unclassified is kept: its cap stays until the file is classified. Survivor
// key order is preserved.
export function applyTighten(
  files: Map<string, number>,
  doc: ModuleSizeDoc,
): { doc: ModuleSizeDoc; changes: string[] } {
  const changes: string[] = [];
  const next: Record<string, number> = {};
  for (const [path, recorded] of Object.entries(doc.module_size_baseline)) {
    const cls = classify(path);
    if (cls?.kind === "excluded") {
      changes.push(`dropped ${path} (recorded exclusion: ${cls.name})`);
      continue;
    }
    const current = files.get(path);
    if (current === undefined) {
      changes.push(`dropped ${path} (gone)`);
      continue;
    }
    if (cls === undefined) {
      next[path] = recorded;
      continue;
    }
    const ceiling = familyCeiling(cls.name, doc);
    let value = recorded;
    if (current < recorded) {
      changes.push(`lowered ${path}: ${recorded} -> ${current}`);
      value = current;
    }
    if (value < ceiling) {
      changes.push(`dropped ${path} (graduated: ${value} < ${ceiling})`);
      continue;
    }
    next[path] = value;
  }
  return { doc: { ...doc, module_size_baseline: next }, changes };
}

// Every tracked path in the repository.
export function trackedPaths(root: string): string[] {
  const res = spawnSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    throw new Error(`git ls-files failed: ${res.stderr}`);
  }
  return res.stdout.split("\0").filter((p) => p.length > 0);
}

// Line counts for every tracked path outside the recorded exclusions:
// measured files, plus any unclassified ones so they can be reported.
function trackedLineCounts(root: string): Map<string, number> {
  const files = new Map<string, number>();
  for (const rel of trackedPaths(root)) {
    if (classify(rel)?.kind === "excluded") continue;
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
  const configErrors = configurationErrors(doc);
  if (configErrors.length > 0) {
    for (const error of configErrors) console.error(error);
    console.error(`module size check: configuration error; add the missing ceilings keys`);
    process.exit(2);
  }
  const files = trackedLineCounts(repoRoot);

  if (process.argv[2] === "--tighten") {
    const unclassified = [...files.keys()].filter((path) => classify(path) === undefined);
    if (unclassified.length > 0) {
      for (const path of unclassified) {
        console.error(
          `unclassified: ${path} — add it to a measured family or to the recorded exclusions in ${SCRIPT_PATH}`,
        );
      }
      console.error(`module size check: --tighten refused while a tracked file is unclassified; nothing written`);
      process.exit(2);
    }
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
      `module size check: ${files.size} measured files, ` +
        `${Object.keys(doc.module_size_baseline).length} baselined — ok`,
    );
    return;
  }
  for (const v of violations) {
    console.log(`${v.kind}: ${v.path} — ${v.detail} — ${v.remedy}`);
  }
  console.log(
    `module size check: ${violations.length} violation(s); ` +
      `apply the remedy named on each line; a recorded count is never raised by hand`,
  );
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
