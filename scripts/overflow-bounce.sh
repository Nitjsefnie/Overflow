#!/bin/sh
# Overflow bounce watcher.
#
# The failure-alert route mails alerts to the local exim daemon, which relays
# them to a smarthost, which delivers to one mailbox. When a message on that
# route cannot be delivered, the relay's own mailer daemon (exim on the
# smarthost, Gmail upstream of it) mails a delivery-failure notification back
# to the envelope sender - overflow-canary@<fqdn> or overflow-alert@<fqdn>.
# Until those addresses became local aliases, exim refused such bounces at
# RCPT and every delivery failure on the alert route vanished without a
# trace: the alert route has no way to report its own mail being lost. With
# the addresses aliased to root (the acceptance leg, host configuration),
# those bounces now file into root's mail spool, and this script is the
# reporting leg: a root-run oneshot that tails the spool from a persisted
# byte offset and forwards each new bounce to the out-of-band Discord
# webhook the canary script already uses.
#
# Why an offset rather than a "seen" list: the spool is append-only and cron
# mail keeps arriving, so a byte offset is the only bookkeeping that stays
# correct forever without pruning. The offset file starts at the spool's
# current size (the existing backlog is cron mail; re-reporting 5.5 MB of it
# once would be noise, so the watcher reports only what arrives after it is
# installed) and advances only after every new message in the batch was
# examined and every report due was successfully posted. A run whose webhook
# post was refused therefore leaves the offset alone, and the next run
# re-reads the same bounce and reports again - the canary's own discipline
# that a report lost is a report owed, never a report recorded.
#
# When the offset points past the spool's end (the spool was rotated or
# truncated), the position is meaningless, so it resets to 0 and the whole
# spool is re-scanned. Mail that arrives during the re-scan has already been
# delivered once; re-reporting an old bounce after a rotation is accepted
# and documented in deploy/README.md.
#
# Two classes of new message are reported, and each exists to catch one of
# the two ways the alert route can fail while leaving no other trace:
#
# - Class A - remote delivery failed. The message READS as a delivery-failure
#   notification (both the exim and the Gmail wording are matched as literal
#   substrings) and it REFERENCES an overflow address (overflow-canary@ or
#   overflow-alert@). Each conjunct suppresses a different false alarm: a
#   cron job whose output mentions an overflow address is ordinary mail, not
#   a failure; and a DSN about any other address is the rest of the system's
#   mail working as intended. This is the bounce the smarthost sends back
#   when it could not deliver the alert.
# - Class B - the alert landed locally (issue 848's class). Exim resolves
#   the alert recipient to this host far more often than it fails remotely,
#   and a successful LOCAL write produces no bounce at all - so a Class-A-only
#   watcher stays silent through the most common real failure. The message
#   itself is the evidence: if the spool holds a message whose From header
#   local part is overflow-alert or overflow-canary, then an alert or canary
#   message was written to the local mailbox and nobody off-host received
#   it. The match is on the From header ONLY, never body text: the From
#   header is the message's own identity, while the body is arbitrary
#   content - a cron job's output can quote "[overflow]" or the addresses
#   verbatim, and a watcher that keyed on that would page on ordinary mail
#   forever. Class B additionally requires the message NOT to be a DSN, so a
#   bounce (Mailer-Daemon's, carrying the alert's text inside it) is
#   classified as A and never double-reported as B.
#
# Together with the canary's own verdict the watcher now distinguishes all
# three outcomes: off-host accepted (silence), local write (Class B), and
# refused/deferred/remote-dead (Class A).
#
# Any other new message advances the offset silently.
#
# Host configuration, read at run time and never committed: the spool path,
# the state directory and the webhook file below. Each is overridable
# through its OVERFLOW_BOUNCE_* variable only so
# tests/scripts/overflow-bounce.test.ts can drive this script against
# scratch files; the bounce unit sets no such variable, so a deployed run
# always reads the defaults.

set -eu

if [ "$#" -ne 0 ]; then
  echo "usage: overflow-bounce.sh" >&2
  exit 2
fi

spool=${OVERFLOW_BOUNCE_SPOOL:-/var/mail/mail}
state_dir=${OVERFLOW_BOUNCE_STATE_DIR:-/var/lib/overflow-bounce}
webhook_file=${OVERFLOW_BOUNCE_WEBHOOK_FILE:-/etc/overflow/canary-discord-webhook}
offset_file=$state_dir/offset

# The report has to name its host, and the override exists only for tests; a
# deployed run resolves the FQDN itself, and a resolution failure is fatal
# rather than a silent empty field in a report that is meant to say where
# the trouble is.
if [ -n "${OVERFLOW_BOUNCE_HOSTNAME:-}" ]; then
  host=$OVERFLOW_BOUNCE_HOSTNAME
