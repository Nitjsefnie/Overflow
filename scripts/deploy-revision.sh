#!/usr/bin/env bash
# Deploy a new revision of the production tree: deploy/README.md section 10's
# standing block, its retention listing and its prune, as one committed script.
#
# Every knob is overridable ONLY through the OVERFLOW_DEPLOY_* env names below,
# which exist for the test suite; production sets none of them and runs on the
# defaults. Under production defaults the script must be run as root from the
# tree root.
set -euo pipefail

tree="${OVERFLOW_DEPLOY_TREE:-/srv/overflow}"
env_file="${OVERFLOW_DEPLOY_ENV_FILE:-/etc/overflow/overflow.env}"
lock="${OVERFLOW_DEPLOY_LOCK:-/run/overflow-deploy.lock}"
unit="${OVERFLOW_DEPLOY_UNIT:-overflow.service}"
url="${OVERFLOW_DEPLOY_URL:-http://127.0.0.1:3000/}"
log_dir="${OVERFLOW_DEPLOY_LOG_DIR:-/var/log/overflow}"

cd "$tree"
exec 9>"$lock"
flock -w 900 9 || { echo "Could not acquire the deploy lock on $lock; refusing to deploy. Consult the deploy procedure's serialization notes before re-running." >&2; exit 1; }
expected_serving=$(readlink -f "$tree/.next" || printf absent)
git pull --ff-only origin main
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
