# Incident response for Overflow operators

## Responsibility and decisions

The maintainer, **Nitjsefnie**, decides the response and any notifications, and
is responsible for sending them. Operators preserve evidence and carry out the
agreed containment and recovery. Record what is known, what is inferred and
what remains unknown; do not put credentials in the incident record.

The private contact route is GitHub's private vulnerability reporting on the
Nitjsefnie/Overflow repository; its report entry point is
https://github.com/Nitjsefnie/Overflow/security/advisories/new, and the
setting was verified enabled on 2026-09-30 (`gh api
repos/Nitjsefnie/Overflow/private-vulnerability-reporting` returns
`{"enabled":true}`). Sensitive incident reports and sensitive data-subject
requests go there; non-sensitive contact stays on the public issue tracker.
This follows #650 and #679, which remain the source of the contact decision.

Nitjsefnie keeps the incident log in `/var/lib/overflow/breach-log/` on the
service host: a directory owned by root, mode 0700, holding one Markdown
file per breach, named `YYYY-MM-DD-<short-slug>-UTC.md`. It does not exist
yet; create it at first use with `install -d -m 0700
/var/lib/overflow/breach-log`. The log is never committed to the public
repository and never copied into it. The responding operator writes entries
as they respond; Nitjsefnie owns the record and its notification decisions.

Private vulnerability reporting: see #642. Alerting: see #651.

