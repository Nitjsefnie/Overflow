// Per-commit legal revision gate (issue 955; text-unchanged exemption added by
// issue 973):
//
//   node scripts/check-legal-revisions.ts <base> <head>
//
// THE RULE AS IMPLEMENTED. A commit that changes a legal page's file must also
// change src/lib/legal-revisions.ts in the SAME commit, or carry a
// `Legal-Text: unchanged; <justification>` claim in its commit message body.
//
// The earlier version of this header claimed the gate compared a legal page's
// TEXT. It never did — it compares plain path membership, so any edit to a
// page counts, including one that leaves the document byte-identical (the
// static-import-to-dynamic-import relocation on PR 971). Comparing rendered
// text instead was considered and rejected (#973): any extractor a real legal
// text edit could slip past is worse than over-triggering, because a gate that
// misses a real revision is silent where this one is loud. The exemption
// therefore lives where a reviewer reads it — the commit message — rather than
// in an extractor nobody can audit.
//
// THE MARKER. One whole line of the message BODY, at column 0:
//
//   Legal-Text: unchanged; <justification>
//
//   - the subject line never counts; the first blank line ends it, and every
//     line after that (in every paragraph) is body
//   - the line is matched whole and anchored: `See-Legal-Text: unchanged; x`,
//     `we agreed, so Legal-Text: unchanged; x`, and an indented or quoted line
//     are all NOT markers
//   - the key and value are matched case-sensitively; `legal-text:` and
//     `Legal-Text: changed;` are not markers
//   - the justification after `;` must hold at least one non-whitespace
//     character. A bare `Legal-Text: unchanged`, a lone `Legal-Text: unchanged;`
//     and a whitespace-only justification are NOT markers: the exemption cannot
//     be a keyword alone, and whatever text it does carry is printed to stderr
//     with its sha, before the exit status is decided
//   - a message carrying several markers is read at the first one
//   - a marker line inside a FENCED code block is documentation, not a claim,
//     and is skipped. This repo's own header spells the marker out, so a commit
//     that documents the grammar — or quotes it in a pull-request-style block —
//     would otherwise carry the string without anyone having made the claim. A
//     fence that is never closed disables the marker for every following line;
//     that is the fail-closed direction, so a stray ``` costs an exemption
//     rather than granting one
//
// WHAT AN EXEMPTION DOES AND DOES NOT DO. It applies only to a commit that
// touches a legal page and does NOT touch the record module; a commit that
// touches the record is already green and claims no exemption, so nothing is
// printed for it. Every honoured marker is reported on stderr — a count, then
// one line per exempted commit carrying its sha and its justification — and it
// is printed BEFORE the exit status is decided, so a run that reds for an
// unrelated commit still shows what the gate let through. When nothing was
// exempted the block is absent entirely, on either path. The success line on
// stdout repeats the count and never carries the list, so the trail cannot be
// read as part of the verdict. An unreadable commit message is an error, never
// a silent pass.
//
// WHAT THE EXEMPTION ACTUALLY ENFORCES, and what it does not. It enforces that
// a justification is present at all, that every honoured marker is printed to
// stderr with its sha and that text before the exit status is decided, and that
// the success line states how many commits were exempted — zero when none were.
// It does NOT enforce that the justification is a good one:
// `Legal-Text: unchanged; x` is accepted. Nothing mechanical stands between that
// line and an unreviewed edit to a legal document. The design buys
// AUDITABILITY, not friction — it makes every exemption visible in the CI log,
// and it does not make writing one expensive. Review is what a careless
// exemption runs into; a deliberate one is not stopped here.
//
// The walk is per-commit over base..head, merge commits excluded: git rev-list
// --no-merges, then one git diff-tree per commit. A legal page edited in one
// commit and the revision record bumped in a later one still violates — the
// gate must survive a rebase that reorders the pair. A commit touching only
// the record file is green, as is an empty range. Violations go to stdout and
// the process exits 1; a failed git call (unknown revision, no repository,
// unreadable message) fails closed on stderr with exit 1.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// The pages whose visible text the revision records describe, and the record
// module every one of their changes must travel with.
const LEGAL_PAGES: readonly string[] = [
  "src/app/terms/page.tsx",
  "src/app/rules/page.tsx",
  "src/app/account-data/page.tsx",
];

const GUARD_FILE = "src/lib/legal-revisions.ts";

// The exemption marker's only accepted spelling, anchored to the whole line so
// no substring, mid-sentence occurrence or indented line can match it. The
// whitespace run after `;` is the delimiter and is free-form; the capture group
// is the justification, and `\S` makes an empty or whitespace-only one a
// non-match, which is what keeps a bare marker worthless.
const MARKER = /^Legal-Text: unchanged;[ \t]+(\S.*)$/;

