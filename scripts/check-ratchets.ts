#!/usr/bin/env node
// Ratchet document guard: refuses a change that relaxes the
// document the SQL statement check compares against. The coverage floor is
// test-ratchet's, in .github/ci-thresholds.json, guarded by its
// records-only-rise.
//
//   node scripts/check-ratchets.ts <base-rev> <head-rev>
//
// All documents are read as data with `git show <rev>:<path>` at the merge
// base of the two revisions and at the head — never from the working tree,
// and no head code is executed. The merge base, not the base tip, is the
// reference: the base branch may tighten a record after a branch forks, and
// the branch did not loosen anything by missing that change.
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

import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const PERF_BUDGET_PATH = "scripts/perf-budget.json";

// Workloads are a closed set. No existing cap may rise or disappear. A new
// positive integer key caps a new workload without changing any existing cap;
// the measurement gate refuses keys without real measured workloads.
export function perfBudgetRelaxations(base: unknown, head: unknown): string[] {
  if (base === null || base === undefined) return [];
  if (head === null || head === undefined) return [deleted(PERF_BUDGET_PATH)];
  if (!isObject(base) || !isObject(head)) {
    return [finding(PERF_BUDGET_PATH, "(document)", base, head, "not an object")];
  }
  const out: string[] = [];
  for (const [key, was] of Object.entries(base)) {
    if (!Object.hasOwn(head, key)) {
      out.push(finding(PERF_BUDGET_PATH, keyPath([key]), was, undefined, "key removed"));
    }
  }
  for (const [key, now] of Object.entries(head)) {
    const was = base[key];
    if (!Number.isSafeInteger(now) || (now as number) <= 0) {
      out.push(finding(PERF_BUDGET_PATH, keyPath([key]), was, now, "not a positive safe integer"));
    } else if (Object.hasOwn(base, key)) {
      if (!Number.isSafeInteger(was) || (was as number) <= 0) {
        out.push(finding(PERF_BUDGET_PATH, keyPath([key]), was, now, "merge-base value is not a positive safe integer"));
      } else if ((now as number) > (was as number)) {
        out.push(finding(PERF_BUDGET_PATH, keyPath([key]), was, now, "raised; it may only fall"));
      }
    }
  }
  return out;
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
// a record whose name equals `path` counts.
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
  // A non-regular entry at head is the branch's own change, refused like
  // any relaxation (exit 1) whether or not the merge base had the file.
  const kind = entryKind(cwd, head, PERF_BUDGET_PATH);
  if (kind !== null && kind !== REGULAR_FILE) {
    return {
      mergeBase: fork,
      findings: [finding(PERF_BUDGET_PATH, "(document)", REGULAR_FILE, kind, "not a regular file")],
    };
  }
  const findings = perfBudgetRelaxations(
    readDocument(cwd, fork, PERF_BUDGET_PATH),
    readDocument(cwd, head, PERF_BUDGET_PATH),
  );
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
      `ratchet check: ${PERF_BUDGET_PATH} not relaxed ` +
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
