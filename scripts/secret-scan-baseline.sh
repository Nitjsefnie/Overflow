#!/usr/bin/env bash
# Every commit the committed baseline names must be reachable from this
# checkout's HEAD. "Reachable" is a question about the REF SET, not the object
# store: an entry naming a commit no ref this repository ships contains is a
# defect in a tracked artefact. It suppresses nothing — gitleaks walks
# `git log --all`, so it never even produces a record equal to one — it misleads
# every reader who consults the baseline to decide what was deliberately
# allowed, and it will never be found by the scan it belongs to.
#
# WHY THIS RUNS HERE AND NOT IN THE TEST SUITE. It was a test, and it was a
# test that could not work: the property is about a COMMIT's reachability, and
# `.github/workflows/ci.yml` gives the `verify` job `actions/checkout`'s default
# depth of 1, where none of the commits the baseline names exist. Asserted
# there, the check had two failure modes and both were bad — a baseline naming
# a commit the repository really does ship, but that a depth-1 checkout never
# fetched, reads as a defect in every contributor's run; and any `--rebase`
# merge re-stamps the branch's commits and can invalidate an entry after the
# fact, landing as a RED REQUIRED CHECK ON MAIN for everybody, over a defect
# that is real but belongs to the weekly sweep that owns it. So it moved to
# the one environment that has the history: this workflow checks out at
# `fetch-depth: 0` and ticks weekly, which is the same posture as every other
# detection signal this repository runs. The blast radius of a stale entry is
# a red scheduled scan that names the entry, not a red main.
#
# WHY `merge-base --is-ancestor` AND NOT AN EXISTENCE TEST. A `--rebase` merge's
# discarded pre-image is exactly the commit this check has to catch, and it is
# PRESENT: the object store still holds it, `git rev-parse` still resolves it,
# and it is on no ref the checkout fetched. `git cat-file -e` waves it through;
# only ancestry asks the question the header asks, which is whether the commit is
# part of the history this repository actually ships.
#
# WHY IT REFUSES A SHALLOW CHECKOUT. There, "this repository does not have the
# commit" and "this checkout was not fetched far enough" are indistinguishable,
# so every verdict would be a false alarm and the step would report a defect
# that is not there. Refusing is the only honest answer it has. The workflow
# fetches the whole history, so this never fires on the surface that owns it.
set -euo pipefail

# Resolved from this script's own location, as in secret-scan.sh: the baseline
# and the history it must be reachable from are this checkout's, not the
# caller's working directory's.
readonly SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly REPO_ROOT="$(dirname -- "$SCRIPT_DIR")"
readonly BASELINE_PATH="$REPO_ROOT/.github/gitleaks-baseline.json"

if [ ! -f "$BASELINE_PATH" ]; then
  echo "secret-scan-baseline: the committed baseline is missing: $BASELINE_PATH" >&2
  exit 1
fi

if [ "$(git -C "$REPO_ROOT" rev-parse --is-shallow-repository)" = "true" ]; then
  echo "secret-scan-baseline: $REPO_ROOT is a SHALLOW checkout, so it cannot tell a commit this" >&2
  echo "secret-scan-baseline: repository does not have from one it was not fetched far enough" >&2
  echo "secret-scan-baseline: back. Nothing was checked; fetch the full history (actions/checkout's" >&2
  echo "secret-scan-baseline: fetch-depth: 0) and run this again." >&2
  exit 1
fi

readonly HEAD_SHA="$(git -C "$REPO_ROOT" rev-parse --verify HEAD)"

# jq reads the baseline into a file BEFORE the loop, not into the loop's stdin
# through a pipe. A pipeline would put the reader in a subshell, where its exit
# status is the last command's — so a jq that failed on malformed JSON would
# leave an empty loop, an empty loop would report success, and the check would
# pass without having read anything. `set -e` on the redirect makes that failure
# fatal here instead. `@tsv` is what keeps a fingerprint containing a separator
# from splitting into fields.
readonly ENTRIES_FILE="$(mktemp)"
trap 'rm -f "$ENTRIES_FILE"' EXIT
jq -r '.[] | [.Fingerprint, .Commit] | @tsv' "$BASELINE_PATH" > "$ENTRIES_FILE"

checked=0
orphans=0
while IFS=$'\t' read -r fingerprint commit; do
  checked=$((checked + 1))
  # The two faults get separate sentences because they have different fixes. An
  # absent commit means the entry was generated against a ref set wider than the
  # one this repository ships — refs/pull/*, or a branch that was never merged.
  # A present-but-unmerged commit means it is a `--rebase` pre-image. Both are
  # REMOVED, never regenerated around: regenerating the whole file absorbs a
  # genuinely new finding and buries it.
  if ! git -C "$REPO_ROOT" cat-file -e "${commit}^{commit}" 2>/dev/null; then
    printf 'secret-scan-baseline: %s names commit %s, which this checkout does not carry at all.\n' \
      "$fingerprint" "$commit" >&2
    orphans=$((orphans + 1))
    continue
  fi
  if ! git -C "$REPO_ROOT" merge-base --is-ancestor "$commit" "$HEAD_SHA"; then
    printf 'secret-scan-baseline: %s names commit %s, which is in the object store but is not an ancestor of %s.\n' \
      "$fingerprint" "$commit" "$HEAD_SHA" >&2
    orphans=$((orphans + 1))
  fi
done < "$ENTRIES_FILE"

# A baseline this read nothing from has certified nothing. `0 checked, all
# reachable` is the shape of the vacuous pass, and an empty or reshaped baseline
# is the way in: `.[]` over a document that is not the array gitleaks emits
# yields no entries and fails nothing.
if [ "$checked" -eq 0 ]; then
  echo "secret-scan-baseline: checked nothing: $BASELINE_PATH yielded no entries to check, so no" >&2
  echo "secret-scan-baseline: verdict about reachability means nothing. The file must be the array" >&2
  echo "secret-scan-baseline: gitleaks --report-format json emits; see scripts/secret-scan.sh." >&2
  exit 1
fi

if [ "$orphans" -ne 0 ]; then
  printf 'secret-scan-baseline: %s of %s entries name commits that are not reachable from %s.\n' \
    "$orphans" "$checked" "$HEAD_SHA" >&2
  echo "secret-scan-baseline: every one of them suppresses nothing, and the scan that just ran" >&2
  echo "secret-scan-baseline: reported whatever was really there regardless. REMOVE each entry named" >&2
  echo "secret-scan-baseline: above and keep the reachable one for the same finding — same file, line" >&2
  echo "secret-scan-baseline: and rule. Do not regenerate the whole baseline to clear them: that" >&2
  echo "secret-scan-baseline: absorbs a genuinely new finding and buries it." >&2
  exit 1
fi

echo "secret-scan-baseline: all $checked entries name commits reachable from $HEAD_SHA."
