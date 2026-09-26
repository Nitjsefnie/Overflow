#!/usr/bin/env node
// Docs-only change gate for CI (issue 592): decides whether a change touched
// documentation only, in which case CI skips coverage and the floor check.
//
//   node scripts/docs-only.ts <base-revision>
//
// Diffs <base-revision> against HEAD and prints "true" when every changed
// path is documentation — the .md, .txt, .rst and .adoc extensions, plus the
// LICENSE file — and "false" otherwise. Rename detection is off (issue 646),
// so a rename lists its source path as a deletion beside its destination as
// an addition, and a code file renamed to a doc is classified as code.
//
// Everything undecidable prints "false" so the change is measured: an empty
// diff, a missing, empty or all-zero base, and any git failure. The exit
// status is 0 whenever the verdict is printed.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const DOCS_EXTENSIONS = [".md", ".txt", ".rst", ".adoc"];

export function isDocsPath(path: string): boolean {
  const base = path.split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot > 0) {
    const extension = base.slice(dot).toLowerCase();
    return DOCS_EXTENSIONS.includes(extension);
  }
  return base.toLowerCase() === "license";
}

export function isDocsOnly(paths: string[]): boolean {
  let count = 0;
  for (const path of paths) {
    count += 1;
    if (!isDocsPath(path)) return false;
  }
  return count > 0;
}

export function parseNulList(input: string): string[] {
  return input.split("\0").filter((path) => path.length > 0);
}

/**
 * Lists the paths changed between `base` and HEAD in the current directory's
 * repository, or returns undefined when git cannot answer. `--end-of-options`
 * keeps an option-shaped base from being read as a flag, and the trailing
 * `--` keeps a path-shaped one from being read as a pathspec.
 */
function changedPaths(base: string): string[] | undefined {
  if (base.length === 0 || /^0+$/.test(base)) return undefined;
  const result = spawnSync(
    "git",
    ["diff", "--no-renames", "--name-only", "-z", "--end-of-options", base, "HEAD", "--"],
    { encoding: "utf8" },
  );
  if (result.error !== undefined || result.status !== 0) return undefined;
  return parseNulList(result.stdout);
}

function main(): void {
  const paths = changedPaths(process.argv[2] ?? "");
  const docsOnly = paths !== undefined && isDocsOnly(paths);
  process.stdout.write(docsOnly ? "true\n" : "false\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
