# Overflow

Overflow is a cooperative ledger for open-source work. A repository sponsor offers work, an outside contributor closes it through GitHub, and Overflow records a settled credit transfer with auditable proof.

## What the ledger records

- GitHub OAuth signs a member in at `/api/auth/callback/github`. Configure the OAuth app's callback URL as `https://<public-host>/api/auth/callback/github`.
- Repository registration is explicit and one at a time. The signed-in person must have GitHub administrator permission for the submitted `owner/name` or canonical `https://github.com/owner/name` URL.
- Each repository chooses its own opening catalog. S/M/L is allowed, but so are arbitrary labels such as `moonlit ridge`, `risk: high`, or anything else the repository understands. Each opening label carries comparison and reserve points from 1 through 10.
- Every actual catalog has exactly one editable mapping for each point from 1 through 10. The labels are repository-defined; the point mapping is the common settlement scale.
- The dashboard uses materialized ledger entries and balances. Available headroom is `settled balance − reserve points` for open issues assigned to outside contributors. `CREDIT_FLOOR`, when configured, is informational only and never clamps the result.

## GitHub and proof

Create a GitHub OAuth application and a public HTTPS webhook endpoint. Set these values in `.env`:

```dotenv
APP_URL=https://<public-host>
GITHUB_WEBHOOK_URL=https://<public-host>/api/webhooks/github
GITHUB_WEBHOOK_SECRET=<the-webhook-secret-configured-in-github>
```

GitHub must be able to reach the webhook URL over public HTTPS. Keep the webhook secret private and set the same value in GitHub and `GITHUB_WEBHOOK_SECRET`.

Closing-link evidence comes from GitHub GraphQL. A pull request settles only when GraphQL authority establishes its linked issue; issue or pull-request text alone is not authoritative. Overflow stores the proof fingerprint with the settlement so the issue, pull request, and scoring inputs can be reviewed later.

## Scoring and calibration

For an outside contributor, settled credits are:

```text
credits = max(0, actual points − distinct review rounds)
```

There is no churn metric. Calibration compares paired self-work samples with outsider settlements; it does not measure activity retention. Self-work is useful calibration evidence, but it creates no ledger entry. If an outside contributor has not signed in yet, their completed work remains an unclaimed settlement until their GitHub identity is claimed.

Moderation is account-level and evidence-led:

```text
audit → warn → recalibrate → ban
```

Open an audit only with the required paired samples, warn when the record supports it, require recalibration before reactivation, and ban only after confirmed patterns persist.

## Local setup

1. Copy `.env.example` to `.env` and replace every placeholder. `AUTH_SECRET` can be generated with `npx auth secret`; `TOKEN_ENCRYPTION_KEY` must be an unpadded base64url encoding of 32 random bytes.
2. Use an already-installed PostgreSQL 17 server **or** start the local Compose service:

   ```bash
   docker compose up -d postgres
   docker compose ps
   ```

3. Point `DATABASE_URL` at that database, then install and migrate:

   ```bash
   pnpm install --frozen-lockfile
   pnpm db:migrate
   ```

4. Start the application:

   ```bash
   pnpm dev
   ```

Useful verification commands:

```bash
pnpm test --run
pnpm lint
pnpm typecheck
pnpm build
```

## Reconciliation

Webhook processing updates repository state incrementally. Run reconciliation when GitHub history must be re-read:

```bash
# Reconcile one explicit registered repository by owner/name.
pnpm reconcile -- --repository <owner>/<name>

# Reconcile every active registered repository.
pnpm reconcile
```

Reconciliation materializes issues, linked pull requests, settlement proof, self-work calibration, and unclaimed contributor records. It is the safe repair path after webhook downtime or a GitHub configuration change.

## Environment reference

`.env.example` documents every required setting:

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | PostgreSQL connection string |
| `AUTH_SECRET` | Auth.js session signing secret |
| `AUTH_GITHUB_ID`, `AUTH_GITHUB_SECRET` | GitHub OAuth application credentials |
| `TOKEN_ENCRYPTION_KEY` | OAuth-token encryption key |
| `APP_URL` | Public application URL |
| `GITHUB_WEBHOOK_URL`, `GITHUB_WEBHOOK_SECRET` | Public GitHub webhook URL and shared secret |
| `MODERATOR_GITHUB_LOGINS` | Comma-separated moderator GitHub logins |
| `CREDIT_FLOOR` | Optional informational credit-floor display |

Use placeholders only in checked-in configuration. Never commit OAuth credentials, webhook secrets, database passwords, or encryption keys.
