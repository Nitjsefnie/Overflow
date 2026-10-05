#!/bin/sh
# Nightly encrypted off-host copy of a reduced Overflow database set.
#
# Runs after the 01:30 UTC full backup (overflow-backup.timer fires this job's
# timer at 02:10 UTC). The on-host full backup (scripts/db-backup.sh) is
# unchanged; this job adds a second, smaller copy that leaves the host:
#
# 1. pg_dump --format=plain of every table's schema, with data excluded for
#    exactly 7 bulky or sensitive tables, compressed with xz -9e and encrypted
#    with age to a public key. Only the public key is on the host.
# 2. A size guard: an encrypted file at or over OVERFLOW_BACKUP_MAX_BYTES is
#    never posted and never split; the run fails so the unit's OnFailure
#    alerts, and the local encrypted file stays as a good local copy.
# 3. Posting as the osc Discord identity to a dedicated backups channel
#    through the mailbox CLI, with a connector the job brings up for itself
#    and stops afterwards when none is running.
# 4. Deleting the job's own posted messages older than 14 days from that
#    channel, matching the privacy notice's backup-lifetime promise
#    (src/app/account-data/page.tsx).
#
# Every failure exits nonzero, which the unit's OnFailure= turns into mail.
#
# All configuration is environment (the unit reads /etc/overflow/backup.env):
#
# DATABASE_URL                      required; without it the script refuses to
#                                   guess which database to dump.
# OVERFLOW_BACKUP_AGE_RECIPIENT     required age recipient public key. An
#                                   unset or empty value is refused before
#                                   anything runs: nothing is ever posted
#                                   unencrypted.
# OVERFLOW_BACKUP_DISCORD_CHANNEL   required numeric id of the dedicated
#                                   backups channel; never a chat channel.
# OVERFLOW_BACKUP_MAX_BYTES         posting limit, default 9961472 (9.5 MiB).
# OVERFLOW_PG_DUMP                  pg_dump override (same convention as
#                                   db-backup.sh; the container drill uses it).
# OVERFLOW_OFFHOST_MB               the mailbox CLI, default
#                                   /root/.agent-bundle/scripts/discord_mb.py.
# OVERFLOW_OFFHOST_CONNECTOR_WAIT_SECONDS
#                                   how long the job waits for a connector it
#                                   started to answer a liveness probe, in
#                                   probes (1-second sleeps between them),
#                                   default 30. The behavioral suite sets it
#                                   small, as the alert unit's suite does with
#                                   its wait budget.
# OVERFLOW_BACKUP_DIR               output directory, default
#                                   /var/backups/overflow.
#
# The pipeline is staged through scratch files rather than piped, on purpose:
# under /bin/sh a pipeline's status is its last stage, so a pg_dump that died
# mid-stream would hand xz a truncated stream and age a clean EOF, exit 0, and
# the encrypted output of an empty dump is still nonempty - the empty check
# would pass on the one shape it exists to catch. Staged, pg_dump's own status
# is what set -e sees. The plaintext intermediates live in the root-only 0700
# output directory under umask 077 and are removed before the encrypted file
# is called a backup.
#
# A run killed before its file is installed leaves its partial behind. Every
# stage's scratch file is .overflow-reduced-<pid>...incomplete, stemmed with
# the pid rather than the stamp for the same reason db-backup.sh stems its
# partial: two runs landing in one UTC second would otherwise share one
# partial, and the second run's redirect would truncate the bytes the first
# is about to install. Every run begins by sweeping leftover partials older
# than 24 hours (-mtime +0) out of the output directory, ANY shape matching
# .overflow-reduced-*.incomplete — a SIGKILL or a power cut lands wherever it
# lands, and the plaintext intermediates must not outlive the run. Real
# backups matching overflow-reduced-*.sql.xz.age are never touched by the
# sweep. Retention prunes reduced backups older than 14 days (-mtime +13)
# after a successful guard, and only files matching that name shape are ours
# to delete.
set -eu

# The dump carries the database's schema and the backup's own messages name
# the job, so their modes are the script's business, not the caller's.
umask 077

program="db-offhost-backup.sh"

fail() {
    printf '%s: %s\n' "$program" "$1" >&2
    exit 1
}

if [ "$#" -gt 0 ]; then
    fail "unknown argument: $1"
fi

if [ -z "${DATABASE_URL:-}" ]; then
    fail "DATABASE_URL is not set; refusing to guess which database to dump"
fi

if [ -z "${OVERFLOW_BACKUP_AGE_RECIPIENT:-}" ]; then
    fail "OVERFLOW_BACKUP_AGE_RECIPIENT is not set; refusing to post an unencrypted backup"
fi

if [ -z "${OVERFLOW_BACKUP_DISCORD_CHANNEL:-}" ]; then
    fail "OVERFLOW_BACKUP_DISCORD_CHANNEL is not set; refusing to guess which channel to post to"
fi

case "$OVERFLOW_BACKUP_DISCORD_CHANNEL" in
    "" | *[!0-9]*)
        fail "OVERFLOW_BACKUP_DISCORD_CHANNEL must be a numeric channel id, got: $OVERFLOW_BACKUP_DISCORD_CHANNEL"
        ;;
