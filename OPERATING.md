# Operating an Overflow instance

Reference for running a development copy or a deployment of Overflow. Using Overflow does not require any of this — the running instance is <https://overflow.nitjsefni.eu>, and [README.md](README.md) is the guide to it. `deploy/README.md` is the production deployment procedure.

## Governance: single-maintainer operation

The repository and the hosted instance at <https://overflow.nitjsefni.eu> are each operated by one person — the GitHub user account `Nitjsefnie` for the codebase, root on the deployment host for the instance — and the arrangement is a deliberate, accepted risk: no backup operator is named. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) records the same one-maintainer shape for conduct. The codebase and the instance stay separate concerns: the codebase is the public repository `Nitjsefnie/Overflow`, and the instance is one deployment of it, which another operator can run from the same public sources by following this document and [deploy/README.md](deploy/README.md).

In the codebase, `Nitjsefnie` is the repository owner as a GitHub user account, not an organization, so there is no organization owner, and the repository has no teams, outside collaborators, or pending invitations. The same account is the sole admin collaborator, so only the maintainer can merge a pull request. There is no `CODEOWNERS` file. `main` is protected: its required status checks are `actionlint`, `verify`, `ratchet-guard`, `secret-scan` and `dependency-audit`, as recorded in [.github/required-checks.json](.github/required-checks.json), no approving review is required, and the protection rules are enforced on administrators. No version tags mark releases: `main`'s tip is the deployable revision, and [deploy/README.md](deploy/README.md) section 10 deploys a revision built from `main`. On the repository side of the ledger, `offered:` labels are set at filing by the issue owner and `settled:` labels before a merge, both ends held by the maintainer account, while the deployed instance prices settlements from those labels and comments automatically.

