#!/bin/sh
# Dump the Overflow database to a timestamped custom-format archive.
#
# Usage: db-backup.sh [--output-dir DIR] [--retention-days N]
#
# DATABASE_URL must name the database to dump; without it the script refuses to
# guess. The dump is written as <output-dir>/overflow-<UTC timestamp>.dump,
# verified nonempty and listable by pg_restore --list, and only then moved into
# place; the path is printed on stdout. Dumps matching overflow-*.dump that are
# older than --retention-days (default 14) are pruned after a successful dump.
#
# The output directory comes from --output-dir, else OVERFLOW_BACKUP_DIR, else
# /var/backups/overflow; a missing directory is created root-only (0700).
#
# OVERFLOW_PG_DUMP and OVERFLOW_PG_RESTORE override the pg_dump and pg_restore
# commands. The automated restore test (tests/db/backup-restore.test.ts) uses
# them to run the client tools inside the postgres:17 container, where the tool
# version always matches the server; the default is the host's own tools.
set -eu

# The dump carries the database's entire contents, so its mode is the
# script's business, not the caller's: under a default umask of 022 the
# shell redirect below would create a world-readable archive.
umask 077

program="db-backup.sh"

fail() {
    printf '%s: %s\n' "$program" "$1" >&2
    exit 1
}

output_dir=""
retention_days=""

while [ "$#" -gt 0 ]; do
    case "$1" in
        --output-dir)
            [ "$#" -ge 2 ] || fail "--output-dir needs a directory argument"
            output_dir=$2
            shift 2
            ;;
        --output-dir=*)
            output_dir=${1#*=}
            shift
            ;;
        --retention-days)
            [ "$#" -ge 2 ] || fail "--retention-days needs a number argument"
            retention_days=$2
            shift 2
            ;;
        --retention-days=*)
            retention_days=${1#*=}
            shift
            ;;
        --)
            shift
            while [ "$#" -gt 0 ]; do
                fail "unexpected argument: $1"
            done
            ;;
        *)
            fail "unknown argument: $1"
            ;;
    esac
done

if [ -z "${DATABASE_URL:-}" ]; then
    fail "DATABASE_URL is not set; refusing to guess which database to dump"
fi

if [ -z "$output_dir" ]; then
    output_dir=${OVERFLOW_BACKUP_DIR:-/var/backups/overflow}
fi

if [ -z "$retention_days" ]; then
    retention_days=14
fi

case "$retention_days" in
    "" | *[!0-9]*)
        fail "--retention-days must be a number of days, got: $retention_days"
        ;;
esac

if [ "$retention_days" -lt 1 ]; then
    fail "--retention-days must be at least 1 day, got: $retention_days"
fi

if [ ! -d "$output_dir" ]; then
    mkdir -p "$output_dir"
    chmod 0700 "$output_dir"
fi

pg_dump_cmd=${OVERFLOW_PG_DUMP:-pg_dump}
pg_restore_cmd=${OVERFLOW_PG_RESTORE:-pg_restore}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
dump="$output_dir/overflow-$stamp.dump"
partial="$output_dir/.overflow-$stamp.dump.incomplete"
trap 'rm -f "$partial"' EXIT HUP INT TERM

# pg_dump writes the custom-format archive; the partial name keeps a failed or
# interrupted dump from ever matching the overflow-*.dump prune-and-restore set.
$pg_dump_cmd --format=custom "$DATABASE_URL" > "$partial"

if [ ! -s "$partial" ]; then
    fail "the dump is empty; refusing to keep it ($dump)"
fi

# Listing the archive through pg_restore proves the file is a complete,
# readable custom-format dump before it is called a backup.
$pg_restore_cmd --list < "$partial" > /dev/null

mv "$partial" "$dump"
trap - EXIT HUP INT TERM

# Prune only after the new dump is safely in place, and only files that match
# the dump name shape: nothing else in the directory is ours to delete.
old=$(find "$output_dir" -maxdepth 1 -type f -name 'overflow-*.dump' -mtime +"$retention_days")
if [ -n "$old" ]; then
    printf '%s\n' "$old"
    find "$output_dir" -maxdepth 1 -type f -name 'overflow-*.dump' -mtime +"$retention_days" -delete
fi

printf '%s\n' "$dump"