elif ! host=$(hostname -f); then
  echo "overflow-bounce.sh: could not determine the host's FQDN; refusing to report without naming its host" >&2
  exit 2
fi

# The webhook file is validated before anything else, exactly as the canary
# script validates its own: readable, non-empty, one line. A newline or
# carriage return in the value would corrupt the curl invocation, and the
# URL is never echoed - the file is host configuration and the journal is
# what gets pasted into an issue, so only the file is named.
if [ ! -r "$webhook_file" ]; then
  echo "overflow-bounce.sh: $webhook_file is missing or unreadable" >&2
  exit 2
fi

webhook_url=$(cat "$webhook_file")
if [ -z "$webhook_url" ]; then
  echo "overflow-bounce.sh: $webhook_file is empty" >&2
  exit 2
fi

cr=$(printf '\r')
nl='
'
case "$webhook_url" in
  *"$nl"*|*"$cr"*)
    echo "overflow-bounce.sh: $webhook_file carries more than one line" >&2
    exit 2
    ;;
esac

# The spool must be readable before the offset is touched: a misconfigured
# path is a misconfiguration to exit 2 over, not a failure to misattribute
# to the mail system, and touching the offset first could make a broken run
# look like a completed one.
if [ ! -r "$spool" ]; then
  echo "overflow-bounce.sh: $spool is missing or unreadable" >&2
  exit 2
fi

# A readable offset file carries the byte position after the last batch this
# script handled. Empty, non-numeric, or absurdly long state means no usable
# prior position (fail open to first-run behavior, like the alert script's
# corrupt-throttle handling); so does state that passes the readability test
# but fails at read time. Leading zeros are stripped before the arithmetic,
# because a POSIX shell reads a leading-zero constant as octal and would
# abort on a digit 8 or 9.
offset=''
if [ -r "$offset_file" ]; then
  offset=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$offset_file") || offset=''
fi
case $offset in
  ''|*[!0-9]*|???????????*)
    # No usable state: behave like a first run below.
    offset=''
    ;;
  *)
    while :; do
      case $offset in
        0[0-9]*) offset=${offset#0} ;;
        *) break ;;
      esac
    done
    ;;
esac

spool_size=$(wc -c < "$spool" | tr -d ' ')

if [ -z "$offset" ]; then
  # First run (or corrupt state): start now. The backlog is cron mail that
  # predates the watcher, and it is never re-reported; the offset records
  # that decision so it survives reboots. Nothing is reported on this run.
  if ! mkdir -p "$state_dir"; then
    echo "overflow-bounce.sh: could not create state directory $state_dir; not recording the starting offset" >&2
    exit 0
  fi
  if ! printf '%s\n' "$spool_size" > "$offset_file"; then
    echo "overflow-bounce.sh: could not write $offset_file; not recording the starting offset" >&2
    exit 0
  fi
  exit 0
fi

if [ "$offset" -gt "$spool_size" ]; then
  # Rotation or truncation: the recorded position points past the spool's
  # end, so it cannot mean "nothing new". Reset and re-scan from the top.
  # The reset is held in memory only: if the spool is empty the two values
  # are equal again and the stale file is rewritten on the next real batch,
  # and holding it here keeps a single write site, below, so the offset
  # advances only after the batch is handled.
  offset=0
fi

if [ "$offset" -eq "$spool_size" ]; then
  # Nothing new since the last run.
  exit 0
fi

if ! tmp_dir=$(mktemp -d); then
  echo "overflow-bounce.sh: could not create a scratch directory; the spool is left unread and the offset unchanged" >&2
  exit 1
fi
trap 'rm -rf "$tmp_dir"' EXIT

# The tail is read incrementally: tail -c +N is 1-based, so +$((offset+1))
# starts exactly after the last handled byte. A failed read exits under
# set -e with the offset untouched.
segment=$tmp_dir/segment
reports=$tmp_dir/reports
tail -c +$((offset + 1)) "$spool" > "$segment"

