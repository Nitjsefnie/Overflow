#!/usr/bin/env node
// Docs-only change gate for CI (issue 592): decides whether a change touched
// documentation only, in which case CI skips coverage and the floor check.
//
//   node scripts/docs-only.ts <base-revision>
//
// Prints "true" only when the base is an ancestor of HEAD, the endpoint diff
// is docs-only, and every commit on the first-parent chain from base to HEAD
// changes only documentation against its first parent. Merge commits therefore
// use their first-parent diff. Docs are .md, .txt, .rst, .adoc and LICENSE.
// Rename detection is off (issue 646), so a code file renamed to a doc still
// exposes its code source path.
//
// Everything undecidable prints "false" so the change is measured: an empty
// diff or range, a non-ancestor, missing history, an empty or all-zero base,
// and any git failure. The exit status is 0 whenever the verdict is printed.

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
function changedPaths(base: string, head = "HEAD"): string[] | undefined {
  if (base.length === 0 || /^0+$/.test(base)) return undefined;
  const result = spawnSync(
    "git",
    ["diff", "--no-renames", "--name-only", "-z", "--end-of-options", base, head, "--"],
    { encoding: "utf8" },
  );
  if (result.error !== undefined || result.status !== 0) return undefined;
  return parseNulList(result.stdout);
}

function docsOnlyRange(base: string): boolean {
  const endpoint = changedPaths(base);
  if (endpoint === undefined || !isDocsOnly(endpoint)) return false;

  const resolved = spawnSync("git", ["rev-parse", "--verify", "--end-of-options", `${base}^{commit}`], { encoding: "utf8" });
  if (resolved.error !== undefined || resolved.status !== 0) return false;
  const baseCommit = resolved.stdout.trim();
  const ancestor = spawnSync("git", ["merge-base", "--is-ancestor", baseCommit, "HEAD"], { encoding: "utf8" });
  if (ancestor.error !== undefined || ancestor.status !== 0) return false;

  const range = spawnSync("git", ["rev-list", "--first-parent", "--reverse", `${baseCommit}..HEAD`], { encoding: "utf8" });
  if (range.error !== undefined || range.status !== 0) return false;
  const commits = range.stdout.trim().split("\n").filter(Boolean);
  if (commits.length === 0) return false;
  for (const commit of commits) {
    const parent = spawnSync("git", ["rev-parse", "--verify", `${commit}^1`], { encoding: "utf8" });
    if (parent.error !== undefined || parent.status !== 0) return false;
    const paths = changedPaths(parent.stdout.trim(), commit);
    if (paths === undefined || !isDocsOnly(paths)) return false;
  }
  return true;
}

function main(): void {
  const docsOnly = docsOnlyRange(process.argv[2] ?? "");
  process.stdout.write(docsOnly ? "true\n" : "false\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
