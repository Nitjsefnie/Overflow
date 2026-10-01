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
[notification decision](#notification-decision).

## Detect and triage

Record the discovery time in UTC, the report or symptom, affected account and
repository IDs, the suspected start and end of the incident, and whether abuse
is continuing. Bring the evidence to Nitjsefnie. Preserve the relevant journal
window immediately; widen it as new evidence changes the suspected window.
Do not wait for a complete scope before containing active abuse.

### Journal retention and immediate preservation

Measured on 2026-09-26: `/etc/systemd/journald.conf` sets nothing (all defaults),
no drop-ins, storage is persistent (`/var/log/journal` exists), so `SystemMaxUse`
defaults to 10% of the filesystem capped at 4 GiB; `journalctl --disk-usage`
reports 4 GiB, i.e. at the cap, so retention is size-bound, not time-bound;
the oldest entry on 2026-09-26 was 2026-07-22; there is no time limit
(`MaxRetentionSec` unset) and rsyslog is not running, so the journal is the
only copy.

Re-measure before relying on those observations:

```bash
journalctl --disk-usage
journalctl --no-pager -q | head -1
```

Those are host-wide observations, not a promise that Overflow's entire
incident window is present. Size pressure can remove older entries sooner.
As root on the service host, replace the example UTC bounds and choose a new
file in the maintainer-approved evidence location. Export the full window,
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

Locate the fixed message within the preserved time window:

```bash
journalctl -u overflow --utc --since '2026-09-26 00:00:00 UTC' \
  --until '2026-09-27 00:00:00 UTC' --no-pager -o short-iso-precise \
  --grep 'Privileged action'
```

This filter locates starts, not necessarily whole objects. The logger calls
`console.info("Privileged action", { action, actorId, credential, clientAddress, subject })`;
Node may print the object over multiple lines. Inspect the full exported
window around each match for all fields; do not treat this output as JSON or
throw away continuation entries.

The implemented action names and `subject` keys are:

| `action` | `subject` keys |
| --- | --- |
| `moderator-role.grant`, `moderator-role.revoke` | `targetAccountId` |
| `audit.open`, `audit.dismiss`, `audit.substantiate` | `auditId`, `targetAccountId` |
| `recalibration.close` | `targetAccountId` |
| `credit-adjustment.create` | `adjustmentId`, `targetAccountId` |
| `credit-adjustment.reverse` | `adjustmentId`, `reversalId`, `targetAccountId` |
| `repository.rederivation-request` | `repositoryId` |
| `settlement-override.grant`, `settlement-override.decline` | `overrideRequestId`, `issueId` |

Match journal `actorId` to SQL `actor_id`, `credential.kind` to
`credential_kind`, and `credential.tokenId` (when present) to
`credential_token_id`. Compare the journal timestamp with `created_at` and
confirm the target/subject and action. These are correlation clues, not a
unique join key: journal emission follows the successful operation, times can
differ, and concurrent actions can be ambiguous. These two history tables
are not a ledger of every action in the table above; retain the journal and
follow its subject IDs when scoping other actions. Missing journal output is
not proof of no mutation, particularly beyond retention or after a crash.

`clientAddress` appears only in the journal, never in these database rows.
It is trustworthy only because nginx sets `X-Real-IP` from `$remote_addr`
after the Cloudflare real-ip step and the app listens on `127.0.0.1`; the app
never reads `X-Forwarded-For`. `readClientAddress` validates a single address
with `node:net` `isIP()`, returning null for an invalid or absent header.
The MCP adapter forwards `x-real-ip` to its wrapped routes. If the proxy or
loopback boundary was bypassed or compromised, do not trust the address.

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

- **Deleted.** Do not assume anything survives, and fork or clone before
  anything else. This is a personal repository — `Nitjsefnie` is the owner as a
  user account, not an organization ([OPERATING.md](../OPERATING.md#governance-single-maintainer-operation))
  — so what GitHub does to the repository when its owner's account is deleted
  is a separate question, and nothing in this repository records the answer
  (see the fourth limit below). What a reader must not conclude is that nothing
  needs preserving: the fold prices settlements from issue labels and comment
  history read off this repository, so the repository is the settlement
  evidence, and a service that keeps serving proves nothing about it. The
  account is unrecoverable by this runbook; treat the repository as evidence
  first and the account second.
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
case is not covered by that list: at least two of its five entries read the
repository, so whether they keep working is the same question the deleted
bullet declines to answer. Take the fork or clone first and work from what
survives.

**The App's own credentials are not the personal account's session, and that
is verified in two independent places.** The reconciliation path mints a
short-lived RS256 JWT from a PEM file on the host and exchanges it for an
installation token; it never presents a session, a personal access token or an
OAuth token of the maintainer's. The file is named by
`GITHUB_APP_PRIVATE_KEY_PATH`, at the host value
`/etc/overflow/github-app/private-key.pem`, beside `GITHUB_APP_ID`, in
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
is the second place, and does not depend on either posture: its workflow reads the App key from
the repository's `overflow-ledger` environment secret and pins the App id and
installation id in the workflow definition itself, so the check-runs that
satisfy branch protection keep being posted whenever a producer run completes
and GitHub triggers the relay, with no personal account involved in the run.
See [OPERATING.md](../OPERATING.md#required-checks-relay) for its operations
and [deploy/README.md](README.md) section 10 for why the required contexts are
pinned to that App at all.

**Four limits on that claim, because the honest version is the useful one.**

1. **Key material is not App identity.** They are different things: a private
   key whose owner record no longer exists mints nothing, and nothing in this
   repository records what GitHub does to an App when its owner's account is
   deleted.
2. **One PEM or two copies.** [deploy/README.md](README.md)'s note that the
   App private key lives under a traversable `/etc/overflow` on a relay host,
   and that an untraversable one fails the required checks closed, ties the
   host file to the required-checks path, while the relay workflow reads the
   Actions environment secret. Whether those are one PEM or two is not
   determinable from this repository; treat them as two locations to check
   rather than one.
3. **The relay may not fire unattended.** The job runs under the
   `overflow-ledger` environment, and a GitHub environment can carry required
   reviewers. If that environment gates runs on an approving reviewer, every
   relay run waits for a human and the personal account is back inside the loop
   — the exact failure the sentence denies. This repository does not record
   that environment's protection rules: `overflow-ledger` appears in the relay
   workflow, in [OPERATING.md](../OPERATING.md#required-checks-relay) and in
   this section, and nowhere else, so nothing here can tell you whether a
   reviewer gate exists. Do not assume the relay fires unattended; read the
   environment's settings before relying on it, and read them from an account
   that survived step 8.
4. **What account deletion does to the repository is unrecorded too.** The
   first limit hedges about the App; the same event raises the same question
   about this repository, and nothing in this repository answers it either. The
   reviewer of this section could not confirm from the tree whether GitHub
   deletes a personal repository with its owner's account, and neither could
   this runbook's author, so the deleted case above assumes nothing survives.
   Treat the fork or clone as the first action rather than the fallback, because
   the cost of having been wrong is the settlement evidence.

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
5. Record where the App's key material lives, without copying any of it into
   the incident record. The host half needs only root on the deployment host
   and works with no repository access at all:

   ```bash
   ls -l /etc/overflow/github-app/private-key.pem
   ```

   Record the path's presence, its owner, its group and its mode; the file has
   to stay readable by the account the service runs as, which is why
   `/etc/overflow` is left traversable on a relay host. The path is absent if
   the host runs the OAuth-only posture, and that absence is itself the record.
   The repository half — the `LEDGER_APP_KEY` secret on the `overflow-ledger`
   environment — is observable only by an account that can read the
   repository's settings, so record that you could not read it when you could
   not. Never `cat` the file, never paste its contents, and never record the
   secret's value.
6. Independent of the account and therefore still running throughout: the
   service, the webhook receivers, GitHub sign-in, the reconciliation worker
   and automatic settlement pricing. No step in 1 to 5 stops any of them, and
   none of steps 1 to 5 needs a merge, a label or a settings change to
   complete. In the deleted case, treat the last two as conditional on what the
   fork or clone turned out to contain.
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
9. Rotating the App's private key is a separate maintainer-held item, and this
   runbook deliberately does not carry that procedure.
   [deploy/README.md](README.md) section 11 is the repository's only
   sanctioned key-rotation procedure and it names `TOKEN_ENCRYPTION_KEY`
   specifically; it does not extend to the App key and must not be applied to
   it. Until the App-key rotation is written, treat that key as unreplaceable
   in practice: the locations holding it are the host path configured by
   `GITHUB_APP_PRIVATE_KEY_PATH` and the `LEDGER_APP_KEY` environment secret
   the relay workflow reads, and a rotation would have to change both.

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
verification do not depend on the journal's size-bound retention (a 4 GiB
cap, the oldest entry months back, rsyslog off, the journal the only copy;
measured in [Journal retention and immediate
preservation](#journal-retention-and-immediate-preservation)).

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
  IDs; journal and nginx access-log export time bounds and file locations;
  evidence access restriction: who may access the evidence and the
  maintainer's handling decision.
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
