# Overflow API

The programmatic surface of an Overflow instance: registering repositories and changing their catalogs, reading the ledger, and the MCP endpoint for agent harnesses. [README.md](README.md) is the guide to using Overflow; [OPERATING.md](OPERATING.md) is the operator reference.

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
no request body. An API token alone cannot mint or regenerate a token. Because
the session cookie is the only credential, the endpoint is same-origin only: the
request must carry an `Origin` header equal to the origin of `APP_URL` (its
scheme, host and port; any path is ignored), and it must either send no body or
declare `Content-Type: application/json`. Success is HTTP `201` with
`{ "token": "<new-token>", "createdAt": "<ISO-8601 timestamp>" }`.
Failures use `{ "error": { "code": "...", "message": "..." } }`:

| HTTP | Code | Exact message | Meaning / next step |
| --- | --- | --- | --- |
| 401 | `UNAUTHENTICATED` | `Sign in is required.` | Sign in through GitHub in the browser. |
| 403 | `FORBIDDEN` | `The request origin is not allowed.` | The request carried no `Origin` header or one that is not the origin of `APP_URL`. Mint the token from the Overflow page in the browser. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `The request must use the application/json content type.` | The request declared a `Content-Type` that is not `application/json`. Send no `Content-Type` at all, or send `application/json`. |
| 500 | `MISCONFIGURED` | `The server is not configured to accept this request.` | The deployment's `APP_URL` is missing or malformed, so it cannot recognize its own origin. Fix the server configuration; nothing about the request will help. |
| 502 | `UPSTREAM_FAILURE` | `Unable to issue an API token.` | Session lookup or token storage failed; retry when the service recovers. |

### Submit a repository

Send `POST /api/repositories` with `Authorization: Bearer <token>` and
`Content-Type: application/json`. Use the Overflow-issued token; registration
uses the account's stored GitHub OAuth credential for its GitHub operations.
The repository must be public, and that account must have GitHub administrator
permission for it. Registration creates the catalog labels and installs a webhook.

A bearer-token request is exempt from the origin check — a script is not a
browser and sends no `Origin` header — but it is not exempt from the content
type: `Content-Type: application/json` is required either way. The same endpoint
reached with a browser session cookie instead of a bearer token is
same-origin only, so its `Origin` must equal the origin of `APP_URL`.

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

#### Submitting a GitLab project

The same endpoint registers a GitLab project when the body carries
`provider: "gitlab"`. Registration then reads the project with the personal
access token of the GitLab identity you linked on the *Ledger* page (or over
`POST /api/forge-identities`) for that instance; without a verified identity on
that exact instance the request is refused. No webhook is installed and no
initial import is scheduled — the periodic reconciliation sweep picks the
project up. The catalog labels must already exist on the project; the *Register a
repository* form has no GitLab path, and neither has `PATCH`.

The body takes the catalog fields above plus these. Extra fields are still
rejected.

| Field | Type and requirements |
| --- | --- |
| `provider` | The string `gitlab`. |
| `instanceUrl` | String: an absolute `http` or `https` URL naming the instance's host, such as `https://gitlab.com`. Only the scheme and host are used, lowercased; a path is ignored. It must match the instance of a linked identity. |
| `project` | String: the project's numeric id (a positive integer), or its path with namespace, such as `group/project` or `group/subgroup/project`. |
| `repositoryUrl` | String: still required by the request schema, and not read for a GitLab submission. |