// What separates a commit message's subject from its body. It is named once and
// sliced by its own `.length`, so the separator and the offset past it cannot
// drift apart: a bare `+ 2` here is a second constant coupled to this one, and a
// refactor that changed only the `indexOf` would silently corrupt the marker's
// first character instead of failing visibly.
const SUBJECT_SEPARATOR = "\n\n";

// A fenced-code-block delimiter: up to three spaces of indent, a run of three
// or more backticks or tildes, then an optional info string. A fence closes
// only on a run of the SAME character at least as long, with no info string, so
// a tilde run cannot close a backtick fence.
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

export interface CommitChanges {
  sha: string;
  files: readonly string[];
  message: string;
}

/** One legal page changed by a commit that carried no exemption for it. */
export interface LegalPageViolation {
  sha: string;
  page: string;
}

/** One legal-page change the commit message itself declared text-unchanged. */
export interface LegalTextExemption {
  sha: string;
  justification: string;
}

export interface LegalRevisionReport {
  violations: readonly LegalPageViolation[];
  exemptions: readonly LegalTextExemption[];
}

/**
 * Marks which lines of a message body fall inside a fenced code block. A fence
 * opens on a run of three or more backticks or tildes (a backtick run whose
 * info string itself holds a backtick is not a delimiter, as in CommonMark) and
 * closes on a longer-or-equal run of the SAME character carrying no info
 * string. The opening and closing lines themselves are not inside.
 */
function fencedLines(lines: readonly string[]): boolean[] {
  const inside: boolean[] = [];
  let open: { character: string; length: number } | null = null;

  for (const line of lines) {
    const fence = FENCE.exec(line);
    const run = fence?.[1];
    const info = fence?.[2] ?? "";

    if (open === null) {
      if (run !== undefined && !(run.startsWith("`") && info.includes("`"))) {
        open = { character: run.charAt(0), length: run.length };
      }
      inside.push(false);
      continue;
    }

    const closes =
      run !== undefined &&
      run.charAt(0) === open.character &&
      run.length >= open.length &&
      info.trim() === "";
    inside.push(!closes);
    if (closes) {
      open = null;
    }
  }

  return inside;
}

/**
 * Returns the justification of a commit message's `Legal-Text: unchanged`
 * marker, or null when the message carries none. Only the BODY counts: the
 * first blank line ends the subject, so a marker that is only ever the subject
 * claims nothing. Lines inside a fenced code block are documentation and are
 * skipped — quoting the grammar is not making the claim.
 */
export function legalTextUnchangedJustification(message: string): string | null {
  const bodyStart = message.indexOf(SUBJECT_SEPARATOR);
  if (bodyStart === -1) {
    return null;
  }

  const lines = message.slice(bodyStart + SUBJECT_SEPARATOR.length).split("\n");
  const insideFences = fencedLines(lines);

  for (const [index, line] of lines.entries()) {
    if (insideFences[index] === true) {
      continue;
    }

    const match = MARKER.exec(line);
    const justification = match?.[1];
    if (justification !== undefined) {
      return justification.trim();
    }
  }

  return null;
}

/**
 * Reviews a range's commits: one violation per (commit, legal page) that
 * changed the page without the record module and without a well-formed
 * exemption, plus one entry per commit an exemption was honoured for. Commits
 * touching the record, or no legal page at all, are green and claim nothing.
 */
export function reviewCommits(
  commits: ReadonlyArray<CommitChanges>,
): LegalRevisionReport {
  const violations: LegalPageViolation[] = [];
  const exemptions: LegalTextExemption[] = [];

  for (const { sha, files, message } of commits) {
    if (files.includes(GUARD_FILE)) {
      continue;
    }

    const pages = LEGAL_PAGES.filter((page) => files.includes(page));
    if (pages.length === 0) {
      continue;
    }

    const justification = legalTextUnchangedJustification(message);
    if (justification === null) {
      for (const page of pages) {
        violations.push({ sha, page });
      }
    } else {
      exemptions.push({ sha, justification });
    }
  }

  return { violations, exemptions };
}

