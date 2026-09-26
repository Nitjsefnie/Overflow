#!/usr/bin/env node
// Ratchet document guard (issue 647): refuses a change that relaxes the
// documents the coverage floor and module size checks compare against.
//
//   node scripts/check-ratchets.ts <base-rev> <head-rev>
//
// Both documents are read as data with `git show <rev>:<path>` at the merge
// base of the two revisions and at the head — never from the working tree,
// and no head code is executed. The merge base, not the base tip, is the
// reference: calibration raises the floor on the base branch after a branch
// forks, and the branch did not loosen anything by missing that raise.
//
// Exit 0 when nothing is relaxed, 1 with one line per relaxation (file, key,
// merge-base value, head value), 2 on a usage error, an unknown revision, a
// merge base that cannot be computed (unrelated histories or a shallow
// clone) or a document that is not valid JSON. A document absent at the
// merge base cannot be relaxed; the sibling checks judge its content.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const COVERAGE_PATH = "scripts/coverage.json";
export const MODULE_SIZE_PATH = "scripts/module-size.json";

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function show(value: unknown): string {
  if (value === undefined) return "absent";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value);
}

function keyPath(parts: string[]): string {
  if (parts.length === 0) return "(document)";
  return parts
    .map((part, index) => {
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(part)) return index === 0 ? part : `.${part}`;
      return `[${JSON.stringify(part)}]`;
    })
    .join("");
}

function finding(file: string, key: string, base: unknown, head: unknown, why: string): string {
  return `${file}: ${key}: merge base ${show(base)}, head ${show(head)} — ${why}`;
}

function deleted(file: string): string {
  return finding(file, "(document)", "present", undefined, "the document was deleted");
}

// Leaf values keyed by their path; a non-object anywhere (including the
// document itself) is a leaf, so a subtree replaced by a scalar shows up as
// its leaves removed and one key added.
function leaves(value: unknown, parts: string[] = [], out = new Map<string, unknown>()) {
  if (!isObject(value)) {
    out.set(keyPath(parts), value);
    return out;
  }
  for (const [key, child] of Object.entries(value)) leaves(child, [...parts, key], out);
  return out;
}

// Direction in which each coverage leaf may move: "up" means it may only rise.
const COVERAGE_DIRECTIONS = new Map<string, "up" | "down">([
  ["languages.typescript.floor", "up"],
  ["languages.typescript.measured", "up"],
  ["gap", "down"],
  ["hysteresis", "down"],
]);

export function coverageRelaxations(base: unknown, head: unknown): string[] {
  if (base === null || base === undefined) return [];
  if (head === null || head === undefined) return [deleted(COVERAGE_PATH)];
  const out: string[] = [];
  const before = leaves(base);
  const after = leaves(head);
  for (const [key, was] of before) {
    if (!after.has(key)) out.push(finding(COVERAGE_PATH, key, was, undefined, "key removed"));
  }
  for (const [key, now] of after) {
    if (!before.has(key)) {
      out.push(finding(COVERAGE_PATH, key, undefined, now, "key added"));
      continue;
    }
    const was = before.get(key);
    if (!isFiniteNumber(now)) {
      out.push(finding(COVERAGE_PATH, key, was, now, "not a finite number"));
      continue;
    }
    if (Object.is(was, now)) continue;
    const direction = COVERAGE_DIRECTIONS.get(key);
    if (direction === undefined) {
      out.push(finding(COVERAGE_PATH, key, was, now, "changed, and has no tightening direction"));
    } else if (!isFiniteNumber(was)) {
      out.push(finding(COVERAGE_PATH, key, was, now, "merge-base value is not a finite number"));
    } else if (direction === "up" && now < was) {
      out.push(finding(COVERAGE_PATH, key, was, now, "lowered; it may only rise"));
    } else if (direction === "down" && now > was) {
      out.push(finding(COVERAGE_PATH, key, was, now, "raised; it may only fall"));
    }
  }
  return out;
}

// Both sections are integer maps in which no value may rise; ceilings keep
// their key set exactly, the baseline may only lose entries.
function integerMapRelaxations(
  section: string,
  base: unknown,
  head: unknown,
  entriesMayBeRemoved: boolean,
): string[] {
  if (!isObject(head)) {
    return [finding(MODULE_SIZE_PATH, section, base, head, "not an object")];
  }
  const before = isObject(base) ? base : {};
  const out: string[] = [];
  for (const [name, was] of Object.entries(before)) {
    if (!Object.hasOwn(head, name) && !entriesMayBeRemoved) {
      out.push(finding(MODULE_SIZE_PATH, keyPath([section, name]), was, undefined, "key removed"));
    }
  }
  for (const [name, now] of Object.entries(head)) {
    const key = keyPath([section, name]);
    if (!Object.hasOwn(before, name)) {
      out.push(finding(MODULE_SIZE_PATH, key, undefined, now, "entry added"));
      continue;
    }
    const was = before[name];
    if (!Number.isInteger(now)) {
      out.push(finding(MODULE_SIZE_PATH, key, was, now, "not an integer"));
    } else if (!Number.isInteger(was)) {
      out.push(finding(MODULE_SIZE_PATH, key, was, now, "merge-base value is not an integer"));
    } else if ((now as number) > (was as number)) {
      out.push(finding(MODULE_SIZE_PATH, key, was, now, "raised; it may only fall"));
    }
  }
  return out;
}

