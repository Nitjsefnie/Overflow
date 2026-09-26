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
// shallow clone — refused up front, because a shallow history can make git
// merge-base fail or return a wrong base without erroring, and the fix is to
// fetch full history (`git fetch --unshallow`) — a merge base that cannot be
// computed (unrelated histories) or a document that is not valid JSON. A
// document absent at the merge base cannot be relaxed; the sibling checks
// judge its content. A non-regular entry (anything but a 100644 blob) at the
// head is a finding (exit 1) — it is the branch's own change; a non-regular
// entry at the merge base is a git/parse error (exit 2).
//
// In the module size document every value may only fall and every existing
// key must stay, except that a baseline entry may be dropped. Two additions
// provably relax nothing and are accepted: a new ceiling that is a positive
// integer, and a new baseline entry for a path that was a regular file at the
// merge base, at or below that file's line count there (read as data, by
// the blob id of the tree entry the key names). Every other added key is a
// finding.

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { round2 } from "./check-coverage-floor.ts";
import { countLines } from "./check-module-size.ts";

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

// Leaf values keyed by their path; a non-object or an empty object anywhere
// (including the document itself) is a leaf, so a subtree replaced by a
// scalar shows up as its leaves removed and one key added, and an added
// empty object is still an added key.
function leaves(value: unknown, parts: string[] = [], out = new Map<string, unknown>()) {
  if (!isObject(value) || Object.keys(value).length === 0) {
    out.set(keyPath(parts), value);
    return out;
  }
  for (const [key, child] of Object.entries(value)) leaves(child, [...parts, key], out);
  return out;
}

// Direction in which each coverage leaf may move: "up" means it may only rise.
// Direction alone is not enough for two of them, because of how
// calibrate-coverage.ts uses them — see calibratorRelaxations.
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
  out.push(...calibratorRelaxations(before, after));
  return out;
}

// The calibrator rewrites the document when round2(measured - recorded)
// exceeds the hysteresis, setting floor = measured - gap. So a negative
// hysteresis makes every run rewrite and the floor falls whenever coverage
// dips, and a recorded measurement inflated above the floor it implies
// freezes the ratchet. A genuine calibrate output meets the floor bound with
// equality.
function calibratorRelaxations(before: Map<string, unknown>, after: Map<string, unknown>) {
  const out: string[] = [];
  const hysteresis = after.get("hysteresis");
  if (isFiniteNumber(hysteresis) && hysteresis < 0) {
    out.push(
      finding(COVERAGE_PATH, "hysteresis", before.get("hysteresis"), hysteresis, "negative"),
    );
  }
  const measuredKey = "languages.typescript.measured";
  const floorKey = "languages.typescript.floor";
  const measured = after.get(measuredKey);
  const floor = after.get(floorKey);
  const gap = after.get("gap");
  if (
    !Object.is(before.get(measuredKey), measured) &&
    isFiniteNumber(measured) &&
    isFiniteNumber(floor) &&
    isFiniteNumber(gap) &&
    floor < round2(measured - gap)
  ) {
    out.push(
      finding(
        COVERAGE_PATH,
        floorKey,
        before.get(floorKey),
        floor,
        `below measured ${measured} minus gap ${gap} = ${round2(measured - gap)}; ` +
          "a changed measurement must carry the floor it implies",
      ),
    );
  }
  return out;
}

// What the merge base holds at a baseline path: a regular file's newline
// count, the "<mode> <type>" of any other tree entry, or null when there is
// no entry of that name.
export type MergeBaseEntry = { lines: number } | { kind: string } | null;

export type MergeBaseLookup = (path: string) => MergeBaseEntry;

// A new ceilings key has no effect until check-module-size resolves it:
// ceilingFor reads only the families named in its code, by exact key, so an
// added key cannot shadow another key's files. That holds only while every
// family is resolved by an exact name defined in code and an unknown
// ceilings key fails the module-size check; extending the families must keep
// both. Under that contract a positive integer adds a limit and loosens none.
function addedCeiling(key: string, now: unknown): string[] {
  if (Number.isInteger(now) && (now as number) > 0) return [];
  return [finding(MODULE_SIZE_PATH, key, undefined, now, "ceiling added that is not a positive integer")];
}

// A path that was a regular file at the merge base, which carried a green
// module-size check, was either over no ceiling (outside the tracked
// families — the entry is a new cap at or below its size) or under its
// ceiling (the entry then only makes check-module-size report it
// `graduated`). So an entry at or below the merge-base size never grants
// headroom the file did not already have, and growth past it is reported
// `grown`. An entry for a new file, or above the merge-base size, could.
function addedBaselineEntry(
  key: string,
  path: string,
  now: unknown,
  atMergeBase: MergeBaseLookup | undefined,
): string[] {
  const refuse = (why: string) => [finding(MODULE_SIZE_PATH, key, undefined, now, why)];
  if (!Number.isInteger(now) || (now as number) < 0) {
    return refuse("entry added that is not a non-negative integer");
  }
  if (atMergeBase === undefined) {
    return refuse("entry added and no merge-base lookup was supplied");
  }
  const entry = atMergeBase(path);
  if (entry === null) return refuse("entry added for a path absent at the merge base");
  if (!("lines" in entry)) {
    return refuse(`entry added for a path that is ${entry.kind}, not a regular file, at the merge base`);
  }
  if ((now as number) > entry.lines) {
    return refuse(`entry added above the file's ${entry.lines} lines at the merge base`);
  }
  return [];
}

