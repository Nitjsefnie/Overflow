#!/usr/bin/env bash
# Base freshness gate — the LAST step of both required CI jobs (ci.yml verify,
# actionlint.yml actionlint), guarded by `if: pull_request`.
#
# What issue 441 needed: the tree that LANDS on main must be covered by a
# required check. A pull_request run tests refs/pull/N/merge — the head merged
# with the base as it stood at event time — and branch protection keeps strict
# up-to-date checking disabled, so when main has advanced, the tree GitHub
# actually lands (the branch rebased onto current main) was never tested.
#
# What the first version of this step enforced instead: main frozen for the
# whole run — base SHA at event time vs current tip at step time. A verify run
# takes ~40 minutes and main merged roughly every 10 minutes when this was
# written, so every run spanned at least one merge and failed, whatever the
# merge contained (issue 510): no pull request could certify at all.
#
# What this enforces instead — the relevant-advance condition, session rule
# 10's final-gate discipline mechanized: the advance from the tested base to
# main's current tip must be DISJOINT from the files this pull request changes.
# Such an advance carried its own required checks; only cross-file interaction
# goes unverified, which is the residual the manual final gate accepts by hand.
#
# The gate fails closed: an API failure, an empty response, an unrepresentative
# compare (more than 200 commits, an empty file list, or exactly 300 files —
# the compare API's truncation bound), or an empty pull-request file list is a
# refusal, never a pass.
#
# A native MERGE QUEUE is the complete fix — it tests the exact merge preview
# as a required check and makes this step deletable; it is a maintainer
# repository setting (named in the PR that introduced this script).
set -euo pipefail
export LC_ALL=C

# Every refusal is a workflow-command error on stdout (the runner annotates
# stdout, matching how the step this replaces reported) plus exit 1.
fail_() {
  echo "::error::Base freshness: $*"
  exit 1
}

for required in REPO_SLUG BASE_SHA BASE_REF; do
  if [ -z "${!required:-}" ]; then
    fail_ "required input $required is empty — refusing to judge the base's freshness without it."
  fi
done

# Step 1 — the unchanged-base fast path, identical to the first version's one
# honest pass: nothing has moved, so the required checks ran against the base
# GitHub will land.
current=$(gh api "repos/$REPO_SLUG/commits/$BASE_REF" --jq .sha) || {
  fail_ "could not read the current head of $BASE_REF (gh api failed) — refusing to certify on a failed API call."
}
if [ -z "$current" ]; then
  fail_ "the API returned no commit for $BASE_REF — refusing to certify on an empty response."
fi
if [ "$current" = "$BASE_SHA" ]; then
  echo "Base freshness: CERTIFIED — the base branch $BASE_REF is unchanged: still at $BASE_SHA, exactly the commit the required checks ran against. Pull request head: $HEAD_SHA."
  exit 0
fi

# Step 2 — the base advanced. The advance is relevant iff it shares a file
# with the pull request. Pull both file lists, refuse on anything that makes
# either list unrepresentative, then intersect.
if [ -z "${PR_NUMBER:-}" ]; then
  fail_ "PR_NUMBER is not set — the pull request's changed-file list cannot be fetched, so the advance cannot be judged. Refusing."
fi

pr_files=$(gh api "repos/$REPO_SLUG/pulls/$PR_NUMBER/files" --paginate --jq '.[].filename') || {
  fail_ "could not read the pull request's changed-file list (gh api failed) — refusing to certify on a failed API call."
}
if [ -z "$pr_files" ]; then
  fail_ "the pull request reports no changed files while $BASE_REF advanced from $BASE_SHA — an empty list cannot prove the advance disjoint. Refusing."
fi

total_commits=$(gh api "repos/$REPO_SLUG/compare/$BASE_SHA...$current" --jq '.total_commits') || {
  fail_ "could not compare $BASE_SHA...$current (gh api failed) — refusing to certify on a failed API call."
}
if ! [[ "$total_commits" =~ ^[0-9]+$ ]]; then
  fail_ "the compare $BASE_SHA...$current returned no commit count (got '$total_commits') — an unrepresentable compare. Refusing."
fi
if [ "$total_commits" -gt 200 ]; then
  fail_ "the advance $BASE_SHA..$current carries $total_commits commits — too large to judge as irrelevant. Update the branch onto current main and re-run. Refusing."
fi

advance_files=$(gh api "repos/$REPO_SLUG/compare/$BASE_SHA...$current" --jq '.files[].filename') || {
  fail_ "could not list the advance's files (gh api failed) — refusing to certify on a failed API call."
}
if [ -z "$advance_files" ]; then
  fail_ "the advance $BASE_SHA..$current reports no changed files while the SHAs differ — an unrepresentable compare. Refusing."
fi

mapfile -t pr_arr <<< "$pr_files"
mapfile -t advance_arr <<< "$advance_files"
if [ "${#advance_arr[@]}" -eq 300 ]; then
  fail_ "the advance $BASE_SHA..$current lists exactly 300 files — the compare API's truncation bound, so the list may be cut short. Refusing."
fi

shared=$(comm -12 <(printf '%s\n' "${pr_arr[@]}" | sort) <(printf '%s\n' "${advance_arr[@]}" | sort))
if [ -n "$shared" ]; then
  echo "::error::Base freshness: REFUSED — the base advanced from $BASE_SHA to $current and the advance touches file(s) this pull request also changes: $shared. The required checks ran against the trial merge at event time and never covered this advance x pull-request interaction. Update the branch onto the current $BASE_REF so the required checks re-run across the interaction."
  exit 1
fi

echo "Base freshness: CERTIFIED — the base advanced from $BASE_SHA to $current ($total_commits commits), and the advance is disjoint from the ${#pr_arr[@]} file(s) this pull request changes: the advanced commits touch none of them, so the required checks cover the merged tree for every file this pull request can affect. Advance range: $BASE_SHA..$current. Pull request head: $HEAD_SHA."
exit 0