export function moduleSizeRelaxations(base: unknown, head: unknown): string[] {
  if (base === null || base === undefined) return [];
  if (head === null || head === undefined) return [deleted(MODULE_SIZE_PATH)];
  if (!isObject(head) || !isObject(base)) {
    if (JSON.stringify(base) === JSON.stringify(head)) return [];
    return [finding(MODULE_SIZE_PATH, "(document)", base, head, "not an object")];
  }
  const out: string[] = [];
  for (const [key, was] of Object.entries(base)) {
    if (!Object.hasOwn(head, key)) out.push(finding(MODULE_SIZE_PATH, key, was, undefined, "key removed"));
  }
  for (const [key, now] of Object.entries(head)) {
    const was = base[key];
    if (!Object.hasOwn(base, key)) {
      out.push(finding(MODULE_SIZE_PATH, key, undefined, now, "key added"));
    } else if (key === "ceilings") {
      out.push(...integerMapRelaxations(key, was, now, false));
    } else if (key === "module_size_baseline") {
      out.push(...integerMapRelaxations(key, was, now, true));
    } else if (JSON.stringify(was) !== JSON.stringify(now)) {
      out.push(finding(MODULE_SIZE_PATH, key, was, now, "changed, and has no tightening direction"));
    }
  }
  return out;
}

function git(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

export function resolveCommit(cwd: string, rev: string): string {
  const result = git(cwd, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`]);
  if (result.status !== 0) throw new Error(`unknown revision: ${rev}`);
  return result.stdout.trim();
}

export function mergeBase(cwd: string, base: string, head: string): string {
  const result = git(cwd, ["merge-base", base, head]);
  const sha = result.stdout.trim();
  if (result.status !== 0 || sha === "") {
    throw new Error(
      `no merge base between ${base} and ${head} (unrelated histories or a shallow clone)`,
    );
  }
  return sha;
}

// The parsed document at `commit`, or null when the path does not exist there.
export function readDocument(cwd: string, commit: string, path: string): unknown {
  const listing = git(cwd, ["ls-tree", "-z", commit, "--", path]);
  if (listing.status !== 0) throw new Error(`cannot list ${path} at ${commit}: ${listing.stderr}`);
  if (listing.stdout === "") return null;
  const blob = git(cwd, ["show", `${commit}:${path}`]);
  if (blob.status !== 0) throw new Error(`cannot read ${path} at ${commit}: ${blob.stderr}`);
  try {
    return JSON.parse(blob.stdout);
  } catch (error) {
    throw new Error(`${path} at ${commit} is not valid JSON: ${error}`);
  }
}

export function checkRatchets(
  cwd: string,
  baseRev: string,
  headRev: string,
): { mergeBase: string; findings: string[] } {
  const base = resolveCommit(cwd, baseRev);
  const head = resolveCommit(cwd, headRev);
  const fork = mergeBase(cwd, base, head);
  return {
    mergeBase: fork,
    findings: [
      ...coverageRelaxations(
        readDocument(cwd, fork, COVERAGE_PATH),
        readDocument(cwd, head, COVERAGE_PATH),
      ),
      ...moduleSizeRelaxations(
        readDocument(cwd, fork, MODULE_SIZE_PATH),
        readDocument(cwd, head, MODULE_SIZE_PATH),
      ),
    ],
  };
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args.some((arg) => arg === "" || arg.startsWith("-"))) {
    console.error("usage: node scripts/check-ratchets.ts <base-rev> <head-rev>");
    process.exit(2);
  }
  const [baseRev, headRev] = args as [string, string];
  let result: { mergeBase: string; findings: string[] };
  try {
    result = checkRatchets(process.cwd(), baseRev, headRev);
  } catch (error) {
    console.error(`ratchet check: ${error instanceof Error ? error.message : error}`);
    process.exit(2);
  }
  if (result.findings.length === 0) {
    console.log(
      `ratchet check: ${COVERAGE_PATH} and ${MODULE_SIZE_PATH} not relaxed ` +
        `against merge base ${result.mergeBase} — ok`,
    );
    return;
  }
  for (const line of result.findings) console.log(line);
  console.log(
    `ratchet check: ${result.findings.length} relaxation(s) against merge base ` +
      `${result.mergeBase}; ratchet documents may only tighten`,
  );
  process.exit(1);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