# Split the segment into mbox messages and emit one line per reportable
# bounce: "<A|B><TAB><subject><TAB><failed-address>". The From_ separator
# line is what mbox writes between messages, and a body line can only start
# with "From " if the delivering agent failed to escape it - the same
# assumption every mbox reader makes. Class A's two conditions are
# whole-message scans, so header or body placement does not matter. Class B
# reads ONLY the ^From: header line: the envelope "From " separator (no
# colon) cannot match it, and body lines are never consulted, which is what
# keeps cron output quoting "[overflow]" inert. The failed-address line is
# the first line carrying an @ after exim's "The following address" marker;
# a Gmail-format DSN names its failed recipient differently, so it reports
# subject-only, which is accepted and documented. Tabs are stripped from the
# extracted fields so the tab stays an unambiguous delimiter.
awk '
  function trim(s) {
    gsub(/^[[:space:]]+/, "", s)
    gsub(/[[:space:]]+$/, "", s)
    gsub(/\t/, " ", s)
    return s
  }
  function emit() {
    if (count == 0) return
    if (dsn && over) printf "A\t%s\t%s\n", subject, addr
    else if (classb && !dsn) printf "B\t%s\t%s\n", subject, addr
  }
  function reset() {
    count = 0; dsn = 0; over = 0; classb = 0
    from = ""; subject = ""; addr = ""; failed = 0
  }
  BEGIN { reset() }
  /^From / { emit(); reset(); next }
  {
    count++
    if (!dsn && (index($0, "This message was created automatically by mail delivery software") || index($0, "This is an automatically generated Delivery Status Notification"))) dsn = 1
    if (!over && (index($0, "overflow-canary@") || index($0, "overflow-alert@"))) over = 1
    if (from == "" && $0 ~ /^From:/) {
      # The Class B identity test: the From header local part. Strip the
      # colon prefix, any leading whitespace and angle bracket, and take
      # everything before the @. Nothing else in the message can set
      # classb.
      from = trim(substr($0, 6))
      sub(/^</, "", from)
      sub(/@.*/, "", from)
      if (from == "overflow-alert" || from == "overflow-canary") classb = 1
    }
    if (subject == "" && $0 ~ /^Subject:/) subject = trim(substr($0, 9))
    if (failed && addr == "" && index($0, "@")) addr = trim($0)
    else if (!failed && index($0, "The following address")) failed = 1
  }
  END { emit() }
' "$segment" > "$reports"

tab=$(printf '\t')
while IFS="$tab" read -r rclass subject addr; do
  # The report text, per class. The Class B report names the failure it
  # actually saw - the alert landed in the local spool - rather than the
  # remote-failure wording, which would be false for a local write. The
  # failed-address clause is appended only to the Class A report, and only
  # when one was found, so a subject-only DSN still reports.
  if [ "$rclass" = B ]; then
    summary="[overflow] an overflow alert or canary message on $host landed in the local spool instead of delivering off-host: $subject"
  else
    summary="[overflow] a delivery-failure notification arrived for an overflow alert or canary message on $host: $subject"
    if [ -n "$addr" ]; then
      summary="$summary; $addr"
    fi
  fi

  # Backslash and double quote are escaped in the interpolated value,
  # because a subject carrying either would otherwise produce a payload
  # Discord rejects - and the report that is lost is the one the operator is
  # relying on. The subject and address are single lines by construction
  # (one line each was extracted), so no newline escaping is needed and the
  # payload stays on one line.
  payload=$(printf '{"content":"%s"}' "$(printf '%s' "$summary" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')")

  # --fail is load-bearing, not tidiness: without it curl exits 0 for any
  # HTTP response, so a webhook answering 404 on a revoked token would be
  # recorded as a delivered report and every later run of the batch stays
  # silent. With it, a refusal is a nonzero exit and takes the branch that
  # leaves the offset alone.
  post_status=0
  printf '%s' "$payload" | curl -sS --fail --max-time 15 --connect-timeout 5 \
    -H 'Content-Type: application/json' \
    --data-binary @- \
    "$webhook_url" >/dev/null || post_status=$?
  if [ "$post_status" -ne 0 ]; then
    echo "overflow-bounce.sh: the bounce report could not be delivered (curl exited $post_status); the offset is left unchanged so the next run reports again" >&2
    exit "$post_status"
  fi
done < "$reports"

# Every message in the batch was examined and every report due was posted:
# only now does the offset advance. A state directory or offset file that
# cannot be written is warned about and the run still exits 0 - the reports
# went out, and the cost of the lost advance is a duplicate report next run,
# which the rotation discipline already accepts; failing the unit instead
# would page over bookkeeping.
new_offset=$((offset + $(wc -c < "$segment" | tr -d ' ')))
if ! mkdir -p "$state_dir"; then
  echo "overflow-bounce.sh: could not create state directory $state_dir; not advancing the offset, so the next run reports the same bounces again" >&2
  exit 0
fi
if ! printf '%s\n' "$new_offset" > "$offset_file"; then
  echo "overflow-bounce.sh: could not write $offset_file; not advancing the offset, so the next run reports the same bounces again" >&2
  exit 0
fi
