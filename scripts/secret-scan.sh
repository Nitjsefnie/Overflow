#!/usr/bin/env bash
# Full-history secret scan over this repository, baselined against the
# committed report of what was already there.
#
# Runs on every push to main and every pull request, plus a daily sweep and
# manual dispatch. Full history includes credentials removed from later trees.
# Under pull_request_target only main's scripts execute: the PR head is fetched
# as git objects, never checked out or executed. gitleaks reads all fetched refs,
# and the committed baseline suppresses the known findings in that history.
#
# WHY THE VERSION IS PINNED, AND WHY THE SCRIPT REFUSES TO SCAN UNDER ANY
# OTHER. The scan is only meaningful relative to a baseline, and a baseline is
# only meaningful relative to a rule set. gitleaks ships detection rules that
# change between releases: a new rule, or a tightened threshold, produces
# findings that the committed baseline cannot explain, so a silently upgraded
# scanner turns a clean history red for reasons that have nothing to do with
# the code. Pinning the version and checking it here is what makes a red run
# mean "a secret is in this history" rather than "the scanner moved". Bumping
# it is a deliberate three-part change: update PINNED_GITLEAKS_VERSION here AND
# the version and checksum in BOTH halves of the split workflow —
# .github/workflows/secret-scan.yml and secret-scan-pr.yml (issue 1090) — and
# regenerate the baseline they pin against.
#
# WHY THE BASELINE MUST BE THE FULL REDACTED REPORT AND NOT A LIST OF
# FINGERPRINTS. This is the non-obvious part, and it is exactly what a future
# editor would "simplify" away, so: gitleaks 8.30.1 compares a baseline entry
# by WHOLE-RECORD equality, not by fingerprint. A baseline reduced to
# `[{"Fingerprint": "..."}]` suppresses nothing at all and the scan still exits
# 1 — verified against this repository, where the full report suppresses all
# 8 known findings and the fingerprint-only form suppresses none of them. So
# .github/gitleaks-baseline.json is committed exactly as gitleaks emits it:
# do not hand-edit, reorder or trim it. Regenerate it, whole, and prove the
# result by re-running with --baseline-path and seeing exit 0.
#
# "DO NOT REORDER" IS ABOUT THE ENTRIES ALREADY IN THE FILE, NOT ABOUT
# POSITION. The array is ordered newest-first by `Date`, so a hand-added entry
# goes AT THE HEAD and the entries already there keep their existing relative
# order. That is what the procedure below describes, and it is not the reordering
# this paragraph forbids: moving an entry that is already in the file past
# another one is.
#
# The report is redacted, so the baseline carries no credential material. Its
# `Match` fields are not literally the string REDACTED, and are not meant to
# be: gitleaks substitutes the redaction into the secret's place inside the
# match and keeps the surrounding source-line context.
#
# ...AND WHAT TRIMMING ONE ACTUALLY COSTS, WHICH IS NOT THE SCAN. This script
# passes --redact, and gitleaks' baseline matcher skips a redacted run's `Match`
# and `Secret` fields outright, so trimming a `Match` down to the bare literal
# leaves the scan's own suppression working exactly as before. What it does break
# is tests/ci/secret-scan-script.test.ts, which compares every field — and a bare
# `Match` also leaves the provenance check with no residue to examine, so the
# entry drops out of the checkable count and EXPECTED_CHECKABLE_ENTRIES has to
# move with it. The green scan is the part that will not warn you.
#
# WHEN THE BASELINE NEEDS A NEW ENTRY. It keys on COMMIT SHA, so editing a file
# that carries a baselined fixture produces a new finding under a new SHA that
# the committed baseline cannot suppress, and the next scan exits 1 on
# a change containing no secret. Add that entry to the existing baseline rather
# than regenerating the file: a wholesale regeneration would also absorb any
# genuinely new finding and bury it. Read the diff of old against new baseline,
# and be able to point at every added entry in whatever diff caused it.
# For PR baseline behavior, see "ON A PULL REQUEST THE BASELINE IS MAIN'S,
# NOT YOURS" in .github/workflows/secret-scan.yml.
#
# ...AND EXPECT A SECOND RED, WHICH IS CORRECT. An added entry whose Match keeps
# source context around the redaction — a generic-api-key finding does, a
# gitlab-pat one does not — is one more entry the provenance check can
# meaningfully examine, and tests/ci/secret-scan-script.test.ts pins that count as
# EXPECTED_CHECKABLE_ENTRIES. Bump it in the same commit, having read the
# baseline diff. Both assertions on that count run at every checkout depth, so
# they will not wait for the daily sweep to tell you.
#
# ...AND THE OPPOSITE REMEDY, FOR AN ORPHANED ENTRY. A `--rebase` merge
# re-creates the branch's commits, so a baseline generated while the pre-rebase
# copies were still REACHABLE — still on a ref, which is what gitleaks walks,
# since it reads `git log --all` — records one logical finding at BOTH SHAs. The
# pre-rebase half is in no history this repository ships, so it suppresses
# nothing, and the secret-scan workflow's last step fails on it by name.
#
# "IN NO SHIPPED HISTORY" IS ABOUT THE REF SET, NOT THE OBJECT STORE, and the
# difference is the whole diagnosis. A merged pull request's head commit, held on
# `refs/remotes/pr/*` by whatever generated the baseline, is exactly this shape:
# gitleaks walked `--all` and recorded it. Only the PR leg explicitly fetches
# its own `refs/pull/*` head; other PR refs are outside the scan's reachability roots.
# Where the object survives locally it is PRESENT AND UNREFERENCED — `git
# cat-file -e` says fine, `git rev-parse` resolves it, and only `git merge-base
# --is-ancestor` catches it. So the remedy there is to REMOVE that entry and keep
# the reachable one — the reverse of the case above — after running that ancestry
# check yourself and confirming the survivor is the same finding by file, line
# and rule. Never regenerate the whole file to clear an orphan; that absorbs a
# genuinely new finding and buries it.
set -euo pipefail

