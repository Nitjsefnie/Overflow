#!/bin/sh
# Dump the Overflow database to a timestamped custom-format archive.
#
# Usage: db-backup.sh [--output-dir DIR] [--retention-days N]
#
# DATABASE_URL must name the database to dump; without it the script refuses to
# guess. The dump is written as <output-dir>/overflow-<UTC timestamp>.dump,
# verified nonempty and listable by pg_restore --list, and only then linked into
# place under a free name; that path is printed on stdout. The stamp has
# one-second resolution, so a second run landing in the same second installs
# under the next free name in the series overflow-<stamp>-1.dump,
# overflow-<stamp>-2.dump, ... rather than replacing the first run's dump. A
# name already held is skipped, whether by a file, a dangling symlink, or a
# directory — a directory counts as taken because ln would otherwise link INTO
# it and report success. Only a link that fails on a FREE name — a read-only
# directory, no space, a name the filesystem will not accept — aborts the run,
# and it says so with ln's own reason.
# Dumps matching overflow-*.dump that are older than --retention-days
# (default 14) are pruned after a successful dump.
#
# A run killed before its dump is installed leaves its
# .overflow-<pid>.dump.incomplete partial behind. Every run begins by sweeping
# leftover partials older than 24 hours (-mtime +0) out of the output directory
# and deleting them; real dumps matching overflow-*.dump are never touched by
# the sweep.
#
# The output directory comes from --output-dir, else OVERFLOW_BACKUP_DIR, else
# /var/backups/overflow; a missing directory is created root-only (0700).
#
# OVERFLOW_PG_DUMP and OVERFLOW_PG_RESTORE override the pg_dump and pg_restore
# commands. The automated restore test (tests/db/backup-restore.test.ts) uses
# them to run the client tools inside the postgres:17 container, where the tool
# version always matches the server; the default is the host's own tools.
#
# OVERFLOW_BACKUP_STAMP replaces the timestamp this run derives from date -u,
# verbatim. It names the dump and nothing else: the search for a free name still
# runs, so two runs given the same stamp keep both dumps. The automated restore
# test sets it to make the same-second collision a thing it can reproduce
# without depending on the wall clock; an operator may set it to file a dump
# under a chosen name.
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

# A crash killed before the mv leaves its partial behind, and the EXIT trap
# only ever cleans the current run's. Reclaim leftovers older than a day
# (-mtime +0), print then delete like the retention prune below. The name is
# anchored to the leading dot and the .dump.incomplete suffix, so a real dump
# can never match.
leftovers=$(find "$output_dir" -maxdepth 1 -type f -name '.overflow-*.dump.incomplete' -mtime +0)
if [ -n "$leftovers" ]; then
    printf '%s\n' "$leftovers"
    find "$output_dir" -maxdepth 1 -type f -name '.overflow-*.dump.incomplete' -mtime +0 -delete
fi

pg_dump_cmd=${OVERFLOW_PG_DUMP:-pg_dump}
pg_restore_cmd=${OVERFLOW_PG_RESTORE:-pg_restore}

# The stamp has second resolution, so two runs landing in the same UTC second
# derive one name. The install below takes the first free name in the series
# overflow-<stamp>.dump, overflow-<stamp>-1.dump, overflow-<stamp>-2.dump, ...
stamp=${OVERFLOW_BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
# The name this run would take if nothing else had it. Only the empty-dump
# refusal below quotes it, and it is quoted as the intent rather than as an
# installed file: the name actually installed is decided by the search, which
# has not run yet, and $dump is set to it only once it has.
intended="$output_dir/overflow-$stamp.dump"
# The partial carries this run's pid: two runs sharing one second would
# otherwise share one partial, and the second run's redirect would truncate the
# bytes the first is about to install. The stem is the pid rather than the
# stamp, which keeps the name inside what the sweep matches and keeps it short
# enough whatever stamp an operator supplies.
partial="$output_dir/.overflow-$$.dump.incomplete"
trap 'rm -f "$partial"' EXIT HUP INT TERM

# pg_dump writes the custom-format archive; the partial name keeps a failed or
# interrupted dump from ever matching the overflow-*.dump prune-and-restore set.
$pg_dump_cmd --format=custom "$DATABASE_URL" > "$partial"

if [ ! -s "$partial" ]; then
    fail "the dump is empty; refusing to keep it ($intended)"
fi

# Listing the archive through pg_restore proves the file is a complete,
# readable custom-format dump before it is called a backup.
$pg_restore_cmd --list < "$partial" > /dev/null

# Install under the first free name in the series, atomically. The primitive is
# link(2): it either creates the name or fails EEXIST, and the kernel decides
# which with no window in between. That is what makes choosing the name and
# taking it one step — a test-then-mv splits them, so two runs in one second
# both see the plain name free and one replaces the other. Both operands sit in
# one directory, which is what makes the hard link possible at all: it rules
# out EXDEV, it is not where the atomicity comes from. (link(2) is atomic on a
# local filesystem; the backup directory is documented as local.)
# The bound keeps a directory full of taken names from searching forever.
max_attempts=100
attempt=0
while :; do
    if [ "$attempt" -eq 0 ]; then
        candidate="$output_dir/overflow-$stamp.dump"
    else
        candidate="$output_dir/overflow-$stamp-$attempt.dump"
    fi

    # ln treats a directory operand as a place to link INTO, which would report
    # success and install the dump under a name this run does not own. A real
    # dump is always a regular file one of these runs created.
    if [ -d "$candidate" ]; then
        :
    elif ln_error=$(ln "$partial" "$candidate" 2>&1); then
        break
    elif [ -e "$candidate" ] || [ -L "$candidate" ]; then
        # The name is taken, which is the collision this search exists for. -L
        # as well as -e: a symlink left by a restore or a half-recovered
        # directory has a name that is taken even when its target is gone, and
        # -e alone follows the link, calls the name free, and fails the run.
        :
    else
        # The name is free, so this is not a collision: a read-only directory,
        # no space, a name the filesystem will not accept. Retrying a suffix
        # cannot help, and spinning would hide a failed backup behind a hung
        # timer, so the run fails loudly and leaves no dump behind.
        fail "could not install the dump as $candidate: $ln_error"
    fi

    attempt=$((attempt + 1))
    if [ "$attempt" -ge "$max_attempts" ]; then
        fail "no free dump name after $max_attempts tries; the last was $candidate"
    fi
done

# The notice about a taken name goes to stderr: stdout's contract is that its
# last line is the installed dump path, and this is a diagnostic, not one.
if [ "$attempt" -gt 0 ]; then
    printf '%s: a dump for %s was already there; this run installed the next one\n' \
        "$program" "$stamp" >&2
fi

# The dump is in place under its own name; the partial link is what is left.
rm -f "$partial"
dump=$candidate
trap - EXIT HUP INT TERM

# Prune only after the new dump is safely in place, and only files that match
# the dump name shape: nothing else in the directory is ours to delete.
old=$(find "$output_dir" -maxdepth 1 -type f -name 'overflow-*.dump' -mtime +"$retention_days")
if [ -n "$old" ]; then
    printf '%s\n' "$old"
    find "$output_dir" -maxdepth 1 -type f -name 'overflow-*.dump' -mtime +"$retention_days" -delete
fi

printf '%s\n' "$dump"