```bash
curl --include --request POST "${OVERFLOW_ORIGIN}/api/repositories" \
  --header "Authorization: Bearer ${OVERFLOW_API_TOKEN}" \
  --header 'Content-Type: application/json' \
  --data-binary @- <<'JSON'
{
  "provider": "gitlab",
  "instanceUrl": "https://gitlab.com",
  "project": "your-group/your-project",
  "repositoryUrl": "your-group/your-project",
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

Success is HTTP `201` with the same body shape as a GitHub registration:
`githubRepositoryId` is the GitLab project id, `ownerName` is the project's
path with namespace, `githubWebhookId` is `null`, `initialImportScheduled` is
`false`, and `claimPath` is `"NOT_CHECKED"`.

The authentication, content-type and catalog-validation answers are the ones the
registration responses below list. The GitLab path answers these in addition;
angle-bracketed text is substituted at runtime:

| HTTP | Code | Exact message | Meaning / next step |
| --- | --- | --- | --- |
| 400 | `INVALID_INPUT` | `The instance URL must be an absolute URL.` | `instanceUrl` is missing or does not parse as a URL. |
| 400 | `INVALID_INPUT` | `The instance URL must use http or https.` | Correct the scheme. |
| 400 | `INVALID_INPUT` | `A GitLab registration requires the instance URL and the project id or path.` | `project` is missing or empty. |
| 400 | `INVALID_INPUT` | `The GitLab project id must be a positive integer.` | `project` is all digits but not a positive safe integer. |
| 400 | `INVALID_INPUT` | `Submit the GitLab project as a positive numeric id or a path with namespace.` | `project` is neither digits nor a path containing `/`. |
| 400 | `INVALID_INPUT` | `The GitLab project does not carry these labels: <labels>. Create them, then register again.` | `<labels>` is the comma-separated list of catalog labels the project lacks. Create them on the project, then register again. |
| 403 | `FORBIDDEN` | `A verified GitLab identity linked to this instance is required to register a GitLab repository.` | Link a GitLab identity for exactly this instance, then retry. |
| 404 | `NOT_FOUND` | `No GitLab project with that id is visible through the linked identity.` | A numeric `project` the instance answered 404 for. Check the id and the token's access. |
| 409 | `CONFLICT` | `This GitLab project is already registered.` | Use the existing registration. |
| 409 | `CONFLICT` | `GitLab project <id> collides with forge id <id> already registered as provider '<provider>'. An id's forge history never migrates between forges; registration refused.` | A registration under another forge already holds that numeric id, so this id cannot become a GitLab registration. |
| 502 | `UPSTREAM_FAILURE` | `Unable to save the repository registration.` | Saving the registration failed; check service health before retrying. |
| 502 | `UPSTREAM_FAILURE` | `Unable to initialize repository registration.` | Every other failure of a read against the instance — a path the instance does not answer, a token it no longer accepts, a transport failure — as well as an unavailable GitHub credential for the account. Check the project path, the linked token and the instance, then retry. |

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
  "initialImportScheduled": true
}
```

`initialImportScheduled` reports whether the import of the work that already
exists in the repository was queued, not whether it has finished: the import
runs after the response, and the issues appear once it does. If it is `false`,
the repository is still registered but nothing is queued; the periodic repair
sweep brings its existing work in later, or arrange a
[reconciliation](OPERATING.md#reconciliation) yourself. Registering the repository again is
never the remedy.

Errors have `{ "error": { "code": "...", "message": "..." } }`. Match the HTTP
status and code, then use the message to distinguish causes:

| HTTP | Code | Exact message | Meaning / next step |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | `Invalid repository registration request.` | Invalid JSON, missing or extra fields, or wrong field types. Correct the body. |
| 400 | `INVALID_INPUT` | `Submit one GitHub repository as owner/name or a canonical GitHub URL.` | Correct the repository reference. |
| 400 | `INVALID_INPUT` | `The repository is missing the difficulty labels <labels>. Create them on GitHub, then register again.` | The repository's existing labels do not include every label the submitted catalog names; `<labels>` is the backticked list of the missing ones. Create those labels on GitHub, then register again. |
| 400 | `INVALID_INPUT` | Catalog validation message listed below. | Correct the catalog names, labels, or points. |
| 401 | `UNAUTHENTICATED` | `The supplied API token was not accepted.` | The bearer credential has an invalid token format or is unknown (including a revoked token). Check the copied token or generate a replacement in the browser. |
| 401 | `UNAUTHENTICATED` | `Sign in is required.` | No recognized bearer credential and no signed-in session. Supply the bearer header or sign in. |
| 401 | `GITHUB_CREDENTIALS` | `GitHub rejected the authorization Overflow holds for this account (HTTP 401) while trying to <step>. To refresh the authorization, sign out of Overflow and sign in again with GitHub, then retry registration.` | GitHub rejected the stored GitHub authorization for the account (expired or revoked); the account's Overflow session is fine. Refresh the authorization by signing out and back in, then retry the registration. |
| 403 | `FORBIDDEN` | `The request origin is not allowed.` | A browser (session-cookie) request carried no `Origin` header or one that is not the origin of `APP_URL`. A bearer-token request never reaches this: its origin is not consulted. |
| 403 | `FORBIDDEN` | `The account is not eligible to register repositories.` | The account is banned or recalibrating. Resolve the account restriction; regenerating the token does not remove it. |
| 403 | `FORBIDDEN` | `Only public GitHub repositories can be registered.` | Choose a public repository. |
| 403 | `FORBIDDEN` | `GitHub administrator permission is required for the submitted repository.` | Use an account with administrator permission for that repository. |
| 403 | `GITHUB_ACCESS` | `GitHub refused to <step> (HTTP 403). GitHub answers 403 both when the Overflow OAuth application is not yet authorized and when it is temporarily limiting requests, and this response carries nothing that separates the two causes. Wait a minute and retry registration before changing anything. <cause> Review Overflow's authorization at https://github.com/settings/applications, then retry registration.` | GitHub refused a setup step without rate-limit evidence, so the answer cannot separate a missing Overflow OAuth authorization from a temporary limit; wait a minute and retry first. `<step>` is the lookup, label-read, or webhook-create step that died, and `<cause>` names the missing authorization — for an organization-owned repository, the owner approval the Overflow application needs there. |
| 403 | `GITHUB_ACCESS` | `GitHub answered 404 for the request to <step>. GitHub returns 404 rather than 403 when it will not reveal a resource, which can indicate missing authorization. The repository may also have been renamed, moved or deleted<since it was looked up>. <cause> Review Overflow's authorization at https://github.com/settings/applications, then retry registration.` | GitHub hid the resource the setup step asked for, which it does instead of refusing it; treat the step as unauthorized until checked. `<since it was looked up>` appears when the repository had already been looked up, and `<cause>` again names the missing authorization, with the organization-owned variant as above. |
| 409 | `CONFLICT` | `This GitHub repository is already registered.` | Use the existing registration. |
| 409 | `CONFLICT` | `The GitHub path <owner/name> is claimed by a different registration. The submitted repository is not registered, and it cannot be registered while another registration holds that path.` | The submitted repository has never been registered, but another registration holds its `owner/name`. Retrying repeats the same collision; the registration holding the path has to be resolved first. |
| 409 | `CONFLICT` | `The GitHub webhook created for the submitted repository collided with one a different registration already records. The submitted repository is not registered. Registering again requests a new webhook from GitHub, so retry once before treating this as stored state that has to be resolved.` | The submitted repository has never been registered. The collision is on the webhook id GitHub returned for the hook this attempt created, and registering again requests another webhook, so retry once first. Only a collision that repeats points at stored state that has to be resolved. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `The request must use the application/json content type.` | The request declared a `Content-Type` that is not `application/json`. This applies to bearer-token requests too, and is answered before the token is looked up. |
| 429 | `GITHUB_RATE_LIMITED` | `GitHub rate-limited the request to <step> (HTTP <status>). Please retry registration later.` | GitHub limited a setup step. `<status>` is 429, or 403 carrying rate-limit evidence; GitHub may append a `Retry after <N> seconds.` sentence when it supplies a delay, and the message ends with the retry instruction either way. Wait out the delay if given, then retry. |
| 500 | `MISCONFIGURED` | `The server is not configured to accept this request.` | The deployment's `APP_URL` is missing or malformed. Only a browser request reaches this; a bearer-token request does not read `APP_URL`. |
| 502 | `UPSTREAM_FAILURE` | `Unable to initialize repository registration.` | Credential/session lookup or registration setup failed; check service configuration and account GitHub access before retrying. |
| 502 | `UPSTREAM_FAILURE` | `Unable to retrieve the submitted GitHub repository.` | GitHub repository lookup failed; check the reference, access, and GitHub availability. |
| 502 | `UPSTREAM_FAILURE` | `Unable to read the repository difficulty labels on GitHub.` | Reading the repository's existing labels failed after the repository itself was found; check GitHub access and availability. |
| 502 | `UPSTREAM_FAILURE` | `Unable to create the repository webhook on GitHub.` | Creating the webhook failed after the repository was found and its labels verified; check GitHub access and availability. |
| 502 | `UPSTREAM_FAILURE` | `Unable to save the repository registration.` | Database lookup or saving the registration failed; check service health before retrying. |
| 503 | `ROLLBACK_INCOMPLETE` | `The repository registration could not be saved, and the webhook Overflow created for it could not be deleted on GitHub. Nothing was registered; retry the registration, and a later successful registration or unregistration removes the abandoned webhook.` | The save failed and the compensating webhook deletion failed too, so a webhook Overflow created still exists on GitHub. Nothing was registered and nothing is lost by retrying; the recorded webhook is cleaned up by a later successful registration or unregistration. |

