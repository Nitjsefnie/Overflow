#!/bin/sh
# Overflow failure alert.
#
# Mails the tail of a failed unit's journal to the address in
# /etc/overflow/alert-recipient (host configuration, read at run time, never
# committed to this repository). Started by deploy/overflow-alert@.service,
# which the watched units trigger through OnFailure=overflow-alert@%n.service.
#
# Mail is submitted by SMTP to the local exim daemon with curl rather than by
# invoking exim in-process: exim's startup privilege dance needs setgroups(),
# which the alert unit's empty capability bounding set deliberately removes.
# The daemon spools the submission itself; the only path this script writes is
# its throttle state under /run/overflow-alert, which the alert unit grants
# through RuntimeDirectory=.
#
# A crash loop cycling slower than the service manager's start limit escapes
# it — StartLimitIntervalSec=300 with Burst=5 trips only on six starts inside
# the window — and would mail one alert per cycle forever. Each failed unit is
# therefore throttled to one message per 1800 seconds: the time of the last
# send is recorded per unit in $state_dir/$unit, and a repeat inside the
# window suppresses the mail, logging one line to the alert unit's journal
# instead. The record is written only after a successful send, so a submission
# that failed leaves no state and the next failure mails again immediately.
# Anything the throttle path cannot read or write fails open and mails.

set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: overflow-alert.sh <failed-unit>" >&2
  exit 2
fi

unit=$1

# The path is overridable through OVERFLOW_ALERT_RECIPIENT_FILE only so
# tests/scripts/overflow-alert.test.ts can drive this script against a scratch
# file; the alert unit sets no such variable, so a deployed run always reads
# the default path below.
recipient_file=${OVERFLOW_ALERT_RECIPIENT_FILE:-/etc/overflow/alert-recipient}

if [ ! -r "$recipient_file" ]; then
  echo "overflow-alert.sh: $recipient_file is missing or unreadable" >&2
  exit 2
fi

recipient=$(cat "$recipient_file")
if [ -z "$recipient" ]; then
  echo "overflow-alert.sh: $recipient_file is empty" >&2
  exit 2
fi

# Exactly one address on one line. A newline or carriage return would break
# the To: header out of its line and hand the daemon injected recipients, so
# a multi-line value is refused, naming the file: the recipient file is
# root-only host configuration, which makes a second line a misconfiguration
# to report, not a message to send.
cr=$(printf '\r')
nl='
'
case "$recipient" in
  *"$nl"*|*"$cr"*)
    echo "overflow-alert.sh: $recipient_file carries more than one line" >&2
    exit 2
    ;;
  *@*) ;;
  *)
    # The value is NOT echoed. The recipient file is host configuration, and
    # the journal is not a safe place for it: the journal is what gets pasted
    # into an issue, a chat and a status page, and a misconfiguration is
    # exactly the moment somebody does all three. The file is named instead.
    echo "overflow-alert.sh: $recipient_file carries no @, so it is not a single address" >&2
    exit 2
    ;;
esac

# The throttle state lives under /run/overflow-alert, the directory the alert
# unit grants through RuntimeDirectory=. The path is overridable through
# OVERFLOW_ALERT_STATE_DIR only so tests/scripts/overflow-alert.test.ts can
# drive this script against a scratch directory; the alert unit sets no such
# variable, so a deployed run always uses the default path below.
state_dir=${OVERFLOW_ALERT_STATE_DIR:-/run/overflow-alert}
throttle_window=1800
state_file=$state_dir/$unit

# The unit name is the systemd unit instance (%i): the raw string between the
# "@" and the type suffix of the unit name, and a systemd unit name cannot
# carry a slash, so state_file cannot escape the state directory.

# One reading of the clock feeds both the suppression decision and the
# recorded value, so a run that spans a second boundary still records the
# moment the check was made against.
now=$(date +%s)

# This check is pinned to its spot in the flow: after recipient validation
# (so a misconfigured recipient still exits 2 loudly) and before the hostname
# lookup and journal read below, a suppressed run exits without touching the
# journal or the mail daemon.

# A readable state file carries the epoch time of the unit's last send. Empty,
# non-numeric or unreadable state means no prior alert: fail open and mail.
# So does state that passes the readability test but fails at read time (a
# directory named after the unit, or an unlink between test and read): the
# read failure is caught, and reads as no prior alert, rather than aborting
# under set -e. Leading zeros are stripped before the arithmetic, because a
# POSIX shell reads a leading-zero constant as octal and would abort on a
# digit 8 or 9; and a value too long to be an epoch time is corrupt like any
# other, not a reason to crash under set -e.
if [ -r "$state_file" ]; then
  last=$(sed 's/^[[:space:]]*//;s/[[:space:]]*$//' "$state_file") || last=''
  case $last in
    ''|*[!0-9]*|???????????*)
      # Empty, non-numeric, or absurdly long: no prior alert.
      ;;
    *)
      while :; do
        case $last in
          0[0-9]*) last=${last#0} ;;
          *) break ;;
        esac
      done
      age=$((now - last))
      if [ "$age" -lt "$throttle_window" ]; then
        echo "overflow-alert.sh: last alert for $unit was $age seconds ago, inside the $throttle_window-second throttle window; suppressing" >&2
        exit 0
      fi
      ;;
  esac
fi

fqdn=$(hostname -f)

send_status=0
{
  printf 'From: overflow-alert@%s\nTo: %s\nSubject: [overflow] %s failed on %s\n\n' \
    "$fqdn" "$recipient" "$unit" "$fqdn"
  printf 'The systemd unit %s failed on host %s at %s.\n\n' \
    "$unit" "$fqdn" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
  echo "Last journal entries for the failed unit (current boot):"
  journalctl -b -u "$unit" --no-pager -n 200 || echo "(reading the journal failed)"
} | curl -sS --max-time 30 --connect-timeout 5 \
  --url smtp://127.0.0.1:25 \
  --mail-from "overflow-alert@$fqdn" \
  --mail-rcpt "$recipient" \
  --upload-file - || send_status=$?

# Only a successful send is recorded; either failure below warns and leaves
# the exit status alone.
if [ "$send_status" -eq 0 ]; then
  if ! mkdir -p "$state_dir"; then
    echo "overflow-alert.sh: could not create state directory $state_dir; not recording the send" >&2
  elif ! printf '%s\n' "$now" > "$state_file"; then
    echo "overflow-alert.sh: could not write state file $state_file; not recording the send" >&2
  fi
fi

exit "$send_status"
