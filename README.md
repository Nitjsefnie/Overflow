# Overflow

Overflow is a cooperative ledger for open-source work. A repository sponsor offers work, an outside contributor closes it through GitHub, and Overflow records a settled credit transfer with auditable proof.

**Overflow is already running at <https://overflow.nitjsefni.eu>.** Pointing you at that instance is what this repository is for. You do not need to deploy anything to use Overflow — sign in there and join the ledger that already exists. The setup instructions further down build a development environment for changing Overflow itself; they are not the way to use it.

`Nitjsefnie/Overflow` is itself registered in that instance, and the issues in this tracker are materialized there, so the mechanism described below can be watched working on this repository itself.

## Join the running instance

1. **Sign in.** Open <https://overflow.nitjsefni.eu> and choose *Sign in with GitHub*. That is the whole account setup — there is nothing to install and nothing to configure.
2. **Register a repository, catalogs and all, on one form.** *Register a repository* takes the repository and both of its catalogs and submits them together; there is no separate catalog-editing page afterwards, so decide the labels and their points before you start. Bring a public repository you administer. Registration writes to it: Overflow creates the catalog labels there and installs its webhook. [What the ledger records](#what-the-ledger-records) is the reference for what a catalog has to contain.
3. **Offer work, then settle it.** Apply an opening label when you file an issue. After the closing pull request's final commit and before you merge it, apply an actual-catalog label and post a comment naming that label. Those are the labels Overflow created for you in step 2. [What the ledger records](#what-the-ledger-records) states the evidence each label has to satisfy, and [Scoring and calibration](#scoring-and-calibration) says what it is worth.
4. **Read the ledger.** A signed-in member gets *Ledger*, *Issues*, *Settlements*, *Register a repository*, *Calibration* and *Rules*.

Closing work needs no repository of your own. Take an issue in a repository that is already registered; the sections that follow are the terms the credit settles on, including what happens when you have not signed in yet.

## Programmatic repository registration

Members can register repositories with an **Overflow-issued API token**. Account
registration still happens manually in a browser through **Sign in with GitHub**;
after that, repositories can be registered over the API. The existing web form
remains unchanged and available — programmatic registration is an additional way
to submit the same repository and catalogs.

### Get or replace a token

Sign in, open **Register a repository** (`/repositories/new`), and use **Generate
token** in the **Overflow API token** panel. Copy the token when it appears: it is
shown only at generation and cannot be redisplayed after leaving or reloading
the page. The server stores only its hash, so it cannot recover the plaintext.

Each account has at most one active token. **Regenerate token** issues a new token
and invalidates the previous one in the same step. Use regeneration if you lose
the token or it leaks, and replace the credential in your scripts. Keep the token
private; do not commit it.

The panel calls `POST /api/tokens` with the signed-in browser session cookie and
no request body. An API token alone cannot mint or regenerate a token. Success
is HTTP `201` with `{ "token": "<new-token>", "createdAt": "<ISO-8601 timestamp>" }`.
Failures use `{ "error": { "code": "...", "message": "..." } }`:

| HTTP | Code | Exact message | Meaning / next step |
| --- | --- | --- | --- |
| 401 | `UNAUTHENTICATED` | `Sign in is required.` | Sign in through GitHub in the browser. |
| 502 | `UPSTREAM_FAILURE` | `Unable to issue an API token.` | Session lookup or token storage failed; retry when the service recovers. |

### Submit a repository

Send `POST /api/repositories` with `Authorization: Bearer <token>` and
`Content-Type: application/json`. Use the Overflow-issued token; registration
uses the account's stored GitHub OAuth credential for its GitHub operations.
The repository must be public, and that account must have GitHub administrator
permission for it. Registration creates the catalog labels and installs a webhook.

The JSON body contains exactly these required fields. Extra fields, including
extra fields inside label objects, are rejected.

| Field | Type and requirements |
| --- | --- |
| `repositoryUrl` | String: one `owner/name` or canonical GitHub repository URL. |
| `openingName` | Nonblank string: opening catalog display name. |
| `actualName` | Nonblank string: actual catalog display name. |
| `openingLabels` | Nonempty array of `{ "label": string, "comparisonPoints": number, "reservePoints": number }`. Both point values must be integers from 1 through 10. |
| `actualLabels` | Array of `{ "label": string, "points": number }` with exactly ten entries, covering every integer from 1 through 10 exactly once. |

All label text must be nonblank and unique across both catalogs. Opening labels
can use any names and need not cover every point. Do not shorten the actual
catalog to S/M/L: missing points cause rejection.

Replace `<overflow-origin>` with the origin of the Overflow instance you use
(scheme and authority, without a trailing slash), `<your-token>` with the token
from its panel, and `your-org/your-repository` with a public repository you
administer that is not already registered. Then run this complete example:

```bash
OVERFLOW_ORIGIN='<overflow-origin>'
OVERFLOW_API_TOKEN='<your-token>'

curl --include --request POST "${OVERFLOW_ORIGIN}/api/repositories" \
  --header "Authorization: Bearer ${OVERFLOW_API_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "repositoryUrl": "your-org/your-repository",
  "openingName": "Estimated scope",
  "actualName": "Delivered difficulty",
  "openingLabels": [
    { "label": "offered: small", "comparisonPoints": 2, "reservePoints": 2 },
    { "label": "offered: medium", "comparisonPoints": 5, "reservePoints": 5 },
    { "label": "offered: large", "comparisonPoints": 8, "reservePoints": 8 }
  ],
  "actualLabels": [
    { "label": "settled: 1", "points": 1 },
    { "label": "settled: 2", "points": 2 },
    { "label": "settled: 3", "points": 3 },
    { "label": "settled: 4", "points": 4 },
    { "label": "settled: 5", "points": 5 },
    { "label": "settled: 6", "points": 6 },
    { "label": "settled: 7", "points": 7 },
    { "label": "settled: 8", "points": 8 },
    { "label": "settled: 9", "points": 9 },
    { "label": "settled: 10", "points": 10 }
  ]
}
JSON
```

### Registration responses

Success is HTTP `201`. Example body (identifiers vary):

```json
{
  "repository": {
    "id": "<repository-id>",
    "githubRepositoryId": 123456789,
    "ownerName": "your-org/your-repository",
    "sponsorId": "<account-id>",
    "visibility": "PUBLIC",
    "githubWebhookId": 987654321
  },
  "existingWorkIngested": true
}
```

`existingWorkIngested` reports whether the initial reconciliation completed
successfully, including when it finds no existing work. If it is `false`, the
repository is still registered; arrange a [reconciliation](#reconciliation) to
retry instead of registering it again.

Errors have `{ "error": { "code": "...", "message": "..." } }`. Match the HTTP
status and code, then use the message to distinguish causes:

| HTTP | Code | Exact message | Meaning / next step |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | `Invalid repository registration request.` | Invalid JSON, missing or extra fields, or wrong field types. Correct the body. |
| 400 | `INVALID_INPUT` | `Submit one GitHub repository as owner/name or a canonical GitHub URL.` | Correct the repository reference. |
| 400 | `INVALID_INPUT` | Catalog validation message listed below. | Correct the catalog names, labels, or points. |
| 401 | `UNAUTHENTICATED` | `The supplied API token was not accepted.` | The bearer credential has an invalid token format or is unknown (including a revoked token). Check the copied token or generate a replacement in the browser. |
| 401 | `UNAUTHENTICATED` | `Sign in is required.` | No recognized bearer credential and no signed-in session. Supply the bearer header or sign in. |
| 403 | `FORBIDDEN` | `The account is not eligible to register repositories.` | The account is banned or recalibrating. Resolve the account restriction; regenerating the token does not remove it. |
| 403 | `FORBIDDEN` | `Only public GitHub repositories can be registered.` | Choose a public repository. |
| 403 | `FORBIDDEN` | `GitHub administrator permission is required for the submitted repository.` | Use an account with administrator permission for that repository. |
| 409 | `CONFLICT` | `This GitHub repository is already registered.` | Use the existing registration. |
| 502 | `UPSTREAM_FAILURE` | `Unable to initialize repository registration.` | Credential/session lookup or registration setup failed; check service configuration and account GitHub access before retrying. |
| 502 | `UPSTREAM_FAILURE` | `Unable to retrieve the submitted GitHub repository.` | GitHub repository lookup failed; check the reference, access, and GitHub availability. |
| 502 | `UPSTREAM_FAILURE` | `Unable to register the repository with GitHub.` | Creating catalog labels or the webhook failed; check GitHub access and availability. |
| 502 | `UPSTREAM_FAILURE` | `Unable to save the repository registration.` | Database lookup or saving the registration failed; check service health before retrying. |

Catalog validation returns one of these exact `INVALID_INPUT` messages:

- `Display names must not be empty.`
- `At least one opening label is required.`
- `Opening label text must not be empty.`
- `Difficulty label text must be unique.`
- `Opening point mappings must be integers from one through ten.`
- `Actual label text must not be empty.`
- `Difficulty label text must be unique across catalogs.`
- `Actual point mappings must be integers from one through ten.`
- `Actual point mappings must be unique.`
- `Actual labels must cover points one through ten exactly once.`

Authentication runs before body validation. A recognized bearer credential takes
precedence over the browser cookie: a rejected token is not rescued by a valid
session. An absent or malformed bearer header falls back to cookie authentication,
which continues to serve the web form.

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

These steps stand up a local copy of the application against a local PostgreSQL database.

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