Angle-bracketed text in the `Exact message` column is a value substituted at runtime.

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

### Changing a registered catalog

A repository's difficulty catalog is a versioned series, not a fixed choice.
`PATCH /api/repositories` accepts the same body a registration takes and appends
the submitted catalog as the repository's next catalog version; the browser form
on the *Register a repository* page does the same. The version begins governing
at the moment of the change, so:

- closures whose evidence window closed before the change keep resolving at
  their recorded figures, and
- closures whose evidence window closes after the change are priced by the new
  catalog.

A submission identical to the current catalog changes nothing and reports it.
Errors have the same shape as the registration errors above; the change path
answers `CONFLICT` for an unregistered repository, and `FORBIDDEN` for anyone
but the repository's sponsor or an account that is not eligible to change
repository catalogs.

## Reading the ledger over the API

Each page a signed-in member reads has a GET endpoint answering the same JSON
the page renders: the dashboard behind the *Ledger* page, the issues board, the
settlement history, a settlement's proof, and calibration. They use the same
Overflow-issued `ovf_` tokens as registration, sent as
`Authorization: Bearer <token>`; a browser can call them with its signed-in
session cookie instead. The credential rules are the ones registration states:
a recognized bearer credential takes precedence over the cookie, a rejected
token is not rescued by a valid session, and an absent or malformed bearer
header falls back to the cookie. Unlike the registration endpoints, these reads
are answered without an origin check — a programmatic GET sends no `Origin`
header at all, so guarding them would reject every script client. They take no
request body.

