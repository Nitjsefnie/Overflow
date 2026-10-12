#!/usr/bin/env bash
# LAST step of ci-pr.yml's verify job and pr-gates.yml's actionlint job.
# Both workflows admit only pull_request_target. Certify an unchanged base
# or an advance disjoint from the PR's files; incomplete API reads fail closed.
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
# either list unrepresentative, then intersect. A rename (or copy) changes
# BOTH paths — the API reports the old one in previous_filename — so each
# projection counts the previous path too (issue 685): either side renaming a
# file the other just edited is an overlap, not a disjoint advance.
if [ -z "${PR_NUMBER:-}" ]; then
  fail_ "PR_NUMBER is not set — the pull request's changed-file list cannot be fetched, so the advance cannot be judged. Refusing."
fi

pr_files=$(gh api "repos/$REPO_SLUG/pulls/$PR_NUMBER/files" --paginate --jq '.[] | (.filename, (.previous_filename // empty))') || {
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

advance_files=$(gh api "repos/$REPO_SLUG/compare/$BASE_SHA...$current" --jq '.files[] | (.filename, (.previous_filename // empty))') || {
  fail_ "could not list the advance's files (gh api failed) — refusing to certify on a failed API call."
}
if [ -z "$advance_files" ]; then
  fail_ "the advance $BASE_SHA..$current reports no changed files while the SHAs differ — an unrepresentable compare. Refusing."
fi

# The truncation bound counts API ENTRIES, not projected lines: a renamed or
# copied entry projects to two lines, so a truncated compare inflated past 300
# lines would slip a -eq 300 line-count check (issue 685). `.files | length`
# is the entry count the API truncates at exactly 300.
advance_entry_count=$(gh api "repos/$REPO_SLUG/compare/$BASE_SHA...$current" --jq '.files | length') || {
  fail_ "could not count the advance's files (gh api failed) — refusing to certify on a failed API call."
}
if ! [[ "$advance_entry_count" =~ ^[0-9]+$ ]]; then
  fail_ "the compare $BASE_SHA...$current returned no file count (got '$advance_entry_count') — an unrepresentable compare. Refusing."
fi

mapfile -t pr_arr <<< "$pr_files"
mapfile -t advance_arr <<< "$advance_files"
if [ "$advance_entry_count" -eq 300 ]; then
  fail_ "the advance $BASE_SHA..$current lists exactly 300 files — the compare API's truncation bound, so the list may be cut short. Refusing."
fi

shared=$(comm -12 <(printf '%s\n' "${pr_arr[@]}" | sort) <(printf '%s\n' "${advance_arr[@]}" | sort))
if [ -n "$shared" ]; then
  echo "::error::Base freshness: REFUSED — the base advanced from $BASE_SHA to $current and the advance touches file(s) this pull request also changes: $shared. The required checks ran against the trial merge at event time and never covered this advance x pull-request interaction. Update the branch onto the current $BASE_REF so the required checks re-run across the interaction."
  exit 1
fi

echo "Base freshness: CERTIFIED — the base advanced from $BASE_SHA to $current ($total_commits commits), and the advance is disjoint from the ${#pr_arr[@]} changed path(s) this pull request touches (a rename or copy counts both its paths): the advanced commits touch none of them, so the required checks cover the merged tree for every file this pull request can affect. Advance range: $BASE_SHA..$current. Pull request head: $HEAD_SHA."
exit 0