# Bump together with both halves of the split workflow:
# .github/workflows/secret-scan.yml and secret-scan-pr.yml (issue 1090).
readonly PINNED_GITLEAKS_VERSION="8.30.1"

# Resolved from this script's own location so the script can be invoked from
# any working directory — a caller-chosen report path is resolved against the
# directory the caller ran it in, but the baseline and the repository it scans
# are this checkout's, not the caller's.
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(dirname -- "$SCRIPT_DIR")"
readonly BASELINE_PATH="$REPO_ROOT/.github/gitleaks-baseline.json"

# Unqualified by default so the report lands where the caller ran the script.
# The workflow sets this to the path it uploads as an artifact.
readonly REPORT_PATH="${GITLEAKS_REPORT_PATH:-gitleaks-report.json}"

# A missing binary is a runner that failed, not a clean history. Refusing here
# is what keeps a broken install from reading as "no secrets found".
if ! command -v gitleaks >/dev/null 2>&1; then
  echo "secret-scan: no gitleaks on PATH, so nothing was scanned." >&2
  echo "secret-scan: this script requires gitleaks ${PINNED_GITLEAKS_VERSION}; see" >&2
  echo "secret-scan:   .github/workflows/secret-scan.yml or secret-scan-pr.yml" >&2
  echo "secret-scan:   for the pinned install." >&2
  exit 1
fi

# Trim surrounding whitespace: a version command that printed a newline, a
# warning or a leading/trailing space must not read as a different version.
found_version="$(gitleaks version 2>/dev/null | tr -d '[:space:]' || true)"
if [ "$found_version" != "$PINNED_GITLEAKS_VERSION" ]; then
  echo "secret-scan: gitleaks ${found_version:-<no version reported>} is on PATH, but this" >&2
  echo "secret-scan: script is pinned to ${PINNED_GITLEAKS_VERSION} and the committed baseline" >&2
  echo "secret-scan: was generated by it. No scan was run: a different rule set under a" >&2
  echo "secret-scan: fixed baseline reports findings the baseline cannot explain. Pin the" >&2
  echo "secret-scan: version in this script AND in .github/workflows/secret-scan.yml and" >&2
  echo "secret-scan:   secret-scan-pr.yml together." >&2
  exit 1
fi

if [ ! -f "$BASELINE_PATH" ]; then
  echo "secret-scan: the committed baseline is missing: $BASELINE_PATH" >&2
  exit 1
fi

mkdir -p -- "$(dirname -- "$REPORT_PATH")"

# `git` is the subcommand that walks every commit; `dir` scans the working
# tree and would pass on a history that carries a secret. --redact keeps the
# report itself free of credential material, which is what makes it safe to
# upload as a build artifact and safe to commit as a baseline. The scan's exit
# status is the script's exit status: a `|| true` here would make a findings
# run green, and a scan that cannot go red reports nothing forever.
gitleaks git \
  --redact \
  --no-banner \
  --report-format json \
  --report-path "$REPORT_PATH" \
  --baseline-path "$BASELINE_PATH" \
  "$REPO_ROOT" || exit $?
