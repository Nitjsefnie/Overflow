#!/bin/sh
# Restore a db-backup.sh dump into an explicit target database.
#
# Usage: db-restore.sh [--allow-live] TARGET_DATABASE DUMP_FILE
#
# The connection comes from DATABASE_URL, with the target database name
# substituted for the one the URL carries; the target is never taken from the
# URL. A target equal to the database DATABASE_URL names is refused without
# --allow-live: restoring --clean over the live database drops its objects, so
# the escape hatch has to be typed on purpose.
#
# The archive is restored with
#   pg_restore --clean --if-exists --no-owner --no-privileges
# so objects are recreated owned by the connecting role, with privileges left
# to be granted deliberately. Everything pg_restore writes to stderr is passed
# through; a nonzero pg_restore exit fails the script.
#
# OVERFLOW_PG_RESTORE overrides the pg_restore command; the automated restore
# test (tests/db/backup-restore.test.ts) uses it to run the client tool inside
# the postgres:17 container, where the tool version matches the server.
set -eu

program="db-restore.sh"

fail() {
    printf '%s: %s\n' "$program" "$1" >&2
    exit 1
}

allow_live=0
target=""
dump=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --allow-live)
            allow_live=1
            shift
            ;;
        --)
            shift
            while [ "$#" -gt 0 ]; do
                if [ -z "$target" ]; then
                    target=$1
                elif [ -z "$dump" ]; then
                    dump=$1
                else
                    fail "unexpected argument: $1"
                fi
                shift
            done
            ;;
        *)
            if [ -z "$target" ]; then
                target=$1
            elif [ -z "$dump" ]; then
                dump=$1
            else
                fail "unexpected argument: $1"
            fi
            shift
            ;;
    esac
done

if [ -z "$target" ] || [ -z "$dump" ]; then
    fail "usage: db-restore.sh [--allow-live] TARGET_DATABASE DUMP_FILE"
fi

case "$target" in
    [!A-Za-z_]* | *[!A-Za-z0-9_$]*)
        fail "TARGET_DATABASE must be a plain database name (letters, digits, underscore, leading letter or underscore), got: $target"
        ;;
esac

if [ -z "${DATABASE_URL:-}" ]; then
    fail "DATABASE_URL is not set; refusing to guess where to restore"
fi

if [ ! -f "$dump" ]; then
    fail "dump file not found: $dump"
fi

# The URL's last path segment is the database it names; swap it for the target.
base=${DATABASE_URL%%\?*}
query=""
case "$DATABASE_URL" in
    *\?*)
        query=${DATABASE_URL#*\?}
        ;;
esac
url_database=${base##*/}
if [ -z "$url_database" ]; then
    fail "DATABASE_URL does not name a database: the path before any query string is empty"
fi

if [ "$target" = "$url_database" ] && [ "$allow_live" -ne 1 ]; then
    fail "refusing to restore over '$target', the database DATABASE_URL names; pass --allow-live only when the target really is the live database"
fi

pg_restore_cmd=${OVERFLOW_PG_RESTORE:-pg_restore}

target_url="${base%/*}/$target"
if [ -n "$query" ]; then
    target_url="$target_url?$query"
fi

# The archive is streamed on stdin rather than named, so an OVERFLOW_PG_RESTORE
# prefix that runs the tool elsewhere (the container test) can still read it.
$pg_restore_cmd --clean --if-exists --no-owner --no-privileges --dbname="$target_url" < "$dump"
