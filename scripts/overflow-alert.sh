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
# A SUBMISSION THE DAEMON ACCEPTED IS NOT AN ALERT THAT ARRIVED. The local exim
# answers a message it has merely spooled with "250 OK id=<id>", and its local
# delivery agent then writes that message to /var/mail/mail on this same
# machine. Every signal the daemon offers is green in that case: curl exits 0,
# the id is well formed, and the mainlog carries a Completed line for it. The
# operator receives nothing, and - because the throttle below records a send -
# the next thirty minutes of real alerts are suppressed in favour of a message
# that reached nobody. So this script submits verbosely, follows the accepted id
# into the exim mainlog, and requires an OFF-HOST routing line before it calls
# an alert delivered. An alert that did not leave this host is a failed alert,
# and saying so is the whole point: the report IS the throttle's absence, so the
# next failure mails immediately instead of being silenced by a delivery that
# never happened.
#
# The transports refused by name below - address_file, address_pipe,
# address_pipe_unset, addressd, address_directory, appendfile, autoreply,
# mailbox, maildrop_home, mailstore_home, tpipe - are a MAINTENANCE OBLIGATION
# rather than a closed set. The list is a denylist on purpose: an allowlist
# would call a legitimately configured remote transport this script does not
# name (remote_smtp direct, remote_smtp_unsecure) a failed alert, and a false
# alert is the same class of false green this check exists to end. The cost
# falls on the other side - a local delivery agent added to exim on this host
# later is not caught by name - and adding it here is the fix.
#
# A crash loop cycling slower than the service manager's start limit escapes
# it - StartLimitIntervalSec=300 with Burst=5 trips only on six starts inside
# the window - and would mail one alert per cycle forever. Each failed unit is
# therefore throttled to one message per 1800 seconds: the time of the last
# send is recorded per unit in $state_dir/$unit, and a repeat inside the
# window suppresses the mail, logging one line to the alert unit's journal
# instead. The record is written only after an alert has actually left the
# host, so a submission that failed, that could not be followed, or that ended
# up on this machine's own mail spool leaves no state and the next failure
# mails again immediately. Anything the throttle path cannot read or write
# fails open and mails.

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

# The mainlog is where the relay verdict has to be read from, and the wait
# budget is how long the relay is given to reach one. Both are overridable
# only so tests/scripts/overflow-alert.test.ts can drive this script against a
# scratch log; the alert unit sets no such variable, so a deployed run always
# reads the default path and waits the default number of seconds. The unit's
# sandbox is ProtectSystem=strict, which is read-only rather than unreadable,
# so the mainlog is readable in the deployed unit exactly as it is here.
exim_log=${OVERFLOW_ALERT_EXIM_LOG:-/var/log/exim4/mainlog}

# The wait budget reaches an arithmetic expansion, where a non-numeric value
# aborts the whole run under set -e with nothing in the journal. Only the
# tests set it, but a refusal costs three lines and says which value is
# wrong, where the arithmetic says nothing at all. Exit 2 is reserved
# throughout for the misconfiguration class - what must fail loudly without
# sending - so this is refused the same way a bad recipient file is.
exim_wait=${OVERFLOW_ALERT_EXIM_WAIT_SECONDS:-60}
case $exim_wait in
  ''|*[!0-9]*)
    echo "overflow-alert.sh: OVERFLOW_ALERT_EXIM_WAIT_SECONDS is \"$exim_wait\", which is not a whole number of seconds" >&2
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

# Whether a transport named in a routing line hands the message to something on
# THIS machine. Every transport in the set ends at a local delivery agent and a
# local mailbox, so the daemon's own acceptance and completion prove nothing
# about whether anybody was told; anything not in the set is treated as leaving
# the host, for the allowlist reason recorded in the header.
leaves_host() {
  case $1 in
    address_file|address_pipe|address_pipe_unset|addressd|address_directory|\
    appendfile|autoreply|mailbox|maildrop_home|mailstore_home|tpipe) return 1 ;;
    *) return 0 ;;
  esac
}