Steps: [detect and triage](#detect-and-triage), [contain](#contain),
[scope](#scope), [recover](#recover), [record](#record),
[notification decision](#notification-decision),
[communicate with affected people](#communicate-with-affected-people).

## Detect and triage

Record the discovery time in UTC, the report or symptom, affected account and
repository IDs, the suspected start and end of the incident, and whether abuse
is continuing. Bring the evidence to Nitjsefnie. Preserve the relevant journal
window immediately; widen it as new evidence changes the suspected window.
Do not wait for a complete scope before containing active abuse.

### Journal retention and immediate preservation

Measure before relying on the journal. It is size-bound, so neither its disk
usage nor an earlier oldest-entry date promises a number of days. As root on
the service host, measure all three separately in UTC:

```bash
journalctl --disk-usage
journalctl -u overflow.service --utc --no-pager -q -o short-iso-precise | head -1
journalctl -u overflow.service --utc --no-pager -q -o short-iso-precise \
  --grep 'Privileged action' | head -1
```

The first measures host-wide usage; the second finds the oldest retained unit
entry; the third finds the oldest retained privileged-action start. Record
the measurement time and those bounds in the restricted breach log, not the
line contents in a public issue. No matching line means no retained match,
not proof that no action occurred. Size pressure can remove older entries
sooner, and a unit start predating privileged-action logging cannot supply
that missing evidence.

Security log lines carrying client IP addresses have a **configured 90-day
retention horizon** in a root-only export outside the size-bound journal,
following the sponsor's retention decision in #1076. On this host,
`overflow-journal-export.timer` runs daily at 00:20 UTC with `Persistent=true`;
`overflow-journal-export.service` invokes
`/usr/local/sbin/overflow-journal-export.sh`. It exports complete UTC days of
`overflow.service` to `/var/log/overflow-journal/overflow-YYYY-MM-DD.log.gz`,
catches up days still available in the journal, skips existing day files and
prunes files older than the 90-day cutoff. The directory is root:root 0700
and the exports are root:root 0600. This is the host's configured horizon,
not a promise of 90 days of populated history: it cannot recover entries
already lost before export, and today's incomplete day remains in the journal.

Before scoping beyond the journal's measured reach, inspect the export as
root and check its actual date coverage and permissions:

```bash
systemctl is-enabled overflow-journal-export.timer
systemctl list-timers --all --no-pager overflow-journal-export.timer
stat -c '%a %U:%G %n' /var/log/overflow-journal
ls -l /var/log/overflow-journal/overflow-*.log.gz
```

Use the relevant daily files for older evidence and the journal for recent
entries. Inspect each selected file locally with `gzip -cd <export-file>`;
preserve the full objects, including continuation lines, as described in
[Journal and request correlation](#journal-and-request-correlation). Preserve
selected originals in the maintainer-approved restricted evidence location
before pruning removes them; record file locations, date bounds and gaps.
Do not paste client addresses or journal contents into public notices.

For the journal still present, replace the example UTC bounds and choose a
new file in the maintainer-approved evidence location. Export the full window,
including the object fields that can span multiple journal entries:

```bash
umask 077
set -o noclobber
journalctl -u overflow --utc --since '2026-09-26 00:00:00 UTC' \
  --until '2026-09-27 00:00:00 UTC' --no-pager -o short-iso-precise \
  > incident-journal.txt
```

`incident-journal.txt` is an example output filename, not the incident-log
location decision. Preserve the original export with restricted access; keep
working notes separately. The service's stdout and stderr go to the journal
according to [overflow.service](overflow.service).

## Contain

Choose the narrowest action that stops the observed abuse. If the extent of
compromise is unknown or requests must stop immediately, stop the service:

```bash
systemctl stop overflow.service
systemctl is-active overflow.service
```

Expect `inactive` and a nonzero status from `is-active`. Restart only after the
recovery checks below. Revocation and demotion do not undo completed work or
guarantee cancellation of requests that already passed authentication.

### Revoke one API token

Use an operator-authorized `psql` connection to the intended database, as in
[README.md](README.md). Confirm the database destination separately; never
paste its connection secret into the incident record. The following recipes
are pasted into `psql` (`\set` is a psql command). Replace example UUIDs with
the observed IDs and save the returned non-secret fields before mutation.

```sql
\set ON_ERROR_STOP on
\set actor_id '00000000-0000-4000-8000-000000000001'
\set token_id '00000000-0000-4000-8000-000000000002'
SELECT id, user_id, created_at, expires_at, last_used_at
FROM api_tokens
WHERE id = :'token_id'::uuid AND user_id = :'actor_id'::uuid;

DELETE FROM api_tokens
WHERE id = :'token_id'::uuid AND user_id = :'actor_id'::uuid
RETURNING id, user_id, created_at, expires_at, last_used_at;
```

Expect one returned row and `DELETE 1`. Zero means that exact issuance is no
longer present or the account/issuance IDs do not match: check the current
token metadata in [Scope](#scope), rather than deleting another issuance by
guess. The bearer lookup requires a matching unexpired row, so deletion stops
future authentication with that token. This does not invalidate sessions or
prevent an account with access from minting a replacement. A revoked token
cannot be recovered; issue a fresh one only after account access is secured.
The SQL operation does not emit a `Privileged action` line; record it manually.

### Demote a moderator

The application route is `POST /api/moderation/moderators`, with JSON fields
`targetAccountId` and `moderator: false`, authorized by a trusted moderator.
It records `moderator_role_changes` and a `moderator-role.revoke` journal entry,
and refuses to revoke the last moderator. Prefer that route when a trusted
moderator and a safe application instance are available.

For emergency operator containment with the service stopped, use this direct
SQL recipe. It deliberately bypasses the application's last-moderator guard
and does **not** produce an application audit row or journal line. Capture its
output and the operator's identity in the incident record:

```sql
\set ON_ERROR_STOP on
\set target_id '00000000-0000-4000-8000-000000000001'
SELECT id, github_user_id, role FROM users WHERE id = :'target_id'::uuid;

UPDATE users SET role = 'MEMBER', updated_at = now()
WHERE id = :'target_id'::uuid AND role = 'MODERATOR'
RETURNING id, github_user_id, role, updated_at;
```

Expect one row with `role = MEMBER` and `UPDATE 1`; zero means missing or
already demoted. Moderator gates read the current database role for both
session and bearer requests, so a cached JWT role does not preserve moderator
authority. Demotion leaves ordinary member access available.

Remove the target's numeric GitHub user ID from `MODERATOR_GITHUB_USER_IDS`
in the service environment before restarting: `src/auth.ts` and
`src/lib/auth/account-store.ts` make that list a floor that promotes the
account again at sign-in. Removing the ID alone does not demote the stored
role. Confirm there is a trusted moderator for recovery; the same bootstrap
list can restore trusted access on sign-in if all moderators were demoted.

### Invalidate every session

`src/auth.ts` uses JWT sessions; there is no stored session ID to revoke.
Replace **`AUTH_SECRET`** in the root-only service environment file specified
by [README.md](README.md), keeping its ownership and mode. Configure a fresh
secret without retaining the compromised secret as a fallback. Do not include
either value in commands saved as evidence. Configure the replacement secret
while the service is stopped, and load it only at the approved recovery start
(see [Recover](#recover)); restarting is what loads it, and as the
[Contain](#contain) section requires, restart only after the recovery checks
are done:

```bash
systemctl restart overflow.service
systemctl is-active overflow.service
```

Expect `active`; perform the readiness check in [Recover](#recover). Once the
new process holds only the new secret, old JWT sessions cannot be decrypted
and users must sign in again. Restarting without changing `AUTH_SECRET` does
not invalidate them. This does not revoke database-backed API tokens or
resolve compromised GitHub access; the latter is handled in [Account loss and
account compromise](#account-loss-and-account-compromise). Do not restore a
compromised auth secret as a recovery shortcut.

### End one account's sessions

Replacing `AUTH_SECRET` ends every member's sessions. Ending one account's
sessions needs only the account's session epoch: every cookie carries the
`session_epoch` it was minted under, and the session refresh — the jwt
callback in `src/auth.ts` — compares that claim against `users.session_epoch`
and refuses a mismatch. In the authorized `psql` session, replace the example
id with the account's GitHub user id:

```sql
\set ON_ERROR_STOP on
\set github_user_id 424242
UPDATE users SET session_epoch = session_epoch + 1 WHERE github_user_id = :'github_user_id';
```

Expect `UPDATE 1`; zero means no account carries that id, and the sessions it
was believed to hold were never anchored to an epoch this ends. The bump ends
every session the account holds at its next refresh without touching any
other account, and the account can sign in again immediately — a fresh
sign-in stamps the new epoch, so the revoked cookies stay dead while the
account recovers. Signing out through the product (`POST /api/auth/signout`)
runs the same bump, so a member can end the sessions of a cookie they know
has been copied.

### Request flood

A flood of webhook deliveries reaches the receivers' decline signal before it
reaches anything else: each receiver answers a declined delivery with 429 and
journals the burst's start — once per burst, never per request — with a fixed
template an operator can grep for. Read the signal over the preserved window
([Journal retention and immediate
preservation](#journal-retention-and-immediate-preservation) is the export
procedure):

```bash
journalctl -u overflow --utc --no-pager -o short-iso-precise \
  --grep 'Webhook rate limit engaged'
```

The line names the receiver and the running decline count, in this exact
shape (issue 1053):

```text
Webhook rate limit engaged for the github receiver (declines so far: 12).
Webhook rate limit engaged for the gitlab receiver (declines so far: 3).
```

Identify the flooded entry point and source from the nginx access log, whose
shape, sharing and retention are described in [Journal and request
correlation](#journal-and-request-correlation): correlate the burst's time
window with the access log and read the request path and source address off
the 429 answers. The path names the flooded receiver
(`/api/github/webhooks` or `/api/gitlab/webhooks`); the addresses say whether
the source is one origin — which a direct block can stop — or many, which
only a limit can.

Tightening has two speeds. The receivers' limits are code:
`WEBHOOK_RATE_LIMIT_CAPACITY` and `WEBHOOK_RATE_LIMIT_REFILL_PER_MINUTE` in
[src/lib/webhooks/rate-limit.ts](../src/lib/webhooks/rate-limit.ts) bound each
receiver's burst and refill, and lowering them is an ordinary reviewed change
through [README.md](README.md)'s deployment procedure — that is the fix for a
sustained flood that should persist. For immediate relief at the origin, the
deployment carries no request-rate limit today, so one is applied on the host
for the incident: scope a temporary nginx `limit_req` — or a `deny` of a
single abusive source — to the flooded location in the affected vhost, then
validate and load it with `nginx -t && systemctl reload nginx`, the same
mechanics [README.md](README.md) section 13 uses for the privileged-proxy
include. Stop the service instead ([Contain](#contain)) when even that is too
slow or the flood carries other traffic with it.

Lift the temporary host-side limit afterwards, once the burst's grep above
stays quiet and the access log's 429 answers have stopped: record the exact
lines in the incident record first, so the lift restores precisely what stood
before, then remove the temporary configuration and reload with `nginx -t &&
systemctl reload nginx` again. A code-level limit change is not lifted; it is
a reviewed correction that stays.

## Scope

### Database history by actor, credential and time

In the same authorized `psql` session, replace the example account UUID and
UTC bounds. Use a half-open window (`from_time` inclusive, `to_time` exclusive)
so adjoining windows do not double-count rows:

```sql
\set ON_ERROR_STOP on
\set actor_id '00000000-0000-4000-8000-000000000001'
\set from_time '2026-09-26 00:00:00+00'
\set to_time '2026-09-27 00:00:00+00'
SELECT id, actor_id, target_account_id, new_role,
       credential_kind, credential_token_id, created_at
FROM moderator_role_changes
WHERE actor_id = :'actor_id'::uuid
  AND created_at >= :'from_time'::timestamptz
  AND created_at < :'to_time'::timestamptz
ORDER BY created_at, id;

SELECT id, actor_id, target_user_id, prior_state, new_state, reason,
       credential_kind, credential_token_id, created_at
FROM moderation_events
WHERE actor_id = :'actor_id'::uuid
  AND created_at >= :'from_time'::timestamptz
  AND created_at < :'to_time'::timestamptz
ORDER BY created_at, id;
```

Start with all credentials for the actor so that a change from token to
session is visible. To isolate a suspected issuance across both tables:

```sql
\set ON_ERROR_STOP on
\set actor_id '00000000-0000-4000-8000-000000000001'
\set token_id '00000000-0000-4000-8000-000000000002'
\set from_time '2026-09-26 00:00:00+00'
\set to_time '2026-09-27 00:00:00+00'
SELECT 'moderator_role_changes' AS source, id, actor_id,
       target_account_id AS target_id, credential_kind, credential_token_id,
       created_at
FROM moderator_role_changes
WHERE actor_id = :'actor_id'::uuid AND credential_kind = 'token'
  AND credential_token_id = :'token_id'::uuid
  AND created_at >= :'from_time'::timestamptz
  AND created_at < :'to_time'::timestamptz
UNION ALL
SELECT 'moderation_events' AS source, id, actor_id,
       target_user_id AS target_id, credential_kind, credential_token_id,
       created_at
FROM moderation_events
WHERE actor_id = :'actor_id'::uuid AND credential_kind = 'token'
  AND credential_token_id = :'token_id'::uuid
  AND created_at >= :'from_time'::timestamptz
  AND created_at < :'to_time'::timestamptz
ORDER BY created_at, source, id;
```

`credential_kind = 'session'` identifies the authentication kind only, not a
particular browser or session JWT. `credential_kind = 'token'` plus
`credential_token_id` identifies the issuance. All-null credential fields
mean unknown: historical rows and writes by an older release have that shape.
They are not evidence of a session or of no credential. The token ID has no
foreign key, so history survives revocation, regeneration and account deletion.
Do not use an inner join to current tokens to decide which history exists.

### Current token metadata

```sql
\set ON_ERROR_STOP on
\set actor_id '00000000-0000-4000-8000-000000000001'
SELECT id, user_id, created_at, expires_at, last_used_at
FROM api_tokens
WHERE user_id = :'actor_id'::uuid;
```

There is at most one current token row per account. `last_used_at` is updated
inside the token lookup statement only when null or older than one minute.
It has throttled, one-minute resolution; it is not a request log, exact last
request time, request count, or proof that a privileged action succeeded.
Authentication can succeed before a later authorization or mutation fails.
Null is not proof of no historical use, especially across older releases.

Regeneration rotates `api_tokens.id`, clears `last_used_at`, and resets
issuance/expiry timestamps, so an ID names one issuance under this release.
The former row is not retained. An older release running after rollback does
not rotate the ID or stamp last use; mark that interval as a correlation gap.
No recipe selects bearer material or its hash.

### Journal and request correlation

First [measure the journal's reach and inspect the root-only daily exports](#journal-retention-and-immediate-preservation).
Privileged-action entries carrying client addresses have a configured 90-day
export horizon; use `/var/log/overflow-journal/overflow-YYYY-MM-DD.log.gz` when
the suspected window is older than the live journal. Record actual coverage
and gaps; the horizon does not manufacture missing history. For a window
still in the journal, locate the fixed message:

```bash
journalctl -u overflow --utc --since '2026-09-26 00:00:00 UTC' \
  --until '2026-09-27 00:00:00 UTC' --no-pager -o short-iso-precise \
  --grep 'Privileged action'
```

This filter locates starts, not necessarily whole objects. The logger calls
`console.info("Privileged action", { action, actorId, credential, clientAddress, clientAddressVerified, subject })`;
Node may print the object over multiple lines. Inspect the full exported
window around each match for all fields; do not treat this output as JSON or
throw away continuation entries.

The implemented action names and `subject` keys are:

| `action` | `subject` keys |
| --- | --- |
| `moderator-role.grant`, `moderator-role.revoke` | `targetAccountId` |
| `audit.open`, `audit.dismiss`, `audit.substantiate` | `auditId`, `targetAccountId` |
| `recalibration.close` | `targetAccountId` |
| `ban.reverse` | `targetAccountId` |
| `credit-adjustment.create` | `adjustmentId`, `targetAccountId` |
| `credit-adjustment.reverse` | `adjustmentId`, `reversalId`, `targetAccountId` |
| `repository.rederivation-request` | `repositoryId` |
| `settlement-override.grant`, `settlement-override.decline` | `overrideRequestId`, `issueId` |
| `sanction.contest.decide`, `sanction.contest.decide.already_gone` | `requestId`, `accountId` |

Match journal `actorId` to SQL `actor_id`, `credential.kind` to
`credential_kind`, and `credential.tokenId` (when present) to
`credential_token_id`. Compare the journal timestamp with `created_at` and
confirm the target/subject and action. These are correlation clues, not a
unique join key: journal emission follows the successful operation, times can
differ, and concurrent actions can be ambiguous. These two history tables
are not a ledger of every action in the table above; retain the journal and
follow its subject IDs when scoping other actions. Missing journal output is
not proof of no mutation, particularly beyond retention or after a crash.

`clientAddress` appears in the journal and its root-only daily exports, never
in these database rows.
The app listens on `127.0.0.1`, but loopback is not a trust boundary: any
local process can reach the listener and set `X-Real-IP` itself, so an
address in the journal is a claim unless the request also carried the
`x-privileged-proxy-secret` header with exactly the value of
`PRIVILEGED_PROXY_SECRET`, in which case the entry's `clientAddressVerified`
is true. Only nginx (and the operator who configured both sides) hold that
secret, so a verified flag says the address is the one nginx recorded.
`readClientAddress` validates a single address with `node:net` `isIP()`,
returning null for an invalid or absent header; the app never reads
`X-Forwarded-For`, and the MCP adapter forwards `x-real-ip` to its wrapped
routes. Read `clientAddressVerified` before reasoning from an address: an
unverified entry names a claimed address, not a proven one — entries written
before a host applies the deploy steps are unverified by design
([deploy/README.md section 13](README.md#13-verifying-the-privileged-action-journals-client-addresses)
has the operator procedure), and a verified flag is only as good as the
secret's secrecy. If the proxy or loopback boundary was bypassed or
compromised, do not trust the address.

The nginx access log contains IP, path and user agent, with no account, and
is shared by every site on this host and kept 14 days (host facts measured on
2026-09-26). Preserve its relevant window and rotated files immediately.
Confirm the host's configured access-log location rather than assuming a
per-Overflow path. Correlate time, IP and request path with the journal; an
IP or user agent alone does not identify an account or person. Shared-log
requests may belong to other sites. Neither log's retention guarantees that
an older incident is fully observable.

## Recover

Have Nitjsefnie approve the recovery based on the scoped cause and affected
actions. Secure the affected accounts, replace compromised credentials and
review unauthorized role grants and mutations before reopening access. Do
not erase history to conceal or reverse an incident; `moderation_events` is
immutable. Record any corrective action and its relationship to the original.

Use [README.md](README.md)'s deployment and rollback procedure for a reviewed
fix, or [backup-restore.md](backup-restore.md) if a restore is necessary. A
release rollback does not revoke credentials or undo database mutations, and
an older release can leave the credential/last-use gaps described above.

If the service was stopped, start it after containment configuration is in
place and check the same readiness endpoint used by the deployment procedure:

```bash
systemctl start overflow.service
systemctl is-active overflow.service
curl --connect-timeout 5 --max-time 30 --retry 30 --retry-delay 1 \
  --retry-connrefused -fsS -o /dev/null -w '%{http_code}\n' \
  http://127.0.0.1:3000/api/readiness
journalctl -u overflow -n 100 --no-pager
```

Expect `active` and HTTP `200`. Verify trusted access works, the revoked token
is refused, the demoted account cannot moderate, and old sessions require
sign-in after an auth-secret rotation. Readiness alone proves none of those
containment properties. Re-scope the journal and database after recovery to
look for continued unauthorized activity; keep the incident open if it recurs.

### Account loss and account compromise

Every step elsewhere in this runbook that ends in a merge, a label or a
settings change needs the maintainer's GitHub account, `Nitjsefnie`. That
account is the repository owner — a user account, not an organization — the
sole admin collaborator, the only account that branch protection's
`enforce_admins` setting reaches, and the account the Overflow Ledger App
belongs to. This section is what to do when that account is gone or held by
someone else.

The four cases are different incidents, not one with four names:

- **Deleted.** If any access remains, fork or clone before anything else — while
  it does, this repository is public, so an anonymous clone needs no account at
  all. Then expect the repository, the App and the username to be gone.
  Deleting a personal account deletes every repository that account owns and
  frees the username — GitHub platform behaviour, documented under *Deleting
  your personal account* in GitHub Docs, not an Overflow policy. This is a
  personal repository — `Nitjsefnie` is the owner as a user account, not an
  organization ([OPERATING.md](../OPERATING.md#governance-single-maintainer-operation))
  — so it goes with the account, and it is the settlement evidence: the fold
  prices settlements from issue labels and comment history read off it. A
  service that keeps serving says nothing about whether the evidence survived.
  If the account has already gone, no clone is left to take and the settlement
  evidence is not recoverable: the code survives in the deployment tree's own
  clone at `/srv/overflow` ([deploy/README.md](README.md) section 5), but issues,
  labels, comments and pull-request history do not. Because the username is
  freed rather than reserved, this runbook's account is not recoverable by
  re-registering it either; treat the repository as evidence first and the
  account second.
- **Locked by platform action.** The platform action reaches the account, not
  the host and not the database. The service keeps serving, the ledger keeps
  reading and pricing, and merges, labelling and every settings change stop
  until access returns. Nothing already merged or already labelled is undone by
  the platform action itself, because none of it lived in the account.
- **Under an attacker's control.** Treat it as the compromise it is, and read
  the paragraph below before acting: [Contain](#contain) is service-side and
  cannot reach the account. An attacker holding the account can merge, label,
  administer branch protection and administer the App for as long as they hold
  it, and noticing that requires someone outside the account.
- **Simply absent, nothing wrong yet.** No containment is warranted. The steps
  below still apply from the moment access is genuinely lost, because nothing
  in them is cheap to reverse afterwards.

**Account-side containment is not in this runbook, and in the compromise case
it is the urgent action.** [Contain](#contain) operates on the running service
and its database: its steps' operands are `api_tokens`, `users.role` and
`AUTH_SECRET` in `/etc/overflow`, so they revoke a database-backed API token,
demote a moderator and invalidate Overflow sessions. None of those is a GitHub
session, a personal access token, an OAuth authorization, or the App's
installation and key. What reaches those is GitHub's own account-security
surface: revoke the account's active sessions, tokens and OAuth authorizations,
and deal with the App installation there. Nothing in this repository performs
it and this runbook does not describe it, so it is done by whoever notices the
compromise first, through whatever route they hold, and no step below is a
substitute for it. Repository administration is not that surface either: a
backup admin collaborator administers the repository and the App, and neither
reaches the account holder's sessions, tokens or recovery contacts.

In the locked, attacker-controlled and absent cases, what keeps running without
the account is the instance half of
[OPERATING.md](../OPERATING.md#governance-single-maintainer-operation): the
service under systemd, the webhook receivers, GitHub sign-in, the
reconciliation worker and its six-hour sweep, and automatic settlement pricing
from repository labels. What stops is the codebase half: merges, issue triage,
`offered:` and `settled:` labelling, deployment, secret rotation, and any
change to branch protection, a registration's webhook or the App. The deleted
case is not covered by that list, and the reason is now settled: at least two
of its five entries read this repository, and the deleted case removes the
repository. The reconciliation worker and automatic settlement pricing
therefore stop with it — not because of the account, but because their source is
gone — while the service, the webhook receivers and GitHub sign-in run on the
deployment host and keep running. If any access remains, take the fork or clone
first: it is the only copy of the settlement evidence that will exist, while
the three entries that survive run on the host without it.

**The Apps' own credentials are not the personal account's session.** The
read-only reconciliation App has Metadata, Issues and Pull requests read
access and no webhook. The reconciliation path mints a
short-lived RS256 JWT from a PEM file on the host and exchanges it for an
installation token; it never presents a session, a personal access token or an
OAuth token of the maintainer's. The file is named by
`GITHUB_APP_PRIVATE_KEY_PATH`, at the host value
`/etc/overflow/github-reconcile-app/private-key.pem`, beside `GITHUB_APP_ID`, in
[deploy/README.md](README.md)'s *Create the environment file* section; the
implementation is `readGitHubAppAuthConfig` in
[src/lib/github/app-installation-auth.ts](../src/lib/github/app-installation-auth.ts),
imported only by the Node reconciliation wiring. The independence does not
hold in either of the two postures [deploy/README.md](README.md) names: either
variable unset or empty is the OAuth-only posture, and — with both set — a
repository the App is not installed on still falls back to the sponsor's OAuth
token, which is a personal credential. This repository has the installation,
so neither posture is expected here; a host that does not is running on a
personal credential for that repository whatever its variables say. The relay
uses a separate check-publishing App and does not depend on either posture.
That App has no credential on the host: its workflow reads its App key from
the repository's `overflow-ledger` environment secret and pins the App id and
installation id in the workflow definition itself, so the check-runs that
satisfy branch protection keep being posted whenever a producer run completes
and GitHub triggers the relay, with no personal account involved in the run.
See [OPERATING.md](../OPERATING.md#required-checks-relay) for its operations
and [deploy/README.md](README.md) section 10 for why the required contexts are
pinned to that App at all.

**Four limits on that claim, because the honest version is the useful one.**
Each is a stated fact. Three say what to do about it; the second separates
the host credential from the Actions secret.

1. **A deleted account takes the App with it.** The Overflow Ledger App belongs
   to `Nitjsefnie`, and installations under a deleted personal account are
   removed with it — the same GitHub Docs page, the same platform behaviour.
   This is not an unknown any more, and the consequence is worth stating
   plainly: after a deletion there is no App, so the relay has no identity to
   post check-runs as, and no required check is satisfied by anyone, the App
   having been the only producer branch protection accepts. The App's identity belongs to the account,
   and the account is gone. And the username is freed rather than reserved, so
   the App is not recoverable by re-registering either.
2. **The host PEM and the Actions secret belong to separate Apps.** The
   file at `GITHUB_APP_PRIVATE_KEY_PATH` is the read-only reconciliation App's
   key. The `LEDGER_APP_KEY` secret belongs to the check-publishing App,
   whose credential is absent from the host. Rotate each App's key separately;
   never copy the reconciliation key into the relay's Actions secret.
3. **The relay fires unattended today, and a gate would change that.** Read
   from the GitHub API, the `overflow-ledger` environment's only protection
   rule is `branch_policy` — protected branches, `can_admins_bypass` false —
   and there is no required-reviewer rule. So nothing stands between a producer
   run completing and the relay posting the required check-runs, which is the
   independence the paragraph above claims. Adding a required-reviewer rule
   would be a settings change, and it is held as a pair with the backup-admin
   invite below: the maintainer's own action, not a commit, and this runbook
   deliberately does not carry the procedure. If that gate is ever added, every
   relay run waits for a human and the personal account is back inside the loop.
4. **A deleted account takes the repository with it,** by the same platform
   behaviour and the same citation. That makes the relay's independence moot
   rather than false: the workflow can still run and still mint a token, but
   there is no repository left to post a check-run against and no branch left
   to protect. Nothing recovers the settlement evidence except the fork or
   clone taken before the account went, which is why the deleted case puts that
   first.

**A backup admin collaborator, if one is ever invited.** Today none is
invited, and this runbook does not create one. If the maintainer later invites
a second admin collaborator, that person can merge a pull request, apply
`offered:` and `settled:` labels, administer branch protection, administer the
Overflow Ledger App including rotating its key and its installation, and
rotate a registration's webhook secret. That person cannot act as the
repository owner — there is no organization owner to escalate to, because this
is a personal repository — and cannot recover the personal account itself;
only GitHub's account-recovery process reaches that. Inviting one is a
repository settings change rather than a commit, it is the maintainer's
action, and as of this writing it has not been done.

**The procedure, in order.**

1. Establish which of the four cases above this is, and record the UTC
   discovery time, before touching anything. Everything else depends on it:
   absence needs no change, compromise needs containment first.
2. Confirm the instance side is unaffected, on the host, as root:

   ```bash
   systemctl is-active overflow.service
   curl --connect-timeout 5 --max-time 30 -fsS -o /dev/null -w '%{http_code}\n' \
     http://127.0.0.1:3000/api/readiness
   ```

   Expect `active` and HTTP `200`. A non-`200` or `inactive` is a host
   problem, not an account problem, and is recovered by the rest of
   [Recover](#recover) regardless of the account's state.
3. For a compromised account, do the account-side containment above first. It
   is the only action that stops the attacker, and it is not one this runbook
   can perform, so it does not wait on anything below. Then contain the service
   side through [Contain](#contain): revoking database-backed API tokens,
   demoting moderators and invalidating sessions is still worth doing, because
   a GitHub sign-in the attacker holds mints new sessions and new tokens — but
   it does not reach the account, and on its own it stops nothing at GitHub.
4. Best effort, and only if some access to the repository remains — a
   maintainer's token, or a backup admin's — establish what is actually blocked
   by observation rather than assumption:

   ```bash
   gh api repos/Nitjsefnie/Overflow/collaborators \
     --jq '[.[] | select(.permissions.admin)] | length'
   gh api repos/Nitjsefnie/Overflow/branches/main/protection \
     --jq '{required: .required_status_checks.contexts, enforce_admins: .enforce_admins.enabled}'
   ```

   Both are read-only. The first prints the number of admin collaborators, the
   second prints the required contexts and whether administrators are enforced.
   Neither is answerable without an account holding permission on the
   repository, so in the loss case this step cannot be performed and its
   omission is expected rather than a fault to chase — that is the case the
   section is written for. A non-200 or a 404 from either means that token has
   no permission, not that the setting is absent. Run both again in step 8.
5. Record where each App's key material lives, without copying any of it into
   the incident record. The reconciliation App's host file needs only root on the deployment host
   and works with no repository access at all:

   ```bash
   ls -l /etc/overflow/github-reconcile-app/private-key.pem
   ```

   Record the path's presence, its owner, its group and its mode; the file has
   to stay readable by the account the service runs as, which is why
   `/etc/overflow` is left traversable on a reconciliation App host. The path is absent if
   the host runs the OAuth-only posture, and that absence is itself the record.
   The separate check-publishing App's `LEDGER_APP_KEY` secret on the `overflow-ledger`
   environment — is observable only by an account that can read the
   repository's settings, so record that you could not read it when you could
   not. Never `cat` the file, never paste its contents, and never record the
   secret's value.
6. Independent of the account and therefore still running throughout: the
   service, the webhook receivers, GitHub sign-in, the reconciliation worker
   and automatic settlement pricing. No step in 1 to 5 stops any of them, and
   none of steps 1 to 5 needs a merge, a label or a settings change to
   complete. In the deleted case the last two stop, because the repository they
   read is gone; the first three run on the deployment host and do not.
7. Blocked until access returns: merges, triage, `offered:` and `settled:`
   labelling, deployment, secret rotation, moderator roster changes, and any
   correction request only a moderator can grant or decline. A `settled:` label
   cannot be applied and its rationale comment cannot be posted, so a merge
   closes no settlement in the fold; leave such an issue open rather than
   closing it by hand.
8. When access returns, verify it is the maintainer's own and not an attacker
   still holding the account — new sessions, new SSH and signing keys, and the
   account's own recovery contacts — before treating anything as recovered.
   Then return to [Contain](#contain) for whatever containment the compromise
   case required, and record the whole of it under [Record](#record).
9. Rotating the reconciliation App's private key has a written procedure:
   [deploy/README.md section 14](README.md#14-rotating-the-reconciliation-app-private-key)
   covers generating the new key in the App settings, replacing the host PEM,
   verifying reconciliation under the new key, and the rollback that is
   possible while the old key still exists. The reconciliation App's key is
   host-only; no CI secret is derived from it.

## Record

In the breach log (see [Responsibility and
decisions](#responsibility-and-decisions)), keep a UTC timeline of discovery,
decisions, containment and recovery; who performed each action; affected
account, token-issuance and subject IDs; returned SQL results; evidence export
locations and time bounds; deployed release/rollback intervals; observed
impact; and unresolved questions. Mark evidence lost to retention or missing
from older releases. Record failed or zero-row containment attempts as well
as successful ones, including direct SQL actions absent from app audit logs.

Keep evidence access restricted. Do not copy bearer tokens, token hashes,
cookie values, session JWTs or auth secrets into notes or log excerpts. The
credential references above are deliberately sufficient for correlation
without those secrets. Record who may access the evidence and the
maintainer's decision about its handling; this runbook sets no new retention
period for incident evidence or database rows.

### Breach-log entries

Every breach gets a timestamped entry in the log, written as the response
proceeds, including a breach for which notification was not made: Article
33(5) GDPR requires documenting those too, with the reasons for not
notifying. The log is the record required by Article 33(5) GDPR, and it
exists so scope reconstruction and any later supervisory-authority
verification do not depend on the journal's measured, size-bound reach or
the privileged-action export's configured 90-day horizon. Preserve relevant
evidence before either source loses it; measure actual coverage and record
gaps using [Journal retention and immediate preservation](#journal-retention-and-immediate-preservation).

Each entry records:

- **Facts**: what happened and how it was detected; discovery time in UTC;
  suspected start and end in UTC; systems and data affected.
- **Effects**: likely and actual effects on the people whose data was
  involved, for confidentiality, integrity and availability.
- **Remedial action**: containment and recovery actions taken, by whom, and
  when.
- **Notification decision and timing**: whether the supervisory authority
  was notified and when; whether data subjects were communicated and when;
  where notification was not made, the reasons for that decision.
- **Scope reconstruction**: affected account, token-issuance and subject
  IDs; journal, root-only daily export and nginx access-log time bounds and
  file locations; evidence access restriction: who may access the evidence
  and the maintainer's handling decision.
- **Record-keeping**: who wrote the entry and when; who approved it.

## Notification decision

Nitjsefnie decides whether notification is required, who receives it, what it
says and when, and sends it. Present the known scope, affected data/actions,
impact, evidence gaps and containment status for that decision. Record the
decision, reasoning, decision time and any notifications actually sent; the
decision and its timing are recorded in the breach log (see
[Record](#record)).

The supervisory authority is Úřad pro ochranu osobních údajů (ÚOOÚ), the
Czech Republic's supervisory authority for personal data protection
(https://uoou.gov.cz). That characterisation is evidence-based, not a legal
opinion: the controller is Nitjsefnie personally (maintainer decision of
2026-09-28, recorded in #679), and the evidence of establishment points at
the Czech Republic, through the maintainer's public GitHub profile and
organisations (for example Consultest-CZ) and the .cz domains operated by
the account. Whether that evidence amounts to establishment is
specialist-dependent in character; the authority above is stated on that
evidence.

The statutory frame that decision applies, cited as the articles stand in
the regulation:

- **Article 33 GDPR** (notification to the supervisory authority): notify
  without undue delay and, where feasible, no later than 72 hours after
  becoming aware of the breach, unless the breach is unlikely to result in a
  risk to natural persons' rights and freedoms. Awareness can be established
  at any point, so the clock is measured from awareness; notification not
  made within 72 hours is accompanied by reasons for the delay
  (Article 33(1)).
- **Article 33(5) GDPR**: document every breach; the breach log (see
  [Record](#record)) is that record.
- **Article 34 GDPR** (communication to data subjects): without undue delay
  where the breach is likely to result in a high risk to their rights and
  freedoms. Article 34(3) names the exceptions, among them data rendered
  unintelligible, subsequent measures making the high risk unlikely, and
  disproportionate effort, where a public communication is made instead.

## Communicate with affected people

Overflow stores no e-mail address or notification contact list for its
members: GitHub sign-in keeps the numeric user ID and login, and strips
e-mail from the session. There is no in-app incident-banner setting or
broadcast-notification control. The hosted instance publishes the
[public GitHub issue tracker](https://github.com/Nitjsefnie/Overflow/issues)
and [private vulnerability reporting](https://github.com/Nitjsefnie/Overflow/security/advisories/new)
as its contact routes; the private route receives sensitive replies rather
than broadcasting a notice. Do not promise individual e-mails or scrape
addresses to build a recipient list.

1. **Draft during triage.** The responding operator fills in the two
   skeletons below from the [scope](#scope) and containment evidence, marking
   unknowns explicitly. Keep drafts in the restricted incident record until
   approved. Describe the affected people and data in terms readers can use
   to recognize whether they may be affected, without listing account IDs,
   client addresses, journal excerpts, credentials or exploitable details.
   Do not wait for perfect scope to prepare a draft.
2. **Get the decision and a publication time.** Nitjsefnie approves the
   notification decision, audience, wording, channels and timing under
   [Notification decision](#notification-decision). Record the awareness time,
   decision time, reasons, publication target and next-update time in the
   breach log. Use that section's timing requirements; a site deployment or
   incomplete investigation must not silently postpone an approved public
   notice. Record any delay and escalate it to Nitjsefnie. Public posting is
   not proof every affected person received it; record reach limitations for
   the notification decision.
3. **Publish the approved public issue.** Nitjsefnie opens an issue on
   `Nitjsefnie/Overflow` with the public-issue draft below and keeps that URL
   as the incident's update location. Put only the approved public text
   there; sensitive questions go through private vulnerability reporting.
   Record the URL, publisher and UTC publication time. If repository access
   is lost or compromised, follow [Account loss and account compromise](#account-loss-and-account-compromise)
   and have Nitjsefnie decide a usable publication route; do not assume the
   issue channel is available or trustworthy.
4. **Publish the site notice through a code deployment.** There is no switch
   to turn on: the operator prepares a reviewed code change adding the
   approved short notice and public-issue link to both `AppShell` and
   `PublicAppShell` in `src/components/app-shell.tsx`, so members and
   signed-out visitors can see it. Merge that change to `main` and follow
   [deploy/README.md section 10](README.md#10-deploying-a-new-revision) to
   build and deploy it after recovery is approved. Verify the notice and
   link on the signed-out landing page and a signed-in member page; record
   the deployed revision and time. If containment keeps the site stopped or
   deployment is blocked, publish the approved GitHub issue first and record
   the site-notice delay. Do not edit the serving build or restart a
   contained service just to display a notice.
5. **Update and close the communication record.** At the stated next-update
   time, update the issue even if the investigation is still open, and keep
   any deployed notice consistent. Record each publication and revision,
   remaining uncertainty, questions received privately, and Nitjsefnie's
   decision about when to remove the site notice through another reviewed
   deployment. Keep the breach-log record even when notification was not
   required.

### Public issue notification draft

Replace every placeholder before publication. This is public text, not the
restricted breach log:

```text
Title: Overflow security incident — [short description], [UTC date]

Published: [UTC time]. Last updated: [UTC time].
We became aware on [UTC time] of [plain-language description of the breach].
The suspected incident window is [start/end UTC, or explicitly unknown].

Who may be affected: [recognizable group and relevant period; no account list].
Data affected: [categories and what happened to them; distinguish confirmed
facts from what is still being investigated].
Likely consequences: [effects on affected people; uncertainties].

What we have done: [containment, mitigation and recovery status].
What you should do: [specific protective steps, or why no action is currently
recommended; do not ask people to post private information].

Operator: Nitjsefnie, maintainer of Overflow.
Public questions and updates: [this issue URL].
Sensitive questions or reports:
https://github.com/Nitjsefnie/Overflow/security/advisories/new
Please do not post client addresses, credentials or private account details here.

Next update: [UTC time], including if there is no material change.
```

### Site notice draft

```text
Overflow security notice — [UTC date].
[Plain-language summary of the incident and who may be affected].
[Immediate protective action, if any].
Read the incident notice and updates: [public issue URL].
Last updated: [UTC time]. Next update: [UTC time].
For sensitive questions, use GitHub private vulnerability reporting:
https://github.com/Nitjsefnie/Overflow/security/advisories/new
```

### Tabletop completion

For a planted signal, follow [Detect and triage](#detect-and-triage), measure
the evidence bounds, scope the affected group and fill in both drafts using
synthetic facts. End with drafts ready for Nitjsefnie's decision, proposed
publication and update times, and the site deployment step identified.
Record evidence gaps and channel limitations. Keep the exercise drafts in
the restricted exercise record; do not publish an exercise as a real breach
or change the running host during the tabletop.
