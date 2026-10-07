# Operating an Overflow instance

Reference for running a development copy or a deployment of Overflow. Using Overflow does not require any of this — the running instance is <https://overflow.nitjsefni.eu>, and [README.md](README.md) is the guide to it. `deploy/README.md` is the production deployment procedure.

## Governance: single-maintainer operation

The repository and the hosted instance at <https://overflow.nitjsefni.eu> are each operated by one person — the GitHub user account `Nitjsefnie` for the codebase, root on the deployment host for the instance — and the arrangement is a deliberate, accepted risk: no backup operator is named. [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) records the same one-maintainer shape for conduct. The codebase and the instance stay separate concerns: the codebase is the public repository `Nitjsefnie/Overflow`, and the instance is one deployment of it, which another operator can run from the same public sources by following this document and [deploy/README.md](deploy/README.md).

In the codebase, `Nitjsefnie` is the repository owner as a GitHub user account, not an organization, so there is no organization owner, and the repository has no teams, outside collaborators, or pending invitations. The same account is the sole admin collaborator, so only the maintainer can merge a pull request. There is no `CODEOWNERS` file. `main` is protected: its required status checks are `actionlint`, `verify` and `ratchet-guard`, no approving review is required, and the protection rules are enforced on administrators. No version tags mark releases: `main`'s tip is the deployable revision, and [deploy/README.md](deploy/README.md) section 10 deploys a revision built from `main`. On the repository side of the ledger, `offered:` labels are set at filing by the issue owner and `settled:` labels before a merge, both ends held by the maintainer account, while the deployed instance prices settlements from those labels and comments automatically.