# curl -v writes its conversation with the daemon to stderr; the message itself
# is piped in on stdin. The redirections take stderr into the substitution and
# discard stdout, so what is left to read below is the trace and nothing else.
#
# --no-progress-meter is not cosmetic. -v re-enables the transfer meter, and the
# meter terminates its line with a carriage return rather than a newline, so it
# lands on the same line as the final response: the trace would read
# "250 OK id=1xBuT1-000000003QH-0Qqz" followed by a counter and no break. The
# extraction below stops at whitespace either way, so a curl without the flag
# still yields the right id rather than one that matches no log line.
submit_status=0
trace=$(
  {
    printf 'From: overflow-alert@%s\nTo: %s\nSubject: [overflow] %s failed on %s\n\n' \
      "$fqdn" "$recipient" "$unit" "$fqdn"
    printf 'The systemd unit %s failed on host %s at %s.\n\n' \
      "$unit" "$fqdn" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
    echo "Last journal entries for the failed unit (current boot):"
    journalctl -b -u "$unit" --no-pager -n 200 || echo "(reading the journal failed)"
  } | curl -v --no-progress-meter --max-time 30 --connect-timeout 5 \
    --url smtp://127.0.0.1:25 \
    --mail-from "overflow-alert@$fqdn" \
    --mail-rcpt "$recipient" \
    --upload-file - 2>&1 1>/dev/null
) || submit_status=$?

# The id is the last 250 that carries one: the reply to the end of DATA. Every
# other 250 in the conversation answers a command the daemon has already
# accepted, so the last is also the only one that names this message. A
# submission that exited zero without producing one is a failure rather than a
# pass, because there is then no id whose routing and Completed lines could ever
# be found, and a run that read it as delivered would stay wrong forever.
message_id=''
if [ "$submit_status" -eq 0 ]; then
  message_id=$(printf '%s\n' "$trace" | sed -n 's/^< 250 OK id=\([^[:space:]]*\).*$/\1/p' | tail -n 1)
fi

reason=''
delivered_via=''
if [ "$submit_status" -ne 0 ]; then
  reason="the alert could not be submitted to the local exim daemon (curl exited $submit_status)"
elif [ -z "$message_id" ]; then
  reason="the local daemon took the submission but answered no 250 OK id= line, so there is no id whose delivery could be followed"
