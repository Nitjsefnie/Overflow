#!/usr/bin/env bash
# Deploy a new revision of the production tree: deploy/README.md section 10's
# standing block, its retention listing and its prune, as one committed script.
#
# Every knob is overridable ONLY through the OVERFLOW_DEPLOY_* env names below,
# which exist for the test suite; production sets none of them and runs on the
# defaults, where the deploy proceeds only when every required check on the
# exact deployed SHA is green. The one operator-facing exception is
# OVERFLOW_DEPLOY_CI_GATE=skip, reserved for rollback/recovery deploys when
# main's CI is red. Under production defaults the script must be run as root
# from the tree root.
set -euo pipefail

tree="${OVERFLOW_DEPLOY_TREE:-/srv/overflow}"
env_file="${OVERFLOW_DEPLOY_ENV_FILE:-/etc/overflow/overflow.env}"
lock="${OVERFLOW_DEPLOY_LOCK:-/run/overflow-deploy.lock}"
unit="${OVERFLOW_DEPLOY_UNIT:-overflow.service}"
url="${OVERFLOW_DEPLOY_URL:-http://127.0.0.1:3000/api/readiness}"
log_dir="${OVERFLOW_DEPLOY_LOG_DIR:-/var/log/overflow}"

# The CI gate: refuse to ship a SHA that main's required checks have not
# blessed. Runs against the fetched SHA before the fast-forward, so every
# refusal below leaves HEAD, the index and the working tree untouched; only
# the fetch's refs (FETCH_HEAD, origin/main) have moved. The required
# contexts come from main's branch protection; .github/required-checks.json,
# read from the deployed SHA itself, pins each one to the workflow file whose
# job produces it, and a context with no pin refuses at once. Per context,
# only the pinned workflow's job named for it decides: among that workflow's
# runs on the SHA the newest run, and within it the latest attempt.
# Completed + success passes; completed + any other conclusion refuses
# immediately; a status that is not completed is pending and waits; an absent
# job (GitHub has not created the run yet — the normal state in the first
# minute after a merge) waits too, listed as `<check> (absent)`. A check-run
# bearing a required name whose id is none of the pinned workflow's jobs of
# that name waits as `<check> (unattributed check-run <id>)`, so the gate
# never passes while one exists. The OVERFLOW_DEPLOY_CI_TIMEOUT deadline
# bounds the wait, so a job that never registers — a renamed job, a
# path-filtered workflow — or a check-run that never becomes attributable
# still refuses at the deadline, named with its marker.
#
# Why job records and not check-run names: protection matches a required
# check by name and app alone, and every workflow here posts through the one
# GitHub Actions app, so a same-named job in any workflow, or a check-run any
# job with checks: write creates through the Checks API, satisfies it. An
# Actions job's id is its check-run's id, and a job record cannot be created
# through the Checks API, so the gate trusts only the pinned workflow's job
# records. An unattributed check-run waits rather than refusing at once
# because GitHub documents no read-after-write consistency between the
# check-run, run and job listings: just after a merge, a legitimate job's
# check-run can be listed before its run is.
required_checks_gate() {
  local remote_url repo required pins check pin unmapped check_runs runs run_id run_path run_jobs jobs
  local job_line job_run job_path job_id job_name job_attempt job_status job_conclusion
  local cr_id cr_name producer_ids status conclusion decided_run decided_attempt pending timeout deadline
  remote_url=$(git config --get remote.origin.url)
  repo=
  case "$remote_url" in
    git@github.com:*) repo="${remote_url#git@github.com:}" ;;
    https://github.com/*) repo="${remote_url#https://github.com/}" ;;
  esac
  repo="${repo%.git}"
  if ! [[ "$repo" =~ ^[^/]+/[^/]+$ ]]; then
    printf 'Could not parse an OWNER/REPO GitHub slug from remote.origin.url (%s); refusing to deploy.\n' "$remote_url" >&2
    exit 1
  fi
  if ! required=$(gh api "repos/$repo/branches/main/protection" \
      --jq '([.required_status_checks.contexts[]?] + [.required_status_checks.checks[]?.context]) | unique | .[]') \
    || [ -z "$required" ]; then
    printf 'could not determine required checks for main; refusing to deploy\n' >&2
    exit 1
  fi
  # The pin map as `check<TAB>workflow path` lines. A missing file, invalid
  # JSON, anything but an object of .github/workflows/*.yml paths, or an
  # absent jq all fail here.
  if ! pins=$(git show "$full_sha:.github/required-checks.json" | jq -r '
      if type == "object" and all(.[]; type == "string" and test("\\A\\.github/workflows/[^/]+\\.ya?ml\\z"))
      then to_entries[] | [.key, .value] | @tsv
      else error("not an object of .github/workflows/*.yml paths") end'); then
    printf 'Could not read a valid .github/required-checks.json at %s (a JSON object mapping each required check to a .github/workflows/*.yml path); refusing to deploy.\n' "$full_sha" >&2
    exit 1
  fi
  unmapped=
  while IFS= read -r check; do
    [ -n "$check" ] || continue
    [ -n "$(pin_for "$check")" ] || unmapped+="${unmapped:+, }$check"
  done <<<"$required"
  if [ -n "$unmapped" ]; then
    printf 'Required checks with no pin in .github/required-checks.json at %s: %s; refusing to deploy.\n' "$full_sha" "$unmapped" >&2
    exit 1
  fi
  timeout="${OVERFLOW_DEPLOY_CI_TIMEOUT:-900}"
  deadline=$((SECONDS + timeout))
  while :; do
    # Check-runs first, so a check-run's job has had the longest time to be
    # listed by the reads that follow. GitHub documents no consistency
    # between these listings, so a check-run whose job is not listed yet
    # waits as unattributed rather than refusing.
    if ! check_runs=$(gh api "repos/$repo/commits/$full_sha/check-runs?filter=all&per_page=100" --paginate \
        --jq '.check_runs[] | [.id, .name] | @tsv'); then
      printf 'Could not read check runs for %s on %s; refusing to deploy.\n' "$repo" "$full_sha" >&2
      exit 1
    fi
    if ! runs=$(gh api "repos/$repo/actions/runs?head_sha=$full_sha&per_page=100" --paginate \
        --jq '.workflow_runs[] | [.id, .path] | @tsv'); then
      printf 'Could not read workflow runs for %s on %s; refusing to deploy.\n' "$repo" "$full_sha" >&2
      exit 1
    fi
    # Every job of every run of a pinned workflow, one per line:
    # run, path, job id, name, attempt, status, conclusion.
    jobs=
    while IFS=$'\t' read -r run_id run_path; do
      [ -n "$run_id" ] || continue
      is_pinned_path "$run_path" || continue
      if ! run_jobs=$(gh api "repos/$repo/actions/runs/$run_id/jobs?filter=all&per_page=100" --paginate \
          --jq '.jobs[] | [.id, .name, .run_attempt, .status, (.conclusion // "")] | @tsv' </dev/null); then
        printf 'Could not read the jobs of workflow run %s for %s on %s; refusing to deploy.\n' "$run_id" "$repo" "$full_sha" >&2
        exit 1
      fi
      while IFS= read -r job_line; do
        if [ -n "$job_line" ]; then
          jobs+="$run_id"$'\t'"$run_path"$'\t'"$job_line"$'\n'
        fi
      done <<<"$run_jobs"
    done <<<"$runs"
    pending=
    while IFS= read -r check; do
      [ -n "$check" ] || continue
      pin=$(pin_for "$check")
      # The check's producers are the pinned workflow's jobs named for it, in
      # any run and attempt. The newest run decides, and within it the latest
      # attempt. On equal keys (two same-named jobs in one attempt) a
      # non-success replaces a success, so a tie can only hold the deploy back.
      producer_ids=$'\n' decided_run=0 decided_attempt=0 status='' conclusion=''
      while IFS=$'\t' read -r job_run job_path job_id job_name job_attempt job_status job_conclusion; do
        [ "$job_path" = "$pin" ] && [ "$job_name" = "$check" ] || continue
        producer_ids+="$job_id"$'\n'
        if [ "$job_run" -gt "$decided_run" ] \
          || { [ "$job_run" -eq "$decided_run" ] && [ "$job_attempt" -gt "$decided_attempt" ]; } \
          || { [ "$job_run" -eq "$decided_run" ] && [ "$job_attempt" -eq "$decided_attempt" ] \
            && ! { [ "$job_status" = completed ] && [ "$job_conclusion" = success ]; }; }; then
          decided_run=$job_run decided_attempt=$job_attempt status=$job_status conclusion=$job_conclusion
        fi
      done <<<"$jobs"
      if [ -z "$status" ]; then
        pending+="${pending:+, }$check (absent)"
      elif [ "$status" != completed ]; then
        pending+="${pending:+, }$check ($status)"
      elif [ "$conclusion" != success ]; then
        printf 'Required check %s concluded %s on %s; refusing to deploy.\n' "$check" "$conclusion" "$full_sha" >&2
        exit 1
      fi
      # A check-run bearing the name that none of those producers accounts
      # for keeps the check pending, whatever the pinned job concluded.
      while IFS=$'\t' read -r cr_id cr_name; do
        [ "$cr_name" = "$check" ] || continue
        if [[ "$producer_ids" != *$'\n'"$cr_id"$'\n'* ]]; then
          pending+="${pending:+, }$check (unattributed check-run $cr_id)"
        fi
      done <<<"$check_runs"
    done <<<"$required"
    [ -z "$pending" ] && break
    if [ "$SECONDS" -ge "$deadline" ]; then
      printf 'Required checks still pending after %ss: %s. The deploy was refused; HEAD, the index and the working tree are untouched; only the fetched refs moved.\n' "$timeout" "$pending" >&2
      exit 1
    fi
    sleep 15
  done
}

