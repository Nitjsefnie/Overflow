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
# blessed. Runs after the pull and before install, migrations, build, switch
# or restart, so every refusal below leaves the tree untouched. Per required
# context, only the latest check run decides: completed + success passes;
# completed + any other conclusion refuses immediately; a status that is not
# completed is pending and waits; absent refuses, because absent is not
# passed.
required_checks_gate() {
  local remote_url repo required check_runs check name status conclusion pending timeout deadline
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
  timeout="${OVERFLOW_DEPLOY_CI_TIMEOUT:-900}"
  deadline=$((SECONDS + timeout))
  while :; do
    if ! check_runs=$(gh api "repos/$repo/commits/$full_sha/check-runs?per_page=100" --paginate \
        --jq '.check_runs[] | [.name, .status, (.conclusion // "")] | @tsv'); then
      printf 'Could not read check runs for %s on %s; refusing to deploy.\n' "$repo" "$full_sha" >&2
      exit 1
    fi
    pending=
    while IFS= read -r check; do
      [ -n "$check" ] || continue
      name=
      while IFS=$'\t' read -r name status conclusion; do
        [ "$name" = "$check" ] && break
      done <<EOF
$check_runs
EOF
      if [ "$name" != "$check" ]; then
        printf 'Required check %s has no check run on %s; absent is not passed; refusing to deploy.\n' "$check" "$full_sha" >&2
        exit 1
      fi
      if [ "$status" != completed ]; then
        pending+="${pending:+, }$check ($status)"
        continue
      fi
      if [ "$conclusion" != success ]; then
        printf 'Required check %s concluded %s on %s; refusing to deploy.\n' "$check" "$conclusion" "$full_sha" >&2
        exit 1
      fi
    done <<EOF
$required
EOF
    [ -z "$pending" ] && break
    if [ "$SECONDS" -ge "$deadline" ]; then
      printf 'Required checks still pending after %ss: %s. The deploy was refused; nothing has been mutated.\n' "$timeout" "$pending" >&2
      exit 1
    fi
    sleep 15
  done
}

cd "$tree"
exec 9>"$lock"
flock -w 900 9 || { echo "Could not acquire the deploy lock on $lock; refusing to deploy. Consult the deploy procedure's serialization notes before re-running." >&2; exit 1; }
expected_serving=$(readlink -f "$tree/.next" || printf absent)
git pull --ff-only origin main
full_sha=$(git rev-parse HEAD)
# Tree-cleanliness gate: a release is named for the commit it was built from,
# so the tree must BE that commit. Tracked modifications, staged changes and
# untracked non-ignored files all survive a fast-forward pull; ignored files
# (.next, releases, node_modules, generated files) are operational state and
# do not block. Refuses before the CI gate, install, migrate or build.
tree_status=$(git status --porcelain=v1 -uall) || {
  printf 'Could not read the working-tree state in %s; refusing to build a release whose source identity cannot be attested. Investigate git status in the tree before re-running.\n' "$tree" >&2
  exit 1
}
if [ -n "$tree_status" ]; then
  printf '%s\n' "$tree_status"
  printf 'The working tree in %s deviates from HEAD (%s). A release is named for the commit it was built from; refusing to build one from a tree that is not that commit. Resolve every deviation above (git status), then re-run the deploy.\n' "$tree" "$full_sha" >&2
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
# Redundant-deploy skip: the serving release records the exact commit it was
# built from (REVISION, written after the build), so a pull that left HEAD at
# that commit means production already serves this source. A match also means
# the migrations for HEAD are applied: the run that built this release ran
# pnpm db:migrate at the same commit, immediately before building it. A
# missing or unreadable REVISION (fresh host, pre-484 release) skips nothing.
serving_release=$(readlink -f "$tree/.next" || printf absent)
if [ "$serving_release" != absent ] && [ -f "$serving_release/REVISION" ]; then
  if [ "$(cat "$serving_release/REVISION")" = "$full_sha" ]; then
    printf 'Already serving %s (%s); the tree pulled to the serving commit, so install, migrate and build are skipped and the existing release stays.\n' "$serving_release" "$full_sha"
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
# After the build: its clean step wipes the release directory (everything outside cache|dev|lock|trace), so the record must be written after it — and it still names the exact tree the gates attested and the build consumed.
printf '%s\n' "$full_sha" > "$release/REVISION"
printf 'Source revision: %s\n' "$full_sha"
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
if printf '%s\n' "$retained" | head -n 3 | grep -Fxq -- "$previous_release_name"; then
  pnpm release:prune "$tree" --keep 3
else
  printf 'Not pruning: previous release %s is not among the newest 3 names in the retention listing above. Refusing to prune automatically. If retention is wanted, read the listing and run, by hand and only after confirming, pnpm release:prune %s --keep 4 (raise --keep above 3 enough to include %s), or skip pruning.\n' \
    "$previous_release_name" "$tree" "$previous_release_name"
fi
