# Operating an Overflow instance

Reference for running a development copy or a deployment of Overflow. Using Overflow does not require any of this — the running instance is <https://overflow.nitjsefni.eu>, and [README.md](README.md) is the guide to it. `deploy/README.md` is the production deployment procedure.

## Development setup

These steps stand up a local copy of the application against a local PostgreSQL database.

1. Copy `.env.example` to `.env` and replace every placeholder. `AUTH_SECRET` can be generated with `npx auth secret`; `TOKEN_ENCRYPTION_KEY` must be an unpadded base64url encoding of 32 random bytes.
2. Use an already-installed PostgreSQL 17 server **or** start the local Compose service:

   ```bash
   docker compose up -d postgres
   docker compose ps
   ```

   That service publishes PostgreSQL on loopback only, and its password is a committed, well-known string; `POSTGRES_HOST_BIND` widens that binding, so any address other than a loopback one publishes a database with known credentials to everything that can route to this machine. To reach it from another host, forward the loopback port over SSH — `ssh -L 5432:127.0.0.1:5432 <host>` — instead of widening the bind address.

3. Point `DATABASE_URL` at that database, then install and migrate:

   ```bash
   pnpm install --frozen-lockfile
   pnpm db:migrate
   ```

4. Start the application:

   ```bash
   pnpm dev
   ```

Useful verification commands (the geometry check needs a Chrome/Chromium binary and, when it spawns its own server, `DATABASE_URL`):

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
shared credential after all registrations migrate; keep `TOKEN_ENCRYPTION_KEY`.

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

## Continuous integration

GitHub Actions runs the complete gate on pushes to `main`, pull requests targeting `main`, and manual dispatches. The gate uses the pinned Node and pnpm versions, applies migrations to PostgreSQL 17, then runs `pnpm test --run`, `pnpm lint`, `pnpm typecheck`, and `pnpm build`, finishing with the page-geometry check, `node scripts/check-page-geometry.mjs`, against the built output. A separate actionlint/zizmor workflow validates and security-checks the workflow definitions themselves. All actions are commit-pinned and checkout credentials are not persisted.

## Environment reference

`.env.example` documents every required setting:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `AUTH_SECRET` | Auth.js session signing secret |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | GitHub OAuth application credentials |
| `TOKEN_ENCRYPTION_KEY` | OAuth-token encryption key |
| `APP_URL` | Public application URL; its origin is the only one browser mutations may come from, and a missing or malformed value refuses every one of them |
| `GITHUB_WEBHOOK_URL`, `GITLAB_WEBHOOK_URL` | Public callback base URLs; registration adds a scoped `hook` UUID |
| `MODERATOR_GITHUB_USER_IDS` | Comma-separated moderator GitHub account ids (`gh api users/<login> --jq .id`); replaces `MODERATOR_GITHUB_LOGINS`, which is no longer read |
| `GITHUB_GRAPHQL_BUDGET_RESERVE` | Optional GraphQL admission threshold for new worker passes; defaults to 500, malformed values fall back to 500, and `0` disables the hold. A very large value is deliberately restrictive; see Reconciliation for scope and restart instructions. |

Use placeholders only in checked-in configuration. Never commit OAuth credentials, webhook secrets, database passwords, or encryption keys.
