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
#
# The script runs in two phases joined by one exec. Bash reads a script
# incrementally, and the fast-forward below rewrites this file mid-run, so
# the tail after `git merge --ff-only` would otherwise execute from the
# pre-merge copy: a verification step the deployed commit adds would not run
# in its own deploy (issue 747). Phase 1 is everything through the
# fast-forward, ending in
#   exec env OVERFLOW_DEPLOY_HANDOFF_SHA="$full_sha" OVERFLOW_DEPLOY_HANDOFF_SERVING="$expected_serving" bash "$tree/scripts/deploy-revision.sh"
# - the merged tree's own copy, with the deploy lock's fd 9 inherited across
# the exec. Phase 2 runs from the redundant-deploy skip through the prune and
# holds no second exec, so the chain cannot loop. The two names
# OVERFLOW_DEPLOY_HANDOFF_SHA and OVERFLOW_DEPLOY_HANDOFF_SERVING are
# internal state the script sets itself across the exec, not operator knobs:
# production never seeds either, and a phase-2 entry refuses fail-closed
# unless fd 9 is open on the deploy lock, the serving anchor is set, and the
# tree is already at the exact commit the handoff carries.
set -euo pipefail

tree="${OVERFLOW_DEPLOY_TREE:-/srv/overflow}"
env_file="${OVERFLOW_DEPLOY_ENV_FILE:-/etc/overflow/overflow.env}"
lock="${OVERFLOW_DEPLOY_LOCK:-/run/overflow-deploy.lock}"
unit="${OVERFLOW_DEPLOY_UNIT:-overflow.service}"
url="${OVERFLOW_DEPLOY_URL:-http://127.0.0.1:3000/api/readiness}"
log_dir="${OVERFLOW_DEPLOY_LOG_DIR:-/var/log/overflow}"
# A release directory's name, unanchored: the grammar the build names each
# release with and the retention listing below enumerates. Defined once so the
# ignored-files gate's allowlist cannot drift from the listing.
release_name_re='\.next-release-[0-9]{8}T[0-9]{6}Z-[a-f0-9]{7,40}'
# The ignored untracked entries a production tree legitimately holds, as
# git ls-files --others --ignored --directory prints them, each matched as a
# whole path from the tree root: the .next anchor (a symlink, or a directory
# before the release migration), release directories and the tsconfig sidecar
# release.ts writes beside each, the release-notes directory, the generated
# next-env.d.ts and node_modules. Nothing else, and nothing nested: a leftover
# .next-switch-* link is a crash artefact the operator should see.
operational_ignored_re="^(\.next/?|${release_name_re}/|${release_name_re}\.tsconfig\.json|\.next-release-notes/|next-env\.d\.ts|node_modules/)\$"
# Matched byte-wise under LC_ALL=C, as the retention listing below is, so the
# operator's locale cannot change what the allowlist admits; the function-local
# assignment restores the locale on return.
is_operational_ignored() {
  local LC_ALL=C
  [[ "$1" =~ $operational_ignored_re ]]
}

