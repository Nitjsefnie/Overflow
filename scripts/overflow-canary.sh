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
# The verdict is read out of a FILE, and the unit runs this script with an
# empty capability bounding set, so the read succeeds only as a member of the
# group that owns the log. That is checked before anything is submitted, and a
# log that cannot be read is never turned into a statement about the relay. The
# deployed canary had neither the membership nor the capability: it read a 0640
# Debian-exim:adm mainlog it could not open, spent the whole budget proving it,
# and reported a relay that had Completed the message one second after
# submission - a false page, sent to the one channel the maintainer trusts, on
# a host that was healthy.
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

# The canary's own fault has its own dedup state, and that separation is the
# whole design. $marker means exactly one thing - "a real outage of the
# failure-alert path has been reported" - and a run that never reached a
# verdict must never write it: doing so silences the next real outage, which
# is the failure this script exists to prevent. A broken canary is still an
# outage of the operator's visibility, so it is reported on its own channel
# line and its own file, and a persistently broken canary posts once rather
# than daily.
fault_marker=$state_dir/canary-fault

# One out-of-band post, shared by both reports below, so the JSON escaping and
# the --fail discipline cannot drift between them: a report lost because one of
# the two paths escaped its payload differently is a report the operator is
# relying on. Returns curl's status; the caller decides what an undelivered
# report means for its own state.
#
# --fail is load-bearing, not tidiness. Without it curl exits 0 for any HTTP
# response, so a webhook that answers 404 Unknown Webhook or 401 on a revoked
# token is recorded as a delivered report, its marker is written for an outage
# nobody was told about, and every later run of the streak stays silent. That is
# one report lost followed by permanent quiet, which is the exact failure this
# script exists to prevent. With it, a refusal is a nonzero exit and takes the
# branch that leaves the marker unwritten.
post_report() {
  report_summary=$1
  report_payload=$(printf '{"content":"%s"}' "$(printf '%s' "$report_summary" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')")

  printf '%s' "$report_payload" | curl -sS --fail --max-time 15 --connect-timeout 5 \
    -H 'Content-Type: application/json' \
    --data-binary @- \
    "$webhook_url" >/dev/null
}

# One refusal report, for a run that never reached a verdict. Both call sites -
# the pre-flight check and the poll-time branch - come through here, so the two
# cannot drift apart in wording, in dedup state, or in what they leave behind.
#
# It is a report and not a silence, because nothing on this host reads the
# canary's exit status: a canary that quietly stopped checking reproduces, one
# level up, the exact failure this whole feature exists to end - a route that
# stopped delivering is indistinguishable from a host with nothing to report.
# What it must never be is an OUTAGE report, so it carries its own header, which
# claims the canary is broken and never claims the relay is failing, and its own
# dedup state, so a canary broken for a week posts once rather than seven times
# and a real outage is never silenced by it.
#
# The dead-streak marker is never written from here. It means "a real outage of
# the alert path was reported", and a run with no verdict is not one: writing it
# silences the next real outage, which is the failure this script exists to
# prevent. It is not removed from here either, and the reasoning for that is at
# the dedup comparison below.
#
# Returns 2; the caller exits with that.
refuse() {
  if [ -e "$fault_marker" ]; then
    echo "overflow-canary.sh: $1; the canary-fault marker $fault_marker already records this refusal, so no second report is posted" >&2
    return 2
  fi

  post_status=0
  post_report "[overflow] the canary on $fqdn cannot run: $1" || post_status=$?

  if [ "$post_status" -ne 0 ]; then
    echo "overflow-canary.sh: $1; the out-of-band report could not be delivered (curl exited $post_status), so the fault is left unrecorded and the next run reports again" >&2
    return 2
  fi

  echo "overflow-canary.sh: $1; the canary itself is broken, reported out of band on its own line rather than as an outage of the alert path" >&2
  if ! mkdir -p "$state_dir"; then
    echo "overflow-canary.sh: could not create state directory $state_dir; not recording the fault" >&2
  elif ! printf '%s\n' "$sent_at" > "$fault_marker"; then
    # The consequence is named, not left to be derived. The report above did
    # reach the channel, so the operator learns the canary is broken; what they
    # cannot see from that is that a dead-streak marker written BEFORE this
    # fault is now unretired, and the dedup comparison will keep honouring it -
    # so the first real outage after readability returns is the one that gets
    # swallowed. That is the line's whole job.
    echo "overflow-canary.sh: could not write the canary-fault marker $fault_marker; the next run will report again, and a dead-streak marker recorded before this fault stays unretired, so the first real outage after readability returns will not be reported" >&2
  fi

  return 2
}

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