If the maintainer is unavailable, merges, issue triage and labelling, conduct decisions ([CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)), and settlement labelling stop; the tracker keeps accepting issues and pull requests, and CI keeps running on them. The repository is public, so the code itself is not at risk for as long as the account exists; deleting the account deletes the repository with it, because a personal account's repositories go with it (GitHub Docs, *Deleting your personal account*). Access recovery runs through GitHub's account-recovery processes, and no co-owner or organization owner exists who could grant access meanwhile. [deploy/incident-response.md](deploy/incident-response.md#account-loss-and-account-compromise) covers what to do when that account is deleted, locked by platform action or under someone else's control, including what the Overflow Ledger App's identity does and does not depend on.

In the instance, the service runs as the unprivileged `overflow` account under the systemd unit [deploy/overflow.service](deploy/overflow.service), pinned by `tests/deploy/unit-file.test.ts`, with `Restart=on-failure` and a five-second restart delay, and a start limit of five starts per 300 seconds, so a crash loop gives up in one final failure instead of restarting forever. Deploy authority and secret rotation sit with root on the deployment host: [deploy/README.md](deploy/README.md) section 10 deploys a new revision and section 11 rotates `OVERFLOW_TOKEN_ENCRYPTION_KEY`. The production environment file — the database URL, OAuth credentials, auth secret, token encryption key, webhook URLs and moderator ids — lives in `/etc/overflow/overflow.env`, owned by root. The production database is PostgreSQL on the deployment host, and [deploy/backup-restore.md](deploy/backup-restore.md) owns its backups. The moderator roster is resolved at sign-in from the `OVERFLOW_MODERATOR_GITHUB_USER_IDS` environment entry ([src/lib/moderation/roles.ts](src/lib/moderation/roles.ts)): a configured id is always promoted, a stored moderator is never demoted by absence from the list, grants made inside the product persist in the database, and changing the entry requires host access and a service restart. A member may request a correction to a priced settlement or calibration, and a moderator grants or declines it ([src/lib/overrides/service.ts](src/lib/overrides/service.ts)); the fold prices settlements automatically from GitHub labels and comments, so pricing itself needs no moderator. The contributor scoring this drives is screened for data-protection impact in [deploy/dpia-screening.md](deploy/dpia-screening.md), which records the scoring activities, the human-review routes on the sanctioning path, and the screening conclusion with its reopen triggers.

If the maintainer is unavailable, new deployments and secret rotation stop, moderator roster changes stop — they are an environment edit plus a service restart — and open settlement-correction requests wait, because only a moderator can grant or decline them; members can still sign in, file correction requests, and read the ledger ([README.md](README.md) is the guide to using the instance). Running unattended are the service itself under systemd (`Restart=on-failure`), the webhook receivers, GitHub sign-in, the reconciliation worker with its startup and recurring sweep, and automatic settlement pricing from repository labels — in every case above except a deleted account, which deletes the repository the last two read, so those two stop with it. The instance is rebuildable from the public repository by another operator following this document and [deploy/README.md](deploy/README.md); the production database exists only on the deployment host, with backups per [deploy/backup-restore.md](deploy/backup-restore.md).

## Development setup

These steps stand up a local copy of the application against a local PostgreSQL database.

1. Copy `.env.example` to `.env` and replace every placeholder. Generate `AUTH_SECRET` with `openssl rand -base64 32`; generate `OVERFLOW_TOKEN_ENCRYPTION_KEY` with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"`, which prints the exact 43-character unpadded base64url form the service accepts.
2. Use an already-installed PostgreSQL 17 server **or** start the local Compose service:

   ```bash
   docker compose up -d postgres
   docker compose ps
   ```

   That service publishes PostgreSQL on loopback only by default at host port 5432, and its password is a committed, well-known string. `POSTGRES_HOST_BIND` widens that binding, while `POSTGRES_HOST_PORT` overrides the host port; the container port stays 5432. Compose reads both values from your shell or the root `.env`, so any non-loopback bind publishes a database with known credentials to everything that can route to this machine. To reach it from another host, forward the loopback port over SSH — `ssh -L 5432:127.0.0.1:5432 <host>` — instead of widening the bind address.

   The other quickstart listener is the application: `pnpm dev` binds to
   `127.0.0.1`, so it is reachable only on this machine by default. To expose
   it deliberately, use `pnpm dev --hostname 0.0.0.0`; that listens on all
   IPv4 interfaces, allowing other hosts that can reach this machine to
   connect. Use a trusted development network and set `OVERFLOW_APP_URL` and the OAuth
   callback URL to the host and port those clients use.

3. Point `OVERFLOW_DATABASE_URL` at that database, then install and migrate:

   ```bash
   pnpm install --frozen-lockfile
   pnpm db:migrate
   ```

   If `POSTGRES_HOST_PORT` is overridden, use that same host port in `OVERFLOW_DATABASE_URL`.

4. Start the application:

   ```bash
   pnpm dev
   ```

   Open `http://127.0.0.1:3000` (port 3000 by default, or the port set by
   `PORT`). To use another port,
   pass Next.js's `--port` flag, for example `pnpm dev --port 3130`.
   Set `OVERFLOW_APP_URL` and the GitHub OAuth callback URL
   (`<OVERFLOW_APP_URL>/api/auth/callback/github`) to use that port too; sign-in and
   origin checks depend on those origins agreeing.

Useful verification commands (the geometry check needs a Chrome/Chromium binary and, when it spawns its own server, `OVERFLOW_DATABASE_URL` and `AUTH_SECRET`, both set in the `.env` configured above):

```bash
pnpm test --run
pnpm lint
pnpm typecheck
pnpm build
node scripts/check-page-geometry.mjs
```

The optional geometry command starts a separate production-mode application
listener on all interfaces at port 3219 by default (`OVERFLOW_LAYOUT_CHECK_PORT`
overrides the port), plus a Chrome DevTools listener on an automatically
allocated port. To reuse the loopback application listener instead of starting
another app server, pass `--base-url http://127.0.0.1:3000` (adjust the port if
needed); Chrome still starts.

`CONTRIBUTING.md` covers the rest of the development surface, including the conventions that reject work silently.

### Removing the local development copy

Stop `pnpm dev` with Ctrl-C in its terminal. If you started PostgreSQL with
Compose, run the following from the same checkout, using the same Compose
project name if you overrode it during setup:

```bash
docker compose down -v
```

This removes the project's containers and network and deletes the declared
`overflow-postgres-data` volume, including its database contents. Docker
prefixes that volume's name with the Compose project name. Omit `-v` if you
want to keep the database for a later restart. If you used an existing
PostgreSQL server instead, Compose does not remove that database; remove only
the database dedicated to this development copy with that server's own tools.

Then remove the local environment file and generated files from the checkout:

```bash
rm -f .env next-env.d.ts tsconfig.tsbuildinfo
rm -rf .next node_modules
```

The source checkout remains; installing dependencies and running the setup
again recreates the development copy.

## Operating an instance: GitHub OAuth and webhooks

This section is operator configuration for a deployment you run yourself; on the running instance it is already done. `https://<public-host>` is a placeholder for your own deployment's origin — replace it with that origin, and do not read it as an address to visit.

Create a GitHub OAuth application and a public HTTPS webhook endpoint. Configure the OAuth app's callback URL as `https://<public-host>/api/auth/callback/github`, and set these values in `.env`:

```dotenv
OVERFLOW_APP_URL=https://<public-host>
OVERFLOW_GITHUB_WEBHOOK_URL=https://<public-host>/api/github/webhooks
OVERFLOW_GITLAB_WEBHOOK_URL=https://<public-host>/api/gitlab/webhooks
```

Both forges must be able to reach their callback URLs over public HTTPS. Registrations using repository webhooks get an independent secret and a callback UUID in the `hook` query parameter. Secrets are encrypted with `OVERFLOW_TOKEN_ENCRYPTION_KEY`; they are never returned by the repository API. A credential authenticates only its registered provider, immutable repository/project ID, and GitLab instance. Receivers reject deliveries larger than 25 MiB with HTTP 413.

For App-based GitHub registration, configure a separate registration App with
`GITHUB_REGISTRATION_APP_ID`, `GITHUB_REGISTRATION_APP_PRIVATE_KEY_PATH` and
`OVERFLOW_GITHUB_REGISTRATION_APP_WEBHOOK_SECRET`. Its public HTTPS receiver is
`POST /api/github/app-webhook`; use the same webhook secret in the App's settings
and the environment. Subscribe to exactly `issues`, `issue_comment`,
`pull_request` and `pull_request_review`, and grant repository permissions
`metadata: read`, `issues: read` and `pull_requests: read`. Install the App on
the repositories it will register. These registrations use the App's webhook
instead of a repository webhook with a `hook` query parameter. The receiver
authenticates the App signature and processes only active App registrations;
authenticated deliveries for other repositories are ignored with HTTP `204`.

Leave the registration App variables unset to keep App-based registration off;
App webhook deliveries then receive HTTP `503` (fail-closed). An unset or empty
App id or key path disables App-based registration; an unset or empty webhook
secret makes the receiver answer `503`. A configured but unreadable, unparseable
or non-RSA key throws at wiring time. See [deployment section 4](deploy/README.md#4-create-the-environment-file)
for the key's service-account access. Every GitHub fold reads the repository
through its sponsor's OAuth token.

## Operating an instance: the production service

The production deployment runs the application as a dedicated unprivileged system account rather than as root, under a systemd unit that keeps the filesystem read-only apart from the one cache directory Next writes at runtime. `deploy/overflow.service` is that unit, and `deploy/README.md` is the procedure that stands it up on a host, deploys a new revision under it, and rolls it back. `tests/deploy/unit-file.test.ts` fails if the unit loses any of that hardening.

### Starting, healthy and degraded states

Read the service state, the loopback probe and the journal together:

```bash
systemctl status overflow.service --no-pager
curl --connect-timeout 5 --max-time 5 -sS -w '\n%{http_code}\n' http://127.0.0.1:3000/api/readiness
journalctl -u overflow.service --since '30 minutes ago' --no-pager
```

Readiness checks the database and migration compatibility only. A `200` does
not prove that GitHub or GitLab is reachable, that webhook credentials can be
decrypted, or that reconciliation is progressing. A `503` response contains
only `{"status":"unavailable"}`; its reason is in the journal. These are
operational states, not separate readiness response values:

| State | Signal | Journal message (static text to search for) | Next step |
| --- | --- | --- | --- |
| Starting | Immediately after start or restart, systemd may already say `active` while the listener still refuses connections. | No dedicated application startup-success message. `Reconciliation sweep` shows the startup sweep ran; `Could not finalize abandoned reconciliation runs on startup` reports a failed recovery step. | Use the bounded retries in [deployment verification](deploy/README.md#7-verify). If startup never reaches readiness, inspect the journal and database rather than treating `active` as ready. |
| Healthy | Readiness `200`, successful webhook deliveries, and completed folds when work is due. | `Reconciliation sweep` with `failed: 0`; `Reconciliation drain` with `RECONCILED` when work completes or `IDLE` when no job is claimable. After a queue outage, `recovered:` names the recovered failure site. | Check recent work and the queue below. A successful sweep only enqueues work, and a recovered drain does not prove every repository folded successfully. |
| Degraded | Readiness can remain `200` while repositories fall behind, jobs retry or wait for budget, or webhook credential lookup answers `503`. | `Reconciliation failed for repository`; `Reconciliation drain` with `RETRY_SCHEDULED`, `FAILED` or `BUDGET_HELD`; `Reconciliation GraphQL budget state changed`; `Webhook credential lookup failed (phase credential lookup, selector ` | Match the repository/selector and failure class to the queue and forge delivery history. For upstream failures, check forge availability and sponsor access. For `BELOW_RESERVE`, inspect the moderator budget panel and reset time. For credential lookup failure, check the encryption-key configuration using [section 11](deploy/README.md#11-rotating-the-credential-encryption-key); do not overwrite stored credentials to bypass it. |
| Disconnected | Loopback readiness `503` for a database/schema failure, or no loopback response if the service is down. If loopback works but the public origin fails, inspect the proxy path. | `Readiness probe failed:` carries the database reason; `Reconciliation worker could not drain the job queue` reports a drain outage. `still failing:` counts continued failures. A request stopped before the application may leave no application journal line. | Check PostgreSQL/service state and the reported migration mismatch. Compare the public and loopback paths, then check nginx and the [reverse-proxy requirements](deploy/README.md#reverse-proxy-requirements). Use the deployment or rollback procedure for a release/schema mismatch. |
| Irrecoverable by automatic restart | The service is `failed` after exhausting the unit's five starts in 300 seconds; automatic restarts have stopped. This does not by itself mean data is lost. | Inspect the application error preceding the stop; a configured invalid App key can report `does not contain a parseable private key.` or `does not contain an RSA private key (received `. There is no single application message for every terminal startup failure. | Correct the cause or follow [rollback](deploy/README.md#9-rolling-back). Then reset the start limit with `systemctl reset-failed overflow.service` and start the service. If database recovery is required, follow [backup/restore](deploy/backup-restore.md). |

`Reconciliation drain` emits nonroutine outcomes immediately; routine `IDLE`
and `DEFERRED` counts are aggregated until a drain at or after the 15-minute
interval. A queue-drain outage prints its first failure, then counted summaries
on continued failures at least 60 seconds apart, and `recovered:` on the first
successful drain. Silence inside either interval is not proof of health. If automatic reconciliation is
disabled with `OVERFLOW_DISABLE_RECONCILIATION_SWEEP`, neither the worker nor
the sweep starts; queued jobs remain outstanding.

### Inspect failed or retrying reconciliation jobs

Run this read-only query with a database connection configured for the instance
you intend to inspect:

```bash
psql "$OVERFLOW_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
select r.owner_name, r.active, j.repository_id, j.state, j.reason,
       j.attempt_count, j.run_after, j.last_failure_at
from repository_reconciliation_jobs j
join registered_repositories r on r.id = j.repository_id
where j.state = 'FAILED'
   or (j.state = 'PENDING' and j.last_failure_at is not null)
order by j.run_after, j.repository_id;
SQL
```

The queue has `PENDING`, `RUNNING` and `FAILED` states, not a `RETRYING` state.
The query includes failed jobs and pending jobs with a recorded failure; the
latter may be waiting for retry backoff or a later deferral. `run_after` is the
earliest scheduled claim time, not a completion deadline. The cause is in the
journal, not an error-text column. Ordinary fold failures get retries after
one, five, fifteen and sixty minutes, then remain `FAILED` on the fifth failed
attempt. The startup and recurring sweep can revive failed jobs for active
repositories of every sponsor under the diff-only backlog threshold. For a
sponsor over the threshold the sweep offers no slot, so a failed job is
revived by the next webhook delivery, or by its re-queued catch-up pass when
the stored evidence is unsafe; a quiet over-threshold repository's failed job
can stay FAILED, and the explicit reconciliation command in
[Reconciliation](#reconciliation) re-reads its upstream history without
reviving the job. An empty result does not prove health: this
query omits new pending work and running jobs.

### Data retention

Webhook delivery receipts and reconciliation run history are pruned automatically, so neither grows without bound. Three windows cover webhook receipts: a PROCESSED receipt is deleted 30 days after it was processed, a FAILED one 90 days after, and an abandoned PENDING receipt — one whose delivery was never finalized and whose processing lease has expired — 90 days after it was received. Reconciliation run history keeps terminal runs (COMPLETED or FAILED) for 90 days after completion, together with their `reconciliation_changes` rows, which go first because the foreign key to the run has no cascade.

Never pruned: a PENDING run at any age (it can still be claimed and completed), and a PENDING receipt whose processing lease has not expired — a live lease means a redelivery can still resume it. A change row is deleted only through its run's expiry, never by its own age.

The pruning is safe for its consumers: receipt deduplication reads only PROCESSED receipts, and a pruned receipt's late redelivery simply reprocesses, because reconciliation is idempotent from the forge's source of truth; runs are read only while PENDING and for account export, whose mapping tolerates a shortened history; and nothing in the application reads `reconciliation_changes`.

The prune runs on the reconciliation sweep tick — once at startup and then every six hours — and reports what it deleted on one info line per tick. It is disabled together with the sweep by setting `OVERFLOW_DISABLE_RECONCILIATION_SWEEP` to any non-empty value.

## Failure alerts and off-host copies

The off-host copy of the backups is the software's job now, and the alerts remain the maintainer's. `overflow-offhost-backup.timer` runs a nightly job that dumps a reduced set of the database, compresses it, encrypts it with `age` to a public key, and posts the encrypted file to a private Discord channel, where both the posted message and the host's local copy are kept for 14 days — [deploy/backup-restore.md section (i)](deploy/backup-restore.md#i-the-encrypted-off-host-copy) documents the copy and stands up the units. The on-host dump in `/var/backups/overflow` sits on the same disk as the database it protects, so the off-host copy is what a lost disk no longer takes with it; the data that cannot be rebuilt from GitHub — accounts, encrypted credentials, moderation history, audits, corrections, API tokens and credit adjustments — is what the copy carries off it. What remains the maintainer's responsibility is owning the alert delivery below, and the age key custody: the private half of the key lives once, in the fleet's Discord #credentials store — never on the host, never in the backups channel — and without it the off-host copies are unreadable.

When `overflow.service` or `overflow-backup.service` fails, systemd's `OnFailure=` starts `overflow-alert@<failed unit>.service`, which mails the failed unit's journal tail to the address in `/etc/overflow/alert-recipient` — host configuration, root-only, never committed — through the host's exim4 smarthost. The route works by design only while the host's mail route works; that dependence is a property of the design, not a defect of it, and the alert unit's own journal shows a submission that could not go out. Alerts are throttled to one message per failed unit per 30 minutes: the first failure mails immediately, sustained failures re-mail every 30 minutes, bounded far below the mail account's daily limit, and suppressed repeats land in the alert unit's journal. A bounce watcher —
`overflow-bounce.timer`, running `overflow-bounce.service` every 15 minutes —
covers what the mail route cannot see about itself: it tails the local spool
the aliased bounce addresses file into and reports two classes of message, a
delivery-failure notification for an overflow address (a remote failure on the
alert route) and a non-DSN alert or canary message that landed in the local
spool instead of delivering off-host. Its acceptance leg, the
`overflow-canary: root` and `overflow-alert: root` entries in `/etc/aliases`,
is host configuration, documented with the install, verification and rollback
in [deploy/README.md section 12](deploy/README.md#12-failure-alerts).

On an alert: read the failed unit's journal with `journalctl -b -u <unit>`, then follow [deploy/backup-restore.md](deploy/backup-restore.md) for a failed backup and [deploy/README.md section 10](deploy/README.md#10-deploying-a-new-revision) for a failed service. When the failed unit is `overflow.service`, a start within five minutes of the crash loop's give-up is refused with `Start request repeated too quickly` until `systemctl reset-failed overflow.service` runs or the 300-second window elapses.

That route is also the only one alerts take, which leaves its own failures silent: a mail path that has stopped delivering is indistinguishable from a host that has had nothing to report. When enabled, `overflow-canary.timer` runs `overflow-canary.service` daily at 03:20 UTC to close that gap. **On the documented deployment the timer has been disabled since 2026-10-01 by maintainer decision**: the daily mail was noise, and the maintainer accepted the consequence. The scheduled check does not run, so the canary no longer checks for silent mail-path failures automatically. With the installed units and host files configured, run a check by hand with `sudo systemctl start overflow-canary.service`, then read `journalctl -u overflow-canary.service --no-pager -n 20`; resume the daily check with `sudo systemctl enable --now overflow-canary.timer` and verify with `systemctl is-enabled overflow-canary.timer` and `systemctl list-timers overflow-canary.timer --no-pager`.

When run, the canary mails a probe by the same route, then reads the verdict from the exim mainlog: a stopped daemon, revoked credentials, greylisting or any 5xx leaves a `defer` or `rejected` line against the message's id and never a `Completed`, and those are caught. A path that cannot deliver is reported to a Discord webhook rather than by mail, because a mail failure reported by mail is a report nobody receives; the canary also exits nonzero, so the failure is visible in `journalctl -u overflow-canary.service` either way. One report is posted per dead streak, and the first successful run clears it. **What it does not catch is a recipient address that is wrong, deleted or converted**: a `Completed` line means the smarthost accepted the message, and nothing observable from the host distinguishes that from the mailbox existing. After re-enabling the timer, treat a run of missing canary mail as a finding in its own right, at the same weight as a failed backup. [deploy/README.md section 12](deploy/README.md#12-failure-alerts) carries the install, what the verdict does and does not cover, and the two-sided verification.

## Reconciliation

A repository is folded from a durable queue rather than inside the request that noticed it had fallen behind. A GitHub webhook delivery records a reconciliation job for the repository and answers immediately; when admission is available, an in-process worker normally claims that job within seconds, folds the repository, and clears the job. After claiming, a GraphQL budget hold can defer that repository to its sponsor's reset time, releasing the lease so the worker can continue to other repositories. A fold that throws is retried on the job after a minute, five, fifteen and an hour, and a repository that exhausts those retries stays visibly failed rather than disappearing from the queue. Registering a repository records the same kind of job, because the work already in the repository predates the webhook.

A sweep runs at startup and then offers a slot to every active repository of every sponsor under the diff-only backlog threshold, pacing each sponsor's repositories across its own sweep window, six hours unless `OVERFLOW_RECONCILIATION_SWEEP_WINDOW_MINUTES` sets another length. A repository owns one job row, so a repository already queued keeps its place and its backoff, and one whose retries were exhausted is revived. Missed webhook deliveries and repositories left failed by a GitHub outage are therefore offered for repair within one sweep window without manual intervention; completion can take longer because of budget holds, queued work, or further GitHub failures.

A sponsor whose stored backlog — the sum of stored issue and pull-request counts over its active repositories, each repository's stored count refreshed at most once per six hours — strictly exceeds `OVERFLOW_RECONCILIATION_DIFF_ONLY_BACKLOG` (default 1000) is offered no slot: its repositories fold incrementally from their webhook events. There, a missed delivery is repaired for the issues it left stale when a later delivery folds them — a fold that runs reads the issues updated since the last successful checkpoint — or by a manual reconciliation; a FAILED job is revived by the next webhook delivery, or by its re-queued catch-up pass when the stored evidence is unsafe; and a fold-revision or evidence-format bump re-derives the repository through its re-queued catch-up pass — one repository per sponsor per sweep tick, smallest stored size first — or a manual reconciliation, because only a full pass re-derives it. One class has no automatic repair: while the most recent stored pass omitted an oversized fact (a payload past the 64 MiB per-fact limit), every webhook fold of an over-threshold repository skips without folding until a full pass rewrites the evidence complete, and the catch-up re-queue does not re-queue for omitted facts — unsafe there means missing, written by a different evidence format, or derived under an older fold revision — so a stalled repository needs a manual reconciliation (`pnpm reconcile --repository <owner>/<name>`), whose full pass re-observes every fact: if each fact now fits the limit the evidence is rewritten complete and incremental folds resume, while a fact still past the limit is omitted again and the skipping continues until it does not.

When a repository's stored count cannot be refreshed — the count read fails or returns nothing — the sweep looks the repository up by its numeric ID with its sponsor's credential. Only a 404 there marks it gone: one warning line names the repository ID and says the forge no longer returns it, the `Reconciliation sweep` line counts it under `gone` instead of `measureFailed`, and its count read is skipped for six hours and then tried again; a read that succeeds forgets it. The repository keeps its sweep slot, a fold that reaches it records it unavailable, and its registration is not changed. A repository the sponsor's token can no longer see also answers 404. Any other outcome — the repository still returned under another name, a lookup that fails, no token — reports the failed count read at error priority as before. The memory is per process, so after a restart a gone repository is warned about once more.

`GITHUB_GRAPHQL_BUDGET_RESERVE` controls reconciliation's admission threshold. It defaults to 500 points; `0` disables the budget hold. Set a nonnegative integer: missing, blank or malformed values fall back to 500. A very large valid value deliberately makes the threshold restrictive, potentially holding every pass with a known current reading. Under the repository lock, after resolving its sponsor and before starting a run, the fold holds when that sponsor's recorded remaining balance is below this threshold. A held job is deferred to that reading's reset time without consuming retries; its outcome is `BUDGET_HELD`, distinct from a cooldown's `DEFERRED`. This admission check also applies to direct folds. An absent or expired reading, or an unavailable observer, permits admission until a usable reading is available.

This is an **admission threshold, not a guaranteed remaining balance**. An admitted pass may fetch many pull requests and paginate without a point ceiling, so it can spend past the reserve. The threshold stops new passes; it does not cancel requests within an admitted pass.

The sweep request budget bounds the GitHub requests a sweep fold may send. It is kept per sponsor and reset with the sponsor's sweep window, defaulting to 3000 requests per sponsor, read from `RECONCILIATION_SWEEP_REQUEST_BUDGET` (read unprefixed — the `OVERFLOW_`-prefixed spelling is not read). Only a fold that runs under the budget spends it or can be held by it: a sweep rotation slot's fold or catch-up pass, or a diff-only repository's re-derivation. Webhook, registration and override folds, a re-derivation of an under-threshold repository, and the explicit command's folds run outside it and are never held. When the sponsor's budget is spent, the fold's next GitHub request holds the run for the rest of the sponsor's window: the job is deferred to the window reset with the same `BUDGET_HELD` outcome the GraphQL admission hold records, and the durable walk resume point below lets a held sweep pass continue. The size measure above is not a fold: its count read neither spends nor is held by this budget.

The sweep window is six hours by default. `OVERFLOW_RECONCILIATION_SWEEP_WINDOW_MINUTES` sets its length in whole minutes — `90`, for example, resets each sponsor's budget every 90 minutes, holds a spent sponsor until that reset, and spaces the sponsor's repositories across 90 minutes — and the account-data notice states the configured length. Missing, blank, malformed, nonpositive or unsafe-integer values fall back to six hours. The service reads it from its environment, which systemd loads when the service starts, so a change takes effect on restart; a job already held at the restart keeps the reset time it was held until.

A paused sweep pass keeps at most 1000 cached pages by default, configurable with `OVERFLOW_RECONCILIATION_SWEEP_PAGE_CEILING`. A budget-bound full walk resumes from its durable resume point per listing stream, keyed by last-update time plus an identity tiebreak, and stages each subject's evidence as it advances. The 1000-page cache no longer decides completion: held runs retain staged evidence and publish only after the walk completes.

For every GitLab version, each issue and merge-request listing stream starts at page 1 with `updated_after`, carrying the server's timestamp anchors verbatim within the window. The walk visits the whole sorted raw page, including the terminal timestamp group, with staging-aware deduplication at its resume point. On a full page it then drains that single-timestamp slice with `updated_after` and `updated_before` at the boundary, using offset pages, before continuing with offsets past the inclusive slice until newer rows appear. This offset shortcut stays local to the current window; `CollectionWalkBound` caps the accumulated slice and continuation at 150,000 rows or 2,000 pages per boundary, counting rereads, and exceeding either limit rejects the walk. A held run reopens from its durable timestamp and identity tiebreak and deduplicates the repeated boundary subjects against staging.

The `reconciliation_sweep_walk_subjects` staging table scales with the evidence facts (about 30 MiB per 1700-subject corpus). Its rows exist only while a pass is open and cascade away with the pass; its data is excluded from the reduced off-host backup.

The GraphQL budget panel at the end of the moderator page (`/moderation`) displays one entry per known quota owner: the account's GitHub login when already available from the moderator roster, otherwise its account ID, followed by the recorded remaining balance, optional limit, reserve, reset time, observation time and hold state. Every GitHub fold reads through its repository's sponsor's OAuth token, so every fold spends that sponsor's GraphQL and REST quota; the admission hold above governs the GraphQL spend only. Each sponsor account's readings and transitions are keyed by account ID, never by a credential. Unowned gateways record nothing. Within each owner's newest reset window the store retains the lowest balance and rejects older windows, so delayed responses cannot erase a known hold. Observations are process-local and disappear on restart; they are not shared across application instances. No owners observed yet is displayed separately from a known owner's unobserved or held budget.

For the production systemd deployment, edit `GITHUB_GRAPHQL_BUDGET_RESERVE` in `/etc/overflow/overflow.env`, then run `sudo systemctl restart overflow.service` to apply the new environment. In local development, update `.env` and restart `pnpm dev`. Restarting also clears the process-local observation, so the panel initially reports an unobserved budget.

Setting `OVERFLOW_DISABLE_RECONCILIATION_SWEEP` to any non-empty value turns off the worker as well as the sweep, which is the whole of automatic reconciliation: jobs still accumulate, and nothing drains them.

Run reconciliation explicitly when GitHub history must be re-read:

```bash
# Reconcile one explicit registered repository by owner/name.
pnpm reconcile --repository <owner>/<name>

# Reconcile every active registered repository.
pnpm reconcile
```

Reconciliation materializes issues, linked pull requests, settlement proof, self-work calibration, and unclaimed contributor records. PostgreSQL serializes each repository from snapshot collection through materialization. Eligibility is reconstructed at merge time from immutable moderation history, so a later sanction cannot rewrite eligible historical facts.

### Upgrade existing webhook subscriptions

New registrations subscribe to `issues`, `pull_request`, `pull_request_review`,
and `issue_comment`. Comment creation, editing and deletion each invalidate the
payload's issue subject and queue repository reconciliation through the same path
as issue events, regardless of the comment text, author or issue state.
The fold's pricing, author/edit evidence rules and fifteen-minute grace are unchanged.

Deploy and verify the comment-capable release before upgrading existing hooks.
With the deployment's `OVERFLOW_DATABASE_URL`, `OVERFLOW_TOKEN_ENCRYPTION_KEY`,
`OVERFLOW_GITHUB_WEBHOOK_URL`, and `OVERFLOW_GITLAB_WEBHOOK_URL` loaded, run:

```bash
pnpm webhooks:upgrade
```

This enumerates active registrations, decrypts each sponsor's OAuth token, and
resolves the current public repository by its immutable GitHub ID. It updates
the persisted hook ID at that repository's current owner/name. GitHub's
[additive webhook update](https://docs.github.com/en/rest/repos/webhooks#update-a-repository-webhook)
retains unrelated subscriptions and active state. The command stages an encrypted,
independent credential, then configures its callback UUID and secret together,
even when event subscriptions are already complete. It verifies the returned hook
ID, callback URL, and events before marking the credential configured. Retries
reuse pending or configured material, including after a remote timeout or queue
failure. Avoid concurrent manual hook edits.

Migration 043 must run before the scoped receivers start. Legacy hooks are rejected
until upgraded; there is no shared-secret fallback. Run the upgrade promptly and
complete the queued full reconciliation to recover gaps. Retire the previous
shared credential after all registrations migrate; keep `OVERFLOW_TOKEN_ENCRYPTION_KEY`,
and change it only by the [key rotation procedure](deploy/README.md#11-rotating-the-credential-encryption-key).

Each JSON outcome identifies the registration by its local ID, reports
`subscription` separately from `queue`, and names a sanitized failure stage.
`VERIFIED` means the subscription was confirmed; `QUEUED` means a full upstream
refresh was durably requested through the existing rederivation mechanism, not
that the fold has finished. Historical missed comments have no known subject to
invalidate, so this administrative repair bypasses incremental checkpoints.
A hook that was disabled stays disabled. Every verified run requests full repair,
including reruns after a queue failure.
The summary counts `succeeded`, `failed`, and `gone` registrations. A GitHub or
GitLab by-ID lookup that returns 404 with the sponsor's token reports
`subscription: "SKIPPED"`, `queue: "NOT_ATTEMPTED"`, and `failure: "REPOSITORY_GONE"`.
It counts only as `gone`, leaves the registration unchanged, and does not fail
the run. This includes a repository the sponsor's token cannot see, such as one
made private without that token's access. Exit 0 requires `failed` to be zero;
exit 1 indicates a failed step; exit 2 indicates invalid arguments. Lookup
errors, missing tokens, missing/inaccessible hooks, lost admin rights, returned
private repositories and mismatched IDs remain failures. Restore the sponsor's
access or correct the reported registration problem, then rerun. `UPGRADE_FAILED`
indicates configuration or enumeration failed before a complete summary was available.
Rerun `pnpm webhooks:upgrade` for any `REPOSITORY_GONE` line you doubt: a transient
404 can still leave a `REVISION` record, so redeploying that SHA skips the upgrade.

Retain the JSON output and real exit status with the deployment record, as the
[ordinary deployment procedure](deploy/README.md#10-deploying-a-new-revision)
does. The startup sweep reconciles evidence but does not upgrade subscriptions.

## Account deletion and export

A person may ask for everything the service stores about them, or for their
account to be deleted. Deletion is pseudonymisation: the account row survives
with its identifier, so ledger history stays attributable, but nothing that
lets anyone act as the person survives with it.

### Requests

Members signed in to Overflow delete their account and download its export
themselves, from the "Your account data" section of their dashboard; no
request to the operator is needed. The tracker route below stays for people
who cannot sign in to Overflow. Their requests arrive as an issue on the public tracker (the
Code of Conduct's [Reporting](CODE_OF_CONDUCT.md#reporting) section); there
is no private channel. Act only for the account that opened the issue, and
resolve that account's numeric id before touching anything with
`gh api repos/Nitjsefnie/Overflow/issues/<number> --jq .user.id`. Pass that
id to the commands below — never a login.

Post the export in the requester's issue only when BOTH hold: the requester
has confirmed in that issue that they accept a public reply, and every export
section that records the account acting on other accounts is empty —
`moderationEvents.asActor`, `calibrationAudits.asReporter`,
`calibrationAudits.asModerator`, `moderatorRoleChanges.asActor`, and
`settlementOverrideRequests.asDecider` — and `calibrationAudits.asAccount`,
the audit reports filed about the account, is empty too: those rows identify
the reporter. The acting-on-others rows carry the rationale, decision and
reason text written about other people, which the requester's consent cannot
cover. The confirmation matters on its own too: the export
also includes the account's own enforcement state and the reasons recorded on
moderation events targeting it. If either condition fails, do not post the
export. The requester can sign in with the same GitHub account and download it
from the "Your account data" section of their dashboard; otherwise the export
is held.

### A person who never signed in

A request from a person who never signed in has no account row to delete and no
dashboard route, so the operator handles it by hand with the forge-keyed
commands — keyed by forge provider, normalized HTTPS instance origin and numeric
forge id, never a login alone. GitHub defaults to `https://github.com`; GitLab
requires `--instance-url <https-origin>` and refuses a request without it.
Resolve the numeric id first (`gh api users/<login> --jq .id` for a GitHub
person), and pass `--login` only to widen matching to rows that carry no
numeric id: an issue's owner login is the one identity column with no id beside
it, so the commands resolve login copies from id-keyed rows themselves and add
the explicit `--login` token to those.

The export writes every row naming the person, one section per store, each with
its table name, its rows and its count: the account row if they have one, all
identities linked to their account, the issues they authored or claimed
(bodies included),
their pull requests, the settlements crediting them, the per-repository cache
facts whose payloads carry their identity, the change-log entries recording
their logins or ids, policy diagnostic rows, the suppression decision itself,
and the moderation notes naming them. It is an access
copy: secret material appears only as presence booleans, never as a value.
Where a table carries no provider column, matching is scoped by the row's
repository's provider and instance origin. A numeric id, where present,
controls matching; a verified login is used only where the id is absent, so
a reused login never overrides a known different id. Issue display copies
first use cached numeric author identities and actors anchored by event or
comment id; a verified login is the fallback when that evidence has no id.

The removal applies one documented decision per store — the decision table is
the module constant `forgePersonRemovalDecisions` in
`src/lib/accounts/forge-person.ts` and is the whole policy in one place:

- `users`, `user_forge_identities` — pseudonymised: a matched account has every
  linked forge identity scrubbed by `user_id`, even on another provider or
  instance; a provider-only person with no matched account has no linked
  credentials to clear. The rows and the numeric ids stay (the ledger attributes
  work by them) while logins are tombstoned to
  `(data subject removal)` and tokens cleared; the account row is stamped
  `deleted_at` and its API token is deleted. The removal is refused while the
  person sponsors a registration that has not been unregistered
  (`SPONSOR_BLOCKED`, naming each repository — unregister first, as with
  deletion).
- `issues`, `pull_requests`, `settlements` — pseudonymised: rows the person
  authored lose their stored body text, and every login and numeric-id copy
  naming them is tombstoned or dropped; the attribution keys the ledger needs
  (`author_id`, `creditor_id`) and everyone else's rows stay untouched. The
  sponsor's done-when statement is cleared on the issues of every repository
  whose registration still names the person as sponsor.
- `repository_reconciliation_evidence_facts` — pseudonymised in place: payload
  identity fields (issue authors, comment authors, history actors and
  assignees, nested closing-PR authors) are tombstoned; titles, reviews and
  raw diffs are kept — proof material that names no reviewer.
- `moderation_events` — kept: the moderation audit trail is immutable by
  trigger, so its rows, states and reasons stay exactly as written; the export
  lists the notes naming the person so the request can be answered about them
  by hand.
- `reconciliation_changes` — kept: the append-only journal is not rewritten;
  new structured identity and generated diagnostic references are scrubbed
  before every write, and retention prunes old entries with their run after
  90 days.
- `repository_policy_violations` — kept as written until a later publication
  replaces the current set. The access copy includes matching diagnostics.
  New diagnostic actor logins and generated reason references are scrubbed
  before publication and journaling.
- `data_subject_suppressions` — kept: the namespaced id and every verified alias
  remain to enforce the removal and are included in the access copy.
- `registered_repositories`, `webhook_deliveries`, and the account-keyed
  stores (audits, calibrations, role changes, override and contest requests,
  runs and usage, credit adjustments) — kept: the registration belongs to its
  sponsor (unregistering is the separate objection lever), receipts carry no
  person columns, and the account-keyed stores follow the account-side
  deletion and export when the person has an account.

The removal records a suppression — one row per (provider, normalized instance
origin, numeric forge id) in `data_subject_suppressions`, retaining all verified
login aliases across reruns. Shared account-deletion and data-subject tombstones
are excluded from alias resolution. The aliases come from id-bearing users,
linked identities, PRs, settlements, claim assignees and cache authors, assignees
and history actors. An operator-supplied `--login` must be verified against the
person before use on login-only fields.

Every later reconciliation pass checks only suppressions for its repository's
provider and origin inside the publication transaction, before writing derived
rows, cache facts or generated policy diagnostics. Retained moderation and
journal text, existing diagnostics until replacement, titles and proof
material are outside the scrub. Id-bearing fields match by id; login-only
fields use the verified aliases. Different people with the same id on different GitLab
instances are separate. The removal takes the fold's repository advisory locks
for that provider and origin, so it cannot race a pass in mid-publication. A
repeat removal retains previous aliases and adds newly verified ones. Imports
also learn and retain new aliases from incoming id-bearing evidence before
scrubbing. If a person renames, rerun with their verified `--login` to cover
login-only rows that have no accompanying numeric evidence. Backups taken
before the removal keep the pre-removal
data until each dump is pruned — in practice about 15 days, like any
pre-deletion dump.

### Running the commands

On the deployment host, with the deployment's `OVERFLOW_DATABASE_URL` loaded:

```bash
cd /srv/overflow
set -a; . /etc/overflow/overflow.env; set +a
node --experimental-transform-types --import ./scripts/register-path-aliases.ts scripts/account.ts export --github-user-id <github-user-id>
node --experimental-transform-types --import ./scripts/register-path-aliases.ts scripts/account.ts delete --github-user-id <github-user-id>
node --experimental-transform-types --import ./scripts/register-path-aliases.ts scripts/account.ts delete --github-user-id <github-user-id> --confirm
node --experimental-transform-types --import ./scripts/register-path-aliases.ts scripts/account.ts export-forge --provider <provider> --instance-url <forge-origin> --forge-id <forge-id>
node --experimental-transform-types --import ./scripts/register-path-aliases.ts scripts/account.ts remove-forge --provider <provider> --instance-url <forge-origin> --forge-id <forge-id>
node --experimental-transform-types --import ./scripts/register-path-aliases.ts scripts/account.ts remove-forge --provider <provider> --instance-url <forge-origin> --forge-id <forge-id> --confirm
```

Each command writes its JSON document to standard output and reports its
outcome through an exit code. The account export covers every table with a
foreign key to the account — not every record that mentions the person: rows
naming the person only by GitHub login or id, with no foreign key to the
account, are not exported. Encrypted tokens appear only as presence booleans
(`hasStoredGitHubToken`, `hasStoredToken`), while the API-token hash and the
webhook secrets are omitted entirely; API-token metadata is `createdAt` and
`expiresAt`, never the hash. The first
`delete` and the first `remove-forge` are dry runs; `--confirm` performs them.
Exit codes: `0` the command succeeded (an export, or a confirmed deletion or
removal); `1` it failed — an unknown
account, a sponsor refusal, or a command error reported as
`ACCOUNT_COMMAND_FAILED`; `2` the arguments violate the grammar; `3` the
dry run completed without deleting.

### What deletion scrubs

- The GitHub login is replaced with the tombstone `(deleted account)`, and the
  avatar and the stored GitHub OAuth token are cleared.
- The account's API token is deleted, so its hash stops authenticating at
  once.
- GitLab identities keep their instance URL and numeric id — the fold
  attributes authorship by them — but their token is cleared, their login is
  tombstoned, and `token_failed_at` is stamped, so the dashboard asks for a
  re-link if the person signs in again.
- The account is stamped with `deleted_at`.

### What deletion keeps

The account's `id`, its `github_user_id` and GitLab numeric ids stay, because
the fold attributes work by them. Every ledger row stays too, including the
GitHub-reported login copies on settlements and pull requests, which
reconciliation keeps refreshing from GitHub after deletion.

### Sponsors and moderators

Deletion is refused while the account sponsors any registration that has not
been unregistered (`SPONSOR_BLOCKED`, naming each repository). To proceed,
the sponsor unregisters each named repository from the dashboard; a handover
is unregister, then the new sponsor registers. Deletion never demotes a
moderator: if removing the moderator role is intended, revoke it first.

### After deletion

A deletion from the dashboard signs that browser out at once. Other signed-in
sessions end at their next request whose account lookup succeeds; until then
member pages and the member routes that re-read the account from the database
refuse it. API tokens stop at once. A later GitHub sign-in re-registers the
account and re-links its history. Deletion does not revoke the OAuth grant on
GitHub; the person revokes that at <https://github.com/settings/applications>.

### Backups

Database dumps taken before the deletion keep the pre-deletion data until each
dump is pruned once it is more than 14 days old — in practice about 15 days.
Pruning runs only after a later backup succeeds, so dumps taken before a
deletion can be kept longer while backups are failing; see
[backup retention](deploy/backup-restore.md#d-backup-location-and-retention).
A nightly encrypted copy of the backups also carries pre-deletion data off the
host to a private Discord channel for 14 days; see
[the encrypted off-host copy](deploy/backup-restore.md#i-the-encrypted-off-host-copy).

## Continuous integration

GitHub Actions runs the complete gate on pushes to `main`, pull requests targeting `main`, and manual dispatches; the privileged pull-request producers use `main`'s definitions, so a pull request that edits its own workflow files cannot shape the job that judges it. `.github/workflows/ci-pr.yml` produces `verify` with a whole `on:` set of `{workflow_run}`, starting only on `pr suite` completion. `.github/workflows/pr-gates.yml` produces `actionlint`, `ratchet-guard`, `secret-scan` and `dependency-audit` with a whole `on:` set of `{pull_request_target}`. Pushes to `main`, daily scans and manual dispatches use their separate producer files: `ci.yml`, `actionlint.yml`, `ratchet-guard.yml`, `secret-scan.yml` and `dependency-audit.yml`. On pushes to `main` and manual dispatches the `verify` job of `.github/workflows/ci.yml` uses the pinned Node and pnpm versions, applies migrations to PostgreSQL 17, then runs the test suite with coverage and the coverage-floor check — a change that touches only documentation is detected first and runs the suite without the coverage measurement — followed by an informational patch-coverage report, `pnpm lint`, the module-size ceilings, `pnpm typecheck`, `pnpm build`, and the page-geometry check, `node scripts/check-page-geometry.mjs`, against the built output. On a pull request the pull request's own code — install, migrations, tests with coverage, lint, typecheck, build and page geometry — runs only in the `pr suite` workflow (`.github/workflows/pr-suite.yml`), under `pull_request` with a read-only token, no secret and no required context of its own. The `verify` job of `.github/workflows/ci-pr.yml` then executes no pull-request code: it checks out `main`'s tip, reads the triggering suite run by id from the API and requires its exact workflow path, pull-request event and successful completion. It binds one open PR by head repository, branch and SHA using the coverage-comment issue-656 algorithm, forks included; missing, ambiguous and moved heads fail. It materialises the resolved PR head merged into its current base as a detached worktree outside its workspace, and runs `main`'s copies of the gate scripts over that tree as data — conflict markers, docs-only detection, the module-size ceilings, migration immutability (which rejects an edit to a migration file that has already reached `main` — a migration, once on `main`, never changes), legal-revision currency and commit scopes. The suite awaiter reads that exact `pr suite` run and one same-head run listing, without polling. It requires success at the resolved head SHA and refuses any higher-id suite run or later run attempt. On a change that is not documentation-only it downloads that run's coverage summary into a fresh directory outside both trees and applies the coverage-floor check to it. The ratchet documents check, which rejects a pull request that would relax the coverage floor or the module-size ceilings, is the `ratchet-guard` job of `.github/workflows/ratchet-guard.yml` on `main` pushes and dispatches and of `.github/workflows/pr-gates.yml` on pull requests. Verify's static gates judge the resolved head merged with the current PR base. Its last step, base freshness, compares the head/current-base merge-base with `main`'s current tip: on main's linear history that fork point is never newer than the suite's tested base, so the comparison covers every potentially untested advance and certifies the run only when the advance touched none of the files the pull request changes — such an advance carried its own required checks — and refuses an overlapping advance or a failed or unrepresentative comparison; pushes to `main` test `main` itself and skip it.

The separate `calibrate` job runs after a green `verify`, on pushes to `main`: when the measured coverage exceeds the recorded measurement by more than its hysteresis it rewrites the record upward — measurement and the floor derived from it — and pushes the raise to `main` as a bot commit. Branch protection refuses that push, and the job fails visibly naming the measured and recorded floors — a red `calibrate` job is the coverage ratchet's alarm, not a deployment blocker: it is not one of `main`'s required checks, and the deployment procedure gates on `main`'s required checks concluding `success` on the exact revision being deployed. Its one other run is a manual dispatch whose `simulate-refused-raise` input fabricates a raise precisely so the refusal fires: the self-test of that alarm, where a red job is the intended outcome.

The `actionlint` jobs of `.github/workflows/actionlint.yml` and `.github/workflows/pr-gates.yml` — the latter has a whole `on:` set of `{pull_request_target}` — validates and security-checks the workflow definitions themselves: `actionlint` checks workflow correctness, and `zizmor` their security posture, with `zizmor`'s install hash-pinned from `.github/requirements-zizmor.txt`, so the gate refuses any downloaded artifact matching no known hash (#686). Its pull-request leg fires `pull_request_target`, so the definition, checkout and tools come from `main`'s tip, while the pull request's own workflow files enter only as data — fetched as git objects and extracted into `.github/workflows-pr/` with `git show`, never checked out, installed or executed — so the gate that judges them is never shaped by them. All actions are commit-pinned and checkout credentials are not persisted.

Required contexts and their producing workflow paths are recorded in [.github/required-checks.json](.github/required-checks.json): `verify`, `actionlint`, `ratchet-guard`, `secret-scan` and `dependency-audit`. The other workflows below provide additional checks, comments or detection signals; they are not additional required contexts in that map.

| Workflow file (under `.github/workflows/`) | Role and trigger |
| --- | --- |
| `ci.yml` | `ci`: produces `verify` for pushes to `main` and manual dispatches, running the migration, test, static and production-build gates described above. |
| `pr-suite.yml` | `pr suite`: runs pull-request code, migrations, tests, lint, typecheck, build and geometry checks on PRs targeting `main`; uploads coverage artifacts for the trusted consumers. |
| `ci-pr.yml` | `ci pull request`: on `pr suite` completion, validates the suite and PR binding, checks the merge tree as data and applies the coverage floor and base-freshness gate to produce `verify`. |
| `pr-gates.yml` | `pr gates`: on `pull_request_target` for `main`, produces `actionlint`, `ratchet-guard`, `secret-scan` and `dependency-audit` using trusted tools with PR content treated as data. |
| `actionlint.yml` | `actionlint`: checks workflow correctness and security with actionlint and zizmor on `main` pushes and manual dispatches; the PR producer is `pr-gates.yml`. |
| `ratchet-guard.yml` | `ratchet guard`: checks the coverage floor and module-size ceiling documents against their trusted baseline on `main` pushes and manual dispatches; the PR producer is `pr-gates.yml`. |
| `secret-scan.yml` | `secret scan`: scans full history with gitleaks and checks baseline reachability on `main` pushes, daily and on manual dispatch; the PR producer is `pr-gates.yml`. |
| `dependency-audit.yml` | `dependency audit`: produces the lockfile advisory gate on `main` pushes, daily and on manual dispatch, without a project install or build; an unchanged-manifest push can take its green fast path. The PR producer is `pr-gates.yml`. |
| `ledger-relay.yml` | `ledger relay`: mirrors the required producers' completions under the Ledger App and sweeps every ten minutes or on manual dispatch; see below. |
| `code-scanning.yml` | `code scanning`: runs CodeQL for JavaScript/TypeScript and Actions on `main` pushes, PRs to `main`, weekly and on manual dispatch; findings are a Security-tab triage signal. |
| `scorecard.yml` | `scorecard`: publishes OpenSSF Scorecard results and SARIF for the upstream default branch weekly and on manual dispatch; it has no PR trigger. |
| `event-policy.yml` | `Actions event policy`: runs the event-policy check on `main` pushes, daily and on PR opening, synchronization or reopening; the PR job uses the read-only workflow token. |
| `pr-gate.yml` | `pr gate`: on PR opening, editing, reopening or readiness, runs the contribution-policy action with commit-attribution enforcement for non-bot, non-draft PRs; the action can comment and close PRs. |
| `claim.yml` | `claim`: responds to non-bot `/claim`, `/unclaim` and `/release` issue comments, including a declining reply on PRs; it manages issue assignments rather than a required check. |
| `coverage-comment.yml` | `coverage comment`: on `pr suite` completion, posts or updates the bound PR's patch-coverage comment and publishes a `coverage comment` check; missing or failed measurements get a “not measured” body. |

### Required checks relay

The `ledger relay` workflow (`.github/workflows/ledger-relay.yml`) re-posts the required checks as check-runs owned by the Overflow Ledger GitHub App: when a run of `ci`, `ci pull request`, `actionlint`, `ratchet guard`, `secret scan`, `dependency audit` or `pr gates` completes, `scripts/ledger-relay.ts` reads `.github/required-checks.json` from its own checkout (the trusted main tip), decides each context whose pin names the triggering run's path from that run's job records — a pin may name several workflow paths, and each required context has a main-push producer and a privileged pull-request producer — highest attempt wins, a non-success wins an attempt tie, a pending job posts as pending, a renamed producer posts failure — and posts one check-run per context against the producer's attested head SHA, so branch protection can pin each required context to the App instead of the github-actions app. The job runs in the `overflow-ledger` environment and needs its `LEDGER_APP_KEY` secret (the App's private key, which also carries the Actions read and Checks write permissions); the App and installation ids are pinned in the workflow. When a run's relay posting died, dispatch the workflow with the id of the newest completed producer run on the affected SHA to re-post it — the newest App check-run for a context decides, so the newest producer run is the one to name. Every start also sweeps eligible completed producers whose App posting is missing and eligible cancelled producers whose PR head is still live; the latter can be rerun. Starts share one serialized concurrency group with `cancel-in-progress: false` and `queue: max`. A ten-minute scheduled start runs the sweep even without a new producer completion; manual dispatch without a run id is also sweep-only. A missing App posting can therefore heal on a scheduled or later producer-triggered start, while dispatch with a completed run id remains the explicit recovery path. When a merge is refused, read the reason with `gh pr merge`: a raw `POST /pulls/N/merge` answers 404 when the base policy blocks, while `gh pr merge` surfaces the actual policy error, so the REST route reports "not found" where the truth is "policy". The relay job is never named after a required context: protection matches a required check by name and app, so a same-named job under the github-actions app would satisfy protection without the App's identity, and `tests/ci/required-checks.test.ts` holds every pinned name to exactly one producing job in every pinned file, and none anywhere else. `pr gates` fires `pull_request_target`; `ci pull request` fires `workflow_run` on suite completion. Both execute `main`'s workflow definitions and a pull request that edits its own workflow files cannot shape the job that judges it; the relay accordingly mirrors onto the App the job records of main-defined runs, and never relays a `pull_request` producer run. For `ci pull request`, the relay API-validates the producer's path, event and repository id, parses its exact `verify for pr suite run <id>` display title, resolves that upstream suite run by id and posts on its head SHA, never the verify run's own default-branch head SHA. It rechecks supersession before posting: a higher-id suite run at the same head, or an upstream rerun started after verify was created, makes the old mirror or orphan an exit-0 skip with no check-run POST, so late older results cannot replace newer decisions. Every gate script those runs execute is `main`'s copy, reading the pull request's tree only as data, so replacing a gate script in a pull request changes the tree being judged, not the judge. The pull request's one remaining control is its own test content: the suite verdict and the coverage numbers come from the pull request's own code running in `pr suite`, and the coverage-floor and module-size documents those gates read are the pull request's, held tighten-only against `main` by `ratchet guard`. That residual stays visible in review and is unchanged by the App switch; the design accepts it and keeps it visible in every review.

## Environment reference

`.env.example` documents every required application setting. The table below
covers the application's runtime settings, including optional settings, the
debug flag and framework or systemd values the source reads. Deployment and
build uses of these values, and Compose inputs, follow in a separate table.
Neither table covers variables read only by surrounding tooling: the shell's
`PATH`, and the coverage-recalibration script's
`GH_TOKEN`, `GITHUB_REPOSITORY`, and optional `PUSH_REMOTE_URL` override.

| Variable | Purpose |
| --- | --- |
| `OVERFLOW_DATABASE_URL` | PostgreSQL connection string |
| `OVERFLOW_DATABASE_STATEMENT_TIMEOUT_MS` | Optional deadline in milliseconds for every statement the database work pool runs, enforced by the server; defaults to 600000 (ten minutes) when unset, while a set-but-invalid value — empty, non-numeric, negative or zero — is an error at client construction, not a fallback |
| `AUTH_SECRET` | Auth.js session signing secret |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | GitHub OAuth application credentials |
| `OVERFLOW_TOKEN_ENCRYPTION_KEY` | OAuth-token encryption key |
| `OVERFLOW_TOKEN_ENCRYPTION_KEY_PREVIOUS` | Optional decrypt-only previous key, set only while rotating `OVERFLOW_TOKEN_ENCRYPTION_KEY` by [deploy/README.md section 11](deploy/README.md#11-rotating-the-credential-encryption-key); unset or empty means none, a malformed value is an error |
| `OVERFLOW_APP_URL` | Public application URL; its origin is the only one browser mutations may come from, and a missing or malformed value refuses every one of them. In production, with all four host-trust overrides below unset, parsing a valid, non-opaque origin enables Auth.js's boolean `trustHost` flag; that flag does not compare incoming sign-in requests against this origin |
| `AUTH_URL`, `AUTH_TRUST_HOST` | Optional overrides of Auth.js's boolean `trustHost` flag: the first defined value in `AUTH_URL`, `AUTH_TRUST_HOST`, `VERCEL`, `CF_PAGES` order enables the flag when non-empty and disables it when empty, bypassing the `NODE_ENV`/`OVERFLOW_APP_URL` fallback. A non-empty `AUTH_URL` must parse as a URL and also rewrites the incoming auth request's URL origin to that URL's origin; leave all four unset to use the fallback described below |
| `VERCEL`, `CF_PAGES` | Optional hosting-platform trust flags; after `AUTH_URL` and `AUTH_TRUST_HOST`, the first defined value in this order decides sign-in host trust by whether it is non-empty. When all four are unset, the `NODE_ENV`/`OVERFLOW_APP_URL` fallback applies |
| `NODE_ENV` | Runtime mode, set to `production` by the systemd unit. With all four host-trust overrides above unset, Auth.js's boolean `trustHost` flag is true in production only when `OVERFLOW_APP_URL` parses to a valid, non-opaque origin, and is true unconditionally in other modes |
| `NEXT_RUNTIME`, `NEXT_PHASE` | Framework markers: only `NEXT_RUNTIME=nodejs` loads Node startup wiring and permits background reconciliation; missing or other runtime values do not. `NEXT_PHASE=phase-production-build` suppresses background reconciliation, while other or unset phase values leave it eligible unless explicitly disabled |
| `JOURNAL_STREAM` | Optional systemd journal stream identity (`device:inode`); only a valid value matching stderr enables journal priorities for `console.error` (3) and `console.warn` (4). Unset, malformed or mismatched values leave the console unchanged |
| `OVERFLOW_NEXT_DIST_DIR` | Also read at runtime by the third-party-notices route: selects the release directory containing `third-party-notices.txt`, trimming the value and defaulting to `.next` when unset or blank. The resolved release is pinned at first use. Keep it unset for the documented production service; its build use is described below |
| `OVERFLOW_GITHUB_WEBHOOK_URL`, `OVERFLOW_GITLAB_WEBHOOK_URL` | Public callback base URLs; registration adds a scoped `hook` UUID |
| `GITHUB_REGISTRATION_APP_ID`, `GITHUB_REGISTRATION_APP_PRIVATE_KEY_PATH` | Optional separate registration App id and PEM RSA key path. Either unset or empty disables App-based registration. A configured unreadable, unparseable or non-RSA key throws at wiring time. See [GitHub OAuth and webhooks](#operating-an-instance-github-oauth-and-webhooks) for setup |
| `OVERFLOW_GITHUB_REGISTRATION_APP_SLUG` | Optional public slug of the registration App; the landing and registration pages link its install page. Unset or invalid shows no link. |
| `OVERFLOW_GITHUB_REGISTRATION_APP_WEBHOOK_SECRET` | Secret shared with the registration App's webhook settings for `POST /api/github/app-webhook`. Unset or empty answers deliveries with HTTP `503` (fail-closed) |
| `PUBLIC_DESTINATION_DENY_CIDRS` | Optional override of the outbound fetch guard's deployment deny list: comma-separated bare IP addresses or CIDR subnets, trimmed, with invalid entries rejected. Empty or blank explicitly selects an empty list. Unset defaults to the host's public interface addresses; unavailable interface enumeration warns and defaults to an empty list, so restricted deployments must supply their public addresses explicitly |
| `CONTROLLER_NAME`, `CONTROLLER_ISSUES_URL`, `CONTROLLER_SENSITIVE_URL` | Optional controller identity and request channels the legal pages (`/account-data`, `/terms`) render; the defaults are the hosted instance's — the maintainer personally, the project's public issue tracker, and GitHub's private vulnerability reporting form — and they render only where `OVERFLOW_APP_URL`'s origin is `https://overflow.nitjsefni.eu`, so any other origin renders the plain self-hosted statement plus exactly the channels configured here, and an unset variable publishes nothing rather than the maintainer's channel. Blank values read as unset |
| `OVERFLOW_MODERATOR_GITHUB_USER_IDS` | Comma-separated moderator GitHub account ids (`gh api users/<login> --jq .id`); replaces `MODERATOR_GITHUB_LOGINS`, which is no longer read |
| `OVERFLOW_PRIVILEGED_PROXY_SECRET` | Optional shared secret the reverse proxy echoes in `x-privileged-proxy-secret` on proxied requests (operator steps in [deploy/README.md section 13](deploy/README.md#13-verifying-the-privileged-action-journals-client-addresses)); a privileged-action journal entry's client address is recorded verified only when that header equals this value and the value is set and non-empty, and an unset or empty value keeps every entry's address recorded but marked unverified |
| `GITHUB_GRAPHQL_BUDGET_RESERVE` | Optional GraphQL admission threshold for new worker passes; defaults to 500, malformed values fall back to 500, and `0` disables the hold. A very large value is deliberately restrictive; see Reconciliation for scope and restart instructions. |
| `OVERFLOW_RECONCILIATION_SWEEP_PAGE_CEILING` | Optional per-pass bound on cached sweep pages; defaults to 1000. Missing, blank, malformed, nonpositive or unsafe-integer values fall back to 1000; pages beyond the ceiling are re-fetched from the forge. |
| `RECONCILIATION_SWEEP_REQUEST_BUDGET` | Optional per-sponsor bound on the GitHub requests a sweep fold may send, reset with the sponsor's sweep window; defaults to 3000, and missing, blank, malformed, nonpositive or unsafe-integer values fall back to 3000. Read unprefixed: the `OVERFLOW_`-prefixed spelling is not read. See Reconciliation. |
| `OVERFLOW_RECONCILIATION_SWEEP_WINDOW_MINUTES` | Optional length of each sponsor's sweep window in whole minutes, for example `90`: the sweep request budget resets, a spent sponsor is held, and the sponsor's repositories are spaced on this window, and the account-data notice states it; defaults to six hours, and missing, blank, malformed, nonpositive or unsafe-integer values fall back to six hours. A change takes effect on restart. See Reconciliation. |
| `OVERFLOW_RECONCILIATION_DIFF_ONLY_BACKLOG` | Optional diff-only threshold: a sponsor is diff-only when the sum of stored issue and pull-request counts over its active repositories strictly exceeds it; defaults to 1000, and missing, blank, malformed, nonpositive or unsafe-integer values fall back to 1000. See Reconciliation. |
| `OVERFLOW_DISABLE_RECONCILIATION_SWEEP` | Any non-empty value turns off the reconciliation worker and its sweep — the whole of automatic reconciliation; jobs still accumulate and nothing drains them (see Reconciliation) |
| `OVERFLOW_SKIP_STARTUP_RECONCILIATION` | Exactly `1` skips the reconciliation sweep a restart runs at startup, as a temporary deploy override; missed deliveries stay unrecovered until the recurring sweep, a later delivery or a manual reconciliation — a sponsor over the diff-only backlog threshold is offered no sweep slot (see Reconciliation) — and any other value keeps the startup sweep on |
| `OVERFLOW_DEBUG_GITHUB_COST` | Debug-only, do not set in production: any non-empty value makes the GitHub client log the point cost and remaining balance of an issues-page query whose response carries a rate-limit reading |
| `OVERFLOW_RATE_LIMIT_EXPORT_PER_HOUR` | Optional per-identity hourly bound for `POST /api/account/export`; defaults to 3. Configured strings use JavaScript `Number` syntax: ordinary decimal/fractional and exponent notation, hexadecimal `0x`, binary `0b` and octal `0o`, with surrounding whitespace allowed. Non-finite, non-numeric and below-one values fall back to the default; every accepted capacity is at least one token. The prefixed name wins over its legacy unprefixed name, including a defined empty value; legacy-only settings remain readable. One of the five expensive-route bounds (with the repositories, tokens, forge-identities and overrides rows below): each value is one acting credential's burst per hour, refilled steadily at value/60 per minute and keyed by the credential that acts — the session's account id, or the API token's issuance id — shared with the MCP dispatch of the same operation |
| `OVERFLOW_RATE_LIMIT_REPOSITORIES_PER_HOUR` | Optional per-identity hourly bound for `POST`, `PATCH` and `DELETE /api/repositories`; defaults to 10. Same derivation, keying and fallback as the export bound |
| `OVERFLOW_RATE_LIMIT_TOKENS_PER_HOUR` | Optional per-identity hourly bound for `POST /api/tokens`; defaults to 5. Same derivation, keying and fallback as the export bound |
| `OVERFLOW_RATE_LIMIT_FORGE_IDENTITIES_PER_HOUR` | Optional per-identity hourly bound for `POST` and `DELETE /api/forge-identities`; defaults to 5. Same derivation, keying and fallback as the export bound |
| `OVERFLOW_RATE_LIMIT_OVERRIDES_PER_HOUR` | Optional per-identity hourly bound for `POST /api/overrides`, the settlement-correction request, including its MCP `correction_open` dispatch; defaults to 5. Same derivation, keying and fallback as the export bound |

### Deployment and build inputs

These values are read while configuring a build or interpolating a Compose
file. `OVERFLOW_NEXT_DIST_DIR` also has the runtime read described above.
See [the container deployment guide](deploy/container.md) for Compose usage.

| Variable | Read site and purpose |
| --- | --- |
| `OVERFLOW_NEXT_DIST_DIR` | [next.config.ts](next.config.ts), lines 6–88: optional trimmed direct-child build output directory. When set, the configuration validates the prepared matching TypeScript config and uses the directory as Next.js `distDir`; unset uses Next.js defaults. |
| `POSTGRES_HOST_BIND` | [docker-compose.yml](docker-compose.yml), lines 9–13: host address for the published PostgreSQL port; defaults to `127.0.0.1`. |
| `POSTGRES_HOST_PORT` | [docker-compose.yml](docker-compose.yml), lines 9–13: host port for PostgreSQL; defaults to `5432`, while the container port stays `5432`. |
| `APP_HOST_BIND` | [docker-compose.yml](docker-compose.yml), lines 36–39: host address for the published app port; defaults to `127.0.0.1`. |

Use placeholders only in checked-in configuration. Never commit OAuth credentials, webhook secrets, database passwords, or encryption keys.
