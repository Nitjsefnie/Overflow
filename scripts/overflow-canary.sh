#!/bin/sh
# Overflow failure-alert canary.
#
# Every failure alert this host can raise leaves by one route: the alert script
# mails it to the local exim daemon, which relays to a smarthost, which
# delivers to one mailbox. Nothing on that route reports its own failure, so a
# route that stopped delivering is indistinguishable from a host that has
# nothing to report. This script exercises the same route on a schedule and
# reports its own failure out of band, over a channel that does not share the
# route it is checking.
#
# What it checks is deliberately not that the local daemon accepted a message.
# That proves only that a socket answered, which is true of a relay that is
# holding every message in a defer queue. So the submission is made with
# curl -v, the exim message id is read off the final "250 OK id=" response
# line, and the run then waits for "<id> Completed" in the exim mainlog. A
# relay that defers, rejects or drops the message logs defer, rejected or
# Failed against that id instead, and the absence of Completed is the verdict.
# This is the only observation that can see the smarthost leg at all: a canary
# addressed to a local mailbox would never leave the host, and would report
# healthy for precisely the failure this exists to catch.
#
# One report per dead streak. The marker under the runtime directory records
# that the current outage has been reported, so a path dead for a week posts
# once rather than seven times. A run that completes clears the marker, so the
# next failure reports again. The marker is written only once a report has
# actually been delivered: recording an outage nobody was told about would
# silence the next run for good, which is the failure being guarded against
# rather than a repetition of it.
#
# Host configuration, read at run time and never committed: the address the
# canary mails is in /etc/overflow/canary-recipient and the out-of-band
# channel in /etc/overflow/canary-discord-webhook. Each path below is
# overridable through its OVERFLOW_CANARY_* variable only so
# tests/scripts/overflow-canary.test.ts can drive this script against scratch
# files; the canary unit sets no such variable, so a deployed run always reads
# the defaults.

set -eu

recipient_file=${OVERFLOW_CANARY_RECIPIENT_FILE:-/etc/overflow/canary-recipient}
webhook_file=${OVERFLOW_CANARY_WEBHOOK_FILE:-/etc/overflow/canary-discord-webhook}
state_dir=${OVERFLOW_CANARY_STATE_DIR:-/run/overflow-canary}
smtp_url=${OVERFLOW_CANARY_SMTP_URL:-smtp://127.0.0.1:25}
exim_log=${OVERFLOW_CANARY_EXIM_LOG:-/var/log/exim4/mainlog}

# The wait budget reaches an arithmetic expansion, where a non-numeric value
# aborts the whole run under set -e with nothing in the journal. Only the
# tests set it, but a refusal costs three lines and says which value is
# wrong, where the arithmetic says nothing at all.
exim_wait=${OVERFLOW_CANARY_EXIM_WAIT_SECONDS:-60}
case $exim_wait in
  ''|*[!0-9]*)
    echo "overflow-canary.sh: OVERFLOW_CANARY_EXIM_WAIT_SECONDS is \"$exim_wait\", which is not a whole number of seconds" >&2
    exit 2
    ;;
esac

marker=$state_dir/dead

# The recipient file is validated exactly as the alert script validates its
# own, and for the same reason: a newline or carriage return in the value
# breaks the To: header out of its line and hands the daemon injected
# recipients, so a single line carrying an @ is the whole contract. Each
# failure below exits nonzero naming the file and never sends.
if [ ! -r "$recipient_file" ]; then
  echo "overflow-canary.sh: $recipient_file is missing or unreadable" >&2
  exit 2
fi

recipient=$(cat "$recipient_file")
if [ -z "$recipient" ]; then
  echo "overflow-canary.sh: $recipient_file is empty" >&2
  exit 2
fi

cr=$(printf '\r')
nl='
'
case "$recipient" in
  *"$nl"*|*"$cr"*)
    echo "overflow-canary.sh: $recipient_file carries more than one line" >&2
    exit 2
    ;;
  *@*) ;;
  *)
    # The value is NOT echoed. The recipient file is host configuration, and
    # the journal is not a safe place for it: the journal is what gets pasted
    # into an issue, a chat and a status page, and a misconfiguration is
    # exactly the moment somebody does all three. The file is named instead.
    echo "overflow-canary.sh: $recipient_file carries no @, so it is not a single address" >&2
    exit 2
    ;;
esac

# The out-of-band channel is checked before anything is sent, and a failure
# here is fatal rather than a warning. A canary that has lost its report
# channel has nothing left to say with: running the rest would either report
# health through a channel that cannot carry it, or fail the unit every day
# over a missing file while the path it is meant to watch went unexamined.
if [ ! -r "$webhook_file" ]; then
  echo "overflow-canary.sh: $webhook_file is missing or unreadable" >&2
  exit 2