Every response is scoped to the authenticated account: each endpoint queries
with the credential's account id, and the settlement proof is answered only to
a caller who is a party to that settlement.

### The endpoints

| Endpoint | Parameters | Success body (HTTP `200`) |
| --- | --- | --- |
| `GET /api/dashboard` | None. | The dashboard projection the *Ledger* page renders. Each entry of `registeredRepositories` carries `reconciliationLastFailureAt` as an ISO 8601 string, or `null` when there is no recorded failure. |
| `GET /api/issues` | Query parameters `repository`, `openingLabel`, `claimState`, all optional. | An array of the issue projections the board renders. |
| `GET /api/settlements` | None. | An array of the settlement-history rows the page renders. |
| `GET /api/settlements/<id>` | Path parameter `id`. | `{ "settlement": <settlement proof projection>, "corrections": <correction requests raised against the settlement, or null> }`. |
| `GET /api/calibration` | None. | `{ "comparison": <calibration comparison>, "selfWork": <self-work calibration rows, or null> }`. |

The field lists of these projections are the server's compiled types, not a
schema this document maintains; this section records the endpoints, their
parameters, and their status behavior.

On `/api/issues`, a filter is applied only when the request names exactly one
value for it — a parameter named more than once is left unset. `claimState`
understands `CLAIMED` and `ALL`; anything unrecognized, including no value at
all, reads the unclaimed board (`OPEN`).

Two responses degrade rather than fail. In the settlement proof, `corrections`
is `null` when the correction history could not be read, and the settlement
itself is still answered; in the calibration response, `selfWork` is `null`
under the same terms and the comparison is still answered. The pages render the
same degradation, so neither null is an API-only shape.