# The workflow path the gate's parsed pin map ($pins) gives a check; empty
# when the check has no pin.
pin_for() {
  local key value
  while IFS=$'\t' read -r key value; do
    if [ "$key" = "$1" ]; then
      printf '%s' "$value"
      return
    fi
  done <<<"$pins"
}

# Whether a workflow path is the pin of some required check.
is_pinned_path() {
  local check
  while IFS= read -r check; do
    if [ -n "$check" ] && [ "$(pin_for "$check")" = "$1" ]; then
      return 0
    fi
  done <<<"$required"
  return 1
}

cd "$tree"
exec 9>"$lock"
flock -w 900 9 || { echo "Could not acquire the deploy lock on $lock; refusing to deploy. Consult the deploy procedure's serialization notes before re-running." >&2; exit 1; }
expected_serving=$(readlink -f "$tree/.next" || printf absent)
# Fetch, gate, then fast-forward: nothing below moves HEAD or the working tree
# until both gates have passed, so a refused deploy leaves the tree on the
# commit it was on. The fetch only writes refs (FETCH_HEAD, origin/main).
git fetch origin main
# FETCH_HEAD, not origin/main: it records exactly what the fetch above
# retrieved, whereas origin/main moves only when remote.origin.fetch maps
# main to it (a single-branch or custom-refspec clone may not). Resolved once;
# the gates and the fast-forward all use this one value.
full_sha=$(git rev-parse --verify 'FETCH_HEAD^{commit}')
# The refusal pull --ff-only used to make: HEAD must fast-forward to the
# fetched commit. A tree ahead of or diverged from main is refused here,
# before either gate. merge-base answers "no" with exit 1; any other nonzero
# status is git failing to answer, refused as undetermined rather than
# reported as a verdict about the tree's history.
ancestry_status=0
git merge-base --is-ancestor HEAD "$full_sha" || ancestry_status=$?
if [ "$ancestry_status" -eq 1 ]; then
  printf 'HEAD in %s is not an ancestor of the fetched main (%s), so it cannot fast-forward there; refusing to deploy. HEAD, the index and the working tree are untouched; only the fetched refs moved. Inspect git log %s..HEAD in the tree before re-running.\n' "$tree" "$full_sha" "$full_sha" >&2
  exit 1