fi

webhook_url=$(cat "$webhook_file")
if [ -z "$webhook_url" ]; then
  echo "overflow-canary.sh: $webhook_file is empty" >&2
  exit 2
fi

case "$webhook_url" in
  *"$nl"*|*"$cr"*)
    echo "overflow-canary.sh: $webhook_file carries more than one line" >&2
    exit 2
    ;;
esac

# Both of these are the only inputs the report and the message carry that the
# script cannot supply for itself, and under set -e a failing command
# substitution kills the run at the assignment with nothing in the journal.
# That would give "the canary unit failed" a third meaning - neither a dead
# path nor a misconfigured host file - tellable only by the absence of a line
# that should be there. So each refuses loudly instead.
if ! fqdn=$(hostname -f); then
  echo "overflow-canary.sh: could not determine the host's FQDN; refusing to run a check that cannot name its host" >&2
  exit 2
fi

if ! sent_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ'); then
  echo "overflow-canary.sh: could not read the clock; refusing to stamp a report with an unknown time" >&2
  exit 2
fi

# The subject carries its own marker, [overflow-canary], rather than sharing
# the alerts' [overflow] prefix. A mailbox rule that pages on "[overflow]" -
# a common shape on exactly this kind of host - would otherwise page once a
# day on a message whose own body says no action is needed, and a filter that
# cries wolf daily is a filter people switch off.
#
# curl -v writes its conversation with the daemon to stderr; the message
# itself is piped in on stdin. The redirections take stderr into the
# substitution and discard stdout, so what is left to read below is the
# trace and nothing else.
#
# --no-progress-meter is not cosmetic. -v re-enables the transfer meter, and
# the meter terminates its line with a carriage return rather than a newline,
# so it lands on the same line as the final response: the trace would read
# "250 OK id=1xBuT1-000000003QH-0Qqz" followed by a counter and no break, and
# the id taken from that line would carry the counter with it. The extraction
# below stops at whitespace either way, so a curl without the flag still
# yields the right id rather than one that matches no log line.
submit_status=0
trace=$(
  {
    printf 'From: overflow-canary@%s\nTo: %s\nSubject: [overflow-canary] alert-path canary on %s\n\n' \
      "$fqdn" "$recipient" "$fqdn"
    printf 'Failure-alert path canary for host %s at %s.\n\n' "$fqdn" "$sent_at"
    printf 'This message went out by the same route a failure alert takes. Receiving it means\n'
    printf 'the host can still page someone; nothing is wrong and no action is needed.\n'
  } | curl -v --no-progress-meter --max-time 30 --connect-timeout 5 \
    --url "$smtp_url" \
    --mail-from "overflow-canary@$fqdn" \
    --mail-rcpt "$recipient" \
    --upload-file - 2>&1 1>/dev/null
) || submit_status=$?

# The id is the last 250 that carries one: the reply to the end of DATA.
# Every other 250 in the conversation answers a command the daemon has already
# accepted, so the last is also the only one that means the message itself is
# spooled. A submission that exited zero without producing one is a failure
# rather than a pass, because there is then no id whose Completed line could
# ever be found and a run that read it as health would stay wrong forever.
message_id=''
if [ "$submit_status" -eq 0 ]; then
  message_id=$(printf '%s\n' "$trace" | sed -n 's/^< 250 OK id=\([^[:space:]]*\).*$/\1/p' | tail -n 1)
fi

reason=''
if [ "$submit_status" -ne 0 ]; then
  reason="the canary could not be submitted to $smtp_url (curl exited $submit_status)"
elif [ -z "$message_id" ]; then
  reason="the local daemon took the submission but answered no 250 OK id= line, so the relay verdict cannot be followed"