esac

max_bytes=${OVERFLOW_BACKUP_MAX_BYTES:-9961472}
case "$max_bytes" in
    "" | *[!0-9]*)
        fail "OVERFLOW_BACKUP_MAX_BYTES must be a number of bytes, got: $max_bytes"
        ;;
esac

mb=${OVERFLOW_OFFHOST_MB:-/root/.agent-bundle/scripts/discord_mb.py}
if [ ! -x "$mb" ]; then
    fail "the mailbox CLI is missing or not executable: $mb"
fi

connector_probes=${OVERFLOW_OFFHOST_CONNECTOR_WAIT_SECONDS:-30}
case "$connector_probes" in
    "" | *[!0-9]*)
        fail "OVERFLOW_OFFHOST_CONNECTOR_WAIT_SECONDS must be a number of probes, got: $connector_probes"
        ;;
esac

output_dir=${OVERFLOW_BACKUP_DIR:-/var/backups/overflow}
if [ ! -d "$output_dir" ]; then
    mkdir -p "$output_dir"
    chmod 0700 "$output_dir"
fi

# A crash killed before the install leaves its partial behind. Reclaim
# leftovers older than a day (-mtime +0), print then delete like the retention
# prune below. The name is anchored to the leading dot and the .incomplete
# suffix, and matches EVERY stage's scratch shape, so a real backup can never
# match.
leftovers=$(find "$output_dir" -maxdepth 1 -type f -name '.overflow-reduced-*.incomplete' -mtime +0)
if [ -n "$leftovers" ]; then
    printf '%s\n' "$leftovers"
    find "$output_dir" -maxdepth 1 -type f -name '.overflow-reduced-*.incomplete' -mtime +0 -delete
fi

pg_dump_cmd=${OVERFLOW_PG_DUMP:-pg_dump}

stamp=$(date -u +%Y%m%dT%H%M%SZ)
# The scratch names carry this run's pid: two runs sharing one second would
# otherwise share one partial, and the second run's redirect would truncate
# the bytes the first is about to install. The pid keeps each run's partial
# its own and inside what the sweep matches.
partial="$output_dir/.overflow-reduced-$$.sql.xz.age.incomplete"
plain="$output_dir/.overflow-reduced-$$.sql.incomplete"
deflated="$output_dir/.overflow-reduced-$$.sql.xz.incomplete"
connector_pid=
started_connector=0

cleanup() {
    rm -f "$partial" "$plain" "$deflated"
    if [ -n "$connector_pid" ]; then
        kill "$connector_pid" 2>/dev/null || :
    fi
}
trap cleanup EXIT HUP INT TERM

# The reduced set: every table's schema, with data excluded for exactly these
# 7 tables. One pg_dump invocation, repeated --exclude-table-data flags, in
# the contract's order.
$pg_dump_cmd --format=plain \
    --exclude-table-data=repository_reconciliation_evidence_facts \
    --exclude-table-data=repository_reconciliation_evidence \
    --exclude-table-data=webhook_deliveries \
    --exclude-table-data=repository_policy_violations \
    --exclude-table-data=repository_reconciliation_dirty_subjects \
    --exclude-table-data=repository_reconciliation_jobs \
    --exclude-table-data=repository_reconciliation_usage \
    "$DATABASE_URL" > "$plain"

if [ ! -s "$plain" ]; then
    fail "the reduced dump is empty; refusing to continue ($pg_dump_cmd wrote no SQL)"
fi

# Compress, then encrypt. xz -9e for size, age -r for a public key that is
# the only key material on the host.
xz -9e < "$plain" > "$deflated"
age -r "$OVERFLOW_BACKUP_AGE_RECIPIENT" < "$deflated" > "$partial"
rm -f "$plain" "$deflated"

if [ ! -s "$partial" ]; then
    fail "the encrypted backup is empty; refusing to continue"
fi

# Install under the first free name in the series, atomically, with the same
# link(2) shape db-backup.sh uses: ln either creates the name or fails EEXIST,
# so two runs landing in one second keep both files. Both operands share the
# directory, which rules out EXDEV. A directory operand is skipped (ln would
# link INTO it and report success); a name that exists or is a symlink is
# taken; an ln failure on a FREE name is a real failure (read-only directory,
# no space) and aborts loudly. The bound keeps a directory full of taken names
# from searching forever.
attempt=0
while :; do
    if [ "$attempt" -eq 0 ]; then
        candidate="$output_dir/overflow-reduced-$stamp.sql.xz.age"
    else
        candidate="$output_dir/overflow-reduced-$stamp-$attempt.sql.xz.age"
    fi

    if [ -d "$candidate" ]; then
        :
    elif ln_error=$(ln "$partial" "$candidate" 2>&1); then
        break
    elif [ -e "$candidate" ] || [ -L "$candidate" ]; then
        :
    else
        fail "could not install the backup as $candidate: $ln_error"
    fi

    attempt=$((attempt + 1))
    if [ "$attempt" -ge 100 ]; then
        fail "no free backup name after 100 tries; the last was $candidate"
    fi