# The relay verdict is read from the exim mainlog, so a log this process cannot
# open is a run that can take no verdict at all - and "no verdict" is not "the
# relay delivered nothing". It is checked HERE, before the submission, for
# three reasons: the failure is immediate and says which file is at fault
# rather than costing the whole wait budget to discover; no heartbeat mail goes
# out that the operator would receive with no explanation attached to it; and
# a canary that cannot read its own evidence must not go on to pretend it has.
#
# This is the deployed defect's own shape, measured on the unit's exact
# hardening: `grep` of the mainlog under this sandbox answers "Permission
# denied", the run timed out, and the report named a relay that had completed
# the message a second earlier. So the check below REFUSES, and refuses as a
# fault in the canary: exit 2, a report on its own header, and no
# dead-streak marker. It sits after the two checks above only because the
# refusal names the host and is stamped like every other report, and both of
# those are computed there.
if [ ! -r "$exim_log" ]; then
  refuse "$exim_log is not readable by this process, so the relay verdict could not be taken and nothing was submitted" || exit $?
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
# Set only where the verdict cannot be taken, never where one is taken. It is
# what separates a run that knows the relay failed from a run that cannot read
# the evidence, and the two must not leave the same journal line: one is an
# outage to act on, the other is a permission to fix.
verdict_impossible=''
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
    # Reset on every pass, so what the deadline reads is the state of the log
    # at the deadline and not the worst moment it passed through. A gap that
    # closed again inside the budget decides nothing at all.
    verdict_impossible=''
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
      # `defer` is deliberately a provisional token. It is what exim writes
      # for a temporary failure - a 4xx, a greylist - and it goes on to RETRY
      # the message, so treating it as final would page the maintainer every
      # time a relay greylists. `Failed to connect to` is provisional on the
      # same terms, and section 53.9 of the exim specification is why: it
      # records that line as the DETAIL written ahead of the `== <address>
      # ... defer` line for the same id, for a message that stays queued and
      # is retried. The first line a scan reaches is therefore the one that
      # never was a verdict. The rest are the outcomes that end a message.
      #
      # A QUOTED field is left out for the same reason, one step further out:
      # DN= and C= carry the peer's own answer byte for byte, so a relay whose
      # rejection text happens to carry a terminal word - a filtering relay's
      # policy answer is the ordinary way that happens - would be read as a
      # verdict exim never gave. Quoted text is dropped before anything is
      # matched, escapes included, and what is left is exim's own accounting
      # of what happened to the message.
      #
      # The search therefore does NOT settle on the first verdict it meets. A
      # log reading `** defer` and later `bounce` under one id is a message
      # that deferred once and then failed for good, and a search that stops
      # at the defer reports the wrong cause and then re-reads the same defer
      # for the rest of the budget. A terminal token anywhere in the log
      # wins; the provisional ones are the fallback for when there is none.
      # They are also tested FIRST on each line, because exim writes
      # deferrals whose own reason text contains a terminal word - `** defer
      # rejected: ...` - and a refused connection followed by the error that
      # refused it, and neither of those lines ends the message.
      verdict=$(awk -v id="$message_id" '
        BEGIN { first = ""; found = 0 }
        {
          at = index($0, id)
          if (at == 0) next
          rest = substr($0, at + length(id))
          # A QUOTED field is text exim did not write: it is the answer from the
          # far end, byte for byte, so a terminal word inside one is a remote
          # verdict and not an exim one. Every quoted span is dropped before
          # anything is matched, backslash escapes included. Exim closes every
          # quote it opens, so an unterminated one cannot swallow the line.
          scrubbed = rest
          while (match(scrubbed, /"([^"\\]|\\.)*"/)) {
            scrubbed = substr(scrubbed, 1, RSTART - 1) " " substr(scrubbed, RSTART + RLENGTH)
          }
          # Section 53.9: a DETAIL line, written before the `== ... defer` for
          # the same id, on a message that stays queued. Provisional, like defer.
          if (scrubbed ~ /Failed to connect to/) {
            if (first == "") first = "Failed to connect to"
            next
          }
          if (scrubbed ~ /defer/) { if (first == "") first = "defer"; next }
          if (match(scrubbed, /(rejected|bounce|blackhole|discarded|Failed)/)) {
            found = 1
            print substr(scrubbed, RSTART, RLENGTH)
            exit
          }
        }
        END { if (found == 0 && first != "") print first }
      ' "$exim_log") || verdict=''
      # Both provisional tokens mean exim is still RETRYING this message, so
      # they are remembered and reported rather than obeyed.
      case "$verdict" in
        '' | defer | 'Failed to connect to') ;;
        *)
          reason="the relay recorded $verdict for $message_id and never Completed it, so the smarthost did not take the message"
          break
          ;;
      esac
      if [ -n "$verdict" ]; then
        seen_verdict=$verdict
      fi
    else
      # The log was readable at the check above and is not now. A rotation
      # under `nocreate` - which is what this host's exim logrotate does -
      # leaves the path absent until exim itself reopens it, and a permission
      # change lands the same way, so this is reachable rather than theoretical.
      #
      # The loop is NOT broken. A log that comes back inside the budget is a
      # log the run can still take its verdict from, and giving up on a
      # momentary gap would fail a run whose relay is fine. The reason is only
      # ever read at the deadline, and only if the log is STILL unreadable
      # then; the first gap never decides anything on its own.
      verdict_impossible="$exim_log was not readable to this process when the ${exim_wait}s wait closed, so the verdict for $message_id could not be taken; the relay is not implicated"
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      if [ -n "$verdict_impossible" ]; then
        reason=$verdict_impossible
      elif [ -n "$seen_verdict" ]; then
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
  # The fault marker is cleared here and nowhere else, and only by a run that
  # actually reached a verdict. It says "the canary itself is broken", so the
  # one thing that must retire it is proof that it works again.
  if [ -e "$fault_marker" ]; then
    if ! rm -f "$fault_marker"; then
      echo "overflow-canary.sh: the path is healthy but the canary-fault marker $fault_marker could not be removed; the next refusal reports again" >&2
    fi
  fi
  exit 0