else
  # The relay may not have finished with the message when curl returns, so the
  # log is polled to the wait budget. The log is matched on this run's own id
  # and never on the word alone: a log already holding someone else's Completed
  # line would otherwise read as a verdict about a message that never left.
  deadline=$(( $(date +%s) + exim_wait ))
  seen_verdict=''
  while :; do
    if [ -r "$exim_log" ]; then
      # ORDER MATTERS, and a test pins it. Completed is read first and it is
      # the only success. A message that is greylisted, or answered with a
      # temporary 4xx, is deferred once and then COMPLETED on its retry, and
      # both lines sit in the log under one id at the same time. If the check
      # below were conclusive on sight, or were read first, that ordinary
      # retry becomes a false dead verdict and a spurious page on the one
      # signal the maintainer is meant to trust.
      #
      # So the verdict is remembered, not obeyed: the poll keeps going for the
      # rest of the budget and Completed at any point in it wins. A verdict
      # decides the report only when the budget closes with no Completed
      # behind it.
      if grep -q -F -e "$message_id Completed" "$exim_log"; then
        reason=''
        break
      fi
      # A named verdict is still worth keeping, so the report says what the
      # relay said rather than our own timeout restated. awk's index() is a
      # literal search, which is why it is used here and not a grep pattern:
      # an exim id carries no metacharacters by the book, and this script has
      # a test that puts a backslash and a quote in one to prove the JSON
      # report survives. Matching a fixed token after a literal id keeps both
      # properties.
      #
      # `defer` is deliberately the ONLY provisional token. It is what exim
      # writes for a temporary failure - a 4xx, a greylist - and it goes on
      # to RETRY the message, so treating it as final would page the
      # maintainer every time a relay greylists. The rest are the outcomes
      # that end a message.
      #
      # The search therefore does NOT settle on the first verdict it meets. A
      # log reading `** defer` and later `bounce` under one id is a message
      # that deferred once and then failed for good, and a search that stops
      # at the defer reports the wrong cause and then re-reads the same defer
      # for the rest of the budget. A terminal token anywhere in the log
      # wins; `defer` is the fallback for when there is none. `defer` is also
      # tested FIRST on each line, because exim writes deferrals whose own
      # reason text contains a terminal word - `** defer rejected: ...` - and
      # that line is a temporary failure, not a rejection.
      verdict=$(awk -v id="$message_id" '
        BEGIN { first = ""; found = 0 }
        {
          at = index($0, id)
          if (at == 0) next
          rest = substr($0, at + length(id))
          if (rest ~ /defer/) { if (first == "") first = "defer"; next }
          if (match(rest, /(rejected|bounce|blackhole|discarded|Failed)/)) {
            found = 1
            print substr(rest, RSTART, RLENGTH)
            exit
          }
        }
        END { if (found == 0 && first != "") print first }
      ' "$exim_log") || verdict=''
      if [ -n "$verdict" ] && [ "$verdict" != defer ]; then
        reason="the relay recorded $verdict for $message_id and never Completed it, so the smarthost did not take the message"
        break
      fi
      if [ -n "$verdict" ]; then
        seen_verdict=$verdict
      fi
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      if [ -n "$seen_verdict" ]; then
        reason="the relay recorded $seen_verdict for $message_id and never Completed it within ${exim_wait}s, so the smarthost did not take the message"
      else
        reason="the local daemon accepted the message as $message_id but $exim_log records no Completed line for it within ${exim_wait}s"
      fi
      break
    fi
    sleep 1
  done
fi

if [ -z "$reason" ]; then
  echo "overflow-canary.sh: the relay completed $message_id; the failure-alert path delivers" >&2
  if [ -e "$marker" ]; then
    if ! rm -f "$marker"; then
      echo "overflow-canary.sh: the path is healthy but the dead-streak marker $marker could not be removed; the next failure will not report" >&2
    fi
  fi
  exit 0
fi

if [ -e "$marker" ]; then
  echo "overflow-canary.sh: $reason; the dead-streak marker $marker already records a reported outage, so no second report is posted" >&2
  exit 1
fi

# The report is a Discord webhook payload. Backslash and double quote are
# escaped in every interpolated value, because a host name or an exim id
# carrying either would otherwise produce a payload Discord rejects - and the
# report that is lost is the one the operator is relying on.
#
# --fail is load-bearing, not tidiness. Without it curl exits 0 for any HTTP
# response, so a webhook that answers 404 Unknown Webhook or 401 on a revoked
# token is recorded as a delivered report, the dead-streak marker is written
# for an outage nobody was told about, and every later run of the streak stays
# silent. That is one report lost followed by permanent quiet, which is the
# exact failure this script exists to prevent. With it, a refusal is a
# nonzero exit and takes the branch below that leaves the marker unwritten.
summary="[overflow] the failure-alert path on $fqdn is not delivering: $reason"
payload=$(printf '{"content":"%s"}' "$(printf '%s' "$summary" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')")

post_status=0
printf '%s' "$payload" | curl -sS --fail --max-time 15 --connect-timeout 5 \
  -H 'Content-Type: application/json' \
  --data-binary @- \
  "$webhook_url" >/dev/null || post_status=$?

if [ "$post_status" -ne 0 ]; then
  echo "overflow-canary.sh: $reason; the out-of-band report could not be delivered (curl exited $post_status), so the outage is left unrecorded and the next run reports again" >&2
  exit 1
fi

echo "overflow-canary.sh: $reason; reported out of band" >&2
if ! mkdir -p "$state_dir"; then
  echo "overflow-canary.sh: could not create state directory $state_dir; not recording the outage" >&2
elif ! printf '%s\n' "$sent_at" > "$marker"; then
  echo "overflow-canary.sh: could not write the dead-streak marker $marker; the next run will report again" >&2
fi

exit 1
