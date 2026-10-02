// Per-commit legal revision gate (issue 955): a commit that changes a legal
// page's text must also touch src/lib/legal-revisions.ts in the SAME commit.
//
//   node scripts/check-legal-revisions.ts <base> <head>
//
// The walk is per-commit over base..head, merge commits excluded: git rev-list
// --no-merges, then one git diff-tree per commit. A legal page edited in one
// commit and the revision record bumped in a later one still violates — the
// gate must survive a rebase that reorders the pair. A commit touching only
// the record file is green, as is an empty range. Violations go to stdout and
// the process exits 1; a failed git call (unknown revision, no repository)
// fails closed on stderr with exit 1.

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

export interface CommitChanges {
  sha: string;
  files: readonly string[];
}

/**
 * Returns one violation per (commit, legal page) whose commit does not also
 * touch the revision record file. Commits touching the record, or no legal
 * page at all, are green.
 */
export function legalRevisionViolations(
  commits: ReadonlyArray<CommitChanges>,
): string[] {
  const violations: string[] = [];

  for (const { sha, files } of commits) {
    const touchesGuard = files.includes(GUARD_FILE);
    if (touchesGuard) {
      continue;
    }

    for (const page of LEGAL_PAGES) {
      if (files.includes(page)) {
        violations.push(
          `${page} changed in ${sha} without a matching ${GUARD_FILE} change in the same commit.`,
        );
      }
    }
  }

  return violations;
}

/** Reads the non-merge commits of base..head with each one's changed paths. */
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
    .map((sha) => ({ sha, files: changedPaths(sha) }));
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

function main(args: readonly string[]): void {
  if (args.length !== 2 || args[0] === undefined || args[1] === undefined) {
    process.stderr.write("Usage: node scripts/check-legal-revisions.ts <base> <head>\n");
    process.exitCode = 1;
    return;
  }

  const [baseRevision, headRevision] = args;
  try {
    const commits = commitsBetween(baseRevision, headRevision);
    const violations = legalRevisionViolations(commits);

    if (violations.length > 0) {
      for (const violation of violations) {
        process.stdout.write(`${violation}\n`);
      }
      process.stdout.write(
        "Legal pages carry revision records in src/lib/legal-revisions.ts: a commit that " +
          "changes a legal page must change its record in the same commit (issue 955). " +
          "Amend the page change to carry the record change.\n",
      );
      process.exitCode = 1;
      return;
    }

    process.stdout.write(
      `${commits.length} ${commits.length === 1 ? "commit" : "commits"} in ` +
        `${baseRevision}..${headRevision} ` +
        `${commits.length === 1 ? "changes" : "change"} no legal page ` +
        "without a matching revision-record change\n",
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2));
}