# The CI gate: refuse to ship a SHA that main's required checks have not
# blessed. Runs against the fetched SHA before the fast-forward, so every
# refusal below leaves HEAD, the index and the working tree untouched; only
# the fetch's refs (FETCH_HEAD, origin/main) have moved. The required
# contexts come from main's branch protection; .github/required-checks.json,
# read from the deployed SHA itself, pins each one to the workflow file whose
# job produces it, and a context with no pin refuses at once. Per context, a
# check-run posted by the ledger App (OVERFLOW_DEPLOY_LEDGER_APP_ID, default
# 5118623) attributes the context, and the NEWEST App check-run for it
# (highest id) decides. When no App check-run exists, the pinned workflow's
# job record decides exactly as before: among that workflow's runs on the
# SHA the newest run, and within it the latest attempt. Completed + success
# passes; completed + any other conclusion refuses immediately; a status
# that is not completed is pending and waits; an absent job (GitHub has not
# created the run yet — the normal state in the first minute after a merge)
# waits too, listed as `<check> (absent)`. A check-run bearing a required
# name whose app is neither the ledger App nor one of the pinned workflow's
# jobs of that name waits as `<check> (unattributed check-run <id>)`, so the
# gate never passes while one exists. The OVERFLOW_DEPLOY_CI_TIMEOUT
# deadline bounds the wait, so a job that never registers — a renamed job, a
# path-filtered workflow — or a check-run that never becomes attributable
# still refuses at the deadline, named with its marker.
#
# Why the ledger App's check-runs are trusted: protection matches a required
# check by name and app alone, so the relay (a workflow_run workflow running
# main's own workflow definitions) must post the required contexts under the
# ledger App's identity for them to count post-switch — the same name+app
# identity protection itself reads. The gate reads that app id straight off
# each check-run, so what the gate blessed is what protection will see. Job
# records remain the no-relay decision path: every workflow here posts
# through the one GitHub Actions app, so a same-named job in any workflow,
# or a check-run any job with checks: write creates through the Checks API,
# satisfies protection; an Actions job's id is its check-run's id, and a job
# record cannot be created through the Checks API, so only the pinned
# workflow's job records decide without the relay. An unattributed check-run
# waits rather than refusing at once because GitHub documents no
# read-after-write consistency between the check-run, run and job listings:
# just after a merge, a legitimate job's check-run can be listed before its
# run is.
required_checks_gate() {
  local remote_url repo required pins check pin unmapped check_runs runs run_id run_path run_jobs jobs
  local job_line job_run job_path job_id job_name job_attempt job_status job_conclusion
  local cr_id cr_name cr_app cr_status cr_conclusion producer_ids status conclusion
  local decided_run decided_attempt pending timeout deadline ledger_app_id ledger_id
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
  # JSON, anything but exactly one object of .github/workflows/*.yml paths,
  # or an absent jq all fail here.
  if ! pins=$(git show "$full_sha:.github/required-checks.json" | jq -rs '
      if length == 1 and (.[0] | type == "object"
          and all(.[]; type == "string" and test("\\A\\.github/workflows/[^/]+\\.ya?ml\\z")))
      then .[0] | to_entries[] | [.key, .value] | @tsv
      else error("not exactly one object of .github/workflows/*.yml paths") end'); then
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
  # The ledger App's id: check-runs it posted attribute a required context to
  # the relay, and their newest decides. A test-only knob, like the timeout:
  # production runs on the default and never sets the name.
  ledger_app_id="${OVERFLOW_DEPLOY_LEDGER_APP_ID:-5118623}"
  deadline=$((SECONDS + timeout))
  while :; do
    # Check-runs first, so a check-run's job has had the longest time to be
    # listed by the reads that follow. GitHub documents no consistency
    # between these listings, so a check-run whose job is not listed yet
    # waits as unattributed rather than refusing.
    if ! check_runs=$(gh api "repos/$repo/commits/$full_sha/check-runs?filter=all&per_page=100" --paginate \
        --jq '.check_runs[] | [.id, .name, (.app.id // 0), (.status // "unknown"), (.conclusion // "")] | @tsv'); then
      printf 'Could not read check runs for %s on %s; refusing to deploy.\n' "$repo" "$full_sha" >&2
      exit 1
    fi
    if ! runs=$(gh api "repos/$repo/actions/runs?head_sha=$full_sha&per_page=100" --paginate \
        --jq '.workflow_runs[] | [.id, .path] | @tsv'); then
      printf 'Could not read workflow runs for %s on %s; refusing to deploy.\n' "$repo" "$full_sha" >&2
      exit 1
    fi
    # Every job of every run of a pinned workflow, one per line:
    # run, path, job id, name, attempt, status, conclusion. Tab is IFS
    # whitespace, so an empty field would shift the ones after it: the jobs
    # projection fills every field but the last.
    jobs=
    while IFS=$'\t' read -r run_id run_path; do
      [ -n "$run_id" ] || continue
      is_pinned_path "$run_path" || continue
      if ! run_jobs=$(gh api "repos/$repo/actions/runs/$run_id/jobs?filter=all&per_page=100" --paginate \
          --jq '.jobs[] | [.id, (if (.name // "") == "" then "(unnamed)" else .name end), (.run_attempt // 0), (.status // "unknown"), (.conclusion // "")] | @tsv' </dev/null); then
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
      # A check-run the ledger App posted attributes this context: its newest
      # run (highest id) decides, reading the same name+app identity
      # protection matches on post-switch.
      ledger_id=0
      while IFS=$'\t' read -r cr_id cr_name cr_app cr_status cr_conclusion; do
        [ "$cr_name" = "$check" ] || continue
        [ "$cr_app" = "$ledger_app_id" ] || continue
        if [ "$cr_id" -gt "$ledger_id" ]; then
          ledger_id=$cr_id status=$cr_status conclusion=$cr_conclusion
        fi
      done <<<"$check_runs"
      if [ -z "$status" ]; then
        pending+="${pending:+, }$check (absent)"
      elif [ "$status" != completed ]; then
        pending+="${pending:+, }$check ($status)"
      elif [ "$conclusion" != success ]; then
        printf 'Required check %s concluded %s on %s; refusing to deploy.\n' "$check" "$conclusion" "$full_sha" >&2
        exit 1
      fi
      # A check-run bearing the name that the ledger App did not post and
      # none of those producers accounts for keeps the check pending,
      # whatever the pinned job or the ledger App concluded.
      while IFS=$'\t' read -r cr_id cr_name cr_app cr_status cr_conclusion; do
        [ "$cr_name" = "$check" ] || continue
        if [ "$cr_app" = "$ledger_app_id" ]; then continue; fi
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

if [ -n "${OVERFLOW_DEPLOY_HANDOFF_SHA:-}" ]; then
  # Phase 2: the post-fast-forward half, entered through the re-exec at the
  # end of phase 1. Four fail-closed entry checks run before anything else,
  # in order: fd 9 must be open; fd 9 must be THE deploy lock (the exec
  # inherits it, so an entry without the lock on fd 9 did not come from the
  # handoff); the serving anchor the handoff carries must be set, since the
  # conditional switch below is held to it; and the tree must already be the
  # exact commit the gates blessed. None is an operator knob; production
  # sets none of them.
  if ! { : <&9; } 2>/dev/null; then
    printf 'The deploy handoff reached the post-fast-forward phase of %s without the deploy lock on fd 9; refusing to deploy. The lock is inherited across the handoff exec, so an entry without it did not come from the handoff.\n' "$tree" >&2
    exit 1
  fi
  fd9_target=$(readlink /proc/self/fd/9) || fd9_target=""
  if [ "$fd9_target" != "$lock" ]; then
    printf 'The deploy handoff reached the post-fast-forward phase of %s with fd 9 open on %s, not on the deploy lock %s; refusing to deploy. The lock is inherited across the handoff exec, so an entry whose fd 9 names another file did not come from the handoff.\n' "$tree" "$fd9_target" "$lock" >&2
    exit 1
  fi
  if [ -z "${OVERFLOW_DEPLOY_HANDOFF_SERVING:-}" ]; then
    printf 'The deploy handoff reached the post-fast-forward phase without a serving anchor (OVERFLOW_DEPLOY_HANDOFF_SERVING is unset or empty); refusing to deploy. The handoff carries the pre-fetch anchor the conditional switch is held to, and the switch must not run without it.\n' >&2
    exit 1
  fi
  full_sha=$OVERFLOW_DEPLOY_HANDOFF_SHA
  expected_serving=$OVERFLOW_DEPLOY_HANDOFF_SERVING
  cd "$tree"
  gated_head=$(git rev-parse HEAD) || {
    printf 'The deploy handoff reached the post-fast-forward phase of %s, but HEAD there could not be read; refusing to deploy.\n' "$tree" >&2
    exit 1
  }
  if [ "$gated_head" != "$full_sha" ]; then
    printf 'The deploy handoff reached the post-fast-forward phase of %s with HEAD at %s, but the handoff carries %s; refusing to deploy. The tree must be the exact commit the gates blessed before the post-fast-forward half runs.\n' "$tree" "$gated_head" "$full_sha" >&2
    exit 1
  fi
else
  # Phase 1: the fence, the anchor, the fetch and both gates, then the
  # fast-forward - and immediately the re-exec, because bash reads a script
  # incrementally and the fast-forward rewrites this file mid-run: the tail
  # would otherwise execute from the pre-merge copy, so a verification step
  # the deployed commit adds would not run in its own deploy (issue 747).
  # The exec replaces this process with the merged tree's own copy, handing
  # over the resolved SHA and the pre-fetch anchor; fd 9 travels with it, so
  # the deploy lock is held across the handoff. Phase 2 holds no second exec,
  # so the chain cannot loop.
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
  # so the tree must BE that commit. It reads the pre-merge tree in two parts,
  # both before the CI gate and the fast-forward. First git status: tracked
  # modifications, staged changes and untracked non-ignored files all survive a
  # fast-forward. Then the ignored untracked files, which git status never shows
  # (the .gitignore denies by default, so a new source file nobody named back is
  # ignored) and the build still compiles: only the operational allowlist above
  # passes, and any other entry refuses.
  tree_status=$(git status --porcelain=v1 -uall) || {
    printf 'Could not read the working-tree state in %s; refusing to build a release whose source identity cannot be attested. Investigate git status in the tree before re-running.\n' "$tree" >&2
    exit 1
  }
  if [ -n "$tree_status" ]; then
    printf '%s\n' "$tree_status"
    printf 'The working tree in %s deviates from HEAD; fast-forwarding it to %s would not make it that commit. A release is named for the commit it was built from; refusing to build one from a tree that is not that commit. Resolve every deviation above (git status), then re-run the deploy.\n' "$tree" "$full_sha" >&2
    exit 1
  fi
  # NUL-delimited, so a name containing a newline is judged whole. Capture the
  # git ls-files status directly from its simple command, so no wait/ECHILD race
  # can lose it; a failed listing still refuses even if it printed entries
  # first. An ignored empty directory is left out: nothing in it can be compiled.
  ignored_listing=$(mktemp)
  ignored_status=0
  git ls-files -z --others --ignored --exclude-standard --directory --no-empty-directory > "$ignored_listing" || ignored_status=$?
  mapfile -d '' -t ignored_entries < "$ignored_listing"
  rm -f "$ignored_listing"
  if [ "$ignored_status" -ne 0 ]; then
    printf 'Could not list the ignored untracked files in %s (git ls-files exited %s); refusing to build a release whose source identity cannot be attested. HEAD, the index and the working tree are untouched; only the fetched refs moved. Investigate git ls-files in the tree before re-running.\n' "$tree" "$ignored_status" >&2
    exit 1
  fi
  stray_ignored=()
  for entry in "${ignored_entries[@]}"; do
    is_operational_ignored "$entry" || stray_ignored+=("$entry")
  done
  if [ "${#stray_ignored[@]}" -gt 0 ]; then
    printf '  %q\n' "${stray_ignored[@]}" >&2
    printf 'The tree in %s holds the ignored untracked files above, outside the operational allowlist (.next, release directories and their .tsconfig.json sidecars, .next-release-notes/, next-env.d.ts and node_modules/, each at the tree root). These are ignored untracked files that git status does not show, and the build would compile them into a release named for %s, a commit that does not contain them; refusing to deploy. HEAD, the index and the working tree are untouched; only the fetched refs moved. Remove them, then re-run the deploy.\n' "$tree" "$full_sha" >&2
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
  exec env OVERFLOW_DEPLOY_HANDOFF_SHA="$full_sha" OVERFLOW_DEPLOY_HANDOFF_SERVING="$expected_serving" bash "$tree/scripts/deploy-revision.sh"
fi
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
migration_status=$(node scripts/deploy-migration-status.ts) || {
  printf 'Could not list the pending migrations (node scripts/deploy-migration-status.ts failed); refusing to deploy. Database connection details come from %s.\n' "$env_file" >&2
  exit 1
}
if [ -n "$migration_status" ]; then
  printf 'Pending migrations this deploy would apply:\n%s\n' "$migration_status"
else
  printf 'No pending migrations.\n'
fi
marked=$(awk -F'\t' '$2 == "review" { print $1 }' <<<"$migration_status")
if [ "${OVERFLOW_DEPLOY_MIGRATION_ACK+x}" = "x" ] && [ "$OVERFLOW_DEPLOY_MIGRATION_ACK" != "1" ]; then
  printf 'OVERFLOW_DEPLOY_MIGRATION_ACK=%s is not a supported value; unset it to enforce the review gate, or set it to exactly 1 after reviewing every marked migration.\n' "$OVERFLOW_DEPLOY_MIGRATION_ACK" >&2
  exit 1
fi
if [ -n "$marked" ] && [ "${OVERFLOW_DEPLOY_MIGRATION_ACK:-}" != "1" ]; then
  printf '%s\n' "$marked" >&2
  printf "The pending migrations above need mixed-version review against the previous release's write path; refusing to deploy. Review every listed migration, then set OVERFLOW_DEPLOY_MIGRATION_ACK=1 to confirm and re-run.\n" >&2
  exit 1
fi
pnpm db:migrate
release=".next-release-$(date -u +%Y%m%dT%H%M%SZ)-$(git rev-parse --short=7 HEAD)"
mkdir "$release"
node scripts/release.ts prepare "$tree" "$release"
NEXT_TELEMETRY_DISABLED=1 NEXT_DIST_DIR="$release" pnpm build
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
# Sign-in smoke (issue 649): readiness certifies the database and the bundled
# schema but cannot see Auth.js trust configuration, so a deployment whose
# documented environment cannot sign in passed the check above. GET
# /api/auth/providers runs the Auth.js configuration and answers 500
# ([auth][error] UntrustedHost) on exactly that misconfiguration; refuse the
# deploy unless it answers 200. The URL derives from the readiness URL knob by
# replacing its trailing /api/readiness — OVERFLOW_DEPLOY_URL is contracted to
# name the readiness endpoint (its production default does), and any other
# target derives a wrong smoke URL that fails closed.
providers_url="${url%/api/readiness}/api/auth/providers"
curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1 \
  --retry-connrefused -fsS -o /dev/null -w '%{http_code}\n' "$providers_url"
install -d -m 0700 "$log_dir"
upgrade_log="$log_dir/webhook-upgrade-$release.jsonl"
upgrade_status=0
pnpm --silent webhooks:upgrade > "$upgrade_log" 2>&1 || upgrade_status=$?
cat "$upgrade_log"
printf 'Webhook upgrade log: %s\nWebhook upgrade exit status: %s\n' "$upgrade_log" "$upgrade_status"
test "$upgrade_status" -eq 0 || exit "$upgrade_status"
# The record attests a fully deployed release — built (after whose clean step it must be written), switched, restarted, readiness- and sign-in-smoke-verified and webhook-upgraded — so a redundant deploy may trust it; a failed deploy leaves no record and its retry re-runs everything.
printf '%s\n' "$full_sha" > "$release/REVISION"
printf 'Source revision: %s\n' "$full_sha"

# Retention listing, exactly as the README prints it, captured for the prune
# guard below and then printed for the deploy record.
retained=$(LC_ALL=C find "$tree" -regextype posix-extended -mindepth 1 -maxdepth 1 \
  -type d -regex ".*/$release_name_re" \
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
