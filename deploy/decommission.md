# Decommissioning

This runbook retires a deployment of Overflow for good. It stops the service
and its timers, deletes the GitHub App and the OAuth application, sweeps the
webhooks Overflow created on member repositories, drops the database and both
database roles, and destroys every store the deployment holds on the host,
with a disposal step or a recorded non-disposal decision for each. It
complements the other deployment procedures: [README.md](README.md) stands a
deployment up, [backup-restore.md](backup-restore.md) backs up and restores
its database, [incident-response.md](incident-response.md) contains and
scopes incidents, and [dpia-screening.md](dpia-screening.md) screens the
contributor scoring for data-protection impact. This file is the end-of-life
path those four do not carry.

Run it when the deployment is being retired and nothing will come back:
the host is being wiped with the product on it, or the product is leaving a
host that stays up for other services. It is not the procedure for moving the
deployment to a new host — that is the restore path in
[backup-restore.md](backup-restore.md#e-restoring) — nor for taking the
service down for a while, which is `systemctl stop overflow.service` and
nothing else, nor for one person's data, which is the account-deletion path
in [OPERATING.md](../OPERATING.md#account-deletion-and-export).

**Every step past the preflight record is irreversible.** The database holds
the only copy of data that cannot be rebuilt from GitHub — accounts, stored
credential ciphertext, moderation history, audits, corrections, API-token
digests, credit adjustments — and the dump files in `/var/backups/overflow`
are the last copy of that data once the database is gone. Past
[phase 6](#6-backup-disposal), nothing can restore the deployment's member
data. If there is any chance the deployment will be wanted again, stop here:
take a final dump the way [backup-restore.md](backup-restore.md) does, move
it off the host, and record in the preflight record where it went. Do not
start this runbook and leave it half-done.

Three orderings are load-bearing, and each exists because skipping it loses
something that cannot be recovered afterwards:

1. The preflight record (phase 2) precedes every destructive step. It is the
   only inventory of what is being destroyed and the only record of where
   member data went; write it somewhere off the host, because everything on
   the host is destroyed by the end.
2. The units are dead (phase 3) before any store is destroyed. A live
   `overflow-backup.timer` recreates `/var/backups/overflow` on its next
   fire, and a live service keeps accepting webhook deliveries and writing
   stores while their disposal is under way.
3. The GitHub App and webhook enumeration (phase 4) precedes the database
   drop (phase 5). The local database is the only record of which member
   repositories carry an Overflow webhook; the drop destroys
   `registered_repositories` and `abandoned_webhook_cleanups`, and GitHub
   offers no reverse index from a deleted app to the repository webhooks its
   tokens created.

Values used throughout: the database is `overflow` (the name in the app's
`DATABASE_URL`); the application **role** on this host is `overflow_app` and
the least-privilege backup role is `overflow_backup`. The role names are
host-specific: they are the login role that owns the application's tables and
the read-only role
[backup-restore.md](backup-restore.md#b-the-least-privilege-backup-role)
created, whichever their local names. On another host substitute those roles
everywhere below.

## 1. Scope and preconditions

This runbook disposes of the deployment's stores. Every store gets a disposal
step in the phase named here, or a named decision not to dispose:

| Store | Disposed | Where |
| --- | --- | --- |
| PostgreSQL database `overflow`, roles `overflow_app` and `overflow_backup` | dropped | [phase 5](#5-database-disposal) |
| `/var/backups/overflow` — dump files, drill log, deploy records | destroyed | [phase 6](#6-backup-disposal) |
| `/etc/overflow` — environment, secrets, `github-app/` key material | destroyed | [phase 7](#7-secrets-and-configuration-disposal) |
| `/srv/overflow` — deployment tree, releases, Next cache | destroyed | [phase 8](#8-remaining-stores) |
| `/var/log/overflow` — deploy logs | destroyed | [phase 8](#8-remaining-stores) |
| journald entries for the deployment's units | aged out or vacuumed, by decision | [phase 8](#8-remaining-stores) |
| `/var/lib/overflow-bounce` — bounce-watcher state | destroyed | [phase 8](#8-remaining-stores) |
| `/run/overflow-alert`, `/run/overflow-canary` — runtime directories | destroyed | [phase 8](#8-remaining-stores) |
| Off-host: the backups channel's posted copies | deleted from the channel | [phase 6](#6-backup-disposal) |
| Off-host: operator-held dump copies, alert and canary mailboxes, Discord webhook | disposed off the host | [phase 7](#7-secrets-and-configuration-disposal) |
| GitHub-side stores: issues, pull requests, labels, comments, checks, Actions artifacts | not disposed — retention is GitHub's | [phase 4](#4-github-app-deletion-and-webhook-sweep) |
| Member browser cookies — the NextAuth JWT session cookie | not disposed — nothing on-host to dispose | [phase 7](#7-secrets-and-configuration-disposal) |
| Node runtime (README section 3) | retained — shared host infrastructure | [phase 8](#8-remaining-stores) |

The cluster hosts other services: only the database and roles named in the
preflight record are dropped, never anything pattern-matched, and never the
cluster itself. Two stores are conditional — they exist only if a procedure
created them — and phase 8 covers both: the breach log
[incident-response.md](incident-response.md#responsibility-and-decisions)
defines at `/var/lib/overflow/breach-log/`, and the pre-hardening unit copy
[README.md section 1](README.md#1-keep-the-unit-you-are-replacing) saves.

Preconditions:

- Root on the deployment host, with the deployment tree at `/srv/overflow`
  reachable — phase 4 enumerates through the database it names in
  `/etc/overflow`, and the tree is destroyed only in phase 8.
- The retirement decision is final. Anything short of final — a pause, a
  host migration, a re-registration on a new tracker — is a different
  procedure, and this one destroys what it would have needed.
- GitHub access that administers the **GitHub App** (the ledger relay, if
  this deployment configured one) and the **OAuth application** member sign-in
  uses, to delete both in phase 4.
- Control of the off-host destinations: the alert and canary mailboxes and
  the Discord channel the canary's failure reports go to — and, on a
  deployment that ran the off-host copy, the backups channel those copies
  were posted to, through the `osc` identity from a machine that runs the
  fleet's mailbox CLI. The host-side files die in phase 7; the destinations
  themselves are closed off the host, by whoever holds them.
- A way to remove the webhooks of phase 4: an administrator of each member
  repository still carrying an Overflow webhook. On a deployment whose
  registrations live in the sponsors' own repositories, that is the sponsors,
  so the sweep is a request to each sponsor plus an operator sweep for the
  repositories whose sponsors cannot act. State which arrangement applies in
  the preflight record.

Confirm the runbook applies to what is actually on the host before starting,
read-only:

```sh
systemctl list-unit-files 'overflow*' --no-pager
ls -d /var/backups/overflow /etc/overflow /srv/overflow
sudo -u postgres psql -lqt | grep overflow
```

## 2. The preflight record

Write the record before anything is destroyed, to a place that survives the
decommission — another machine, a private gist, a sealed printout. Everything
on this host is gone by the end of phase 8, so a record written onto the host
is destroyed with what it describes. The record answers three questions after
the fact: what was here, where did the data go, and what was disposed
off-host. It is also what phases 4 and 5 read their targets from: the
enumerations below produce the exact repositories, databases and roles the
later phases destroy, named individually.

```sh
systemctl list-unit-files 'overflow*' --no-pager
systemctl list-timers 'overflow*' --all --no-pager
systemctl list-units 'overflow*' --all --no-pager

# The database and its roles. Name the exact databases this decommission
# drops — the production database plus any leftover drill or replacement
# copies this deployment created, of the shape backup-restore.md's drill and
# its replacement path leave behind. Never pattern-match: a cluster can carry
# similarly named databases that belong to other work.
sudo -u postgres psql -lqt
sudo -u postgres psql -tAc "select rolname from pg_roles where rolname like 'overflow%'"

# The stores on disk, with their sizes at decommission time.
ls -la /var/backups/overflow
du -sh /var/backups/overflow /etc/overflow /srv/overflow \
  /var/log/overflow /var/lib/overflow-bounce /run/overflow-alert /run/overflow-canary

# The registrations whose webhooks phase 4 sweeps. Run before anything is
# destroyed; the output is the sweep list.
sudo -u postgres psql -d overflow -tAc \
  "select owner_name, provider, github_repository_id, github_webhook_id
     from registered_repositories where unregistered_at is null order by owner_name"

# Webhooks a failed registration may have orphaned; phase 4 drains these too.
sudo -u postgres psql -d overflow -tAc \
  "select owner_name, github_repository_id, webhook_id from abandoned_webhook_cleanups order by created_at"

# The secret files' names and modes — never their contents.
ls -la /etc/overflow /etc/overflow/github-app

# The off-host mail destinations, to be closed by whoever holds them. These
# two files carry mail addresses, not credentials, and the off-host closure
# in phase 7 needs them named, so their contents are recorded here while the
# credential-bearing files are recorded by name only, never read.
printf '%s\n' 'alert mailbox:'; cat /etc/overflow/alert-recipient
printf '%s\n' 'canary mailbox:'; cat /etc/overflow/canary-recipient

# The backups channel the off-host copies were posted to, which phase 6's
# disposal reads out of the environment file (an identifier, not a secret).
# On a deployment that never ran the off-host copy this line answers nothing.
grep OVERFLOW_BACKUP_DISCORD_CHANNEL /etc/overflow/backup.env

# Journal footprint, for the phase 8 journald decision.
journalctl --disk-usage
```

Two lines of that record need an operator decision at write time, and the
record is where the decision is written:

- **Deployment records inside the backup directory.**
  `/var/backups/overflow` holds more than dumps on a long-lived deployment:
  the drill log `drill-log.md` and the `webhook-upgrade-*.jsonl` deploy
  records sit beside the dumps. Copy any of them the operator must keep to
  the off-host record now; phase 6 destroys the directory.
- **The journald decision.** Phase 8 either vacuums the deployment units' journal
  entries — legitimate only when the host retires with the product — or
  leaves them to age out. Write which way this went into the record here.

The credential-bearing files — `overflow.env`, `backup.env`,
`canary-discord-webhook`, everything under `github-app/` — are recorded by
name and mode only, never read: the record is a survivor document, and a
secret that outlives the product is a leak that outlives the product. The
two mail addresses are the exception the block above records, because the
off-host closure in phase 7 has to name what it closes.

## 3. Stop and remove the units and timers

The units die before any store is destroyed. A timer that fires mid-run
recreates a store phase 6 or 8 believes it has disposed of, and a live
`overflow.service` keeps serving webhook deliveries, running the
reconciliation worker, and writing the stores this runbook is destroying —
so every disposal step after this phase assumes the units are already gone.
The alert template is never enabled: `OnFailure=` is its only trigger, and
removing the watched units removes the trigger.

```sh
systemctl disable --now overflow-backup.timer overflow-bounce.timer overflow-canary.timer \
  overflow-offhost-backup.timer
systemctl stop overflow.service
systemctl disable overflow.service
systemctl stop 'overflow-alert@*.service'

rm /etc/systemd/system/overflow.service \
   /etc/systemd/system/overflow-alert@.service \
   /etc/systemd/system/overflow-backup.service /etc/systemd/system/overflow-backup.timer \
   /etc/systemd/system/overflow-offhost-backup.service /etc/systemd/system/overflow-offhost-backup.timer \
   /etc/systemd/system/overflow-bounce.service /etc/systemd/system/overflow-bounce.timer \
   /etc/systemd/system/overflow-canary.service /etc/systemd/system/overflow-canary.timer
systemctl daemon-reload
systemctl reset-failed 'overflow*'
```

`disable --now` stops and disables each timer in one step. `systemctl`
errors on each name this host does not have — `Failed to disable unit …
does not exist`, exit 1 — and carries on with the rest, so a nonzero status
from this line is expected on a host missing one of the timers; the removals
and `daemon-reload` below are what matter. After
`daemon-reload` nothing under `overflow*` is loaded any more — no loaded
unit can start, so no store below is written again — and phase 9's
`list-units` check confirms it. The service is down and the public site now
answers from the reverse proxy with a 502; that is expected. The reverse
proxy is host web-server infrastructure shared with other services, and this
runbook does not touch it: when the hostname retires with the deployment,
remove the vhost per host policy — a vhost left pointing at a dead listener
is host state, not a store of the product.

## 4. GitHub App deletion and webhook sweep

Do this before the database drop. The local database is the only record of
which member repositories carry an Overflow webhook:
`registered_repositories` holds one row per registration, and
`abandoned_webhook_cleanups` holds webhooks a failed registration created
and never cleaned up — written before the compensating deletion was
attempted, so the id survives every failure. Once the database is dropped
there is no way to enumerate them from the product, and GitHub offers no
reverse index from a deleted application to the repository webhooks its
tokens created. The sweep list is the preflight record's enumeration; this
phase re-runs it live and works through it.

```sh
sudo -u postgres psql -d overflow -P footer=off -c \
  "select owner_name, provider, github_repository_id, github_webhook_id
     from registered_repositories where unregistered_at is null order by owner_name"

sudo -u postgres psql -d overflow -P footer=off -c \
  "select owner_name, github_repository_id, webhook_id
     from abandoned_webhook_cleanups order by created_at"
```

Sweep the webhooks first, while the database is still there to re-run the
enumeration against. `owner_name` carries the repository's `owner/name`
path, so each row names its own delete call:

```sh
sudo -u postgres psql -d overflow -tAc \
  "select owner_name, github_webhook_id from registered_repositories where unregistered_at is null order by owner_name" \
  | while IFS='|' read -r owner hook_id; do
      if gh api --method DELETE "repos/${owner}/hooks/${hook_id}" >/dev/null 2>&1; then
        printf 'deleted webhook %s on %s\n' "$hook_id" "$owner"
      else
        printf 'FAILED webhook %s on %s — delete it by hand and record it\n' "$hook_id" "$owner"
      fi
    done

sudo -u postgres psql -d overflow -tAc \
  "select owner_name, webhook_id from abandoned_webhook_cleanups order by created_at" \
  | while IFS='|' read -r owner hook_id; do
      if gh api --method DELETE "repos/${owner}/hooks/${hook_id}" >/dev/null 2>&1; then
        printf 'deleted abandoned webhook %s on %s\n' "$hook_id" "$owner"
      else
        printf 'FAILED abandoned webhook %s on %s — delete it by hand and record it\n' "$hook_id" "$owner"
      fi
    done
```

A 404 is a success here — GitHub answers 404 for an absent webhook, and an
absent webhook is what the sweep wants. Where the token does not administer
the repository the deletion fails: fall back to the sponsor route — the
sponsor unregisters from the dashboard, which deletes the webhook through
the product — or an administrator of that repository deletes the webhook in
the repository's settings, and the deletion is recorded in the preflight
record. The record is this phase's auditable artifact.

Then delete the applications, in GitHub's developer settings:

- **The GitHub App** — the ledger relay app, if this deployment configured
  one: Developer settings → GitHub Apps → the app → Delete. Deletion ends
  its installations and invalidates its private key server-side; the local
  copy under `/etc/overflow/github-app/` is destroyed in phase 7.
- **The OAuth application** member sign-in uses: Developer settings → OAuth
  Apps → the app → Delete. Deleting it invalidates its client secret and
  ends every authorization members granted it; a member who wants the grant
  gone beforehand revokes it at <https://github.com/settings/applications>.

Named non-disposal, stated for the record: **the GitHub-side stores are not
disposed of.** The issues, pull requests, labels and comments are the ledger
source of truth, the checks are the CI evidence, and the Actions artifacts
are the run logs; their retention is GitHub's. Deleting a member repository
is its owner's decision and no part of this runbook — the deployment deletes
only the two applications it created.

## 5. Database disposal

The database holds the deployment's member data — the account tombstones the
[account-deletion path](../OPERATING.md#account-deletion-and-export) leaves
by design, the attribution ids the ledger attributes work by, the stored
credential ciphertext, the API-token digests, and the append-only moderation
rows. Whole-product decommissioning drops the database rather than looping
account deletions: the account-deletion path is pseudonymisation that keeps
every ledger row on purpose, so it disposes of nothing. This phase is the
step that actually disposes of the member data.

The dumps in `/var/backups/overflow` still exist through this phase — the
last remaining copy of everything destroyed here, themselves destroyed in
the next phase. Nothing restores after this point.

```sh
# Nothing may hold a connection: the units died in phase 3. This lists any
# client still attached to the database; it must print no rows.
sudo -u postgres psql -tAc \
  "select pid, usename, application_name from pg_stat_activity where datname = 'overflow'"

sudo -u postgres psql <<'SQL'
DROP DATABASE overflow WITH (FORCE);
SQL
```

`WITH (FORCE)` terminates straggler connections instead of failing on them.
Drop the leftover drill and replacement databases the preflight record
named, by their exact names — the shapes the
[restore drill](backup-restore.md#e-restoring) and its replacement path leave
behind (`overflow_drill_<stamp>`, `overflow_replacement`,
`overflow_old_<epoch>`) or anything else the preflight listing identified as
this deployment's own:

```sh
sudo -u postgres psql -c "DROP DATABASE overflow_drill_<stamp> WITH (FORCE)"
sudo -u postgres psql -c "DROP DATABASE overflow_replacement WITH (FORCE)"
```

The cluster hosts other services: drop only the databases the preflight
record named, never pattern-matched. A similarly named database belonging to
other work stays exactly where it is.

Then the two roles. `DROP ROLE` fails while the role owns objects or holds
privileges in any database of the cluster — on a clean run it succeeds once
the deployment's databases are gone, and any other failure names where the
role still holds something: stop, investigate, never force it.

```sh
sudo -u postgres psql <<'SQL'
DROP ROLE overflow_app;
DROP ROLE overflow_backup;
SQL
```

**Never drop the cluster.** The PostgreSQL data directory hosts other
services' databases and roles; this runbook disposes of one database and two
roles, and a dropped cluster destroys those other services' data with it. If
the host itself is being wiped, the host retirement handles the cluster.

## 6. Backup disposal

The dumps are gone now, and with them the last copy of the member data. This
is the step past which nothing restores — the irreversibility the
introduction warns about lands here.

```sh
rm -rf /var/backups/overflow
```

Removing the whole tree is the disposal step, not the backup script's
retention prune and not a glob. The 14-day prune
([backup-restore.md](backup-restore.md#d-backup-location-and-retention))
matches only `overflow-*.dump`, so operator-named dumps — a rotation's kept
dump ([README.md section 11](README.md#11-rotating-the-credential-encryption-key)),
the drill log `drill-log.md`, the `webhook-upgrade-*.jsonl` deploy records —
sit outside the grammar and persist through every prune; and the
`.overflow-*.dump.incomplete` partials a killed dump leaves behind are swept
only when they are more than a day old. Only removing the directory covers
every grammar loophole at once.

Off-host copies are disposed of off the host, by whoever holds them. Keeping
copies of the dumps off the host is the maintainer's responsibility while
the deployment runs
([OPERATING.md](../OPERATING.md#failure-alerts-and-off-host-copies)), so
disposing of them is too — a decommission that leaves last quarter's
off-host dump in a drawer has not decommissioned. The preflight record names
where the off-host copies were held and where their disposal is recorded.

The posted copies the off-host job leaves in Discord are the one off-host
store this runbook disposes of itself: their sweeper — the job deletes its
own posted messages once they pass 14 days — died with the timer in phase 3,
so whatever the backups channel still holds is stranded past the backup
lifetime the privacy notice promises. Delete the remaining backup messages
from the channel as the `osc` identity, through the mailbox CLI the job
itself used; the messages go and the channel stays, which is the disposal
phase 7 already performs for the canary's webhook in an operator-held
channel. A deletion failure is recorded, not retried forever, like phase 4's
webhook sweep:

```sh
# The channel id comes from the environment file the nightly unit read; this
# phase runs before phase 7 destroys it. The osc token is not in the file:
# export DISCORD_TOKEN from the fleet's ~/.agent-bundle/discord/osc.token
# before running this block.
set -a
. /etc/overflow/backup.env
set +a

# The disposal needs the osc identity's connector, as the nightly job's was.
python3 ~/.agent-bundle/scripts/discord_mb.py connector osc &
connector_pid=$!

# One page of 100 per pass, then strictly backwards with --before, so the
# sweep terminates even when a deletion fails — 14 daily posts are the
# channel's whole legal backlog, so this is a page or two at most.
before_args=
while :; do
    if ! page=$(python3 ~/.agent-bundle/scripts/discord_mb.py conversation osc 100 \
            --channel "$OVERFLOW_BACKUP_DISCORD_CHANNEL" --json $before_args); then
        printf 'FAILED to read the backups channel — clear any remaining backup messages by hand and record it\n' >&2
        break
    fi
    ids=$(printf '%s' "$page" | python3 -c '
import json, sys
for message in json.load(sys.stdin):
    if message.get("from") != "osc" or not message.get("msg_id"):
        continue
    print(message["msg_id"])')
    oldest=$(printf '%s' "$page" | python3 -c '
import json, sys
messages = json.load(sys.stdin)
print(messages[-1].get("msg_id", "") if messages else "")')
    [ -n "$oldest" ] || break
    for id in $ids; do
        if python3 ~/.agent-bundle/scripts/discord_mb.py message osc delete "$id" \
                --channel "$OVERFLOW_BACKUP_DISCORD_CHANNEL"; then
            printf 'deleted backup message %s\n' "$id"
        else
            printf 'FAILED backup message %s — delete it by hand and record it\n' "$id" >&2
        fi
    done
    before_args="--before $oldest"
done

kill "$connector_pid" 2>/dev/null || :
```

## 7. Secrets and configuration disposal

```sh
rm -rf /etc/overflow
```

`/etc/overflow` is the whole secret store. On a deployment running the
required-checks relay it is `0750 root:overflow` — traversable by the service
account so the ledger app's key stays readable — and the files within it are
`0600`:

- `overflow.env` — `DATABASE_URL` with the database role's password, the
  OAuth client credentials, `AUTH_SECRET`, and `TOKEN_ENCRYPTION_KEY`, the
  key that sealed every stored credential
  ([README.md section 11](README.md#11-rotating-the-credential-encryption-key)).
  The credentials it sealed are already destroyed with the database, and the
  environment reference
  ([OPERATING.md](../OPERATING.md#environment-reference)) carries nothing
  that lives anywhere else — but a key whose ciphertext is gone elsewhere is
  still disposed of here, and `AUTH_SECRET` is what the members' outstanding
  session cookies are signed with.
- `backup.env` — the backup role's `DATABASE_URL` and password
  ([backup-restore.md](backup-restore.md#b-the-least-privilege-backup-role)),
  plus, on a deployment running the off-host copy, the age recipient public
  key and the backups channel id. The `osc` identity's token is not in the
  file: the off-host unit loads it from the fleet's
  `~/.agent-bundle/discord/osc.token` at each start — a fleet-side file other
  products share, not part of this host's disposal inventory
  ([backup-restore.md](backup-restore.md#i-the-encrypted-off-host-copy)).
- `alert-recipient`, `canary-recipient` — the two mail addresses alerts and
  canary probes are sent to, off this host.
- `canary-discord-webhook` — the Discord webhook URL the canary reports
  failures to and the bounce watcher reports dead alert routes to.
- `github-app/` — the ledger relay app's `private-key.pem`, the one file
  [README.md section 4](README.md#4-create-the-environment-file) documents
  at that path; the OAuth client credentials live in `overflow.env`, as
  stated above. The App was deleted in phase 4, which invalidated the key
  server-side; this removes the local copy.

The session cookies members hold are signed with the destroyed `AUTH_SECRET`
and authenticate against the service destroyed in phase 3, so an outstanding
cookie now authenticates nothing. Named non-disposal, for the record: member
browser cookies are not disposed of — there is nothing on-host to dispose;
they die with the service and the database.

Remove the product's lines from the host's mail aliases — the acceptance leg
[README.md section 12](README.md#12-failure-alerts) installs — then rebuild
the alias database:

```sh
sed -i -e '/^overflow-alert:/d' -e '/^overflow-canary:/d' /etc/aliases
newaliases
```

The exim smarthost configuration stays: it is the host's mail
infrastructure, used by other mail on the host, and the product's departure
does not dispose of it. The product-specific parts of the alert route were
the alias lines and the recipient files, and both are gone.

Off-host disposal completes this phase, and it is not optional: deleting the
local files does not close the destinations. Close or reassign the alert and
canary mailboxes — a mailbox left open receives nothing and proves nothing,
while one left under the operator's control is a live address tied to the
retired deployment's history — and delete the Discord webhook from its
channel's integration settings, which invalidates the URL whose local copy
was destroyed above. Record both closures in the preflight record. The
backups channel's posted copies were disposed of in
[phase 6](#6-backup-disposal), which had to run first: that disposal reads
the channel id out of the `backup.env` this phase destroys, and speaks as
`osc` through a token the operator supplies from the fleet's canonical file.

## 8. Remaining stores

The stores the earlier phases do not cover, each with its disposal step. The
units have been dead since phase 3, which is what makes destroying these
safe: nothing recreates them.

```sh
rm -rf /srv/overflow /var/log/overflow /var/lib/overflow-bounce \
  /run/overflow-alert /run/overflow-canary
```

- `/srv/overflow` — the deployment tree: the unit's `WorkingDirectory`, the
  `.next-release-*` release directories, and `.next/cache`. The unit
  [README.md section 6](README.md#6-install-the-unit-and-switch-onto-it)
  installed ran from here; with the unit gone the tree is inert files.
- `/var/log/overflow` — the deployment's log files, root-only.
- `/var/lib/overflow-bounce` — the bounce watcher's offset state, the
  `StateDirectory` of the removed `overflow-bounce.service`.
- `/run/overflow-alert`, `/run/overflow-canary` — the alert template's and
  the canary's `RuntimeDirectory` state: the alert throttle records and the
  canary's dead-route marker. Both are tmpfs, wiped at boot, but they
  persist across runs while installed — `RuntimeDirectoryPreserve=yes` — so
  they are removed for immediate disposal rather than left to the next boot.

Two conditional stores, removed only if present:

```sh
rm -rf /var/lib/overflow/breach-log /root/overflow.service.pre-hardening
```

- `/var/lib/overflow/breach-log/` — the incident log
  [incident-response.md](incident-response.md#responsibility-and-decisions)
  defines, created at first use and never committed. If the deployment ever
  responded to a breach this log is personal data: its content belongs with
  the off-host record if the operator must keep it, and its disposal is a
  line in the preflight record.
- `/root/overflow.service.pre-hardening` — the unit copy
  [README.md section 1](README.md#1-keep-the-unit-you-are-replacing) saves
  before hardening, kept as the rollback. The rollback is over when the
  product is.

The deployment units' journald entries are the last on-host store, and their
disposal is a recorded decision rather than a command:

- **When the host retires with the product:** `journalctl --rotate` followed
  by `journalctl --vacuum-time=1s` clears the archived journal files. The
  vacuum is host-wide — it removes other units' archived entries too — which
  is what makes it legitimate only here, where everything on the host goes
  anyway.
- **When the host stays up:** do not vacuum. The entries age out under the
  host's journald policy like any other unit's entries, and the preflight
  record carries the decision and its reason.

Named retention, stated for the record: **the Node runtime stays.**
[README.md section 3](README.md#3-install-the-node-runtime-outside-root)
installs it system-wide — the runtime under `/usr/local/lib/nodejs`, the
`/usr/local/bin/node` symlink, the corepack shims in `/usr/local/sbin` —
because it is shared host infrastructure: other services on the host run on
the same runtime, and none of it is product state or holds deployment data.

## 9. Post-decommission verification

Every check is read-only. Run them after phase 8 and file the outputs with
the preflight record.

The units and timers are gone: `list-unit-files` prints a header and no
rows, `list-units` no loaded units, `list-timers` no timers.

```sh
systemctl list-unit-files 'overflow*' --no-pager
systemctl list-units 'overflow*' --all --no-pager
systemctl list-timers 'overflow*' --all --no-pager
```

```text
Unit file list: header only, no unit file rows.
0 loaded units listed.
0 timers listed.
```

The stores are gone: `ls -d` must fail on every path.

```sh
ls -d /var/backups/overflow /etc/overflow /srv/overflow /var/log/overflow \
  /var/lib/overflow-bounce /run/overflow-alert /run/overflow-canary
```

```text
ls: cannot access '/var/backups/overflow': No such file or directory
ls: cannot access '/etc/overflow': No such file or directory
ls: cannot access '/srv/overflow': No such file or directory
ls: cannot access '/var/log/overflow': No such file or directory
ls: cannot access '/var/lib/overflow-bounce': No such file or directory
ls: cannot access '/run/overflow-alert': No such file or directory
ls: cannot access '/run/overflow-canary': No such file or directory
```

The database and both roles are gone. Each query prints nothing on its own;
the fallback line confirms the emptiness came from the database answering,
not from a query that could not run:

```sh
sudo -u postgres psql -tAc "select datname from pg_database where datname = 'overflow'" \
  | grep . || echo "overflow database: gone"
sudo -u postgres psql -tAc \
  "select rolname from pg_roles where rolname in ('overflow_app','overflow_backup')" \
  | grep . || echo "overflow roles: gone"
```

```text
overflow database: gone
overflow roles: gone
```

Any leftover database the preflight record named — a drill or replacement
copy — is verified gone by the same shape, with its own exact name.

The journald decision is verified by measurement, not by trust. Against the
`journalctl --disk-usage` reading the preflight record took in phase 2:
after a vacuum the archived-journal footprint is far below it; on the
no-vacuum path it is unchanged. A reading that matches neither expectation
means the step did not do what the record claims — re-run it and read
again.

```sh
journalctl --disk-usage
```

```text
Archived journal size far below the preflight record's reading (vacuum
path), or unchanged from it (no-vacuum path).
```

The webhooks are gone: spot-check a repository from the sweep list and
assert no Overflow webhook remains — the repository may carry unrelated
webhooks, so the list need not be empty. The Overflow webhook is the one
whose `config.url` carries the deployment's `GITHUB_WEBHOOK_URL` and the
`hook=<uuid>` parameter registration appends.

```sh
gh api "repos/<owner>/<name>/hooks" --jq '.[] | .config.url'
```

```text
No URL in the output carries the deployment's GITHUB_WEBHOOK_URL or a
hook=<uuid> parameter: no Overflow webhook remains.
```

The applications are gone: neither the GitHub App nor the OAuth application
appears in GitHub's developer settings, and the App's page answers 404. The
off-host destinations are closed: the mailboxes receive nothing, and the
Discord channel carries no Overflow webhook in its integration settings.
The backups channel carries no remaining backup messages:

```sh
# Read-only. The osc identity's connector serves the call, as in phase 6.
python3 ~/.agent-bundle/scripts/discord_mb.py connector osc &
connector_pid=$!
python3 ~/.agent-bundle/scripts/discord_mb.py conversation osc 100 \
    --channel "<the backups channel's id, from the preflight record>" --json
kill "$connector_pid" 2>/dev/null || :
```

```text
[]
```

File the completed checklist with the preflight record. The deployment is
decommissioned.
