#!/usr/bin/env node
// Docs-only change gate for CI (issue 592): decides whether a change touched
// documentation only, in which case CI skips coverage and the floor check.
//
//   git diff --name-only -z HEAD^1 HEAD | node scripts/docs-only.ts
//
// Prints "true" when every changed path is documentation — the .md, .txt,
// .rst and .adoc extensions, plus the LICENSE file — and "false" otherwise.
// An empty diff counts as code, so an undecidable change is measured.

import { readFileSync } from "node:fs";
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

function main(): void {
  const paths = parseNulList(readFileSync(0, "utf8"));
  process.stdout.write(isDocsOnly(paths) ? "true\n" : "false\n");
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