/** Reads the non-merge commits of base..head with each one's changed paths and message. */
function commitsBetween(baseRevision: string, headRevision: string): CommitChanges[] {
  const listing = spawnSync(
    "git",
    ["rev-list", "--no-merges", `${baseRevision}..${headRevision}`],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  if (listing.error !== undefined || listing.status !== 0) {
    const detail = listing.error?.message ?? listing.stderr.trim();
    throw new Error(
      `Could not list commits in ${baseRevision}..${headRevision}` +
        `${detail.length === 0 ? "." : `: ${detail}`}`,
    );
  }

  return listing.stdout
    .split("\n")
    .filter((sha) => sha.length > 0)
    .map((sha) => ({ sha, files: changedPaths(sha), message: commitMessage(sha) }));
}

/**
 * Reads the paths one commit changed against its first parent. --no-renames
 * makes every rename deterministic: it is reported as its old path removed and
 * its new path added, so both names appear here whichever one is legal, and
 * rename detection can never depend on the caller's diff.renames config.
 * --root judges a root commit like any other (every path counts as added).
 */
function changedPaths(sha: string): string[] {
  const diff = spawnSync(
    "git",
    ["diff-tree", "--root", "--no-commit-id", "--name-only", "-r", "--no-renames", "-z", sha],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  if (diff.error !== undefined || diff.status !== 0) {
    const detail = diff.error?.message ?? diff.stderr.trim();
    throw new Error(
      `Could not list the changed paths of ${sha}${detail.length === 0 ? "." : `: ${detail}`}`,
    );
  }

  return diff.stdout.split("\0").filter((path) => path.length > 0);
}

/**
 * Reads one commit's full message (subject and body, as %B renders them).
 * --no-walk stops at the named commit instead of walking its history, and -z
 * terminates the single record with a NUL. A commit whose message cannot be
 * read is an error: the exemption is a claim, and a claim the gate cannot
 * check is never assumed to be absent.
 */
function commitMessage(sha: string): string {
  const message = spawnSync(
    "git",
    ["log", "--no-walk", "--format=%B", "-z", sha],
    { cwd: repositoryRoot, encoding: "utf8" },
  );

  if (message.error !== undefined || message.status !== 0) {
    const detail = message.error?.message ?? message.stderr.trim();
    throw new Error(
      `Could not read the message of ${sha}${detail.length === 0 ? "." : `: ${detail}`}`,
    );
  }

  const [record] = message.stdout.split("\0");
  if (record === undefined || record.trim() === "") {
    throw new Error(`Could not read the message of ${sha}: git returned none.`);
  }

  return record.replace(/\n$/, "");
}

function main(args: readonly string[]): void {
  if (args.length !== 2 || args[0] === undefined || args[1] === undefined) {
    process.stderr.write("Usage: node scripts/check-legal-revisions.ts <base> <head>\n");
    process.exitCode = 1;
    return;
  }

  const [baseRevision, headRevision] = args;
  try {
    const commits = commitsBetween(baseRevision, headRevision);
    const { violations, exemptions } = reviewCommits(commits);

    // stderr, not stdout: this is the audit trail of what the gate chose to let
    // through, and it must never be mistakable for the success line. It is
    // written BEFORE the exit status is decided — a red run is exactly when a
    // reader asks what the gate let through — and it leads with the count so
    // the count is stated on the red path as well as the green one.
    if (exemptions.length > 0) {
      process.stderr.write(
        `${exemptions.length} ${exemptions.length === 1 ? "commit" : "commits"} ` +
          "exempted with a Legal-Text: unchanged claim:\n",
      );
      for (const { sha, justification } of exemptions) {
        process.stderr.write(
          `exempted ${sha} (Legal-Text: unchanged): ${justification}\n`,
        );
      }
    }

    if (violations.length > 0) {
      for (const { sha, page } of violations) {
        process.stdout.write(
          `${page} changed in ${sha} without a matching ${GUARD_FILE} change in the same commit.\n`,
        );
      }
      process.stdout.write(
        "Legal pages carry revision records in src/lib/legal-revisions.ts: a commit that " +
          "changes a legal page must change its record in the same commit (issue 955). " +
          "Amend the page change to carry the record change. If the page's text is genuinely " +
          "unchanged, say so in the commit message body with a whole line reading " +
          "`Legal-Text: unchanged; <justification>`, and the gate will report the exemption " +
          "rather than treat the page as revised.\n",
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      `${commits.length} ${commits.length === 1 ? "commit" : "commits"} in ` +
        `${baseRevision}..${headRevision} ` +
        `${commits.length === 1 ? "changes" : "change"} no legal page ` +
        "without a matching revision-record change or a text-unchanged claim " +
        `(${exemptions.length} ${exemptions.length === 1 ? "commit" : "commits"} exempted ` +
        "with a Legal-Text: unchanged claim)\n",
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
