# Overflow

Overflow is a cooperative ledger for open-source work. A repository sponsor offers work, an outside contributor closes it through GitHub, and Overflow records a settled credit transfer with auditable proof.

**Overflow is already running at <https://overflow.nitjsefni.eu>.** Pointing you at that instance is what this repository is for. You do not need to deploy anything to use Overflow — sign in there and join the ledger that already exists. The setup instructions further down build a development environment for changing Overflow itself; they are not the way to use it.

This repository is registered in that instance. `Nitjsefnie/Overflow` is a row in its ledger and the issues in this tracker are rows joined to it, so the mechanism described below can be watched working on this repository itself.

## Join the running instance

1. **Sign in.** Open <https://overflow.nitjsefni.eu> and choose *Sign in with GitHub*. That is the whole account setup — there is nothing to install and nothing to configure.
2. **Register a repository, catalogs and all, on one form.** *Register a repository* takes the repository and both of its catalogs and submits them together; there is no separate catalog-editing page afterwards, so decide the labels and their points before you start. Bring a public repository you administer. Registration writes to it: Overflow creates the catalog labels there and installs its webhook. [What the ledger records](#what-the-ledger-records) is the reference for what a catalog has to contain.
3. **Offer work, then settle it.** Apply an opening label when you file an issue, and a result label with a comment naming it before you merge the closing pull request. Those are the labels Overflow created for you in step 2. [What the ledger records](#what-the-ledger-records) states the evidence each label has to satisfy, and [Scoring and calibration](#scoring-and-calibration) what it is worth.
4. **Read the ledger.** A signed-in member gets *Ledger*, *Issues*, *Settlements*, *Register a repository*, *Calibration* and *Rules*.

Closing work needs no repository of your own. Take an issue in a repository that is already registered; [What the ledger records](#what-the-ledger-records) and [Scoring and calibration](#scoring-and-calibration) are the terms the credit settles on, including what happens when you have not signed in yet.

## What the ledger records

- GitHub OAuth signs a member in at `/api/auth/callback/github`.
- Repository registration is explicit and one at a time. The submitted `owner/name` or canonical `https://github.com/owner/name` URL must be a public repository, and the signed-in person must have GitHub administrator permission for it.
- Each repository chooses its own opening catalog. S/M/L is allowed, but so are arbitrary labels such as `moonlit ridge`, `risk: high`, or anything else the repository understands. Each opening label carries comparison and reserve points from 1 through 10.
- Every actual catalog has exactly one editable mapping for each point from 1 through 10. The labels are repository-defined; the point mapping is the common settlement scale.
- The dashboard uses materialized ledger entries and balances. Available headroom is `settled balance − reserve points` for open issues assigned to outside contributors, and negative headroom remains visible. This release enforces no credit floor and exposes no floor configuration; optional group floors await a later idempotent assignment-enforcement design.

Closing-link evidence comes only from GitHub GraphQL `closedByPullRequestsReferences`. Opening difficulty is reconstructed from the earliest configured label that the issue owner applied before the first assignment. Settled difficulty requires an issue-owner label applied between the closing pull request's final commit and merge, plus a nonblank owner comment in that window that names the label. Pull-request labels never price work. Overflow retains those event/comment identifiers and timestamps, the exact merge commit OID, and the diff fingerprint so every scoring input is reproducible.

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

## Running your own instance is not the way to use Overflow

Each instance keeps its own ledger. Balances, reserves, settlements, proof records and calibration history live in that instance's own PostgreSQL database, and nothing in this codebase moves them between deployments. A second instance therefore starts empty and stays private to itself: no registered repositories, no counterpart to settle with, and no credit that anyone else can see or honour. Signing in at <https://overflow.nitjsefni.eu> is what puts your work in a ledger other people are already reading.

## Development setup

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

`CONTRIBUTING.md` covers the rest of the development surface, including the conventions that reject work silently.

## Operating an instance: GitHub OAuth and webhooks

This section is operator configuration for a deployment you run yourself; on the running instance it is already done. `https://<public-host>` is a placeholder for your own deployment's origin — replace it with that origin, and do not read it as an address to visit.

Create a GitHub OAuth application and a public HTTPS webhook endpoint. Configure the OAuth app's callback URL as `https://<public-host>/api/auth/callback/github`, and set these values in `.env`:

```dotenv
APP_URL=https://<public-host>
GITHUB_WEBHOOK_URL=https://<public-host>/api/github/webhooks
GITHUB_WEBHOOK_SECRET=<the-webhook-secret-configured-in-github>
```

GitHub must be able to reach the webhook URL over public HTTPS. Keep the webhook secret private and set the same value in GitHub and `GITHUB_WEBHOOK_SECRET`.

## Reconciliation

Webhook processing updates repository state incrementally. Run reconciliation when GitHub history must be re-read:

```bash
# Reconcile one explicit registered repository by owner/name.
pnpm reconcile -- --repository <owner>/<name>

# Reconcile every active registered repository.
pnpm reconcile
```

Reconciliation materializes issues, linked pull requests, settlement proof, self-work calibration, and unclaimed contributor records. PostgreSQL serializes each repository from snapshot collection through materialization. Eligibility is reconstructed at merge time from immutable moderation history, so a later sanction cannot rewrite eligible historical facts.

## Continuous integration

GitHub Actions runs the complete gate on pushes to `main`, pull requests targeting `main`, and manual dispatches. The gate uses the pinned Node and pnpm versions, applies migrations to PostgreSQL 17, then runs `pnpm test --run`, `pnpm lint`, `pnpm typecheck`, and `pnpm build`. A separate actionlint/zizmor workflow validates and security-checks the workflow definitions themselves. All actions are commit-pinned and checkout credentials are not persisted.

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

Use placeholders only in checked-in configuration. Never commit OAuth credentials, webhook secrets, database passwords, or encryption keys.