else
  # The relay may not have finished with the message when curl returns, so the
  # log is polled to the wait budget. The log is matched on this run's own id
  # and never on the word alone: a log already holding someone else's Completed
  # line would otherwise read as a verdict about a message that never left.
  #
  # Delivered needs TWO lines under this id. The Completed line says the daemon
  # finished with the message; it carries no T=, so it cannot say where. The
  # routing line carries T=<transport>, and it is the only place the question
  # "did this leave the host?" is written down. Both, or the alert is not
  # delivered.
  #
  # The submission has exactly one recipient, so there is exactly one routing
  # line per delivery attempt, and the LAST one under this id is the current
  # routing decision - which is what a message that deferred and was re-routed
  # is judged on, not the route it first tried.
  deadline=$(( $(date +%s) + exim_wait ))
  seen_verdict=''
  local_transport=''
  log_readable=0
  while :; do
    if [ -r "$exim_log" ]; then
      log_readable=1

      transport=$(awk -v id="$message_id" '
        {
          at = index($0, id)
          if (at == 0) next
          arrow = index($0, "=>")
          if (arrow == 0 || arrow <= at) next
          rest = substr($0, arrow + 2)
          if (match(rest, /T=[^[:space:]]+/)) last = substr(rest, RSTART + 2, RLENGTH - 2)
        }
        END { if (last != "") print last }
      ' "$exim_log") || transport=''

      if grep -q -F -e "$message_id Completed" "$exim_log" && [ -n "$transport" ]; then
        if leaves_host "$transport"; then
          delivered_via=$transport
          break
        fi
        # A local transport is remembered rather than obeyed, on the same
        # reasoning as `defer` below: one observation does not end the poll
        # while the budget is still open. The cost is that a locally routed
        # alert is reported when the budget closes rather than on sight, and
        # the gain is that the rule stays single - nothing concludes the wait
        # early except a verdict that ends the message for good.
        local_transport=$transport
      fi

      # ORDER MATTERS, and a test pins it. Completed is read first and it is
      # the only success, but only once a routing line has said the transport
      # leaves this host. A message that is greylisted, or answered with a
      # temporary 4xx, is deferred once and then COMPLETED on its retry, and
      # both lines sit in the log under one id at the same time; a check that
      # were conclusive on sight would manufacture a dead verdict on the one
      # signal the operator has to trust.
      #
      # A named verdict is still worth keeping, so the report says what exim
      # said rather than our own timeout restated. awk's index() is a literal
      # search, which is why it is used here and not a grep pattern: an exim id
      # carries no metacharacters by the book, and matching a fixed token after
      # a literal id keeps both properties.
      #
      # `defer` is deliberately the ONLY provisional token. It is what exim
      # writes for a temporary failure - a 4xx, a greylist - and it goes on to
      # RETRY the message, so treating it as final would report a dead alert
      # every time a relay greylists. The rest are the outcomes that end a
      # message.
      #
      # The search therefore does NOT settle on the first verdict it meets. A
      # log reading `** defer` and later `bounce` under one id is a message
      # that deferred once and then failed for good, and a search that stops
      # at the defer reports the wrong cause and then re-reads the same defer
      # for the rest of the budget. A terminal token anywhere in the log wins;
      # `defer` is the fallback for when there is none. `defer` is also tested
      # FIRST on each line, because exim writes deferrals whose own reason text
      # contains a terminal word - `** defer rejected: ...` - and that line is
      # a temporary failure, not a rejection.
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
        reason="exim recorded $verdict for $message_id and never Completed it, so the alert did not leave this host"
        break
      fi
      if [ -n "$verdict" ]; then
        seen_verdict=$verdict
      fi
    fi
    if [ "$(date +%s)" -ge "$deadline" ]; then
      # The budget closed with no off-host acceptance. Which of these names
      # the cause decides what an operator reads at three in the morning, so
      # the most specific one is reported first.
      if [ -n "$local_transport" ]; then
        # The recipient is NOT named, for the reason its own validation gives
        # above: this line lands in the journal, and the journal is what gets
        # pasted into an issue. The transport and the id say everything an
        # operator needs about why the alert stayed here.
        reason="exim routed $message_id to the local $local_transport transport, so the alert was written to this host's own mail spool rather than sent off it"
      elif [ -n "$seen_verdict" ]; then
        reason="exim recorded $seen_verdict for $message_id and never Completed it within ${exim_wait}s, so the relay did not take the alert"
      elif [ "$log_readable" -eq 0 ]; then
        reason="$exim_log is missing or unreadable, so no off-host acceptance of $message_id could be observed within ${exim_wait}s"
      else
        reason="the local daemon accepted the alert as $message_id but $exim_log records no Completed line for it within ${exim_wait}s"
      fi
      break
    fi
    sleep 1
  done
fi

if [ -n "$reason" ]; then
  echo "overflow-alert.sh: $reason; the send is NOT recorded, so the next failure for $unit alerts again" >&2
  # A submission failure keeps curl's own status, which says more than any
  # code invented here would. Everything else is a delivery failure, which is
  # not a misconfiguration and must not borrow exit 2.
  if [ "$submit_status" -ne 0 ]; then
    exit "$submit_status"
  fi
  exit 1
fi

echo "overflow-alert.sh: exim routed $message_id to $delivered_via and Completed it; the alert left this host" >&2

# Only an alert that actually left the host is recorded; a warning below leaves
# the exit status alone, because failing open is the point of the throttle path.
if ! mkdir -p "$state_dir"; then
  echo "overflow-alert.sh: could not create state directory $state_dir; not recording the send" >&2
elif ! printf '%s\n' "$now" > "$state_file"; then
  echo "overflow-alert.sh: could not write state file $state_file; not recording the send" >&2
fi

exit 0