Both list reads are capped at the most recent 200 rows — the settlement
history on `/api/settlements` and the `selfWork` list on `/api/calibration` —
mirroring what the pages render, so a capped list is not distinguishable from
complete history.

### Read responses

Success is HTTP `200`. Errors use the registration error envelope,
`{ "error": { "code": "...", "message": "..." } }`. Match the HTTP status and
code, then use the message to distinguish causes:

| HTTP | Code | Exact message | Meaning / next step |
| --- | --- | --- | --- |
| 401 | `UNAUTHENTICATED` | `The supplied API token was not accepted.` | The bearer credential has an invalid token format or is unknown (including a revoked token). Check the copied token or generate a replacement in the browser. |
| 401 | `UNAUTHENTICATED` | `Sign in is required.` | No recognized bearer credential and no signed-in session. Supply the bearer header or sign in. |
| 403 | `FORBIDDEN` | `A member account is required.` | The credential resolved to an account that no longer exists: the member gate re-reads the account's role from the database at request time, so a session or token outliving its account is refused. |
| 404 | `NOT_FOUND` | `Settlement proof is not available.` | (`GET /api/settlements/<id>`) No settlement with this id, or the caller is not a party to it. Both are the same refusal. |
| 502 | `UPSTREAM_FAILURE` | `Unable to authorize the member request.` | Credential lookup or the role re-read failed; retry when the service recovers. |
| 502 | `UPSTREAM_FAILURE` | `Unable to load the eligible issues.` | (`GET /api/issues`) The read behind the endpoint failed; retry when the service recovers. |
| 502 | `UPSTREAM_FAILURE` | `Unable to load the settlement history.` | (`GET /api/settlements`) The read behind the endpoint failed; retry when the service recovers. |
| 502 | `UPSTREAM_FAILURE` | `Unable to load the settlement proof.` | (`GET /api/settlements/<id>`) The read behind the endpoint failed; retry when the service recovers. |
| 502 | `UPSTREAM_FAILURE` | `Unable to load the calibration comparison.` | (`GET /api/calibration`) The read behind the endpoint failed; retry when the service recovers. |
| 502 | `UPSTREAM_FAILURE` | `Unable to load the dashboard.` | (`GET /api/dashboard`) The read behind the endpoint failed; retry when the service recovers. |

## Calling Overflow from an agent harness

The API above is also exposed as MCP tools over a single endpoint,
`POST /api/mcp`, so an agent harness can read the ledger and drive the
moderation and correction flows without hand-rolling HTTP calls against the
page endpoints.

Authentication uses the same Overflow-issued `ovf_` tokens, sent as
`Authorization: Bearer <token>`. Browser sessions work for the reads, but
token auth is the intended credential: a cookie-authenticated write through
MCP is refused, because the synthesized internal calls carry no `Origin`
header for the same-origin guard to check.

The transport is stateless streamable HTTP — one JSON-RPC request per
`POST`, and no session state between calls. `initialize` answers with
protocol version `2025-06-18`; a notification (a JSON-RPC request with no
`id`) is answered with an empty HTTP `202`.

### The tools

| Tool | Purpose |
| --- | --- |
| `issues_board` | List the eligible issues on the claim board, optionally filtered by repository, opening label or claim state. |
| `settlements_list` | List the calling account's priced settlements. |
| `settlement_get` | Fetch one settlement's proof by its id. |
| `calibration_compare` | Fetch the calibration comparison for the calling account. |
| `dashboard_summary` | Fetch the calling account's dashboard summary. |
| `moderation_queue` | List the account audits currently open in the moderation queue. |
| `audit_open` | Open an account audit over a calibration sample. |
| `audit_decide` | Dismiss or substantiate an open account audit. |
| `correction_open` | Request a correction to a priced settlement or calibration outcome. |
| `correction_decide` | Grant or decline a settlement correction request. |

Tool errors are not transport errors: the wrapped endpoint's
`{ "error": { "code": "...", "message": "..." } }` envelope comes back as the
result's text content with `isError: true`, so read the text to tell a
validation refusal from an upstream outage.

On `issues_board`, a filter argument that is not a string is dropped from the
query rather than rejected, so an omitted argument and a malformed one read
the same board.