fi

# A verdict that could not be taken is reported, but never as an outage. It is
# placed after the healthy exit so a log that went dark and came back inside
# the budget is still the healthy run it actually was, and before the outage
# branch so the dead-streak marker below cannot be reached from here - writing
# that marker for a fault in the check silences the next real outage, which is
# the failure this script exists to prevent. What it says, and dedups on, is
# `refuse`'s business, shared with the pre-flight check.
if [ -n "$verdict_impossible" ]; then
  refuse "$reason" || exit $?
fi

# One report per dead streak, with one exception. $marker is honoured when it
# is the newest word on the outage: nothing has proven the path healthy since
# it was written, so a second report would be the same message again. A
# canary-fault marker NEWER than it is the exception, and the shape is a stamp
# comparison because both files hold this script's own `$sent_at`. That fault
# means the canary was blind for a stretch, and an outage reported before the
# blindness says nothing about the path since: the streak may have been
# re-established while nothing could see it, and honouring the old marker would
# swallow the first real outage after readability came back - the same silence,
# one step later. Neither marker is written or removed from here.
dedup_holds=1
if [ -e "$marker" ] && [ -e "$fault_marker" ]; then
  # Unreadable or oddly shaped stamps retire the dedup rather than trusting it:
  # the cost of a duplicate report is one message, and the cost of a wrong
  # silence is an outage nobody was told about.
  dedup_holds=0
  if [ -r "$fault_marker" ] && [ -r "$marker" ]; then
    fault_stamp=$(cat "$fault_marker")
    dead_stamp=$(cat "$marker")
    # EMPTY is listed beside the odd characters, and it has to be: the empty
    # string is a prefix of every character class, so the guard below accepts it
    # and it would sort first, read as the older of the two, and let the dedup
    # hold - the one unusable stamp that silenced the outage. A zero-length
    # marker is reachable rather than hypothetical: the write is a `>` redirect,
    # which truncates before `printf` runs, so a write that then fails leaves
    # exactly this.
    case "$fault_stamp$dead_stamp" in
      *[!0-9A-Za-z:.-]*) ;;
      *)
        if [ -n "$fault_stamp" ] && [ -n "$dead_stamp" ]; then
          # Both stamps are this script's own `$sent_at` - YYYY-MM-DDTHH:MM:SSZ,
          # fixed width - so the earliest of the two is the older one, and the
          # dedup holds only while the recorded outage is the NEWER of them.
          # POSIX `test` has no string ordering operator, and `sort` under
          # LC_ALL=C is byte order, which for one fixed-width format is
          # chronological. Equal stamps count as the outage being the newer
          # word: a fault reported in the same second says nothing about the
          # path since.
          oldest=$(printf '%s\n%s\n' "$dead_stamp" "$fault_stamp" | LC_ALL=C sort | head -n 1)
          if [ "$oldest" = "$fault_stamp" ]; then
            dedup_holds=1
          fi
        fi
        ;;
    esac
  fi
fi

if [ -e "$marker" ] && [ "$dedup_holds" -eq 1 ]; then
  echo "overflow-canary.sh: $reason; the dead-streak marker $marker already records a reported outage, so no second report is posted" >&2
  exit 1
fi

post_status=0
post_report "[overflow] the failure-alert path on $fqdn is not delivering: $reason" || post_status=$?

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

# The fault that retired this dedup has now been accounted for by the report
# above, and this run read the log well enough to take a verdict, so the canary
# works again and its fault marker goes. Leaving it would retire the dedup on
# every later run of the streak, which is a daily duplicate rather than a
# re-announcement of an outage nobody had heard about.
if [ -e "$fault_marker" ]; then
  if ! rm -f "$fault_marker"; then
    echo "overflow-canary.sh: the outage is reported but the canary-fault marker $fault_marker could not be removed; the next run of this streak reports again" >&2
  fi
fi

exit 1
