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
# The daemon spools the submission itself, so this script needs no writable
# path anywhere on the box.

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
    echo "overflow-alert.sh: $recipient_file carries no @: \"$recipient\"" >&2
    exit 2
    ;;
esac

fqdn=$(hostname -f)

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
  --upload-file -