done

rm -f "$partial"
encrypted=$candidate

# The size guard, before anything is posted. At or over the limit the run
# FAILS (nonzero, so OnFailure alerts through overflow-alert@) and the local
# encrypted file stays: it is a good local copy, and the file is never split.
size=$(wc -c < "$encrypted")
if [ "$size" -ge "$max_bytes" ]; then
    fail "the encrypted backup is $size bytes, at or over the $max_bytes-byte posting limit; keeping the local copy at $encrypted and posting nothing (never split; delete it once the limit is raised)"
fi

# Prune only after the new backup is safely in place, and only files matching
# the reduced-backup name shape: nothing else in the directory is ours to
# delete. -mtime +13 is "older than 14 days" the same way db-backup.sh's
# retention reads.
old=$(find "$output_dir" -maxdepth 1 -type f -name 'overflow-reduced-*.sql.xz.age' -mtime +13)
if [ -n "$old" ]; then
    printf '%s\n' "$old"
    find "$output_dir" -maxdepth 1 -type f -name 'overflow-reduced-*.sql.xz.age' -mtime +13 -delete
fi

# Discord, as the osc identity, through the mailbox CLI. Only the dedicated
# backups channel; NEVER a chat channel.
identity=osc

# Liveness: reuse a running connector; otherwise start one for this job and
# stop it when the work is done. The probe is the cheapest authenticated
# round-trip the CLI offers.
if "$mb" list-agents "$identity" --timeout 10 >/dev/null 2>&1; then
    :
else
    # The connector's stdout stays suppressed - it carries event-stream
    # lines, not diagnostics - but its stderr reaches this script's stderr,
    # and the unit's journal with it: a bring-up death must name its cause
    # ("cannot establish connector lock root ...", the first manual run) in
    # the journal rather than leave it with the final failure line alone.
    # That stderr carries identity names and connection ids only; the osc
    # token travels to the CLI through the environment and never through
    # stderr, so the redirect carries no secret.
    "$mb" connector "$identity" --claude-pid "$$" >/dev/null &
    connector_pid=$!
    started_connector=1
    live=0
    probes_left=$connector_probes
    while [ "$probes_left" -gt 0 ]; do
        if "$mb" list-agents "$identity" --timeout 2 >/dev/null 2>&1; then
            live=1
            break
        fi
        probes_left=$((probes_left - 1))
        sleep 1
    done
    if [ "$live" -eq 0 ]; then
        fail "the $identity connector did not come up within $connector_probes probes; posted nothing"
    fi
fi

# Post: minimal subject/body - filename, byte size, UTC date. Never the age
# private key (none is on the host), never unencrypted content, never the
# recipient key value. --wait is what surfaces a failed post as a CLI error,
# which the nonzero exit turns into an alert.
filename=${encrypted##*/}
body="$filename $size bytes $(date -u +%Y-%m-%d)"
if ! send_output=$("$mb" send "$identity" nobody "$filename" "$body" \
        --attach "$encrypted" --channel "$OVERFLOW_BACKUP_DISCORD_CHANNEL" --wait); then
    fail "posting the backup to channel $OVERFLOW_BACKUP_DISCORD_CHANNEL failed"
fi
printf '%s\n' "$send_output"

# Delete this job's own backup messages older than 14 days in that channel,
# matching the privacy notice's backup-lifetime promise. One generous page;
# a message older than the window that the first page misses is swept on a
# later run. Only messages authored by osc and older than the cutoff go, and
# an unparseable stamp is kept (deletion is destructive; missing the window
# one night is safe and self-healing).
cutoff=$(( $(date -u +%s) - 14 * 24 * 60 * 60 ))
if ! messages=$("$mb" conversation "$identity" 100 \
        --channel "$OVERFLOW_BACKUP_DISCORD_CHANNEL" --json); then
    fail "reading the backups channel for the 14-day sweep failed"
fi

stale_ids=$(printf '%s' "$messages" | python3 -c '
import json
import sys
from datetime import datetime

cutoff = float(sys.argv[1])
try:
    messages = json.load(sys.stdin)
except ValueError:
    sys.exit(3)
for message in messages:
    if message.get("from") != "osc":
        continue
    created = (message.get("created") or "").replace("Z", "+00:00")
    try:
        epoch = datetime.fromisoformat(created).timestamp()
        msg_id = str(message.get("msg_id") or "")
    except ValueError:
        continue
    if msg_id and epoch < cutoff:
        print(msg_id)
' "$cutoff") || fail "the 14-day sweep could not read the channel listing"

for stale_id in $stale_ids; do
    if ! "$mb" message "$identity" delete "$stale_id" \
            --channel "$OVERFLOW_BACKUP_DISCORD_CHANNEL" >/dev/null; then
        fail "deleting the old backup message $stale_id failed"
    fi
done

# Stop a connector this run started. One the operator was already running is
# left alone.
if [ "$started_connector" -eq 1 ]; then
    kill "$connector_pid" 2>/dev/null || :
    connector_pid=
fi

printf '%s\n' "$encrypted"