If the maintainer is unavailable, merges, issue triage and labelling, conduct decisions ([CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)), and settlement labelling stop; the tracker keeps accepting issues and pull requests, and CI keeps running on them. The repository is public, so the code itself is not at risk for as long as the account exists; deleting the account deletes the repository with it, because a personal account's repositories go with it (GitHub Docs, *Deleting your personal account*). Access recovery runs through GitHub's account-recovery processes, and no co-owner or organization owner exists who could grant access meanwhile. [deploy/incident-response.md](deploy/incident-response.md#account-loss-and-account-compromise) covers what to do when that account is deleted, locked by platform action or under someone else's control, including what the Overflow Ledger App's identity does and does not depend on.

In the instance, the service runs as the unprivileged `overflow` account under the systemd unit [deploy/overflow.service](deploy/overflow.service), pinned by `tests/deploy/unit-file.test.ts`, with `Restart=on-failure` and a five-second restart delay, and a start limit of five starts per 300 seconds, so a crash loop gives up in one final failure instead of restarting forever. Deploy authority and secret rotation sit with root on the deployment host: [deploy/README.md](deploy/README.md) section 10 deploys a new revision and section 11 rotates `TOKEN_ENCRYPTION_KEY`. The production environment file — the database URL, OAuth credentials, auth secret, token encryption key, webhook URLs and moderator ids — lives in `/etc/overflow/overflow.env`, owned by root. The production database is PostgreSQL on the deployment host, and [deploy/backup-restore.md](deploy/backup-restore.md) owns its backups. The moderator roster is resolved at sign-in from the `MODERATOR_GITHUB_USER_IDS` environment entry ([src/lib/moderation/roles.ts](src/lib/moderation/roles.ts)): a configured id is always promoted, a stored moderator is never demoted by absence from the list, grants made inside the product persist in the database, and changing the entry requires host access and a service restart. A member may request a correction to a priced settlement or calibration, and a moderator grants or declines it ([src/lib/overrides/service.ts](src/lib/overrides/service.ts)); the fold prices settlements automatically from GitHub labels and comments, so pricing itself needs no moderator. The contributor scoring this drives is screened for data-protection impact in [deploy/dpia-screening.md](deploy/dpia-screening.md), which records the scoring activities, the human-review routes on the sanctioning path, and the screening conclusion with its reopen triggers.

If the maintainer is unavailable, new deployments and secret rotation stop, moderator roster changes stop — they are an environment edit plus a service restart — and open settlement-correction requests wait, because only a moderator can grant or decline them; members can still sign in, file correction requests, and read the ledger ([README.md](README.md) is the guide to using the instance). Running unattended are the service itself under systemd (`Restart=on-failure`), the webhook receivers, GitHub sign-in, the reconciliation worker with its startup and six-hour sweep, and automatic settlement pricing from repository labels — in every case above except a deleted account, which deletes the repository the last two read, so those two stop with it. The instance is rebuildable from the public repository by another operator following this document and [deploy/README.md](deploy/README.md); the production database exists only on the deployment host, with backups per [deploy/backup-restore.md](deploy/backup-restore.md).

## Development setup

These steps stand up a local copy of the application against a local PostgreSQL database.

1. Copy `.env.example` to `.env` and replace every placeholder. Generate `AUTH_SECRET` with `openssl rand -base64 32`; generate `TOKEN_ENCRYPTION_KEY` with `node -e "process.stdout.write(require('node:crypto').randomBytes(32).toString('base64url'))"`, which prints the exact 43-character unpadded base64url form the service accepts.
2. Use an already-installed PostgreSQL 17 server **or** start the local Compose service:

   ```bash
   docker compose up -d postgres
   docker compose ps
   ```

   That service publishes PostgreSQL on loopback only by default at host port 5432, and its password is a committed, well-known string. `POSTGRES_HOST_BIND` widens that binding, while `POSTGRES_HOST_PORT` overrides the host port; the container port stays 5432. Compose reads both values from your shell or the root `.env`, so any non-loopback bind publishes a database with known credentials to everything that can route to this machine. To reach it from another host, forward the loopback port over SSH — `ssh -L 5432:127.0.0.1:5432 <host>` — instead of widening the bind address.

3. Point `DATABASE_URL` at that database, then install and migrate:

   ```bash
   pnpm install --frozen-lockfile
   pnpm db:migrate
   ```

   If `POSTGRES_HOST_PORT` is overridden, use that same host port in `DATABASE_URL`.

4. Start the application:

   ```bash
   pnpm dev
   ```

   The development server binds port 3000 by default. To use another port,
   pass Next.js's `--port` flag, for example `pnpm dev --port 3130`.
   Set `APP_URL` and the GitHub OAuth callback URL
   (`<APP_URL>/api/auth/callback/github`) to use that port too; sign-in and
   origin checks depend on those origins agreeing.

Useful verification commands (the geometry check needs a Chrome/Chromium binary and, when it spawns its own server, `DATABASE_URL` and `AUTH_SECRET`, both set in the `.env` configured above):

```bash
pnpm test --run
pnpm lint
pnpm typecheck
pnpm build
node scripts/check-page-geometry.mjs
```

`CONTRIBUTING.md` covers the rest of the development surface, including the conventions that reject work silently.

## Operating an instance: GitHub OAuth and webhooks

This section is operator configuration for a deployment you run yourself; on the running instance it is already done. `https://<public-host>` is a placeholder for your own deployment's origin — replace it with that origin, and do not read it as an address to visit.

Create a GitHub OAuth application and a public HTTPS webhook endpoint. Configure the OAuth app's callback URL as `https://<public-host>/api/auth/callback/github`, and set these values in `.env`:

```dotenv
APP_URL=https://<public-host>
GITHUB_WEBHOOK_URL=https://<public-host>/api/github/webhooks
GITLAB_WEBHOOK_URL=https://<public-host>/api/gitlab/webhooks
```

Both forges must be able to reach their callback URLs over public HTTPS. Every registration gets an independent secret and a callback UUID in the `hook` query parameter. Secrets are encrypted with `TOKEN_ENCRYPTION_KEY`; they are never returned by the repository API. A credential authenticates only its registered provider, immutable repository/project ID, and GitLab instance. Receivers reject deliveries larger than 25 MiB with HTTP 413.

## Operating an instance: the production service

The production deployment runs the application as a dedicated unprivileged system account rather than as root, under a systemd unit that keeps the filesystem read-only apart from the one cache directory Next writes at runtime. `deploy/overflow.service` is that unit, and `deploy/README.md` is the procedure that stands it up on a host, deploys a new revision under it, and rolls it back. `tests/deploy/unit-file.test.ts` fails if the unit loses any of that hardening.

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

That route is also the only one alerts take, which leaves its own failures silent: a mail path that has stopped delivering is indistinguishable from a host that has had nothing to report. `overflow-canary.timer` runs `overflow-canary.service` daily at 03:20 UTC to close that gap. It mails a probe by the same route, then reads the verdict from the exim mainlog: a stopped daemon, revoked credentials, greylisting or any 5xx leaves a `defer` or `rejected` line against the message's id and never a `Completed`, and those are caught. A path that cannot deliver is reported to a Discord webhook rather than by mail, because a mail failure reported by mail is a report nobody receives; the canary also exits nonzero, so the failure is visible in `journalctl -u overflow-canary.service` either way. One report is posted per dead streak, and the first successful run clears it. **What it does not catch is a recipient address that is wrong, deleted or converted**: a `Completed` line means the smarthost accepted the message, and nothing observable from the host distinguishes that from the mailbox existing. Treat a run of missing canary mail as a finding in its own right, at the same weight as a failed backup. [deploy/README.md section 12](deploy/README.md#12-failure-alerts) carries the install, what the verdict does and does not cover, and the two-sided verification.

## Reconciliation

A repository is folded from a durable queue rather than inside the request that noticed it had fallen behind. A GitHub webhook delivery records a reconciliation job for the repository and answers immediately; when admission is available, an in-process worker normally claims that job within seconds, folds the repository, and clears the job. After claiming, a GraphQL budget hold can defer that repository to its sponsor's reset time, releasing the lease so the worker can continue to other repositories. A fold that throws is retried on the job after a minute, five, fifteen and an hour, and a repository that exhausts those retries stays visibly failed rather than disappearing from the queue. Registering a repository records the same kind of job, because the work already in the repository predates the webhook.

A sweep runs at startup and every six hours, and offers every active repository to that queue. A repository owns one job row, so a repository already queued keeps its place and its backoff, and one whose retries were exhausted is revived. Missed webhook deliveries and repositories left failed by a GitHub outage are therefore offered for repair within six hours without manual intervention; completion can take longer because of budget holds, queued work, or further GitHub failures.

`GITHUB_GRAPHQL_BUDGET_RESERVE` controls reconciliation's admission threshold. It defaults to 500 points; `0` disables the budget hold. Set a nonnegative integer: missing, blank or malformed values fall back to 500. A very large valid value deliberately makes the threshold restrictive, potentially holding every pass with a known current reading. Under the repository lock, after resolving its sponsor and before starting a run, the fold holds when that sponsor's recorded remaining balance is below this threshold. A held job is deferred to that reading's reset time without consuming retries; its outcome is `BUDGET_HELD`, distinct from a cooldown's `DEFERRED`. This admission check also applies to direct folds. An absent or expired reading, or an unavailable observer, permits admission until a usable reading is available.

This is an **admission threshold, not a guaranteed remaining balance**. An admitted pass may fetch many pull requests and paginate without a point ceiling, so it can spend past the reserve. The threshold stops new passes; it does not cancel requests within an admitted pass.

The GraphQL budget panel at the end of the moderator page (`/moderation`) displays one entry per known quota owner: the account's GitHub login when already available from the moderator roster, otherwise its account ID, followed by the recorded remaining balance, optional limit, reserve, reset time, observation time and hold state. Each sponsor account has its own OAuth quota; its readings and transitions are keyed by account ID, never by a credential. Unowned gateways record nothing. Within each owner's newest reset window the store retains the lowest balance and rejects older windows, so delayed responses cannot erase a known hold. Observations are process-local and disappear on restart; they are not shared across application instances. No owners observed yet is displayed separately from a known owner's unobserved or held budget.

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
With the deployment's `DATABASE_URL`, `TOKEN_ENCRYPTION_KEY`,
`GITHUB_WEBHOOK_URL`, and `GITLAB_WEBHOOK_URL` loaded, run:

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
shared credential after all registrations migrate; keep `TOKEN_ENCRYPTION_KEY`,
and change it only by the [key rotation procedure](deploy/README.md#11-rotating-the-credential-encryption-key).

Each JSON outcome identifies the registration by its local ID, reports
`subscription` separately from `queue`, and names a sanitized failure stage.
`VERIFIED` means the subscription was confirmed; `QUEUED` means a full upstream
refresh was durably requested through the existing rederivation mechanism, not
that the fold has finished. Historical missed comments have no known subject to
invalidate, so this administrative repair bypasses incremental checkpoints.
A hook that was disabled stays disabled. Every verified run requests full repair,
including reruns after a queue failure.
The summary counts succeeded and failed registrations. Exit 0 requires every
registration to succeed; exit 1 indicates a failed step; exit 2 indicates invalid
arguments. Missing tokens, missing/inaccessible hooks, lost admin rights, private
repositories and mismatched IDs remain failures. Restore the sponsor's access or
correct the reported registration problem, then rerun. `UPGRADE_FAILED` indicates
configuration or enumeration failed before a complete summary was available.

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
dashboard route, so the operator handles it by hand. Identify the person's rows
by forge login and numeric user id together, never a login alone, across the
stores the notice's "People who have never signed in" section enumerates:
tracked-issue and claim-assignee logins and ids, pull request author logins and
ids, settlements credited to them, the per-repository cache of issue authors,
assignees, and comment authors, change-log entries, and moderation notes naming
them. The free text held for such a person is the issue and pull request body
text written before 2026-09-26 (comment bodies are placeholder-replaced at
write time), so for each repository holding their text clear those columns with
the unregister scrub — `scrubRepositoryFreeText` from
`src/lib/repositories/unregister-scrub.ts`, the same routine unregistration
runs, which nulls `issues.body` and `pull_requests.body` for the repository.
If the person also holds an account, handle it as the deletion commands above
do — pseudonymisation, never a hard delete: the account row keeps its id and
`github_user_id` while the login is tombstoned and avatar and tokens go, and
deletion is refused while they sponsor a registration that has not been
unregistered. Backups taken before the scrub keep the pre-scrub text until each
dump is pruned — in practice about 15 days, like any pre-deletion dump.

### Running the commands

On the deployment host, with the deployment's `DATABASE_URL` loaded:

```bash
cd /srv/overflow
set -a; . /etc/overflow/overflow.env; set +a
node --experimental-transform-types --import ./scripts/register-path-aliases.ts scripts/account.ts export --github-user-id <github-user-id>
node --experimental-transform-types --import ./scripts/register-path-aliases.ts scripts/account.ts delete --github-user-id <github-user-id>
node --experimental-transform-types --import ./scripts/register-path-aliases.ts scripts/account.ts delete --github-user-id <github-user-id> --confirm
```

Each command writes its JSON document to standard output and reports its
outcome through an exit code. The export covers every table with a foreign
key to the account — not every record that mentions the person: rows naming
the person only by GitHub login or id, with no foreign key to the account,
are not exported. Encrypted tokens appear only as presence booleans
(`hasStoredGitHubToken`, `hasStoredToken`), while the API-token hash and the
webhook secrets are omitted entirely; API-token metadata is `createdAt` and
`expiresAt`, never the hash. The first
`delete` is a dry run; `--confirm` performs it. Exit codes: `0` the command
succeeded (an export, or a confirmed deletion); `1` it failed — an unknown
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

GitHub Actions runs the complete gate on pushes to `main`, pull requests targeting `main`, and manual dispatches; the pull-request legs of the required checks fire `pull_request_target`, so the workflow definitions those runs execute are `main`'s tip and a pull request that edits its own workflow files cannot shape the job that judges it. Since issue 1090 each pull-request leg is a workflow file of its own whose `on:` set holds nothing but `pull_request_target` — `.github/workflows/ci-pr.yml`, `actionlint-pr.yml`, `ratchet-guard-pr.yml` and `secret-scan-pr.yml` — and the remaining legs — pushes to `main`, the secret scan's daily schedule tick and manual dispatches — stay in the repository-level `ci.yml`, `actionlint.yml`, `ratchet-guard.yml` and `secret-scan.yml`. On pushes to `main` and manual dispatches the `verify` job of `.github/workflows/ci.yml` uses the pinned Node and pnpm versions, applies migrations to PostgreSQL 17, then runs the test suite with coverage and the coverage-floor check — a change that touches only documentation is detected first and runs the suite without the coverage measurement — followed by an informational patch-coverage report, `pnpm lint`, the module-size ceilings, `pnpm typecheck`, `pnpm build`, and the page-geometry check, `node scripts/check-page-geometry.mjs`, against the built output. On a pull request the pull request's own code — install, migrations, tests with coverage, lint, typecheck, build and page geometry — runs only in the `pr suite` workflow (`.github/workflows/pr-suite.yml`), under `pull_request` with a read-only token, no secret and no required context of its own. The `verify` job of `.github/workflows/ci-pr.yml` then executes no pull-request code: it checks out `main`'s tip, materialises the pull request's merge commit as a detached worktree outside its workspace, and runs `main`'s copies of the gate scripts over that tree as data — conflict markers, docs-only detection, the module-size ceilings, migration immutability (which rejects an edit to a migration file that has already reached `main` — a migration, once on `main`, never changes), legal-revision currency and commit scopes. It then waits for the `pr suite` run at the pull request's head commit and requires it to have succeeded, and on a change that is not documentation-only it downloads that run's coverage summary into a fresh directory outside both trees and applies the coverage-floor check to it. The ratchet documents check, which rejects a pull request that would relax the coverage floor or the module-size ceilings, is the separate `ratchet guard` workflow pair — `.github/workflows/ratchet-guard.yml` on `main` pushes and dispatches, `.github/workflows/ratchet-guard-pr.yml` on pull requests. A pull-request run judges the head merged with the base as it stood when the run started, so its last step, base freshness, compares that base with `main`'s current tip and certifies the run only when the advance touched none of the files the pull request changes — such an advance carried its own required checks — and refuses an overlapping advance or a failed or unrepresentative comparison; pushes to `main` test `main` itself and skip it.

The separate `calibrate` job runs after a green `verify`, on pushes to `main`: when the measured coverage exceeds the recorded measurement by more than its hysteresis it rewrites the record upward — measurement and the floor derived from it — and pushes the raise to `main` as a bot commit. Branch protection refuses that push, and the job fails visibly naming the measured and recorded floors — a red `calibrate` job is the coverage ratchet's alarm, not a deployment blocker: it is not one of `main`'s required checks, and the deployment procedure gates on `main`'s required checks concluding `success` on the exact revision being deployed. Its one other run is a manual dispatch whose `simulate-refused-raise` input fabricates a raise precisely so the refusal fires: the self-test of that alarm, where a red job is the intended outcome.

The `actionlint` workflow pair — `.github/workflows/actionlint.yml`, and its pull-request leg `.github/workflows/actionlint-pr.yml`, a file whose `on:` set holds nothing but `pull_request_target` — validates and security-checks the workflow definitions themselves: `actionlint` checks workflow correctness, and `zizmor` their security posture, with `zizmor`'s install hash-pinned from `.github/requirements-zizmor.txt`, so the gate refuses any downloaded artifact matching no known hash (#686). Its pull-request leg fires `pull_request_target` like the verify job's, so the definition, checkout and tools come from `main`'s tip, while the pull request's own workflow files enter only as data — fetched as git objects and extracted into `.github/workflows-pr/` with `git show`, never checked out, installed or executed — so the gate that judges them is never shaped by them. All actions are commit-pinned and checkout credentials are not persisted.

### Required checks relay

The `ledger relay` workflow (`.github/workflows/ledger-relay.yml`) re-posts the required checks as check-runs owned by the Overflow Ledger GitHub App: when a run of `ci`, `actionlint`, `ratchet guard` or `secret scan` — or of that workflow's pull-request leg — completes, `scripts/ledger-relay.ts` reads `.github/required-checks.json` from its own checkout (the trusted main tip), decides each context whose pin names the triggering run's path from that run's job records — a pin may name several workflow paths, and since issue 1090's split every required context is produced by a repository-level file and a pull-request-only file — highest attempt wins, a non-success wins an attempt tie, a pending job posts as pending, a renamed producer posts failure — and posts one check-run per context against the triggering run's head SHA, so branch protection can pin each required context to the App instead of the github-actions app. The job runs in the `overflow-ledger` environment and needs its `LEDGER_APP_KEY` secret (the App's private key, which also carries the Actions read and Checks write permissions); the App and installation ids are pinned in the workflow. When a run's relay posting died, dispatch the workflow with the id of the newest completed producer run on the affected SHA to re-post it — the newest App check-run for a context decides, so the newest producer run is the one to name. The same dispatch is the escape hatch for the other way a posting goes missing: a relay instance replaced out of the group's single pending slot never posts anything, because GitHub cancels that pending run whenever a newer arrival joins the group whatever `cancel-in-progress` says (`tests/ci/concurrency.test.ts` records the mechanism), so the completion which triggered it is orphaned — no App check-run is ever posted for it, and branch protection refuses the merge with `Required status check ... was not set by the expected GitHub app`, which reads as a misconfiguration rather than a cancellation; this repository hit it twice on 2026-09-30, on PR 881's actionlint and PR 865's ratchet-guard. The relay's orphan sweep now relays such a completion on the next relay start, so the orphan heals itself whenever any later producer run completes; the dispatch above covers the case where none does. When a merge is refused, read the reason with `gh pr merge`: a raw `POST /pulls/N/merge` answers 404 when the base policy blocks, while `gh pr merge` surfaces the actual policy error, so the REST route reports "not found" where the truth is "policy". The relay job is never named after a required context: protection matches a required check by name and app, so a same-named job under the github-actions app would satisfy protection without the App's identity, and `tests/ci/required-checks.test.ts` holds every pinned name to exactly one producing job in every pinned file, and none anywhere else. The pull-request legs of `ci`, `actionlint`, `ratchet guard` and `secret scan` fire `pull_request_target`, so the run that judges a pull request executes `main`'s workflow definitions and a pull request that edits its own workflow files cannot shape the job that judges it; the relay accordingly mirrors onto the App the job records of main-defined runs, and never relays a `pull_request` run. Every gate script those runs execute is `main`'s copy, reading the pull request's tree only as data, so replacing a gate script in a pull request changes the tree being judged, not the judge. The pull request's one remaining control is its own test content: the suite verdict and the coverage numbers come from the pull request's own code running in `pr suite`, and the coverage-floor and module-size documents those gates read are the pull request's, held tighten-only against `main` by `ratchet guard`. That residual stays visible in review and is unchanged by the App switch; the design accepts it and keeps it visible in every review.

## Environment reference

`.env.example` documents every required application setting. The table below
covers the application's runtime settings, including the optional ones a
minimal setup leaves unset and the debug flag. Deployment and build inputs
read by Next.js configuration or Compose follow in a separate table. Neither
table covers variables read only by surrounding tooling: the Node runtime's
`NODE_ENV`, the shell's `PATH`, and the coverage-recalibration script's
`GH_TOKEN`, `GITHUB_REPOSITORY`, and optional `PUSH_REMOTE_URL` override.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `DATABASE_STATEMENT_TIMEOUT_MS` | Optional deadline in milliseconds for every statement the database work pool runs, enforced by the server; defaults to 600000 (ten minutes) when unset, while a set-but-invalid value — empty, non-numeric, negative or zero — is an error at client construction, not a fallback |
| `AUTH_SECRET` | Auth.js session signing secret |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | GitHub OAuth application credentials |
| `TOKEN_ENCRYPTION_KEY` | OAuth-token encryption key |
| `TOKEN_ENCRYPTION_KEY_PREVIOUS` | Optional decrypt-only previous key, set only while rotating `TOKEN_ENCRYPTION_KEY` by [deploy/README.md section 11](deploy/README.md#11-rotating-the-credential-encryption-key); unset or empty means none, a malformed value is an error |
| `APP_URL` | Public application URL; its origin is the only one browser mutations may come from, and a missing or malformed value refuses every one of them; the same origin is what Auth.js trusts for sign-in |
| `AUTH_URL`, `AUTH_TRUST_HOST` | Optional overrides of the host Auth.js trusts for sign-in: when either is set — along with the hosting platforms' `VERCEL` and `CF_PAGES` — it decides trust by itself and the `APP_URL` origin is no longer consulted, and a set-but-blank value reads as distrust; leave both unset to trust the `APP_URL` origin |
| `GITHUB_WEBHOOK_URL`, `GITLAB_WEBHOOK_URL` | Public callback base URLs; registration adds a scoped `hook` UUID |
| `MODERATOR_GITHUB_USER_IDS` | Comma-separated moderator GitHub account ids (`gh api users/<login> --jq .id`); replaces `MODERATOR_GITHUB_LOGINS`, which is no longer read |
| `PRIVILEGED_PROXY_SECRET` | Optional shared secret the reverse proxy echoes in `x-privileged-proxy-secret` on proxied requests (operator steps in [deploy/README.md section 13](deploy/README.md#13-verifying-the-privileged-action-journals-client-addresses)); a privileged-action journal entry's client address is recorded verified only when that header equals this value and the value is set and non-empty, and an unset or empty value keeps every entry's address recorded but marked unverified |
| `GITHUB_GRAPHQL_BUDGET_RESERVE` | Optional GraphQL admission threshold for new worker passes; defaults to 500, malformed values fall back to 500, and `0` disables the hold. A very large value is deliberately restrictive; see Reconciliation for scope and restart instructions. |
| `OVERFLOW_DISABLE_RECONCILIATION_SWEEP` | Any non-empty value turns off the reconciliation worker and its sweep — the whole of automatic reconciliation; jobs still accumulate and nothing drains them (see Reconciliation) |
| `OVERFLOW_SKIP_STARTUP_RECONCILIATION` | Exactly `1` skips the reconciliation sweep a restart runs at startup, as a temporary deploy override; missed deliveries stay unrecovered until the six-hour sweep or a manual reconciliation, and any other value keeps the startup sweep on |
| `DEBUG_GITHUB_COST` | Debug-only, do not set in production: any non-empty value makes the GitHub client log the point cost and remaining balance of an issues-page query whose response carries a rate-limit reading |

### Deployment and build inputs

These values are read while configuring a build or interpolating a Compose
file; they are separate from the application's runtime environment above.
See [the container deployment guide](deploy/container.md) for Compose usage.

| Variable | Read site and purpose |
| --- | --- |
| `NEXT_DIST_DIR` | [next.config.ts](next.config.ts), lines 6–88: optional trimmed direct-child build output directory. When set, the configuration validates the prepared matching TypeScript config and uses the directory as Next.js `distDir`; unset uses Next.js defaults. |
| `POSTGRES_HOST_BIND` | [docker-compose.yml](docker-compose.yml), lines 9–13: host address for the published PostgreSQL port; defaults to `127.0.0.1`. |
| `POSTGRES_HOST_PORT` | [docker-compose.yml](docker-compose.yml), lines 9–13: host port for PostgreSQL; defaults to `5432`, while the container port stays `5432`. |
| `APP_HOST_BIND` | [docker-compose.yml](docker-compose.yml), lines 36–39: host address for the published app port; defaults to `127.0.0.1`. |

Use placeholders only in checked-in configuration. Never commit OAuth credentials, webhook secrets, database passwords, or encryption keys.