elif [ "$ancestry_status" -ne 0 ]; then
  printf 'Could not determine whether HEAD in %s is an ancestor of the fetched main (%s): git merge-base exited %s; refusing to deploy. HEAD, the index and the working tree are untouched; only the fetched refs moved. Investigate the repository state in the tree before re-running.\n' "$tree" "$full_sha" "$ancestry_status" >&2
  exit 1
fi
# Tree-cleanliness gate: a release is named for the commit it was built from,
# so the tree must BE that commit. It reads the pre-merge tree: tracked
# modifications, staged changes and untracked non-ignored files all survive a
# fast-forward; ignored files (.next, releases, node_modules, generated files)
# are operational state and do not block. Refuses before the CI gate and the
# fast-forward.
tree_status=$(git status --porcelain=v1 -uall) || {
  printf 'Could not read the working-tree state in %s; refusing to build a release whose source identity cannot be attested. Investigate git status in the tree before re-running.\n' "$tree" >&2
  exit 1
}
if [ -n "$tree_status" ]; then
  printf '%s\n' "$tree_status"
  printf 'The working tree in %s deviates from HEAD; fast-forwarding it to %s would not make it that commit. A release is named for the commit it was built from; refusing to build one from a tree that is not that commit. Resolve every deviation above (git status), then re-run the deploy.\n' "$tree" "$full_sha" >&2
  exit 1
fi
case "${OVERFLOW_DEPLOY_CI_GATE:-}" in
  skip)
    printf 'OVERFLOW_DEPLOY_CI_GATE=skip is set; skipping the required-checks gate for %s; CI is NOT verified for this deploy.\n' "$full_sha" >&2
    ;;
  '')
    required_checks_gate
    ;;
  *)
    printf 'OVERFLOW_DEPLOY_CI_GATE=%s is not a supported value; unset it to enforce the gate, or set it to exactly skip for a rollback/recovery deploy when main'"'"'s CI is red.\n' "${OVERFLOW_DEPLOY_CI_GATE}" >&2
    exit 1
    ;;