// Both sections are integer maps in which no value may rise; ceilings keep
// every existing key, the baseline may lose entries. What each may gain is
// judged by addedCeiling and addedBaselineEntry.
function integerMapRelaxations(
  section: "ceilings" | "module_size_baseline",
  base: unknown,
  head: unknown,
  atMergeBase: MergeBaseLookup | undefined,
): string[] {
  const entriesMayBeRemoved = section === "module_size_baseline";
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
      out.push(
        ...(section === "ceilings"
          ? addedCeiling(key, now)
          : addedBaselineEntry(key, name, now, atMergeBase)),
      );
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

// Without `atMergeBase` nothing can be known about the merge base, so every
// added baseline entry is refused.
export function moduleSizeRelaxations(
  base: unknown,
  head: unknown,
  atMergeBase?: MergeBaseLookup,
): string[] {
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
    } else if (key === "ceilings" || key === "module_size_baseline") {
      out.push(...integerMapRelaxations(key, was, now, atMergeBase));
    } else if (JSON.stringify(was) !== JSON.stringify(now)) {
      out.push(finding(MODULE_SIZE_PATH, key, was, now, "changed, and has no tightening direction"));
    }
  }
  return out;
}

function git(cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  return spawnSync("git", args, { cwd, encoding: "utf8" });
}

// A shallow history disqualifies the whole check: git merge-base can fail on
// it, or worse pick a wrong base without erroring, and either answer is one
// a relaxation could hide behind. Refuse before touching any revision.
function requireFullHistory(cwd: string): void {
  const result = git(cwd, ["rev-parse", "--is-shallow-repository"]);
  if (result.status !== 0) {
    throw new Error(`cannot tell whether the repository is shallow: ${result.stderr}`);
  }
  if (result.stdout.trim() === "true") {
    throw new Error(
      "the repository is shallow; a shallow history can make git merge-base return " +
        "a wrong base without erroring, so the check refuses to run — fetch full " +
        "history first (git fetch --unshallow)",
    );
  }
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

// The only tree entry a ratchet document may be. `git show` of a symlink
// yields its target text, not the file it points at, while the checks read
// through the link.
export const REGULAR_FILE = "100644 blob";

// The tree entry named exactly `path` — its "<mode> <type>" and object id —
// or null when there is none. git ls-tree reads its argument as a pattern —
// "dir/" lists the directory's children — so pathspec magic is off and only
// a record whose name equals `path` counts. Baseline keys are the branch's
// own text.
function treeEntry(
  cwd: string,
  commit: string,
  path: string,
): { kind: string; object: string } | null {
  const listing = git(cwd, ["--literal-pathspecs", "ls-tree", "-z", commit, "--", path]);
  if (listing.status !== 0) throw new Error(`cannot list ${path} at ${commit}: ${listing.stderr}`);
  for (const record of listing.stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab === -1 || record.slice(tab + 1) !== path) continue;
    const [mode, type, object] = record.slice(0, tab).split(" ", 3);
    return { kind: `${mode} ${type}`, object: object ?? "" };
  }
  return null;
}

// "<mode> <type>" of the tree entry named exactly `path`, or null when there
// is none.
export function entryKind(cwd: string, commit: string, path: string): string | null {
  return treeEntry(cwd, commit, path)?.kind ?? null;
}

// The merge-base lookup checkRatchets hands moduleSizeRelaxations: the
// newline count of a regular file at `commit`, counted the way
// check-module-size counts. The blob is read by the object id of the matched
// tree entry, never by name: `git show <commit>:<key>` would parse a key
// containing ".." as a revision range and print whatever that range shows.
export function mergeBaseEntry(cwd: string, commit: string, path: string): MergeBaseEntry {
  const entry = treeEntry(cwd, commit, path);
  if (entry === null) return null;
  if (entry.kind !== REGULAR_FILE) return { kind: entry.kind };
  const blob = git(cwd, ["cat-file", "blob", entry.object]);
  if (blob.status !== 0) throw new Error(`cannot read ${path} at ${commit}: ${blob.stderr}`);
  return { lines: countLines(blob.stdout) };
}

// The parsed document at `commit`, or null when the path does not exist
// there. Anything but a regular file is an error.
export function readDocument(cwd: string, commit: string, path: string): unknown {
  const kind = entryKind(cwd, commit, path);
  if (kind === null) return null;
  if (kind !== REGULAR_FILE) throw new Error(`${path} at ${commit} is ${kind}, not a regular file`);
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
  requireFullHistory(cwd);
  const base = resolveCommit(cwd, baseRev);
  const head = resolveCommit(cwd, headRev);
  const fork = mergeBase(cwd, base, head);
  const findings: string[] = [];
  const atMergeBase: MergeBaseLookup = (path) => mergeBaseEntry(cwd, fork, path);
  const documents = [
    [COVERAGE_PATH, coverageRelaxations],
    [
      MODULE_SIZE_PATH,
      (before: unknown, after: unknown) => moduleSizeRelaxations(before, after, atMergeBase),
    ],
  ] as const;
  for (const [path, relaxations] of documents) {
    // A non-regular entry at head is the branch's own change, refused like
    // any relaxation (exit 1) whether or not the merge base had the file.
    const kind = entryKind(cwd, head, path);
    if (kind !== null && kind !== REGULAR_FILE) {
      findings.push(finding(path, "(document)", REGULAR_FILE, kind, "not a regular file"));
      continue;
    }
    findings.push(...relaxations(readDocument(cwd, fork, path), readDocument(cwd, head, path)));
  }
  return { mergeBase: fork, findings };
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