esac
# Both gates passed: only now does the tree move to the gated commit.
git merge --ff-only "$full_sha"
# Redundant-deploy skip: the serving release records the exact commit it was
# built from (REVISION, written only after the deploy verifies), so a
# fast-forward that left HEAD at that commit means production already serves
# this source. A match also means
# the migrations for HEAD are applied: the run that built this release ran
# pnpm db:migrate at the same commit, immediately before building it. A
# missing or unreadable REVISION (fresh host, pre-484 release) skips nothing.
# The fresh read is deliberate: the pre-fetch anchor can be repointed by an
# off-procedure actor mid-deploy, so the skip compares against what serves now.
serving_release=$(readlink -f "$tree/.next" || printf absent)
if [ "$serving_release" != absent ] && [ -f "$serving_release/REVISION" ]; then
  if [ "$(cat "$serving_release/REVISION")" = "$full_sha" ]; then
    printf 'Already serving %s (%s); the tree fast-forwarded to the serving commit, so install, migrate and build are skipped and the existing release stays.\n' "$serving_release" "$full_sha"
    exit 0
  fi
fi
npm_config_package_import_method=copy pnpm install --frozen-lockfile
set -a; . "$env_file"; set +a
pnpm db:migrate
release=".next-release-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=7 HEAD)"
mkdir "$release"
node scripts/release.ts prepare "$tree" "$release"
NEXT_DIST_DIR="$release" pnpm build
previous_release=$(readlink -f "$tree/.next")
serving_cache="$previous_release/cache"
test -d "$serving_cache"
find "$tree" -path "$serving_cache" -prune -o \
  -exec chown -h root:overflow {} +
find "$tree" -path "$serving_cache" -prune -o \
  ! -type l -exec chmod u=rwX,g=rX,o= {} +
mkdir -p "$release/cache"
chown -R overflow:overflow "$release/cache"
chmod -R u=rwX,g=rX,o= "$release/cache"
printf 'Previous build: %s\nNew build: %s\n' "$previous_release" "$release"
pnpm release:switch "$tree" "$release" --expect-current "$expected_serving"
systemctl restart "$unit"
systemctl is-active "$unit"
curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1 \
  --retry-connrefused -fsS -o /dev/null -w '%{http_code}\n' "$url"
install -d -m 0700 "$log_dir"
upgrade_log="$log_dir/webhook-upgrade-$release.jsonl"
upgrade_status=0
pnpm --silent webhooks:upgrade > "$upgrade_log" 2>&1 || upgrade_status=$?
cat "$upgrade_log"
printf 'Webhook upgrade log: %s\nWebhook upgrade exit status: %s\n' "$upgrade_log" "$upgrade_status"
test "$upgrade_status" -eq 0 || exit "$upgrade_status"
# The record attests a fully deployed release — built (after whose clean step it must be written), switched, restarted, readiness-verified and webhook-upgraded — so a redundant deploy may trust it; a failed deploy leaves no record and its retry re-runs everything.
printf '%s\n' "$full_sha" > "$release/REVISION"
printf 'Source revision: %s\n' "$full_sha"

# Retention listing, exactly as the README prints it, captured for the prune
# guard below and then printed for the deploy record.
retained=$(LC_ALL=C find "$tree" -regextype posix-extended -mindepth 1 -maxdepth 1 \
  -type d -regex '.*/\.next-release-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}' \
  -printf '%f\n' | LC_ALL=C sort -r)
printf '%s\n' "$retained"

# The README's confirm-first prune rule: prune only when the recorded previous
# release is among the newest 3 grammar-matching names of the same listing
# above. Otherwise print a warning naming the previous release and the exact
# manual release:prune command with a raised --keep suggestion, and run nothing.
previous_release_name="${previous_release##*/}"
# Capture-then-match, not a printf|head|grep pipeline: grep -q exits after its
# first match, so on a long listing the consumers can exit while printf is
# still writing, the producer dies by SIGPIPE (status 141) and pipefail turns
# the guard false — silently skipping the prune (issue 624). The herestring's
# producer has already finished before head reads it.
newest_three=$(head -n 3 <<<"$retained")
if grep -Fxq -- "$previous_release_name" <<<"$newest_three"; then
  pnpm release:prune "$tree" --keep 3
else
  printf 'Not pruning: previous release %s is not among the newest 3 names in the retention listing above. Refusing to prune automatically. If retention is wanted, read the listing and run, by hand and only after confirming, pnpm release:prune %s --keep 4 (raise --keep above 3 enough to include %s), or skip pruning.\n' \
    "$previous_release_name" "$tree" "$previous_release_name"
fi
