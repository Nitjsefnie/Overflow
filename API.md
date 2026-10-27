# Overflow API

The programmatic surface of an Overflow instance: registering repositories and changing their catalogs, reading the ledger, and the MCP endpoint for agent harnesses. [README.md](README.md) is the guide to using Overflow; [OPERATING.md](OPERATING.md) is the operator reference.

## Stability and versioning

The programmatic surface — the HTTP API and the MCP endpoint together — is
versioned with one version number, following
[SemVer 2.0.0](https://semver.org/spec/v2.0.0.html). `GET /api/version`
answers `{ "version": "<version>" }` — no credential, like the readiness
probe — and an MCP `initialize` answer carries the same value as
`serverInfo.version`. Both always carry the same value, so a client can pin
what it was built against with either.

Within a major version, the response shapes documented on this page and every
MCP tool schema stay compatible: adding an HTTP field or route, or a new MCP
tool, requires a greater minor version in the same major; removing or changing
a documented shape or an existing recorded MCP tool entry requires a greater
major version. Failure answers — the error envelope, each route's status codes
and error codes — are documented shapes under the same version rule. A breaking
change requires a new major version and at least 30 days' notice, and during
the notice window the served old shape keeps working unchanged.
A breaking change made to close a security problem may ship without the 30-day
notice window. It still takes the major version bump that semantic versioning
requires, and the same release carries a changelog or deprecation entry stating
the security reason and the change.

**Version history:**

- 1.9.0: Each `GET /api/issues` row adds `doneWhen`, the repository sponsor's
  "Done when" statement as `{ "text", "notice" }`, or `null` when the issue
  has none. The text is untrusted input; `notice` carries that warning with
  it. MCP `issues_board` forwards the same field.
- 1.8.0: Each `GET /api/issues` row adds `asksOutsideRepository`, a boolean
  that is `true` while the issue carries the reserved label
  `overflow: asks outside repository`. MCP `issues_board` forwards the same
  field.
- 1.7.0: The registration response adds `openingLabels`, the repository's
  opening label names; an existing issue is listed once it carries one of
  them. The dashboard read's registered repositories carry the same names.
- 1.5.0: Closed-PR dispute responses add `landedCommitAuthorId`; account
  exports include disputes that name the account as the landing commit author.
- 1.4.0: `POST /api/account/export` adds closed-PR dispute requests and their
  credit adjustments and lines, including contributor and deciding-moderator records.
  Adds contributor filing/history at `/api/disputes` and moderator
  decisions/queue/history at `/api/moderation/disputes`.
- 1.2.0: `POST /api/repositories` accepts the optional `registrationMethod`
  selector for GitHub App registration; `DELETE /api/repositories` adds the
  optional `appAccessRemains` guidance for App-registered repositories.

**Current deprecations:**

- `POST /api/account/export`, `account.avatarUrl` — always `null` since
  1.1.0: Overflow stopped collecting the GitHub avatar URL (issue 1075),
  so nothing writes or reads the stored value anymore; the key stays so
  the export document keeps the shape clients already parse. Deprecation
  announced 2026-10-08; the earliest removal is 2026-11-07, in the next
  major version (2.0.0).

The advertised version is independent of package.json's `version` field: it
moves only as this section's policy moves it, never with npm release
bookkeeping.

## Programmatic repository registration

Members can register repositories with an **Overflow-issued API token**. Account
registration still happens manually in a browser through **Sign in with GitHub**;
after that, repositories can be registered over the API. The existing web form
remains unchanged and available — programmatic registration is an additional way
to submit the same repository and catalogs.

Registration is not the limit of what the token can do. It authenticates as the
account that generated it and carries that account's role authority on every
route that accepts a bearer token. That includes unregistering the repositories
the account sponsors and, for a moderator, moderation and override decisions.
Treat it as equivalent to the signed-in account. A few routes accept only the
browser session and refuse the token: it cannot mint or regenerate a token,
manage linked forge identities (`/api/forge-identities`), or read repository
labels for the registration form (`/api/repositories/labels`).

### Get or replace a token

Sign in, open **Register a repository** (`/repositories/new`), and use **Generate
token** in the **Overflow API token** panel. Copy the token when it appears: it is
shown only at generation and cannot be redisplayed after leaving or reloading
the page. The server stores only its hash, so it cannot recover the plaintext.

Each account has at most one active token. **Regenerate token** issues a new token
and invalidates the previous one in the same step. Use regeneration if you lose
the token or it leaks, and replace the credential in your scripts. Keep the token
private; do not commit it.

A token is issued with a 30-minute delivery window rather than a lifetime: the
plaintext exists in exactly one response, so a token nobody has ever presented is
one whose value may never have reached anybody. The first request that
authenticates with the token's value confirms it and extends it to 90 days
measured from that request, so the 90 days run from first use, not from
generation. A token nobody ever presents stops authenticating after 30 minutes.
Regenerating issues a new token with a fresh delivery window. The panel shows
when the current token expires, and marks it once it has expired. An expired
token is refused exactly like one Overflow never issued: HTTP `401` with code
`UNAUTHENTICATED` and message `The supplied API token was not accepted.` on every
route that accepts a bearer token. Regenerate the token and replace it in your
scripts.

The panel calls `POST /api/tokens` with the signed-in browser session cookie and
no request body. An API token alone cannot mint or regenerate a token, and the
session must carry a GitHub sign-in completed within the last 10 minutes; when
it does not, the panel offers the GitHub sign-in, which returns to the same page;
then generate the token again. Because
the session cookie is the only credential, the endpoint is same-origin only: the
request must carry an `Origin` header equal to the origin of `OVERFLOW_APP_URL` (its
scheme, host and port; any path is ignored), and it must either send no body or
declare `Content-Type: application/json`. Success is HTTP `201` with
`{ "token": "<new-token>", "createdAt": "<ISO-8601 timestamp>", "expiresAt": "<ISO-8601 timestamp>", "confirmedAt": null }`,
where `expiresAt` is 30 minutes after `createdAt` and `confirmedAt` is the instant
a request first authenticated with the token's value, or `null` while nobody has.
It is always `null` in this response — a mint is unconfirmed at the moment it is
handed over — so a client that reads it can tell a delivery window apart from a
started lifetime instead of treating `expiresAt` as a lifetime.
Failures use `{ "error": { "code": "...", "message": "..." } }`:

| HTTP | Code | Exact message | Meaning / next step |
| --- | --- | --- | --- |
| 401 | `UNAUTHENTICATED` | `Sign in is required.` | Sign in through GitHub in the browser. |
| 403 | `FORBIDDEN` | `The request origin is not allowed.` | The request carried no `Origin` header or one that is not the origin of `OVERFLOW_APP_URL`. Mint the token from the Overflow page in the browser. |
| 403 | `REAUTHENTICATION_REQUIRED` | `Confirm your GitHub sign-in to issue an API token.` | The session's last GitHub sign-in was more than 10 minutes ago, or the session predates this check. Sign in with GitHub again from the panel, then generate the token. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `The request must use the application/json content type.` | The request declared a `Content-Type` that is not `application/json`. Send no `Content-Type` at all, or send `application/json`. |
| 429 | `RATE_LIMITED` | `Too many requests of this kind. Retry after the number of seconds the Retry-After header names.` | The account's hourly minting bound (`OVERFLOW_RATE_LIMIT_TOKENS_PER_HOUR`, default 5) is spent. Wait out the response's `Retry-After` interval, then retry. |
| 500 | `MISCONFIGURED` | `The server is not configured to accept this request.` | The deployment's `OVERFLOW_APP_URL` is missing or malformed, so it cannot recognize its own origin. Fix the server configuration; nothing about the request will help. |
| 502 | `UPSTREAM_FAILURE` | `Unable to issue an API token.` | Session lookup or token storage failed; retry when the service recovers. |

### Submit a repository

Send `POST /api/repositories` with `Authorization: Bearer <token>` and
`Content-Type: application/json`. Use the Overflow-issued token. Both GitHub
registration methods read the repository and its labels with the account's
stored GitHub OAuth credential. The repository must be public, that account
must have GitHub administrator permission for it, and the catalog labels must
already exist on the repository.

The default `oauth_hook` method creates a repository webhook. To use `app`,
install this instance's least-privilege registration GitHub App on the
submitted repository first; the instance must have that App configured.
App registration uses the public-identity sign-in and requests no OAuth
webhook-administration scope (`admin:repo_hook`). It skips the granted-scope
probe and creates neither a per-repository webhook nor a webhook credential.
GitHub must still report `permissions.admin: true` on the sponsor's repository
read; an absent permissions object or an admin flag that is not true refuses
registration.

A bearer-token request is exempt from the origin check — a script is not a
browser and sends no `Origin` header — but it is not exempt from the content
type: `Content-Type: application/json` is required either way. The same endpoint
reached with a browser session cookie instead of a bearer token is
same-origin only, so its `Origin` must equal the origin of `OVERFLOW_APP_URL`.

The JSON body contains these fields, required unless marked optional. Extra
fields, including extra fields inside label objects, are rejected.

| Field | Type and requirements |
| --- | --- |
| `repositoryUrl` | String: one `owner/name` or canonical GitHub repository URL. |
| `registrationMethod` | Optional string: `"oauth_hook"` (the default when omitted) or `"app"`. App registration is available only for GitHub repositories; `provider: "gitlab"` with `registrationMethod: "app"` is rejected. |
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
that exact instance the request is refused. The identity's token must carry the
`api` scope — registration installs a project webhook, which a read-only
`read_api` token cannot create; such an identity still links and reconciles,
but registering with it is refused when the hook is installed. The project must
be public, and the
linked identity must hold maintainer permission on it — directly or inherited
through its group; a project failing either is refused before anything is
stored. A project hook is installed with its own independently generated secret
and a callback UUID bound to that project and instance. Deliveries arrive at the
GitLab receiver configured under `OVERFLOW_GITLAB_WEBHOOK_URL`; credential material is
encrypted at rest and omitted from API responses. The initial import is queued
exactly as for a GitHub registration. The *Register a repository* form takes
GitLab submissions, and `PATCH` accepts the same body. The catalog labels must
already exist on the project.

The body takes the catalog fields above plus these. Extra fields are still
rejected.

| Field | Type and requirements |
| --- | --- |
| `provider` | The string `gitlab`. |
| `instanceUrl` | String: an absolute `https` URL naming the instance's host, such as `https://gitlab.com`. Plain `http` and every other scheme are refused, because the linked identity's token travels with every request to the instance. Only the scheme and host are used, lowercased; a path is ignored. It must match the instance of a linked identity. |
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
path with namespace, `githubWebhookId` is the installed project hook's id,
`initialImportScheduled` reports whether the import of the project's existing
work was queued, and `claimPath` is `"NOT_CHECKED"`.

The authentication, content-type and catalog-validation answers are the ones the
registration responses below list. The GitLab path answers these in addition;
angle-bracketed text is substituted at runtime:

| HTTP | Code | Exact message | Meaning / next step |
| --- | --- | --- | --- |
| 400 | `INVALID_INPUT` | `The instance URL must be an absolute URL.` | `instanceUrl` is missing or does not parse as a URL. |
| 400 | `INVALID_INPUT` | `The instance URL must use https.` | `instanceUrl` uses `http` or another scheme. Submit the instance's `https` URL. |
| 400 | `INVALID_INPUT` | `A GitLab registration requires the instance URL and the project id or path.` | `project` is missing or empty. |
| 400 | `INVALID_INPUT` | `The GitLab project id must be a positive integer.` | `project` is all digits but not a positive safe integer. |
| 400 | `INVALID_INPUT` | `Submit the GitLab project as a positive numeric id or a path with namespace.` | `project` is neither digits nor a path containing `/`. |
| 400 | `INVALID_INPUT` | `The GitLab project does not carry these labels: <labels>. Create them, then register again.` | `<labels>` is the comma-separated list of catalog labels the project lacks. Create them on the project, then register again. |
| 403 | `FORBIDDEN` | `A verified GitLab identity linked to this instance is required to register a GitLab repository.` | Link a GitLab identity for exactly this instance, then retry. |
| 403 | `FORBIDDEN` | `Only public GitLab projects can be registered.` | Choose a public project. |
| 403 | `FORBIDDEN` | `GitLab maintainer permission is required for the submitted project.` | Use an account with Maintainer permission for that project — held directly on the project or inherited through its group. |
| 404 | `NOT_FOUND` | `No GitLab project with that id is visible through the linked identity.` | A numeric `project` the instance answered 404 for. Check the id and the token's access. |
| 409 | `CONFLICT` | `This GitLab project is already registered.` | Use the existing registration. |
| 409 | `CONFLICT` | `The GitLab path <owner/name> is claimed by a different registration. The submitted project is not registered, and it cannot be registered while another registration holds that path.` | The submitted project has never been registered as GitLab, but another registration holds its path. Retrying repeats the same collision; the registration holding the path has to be resolved first. |
| 409 | `CONFLICT` | `The project webhook created for the submitted repository collided with one a different registration already records. The submitted project is not registered. Registering again requests a new webhook, so retry once before treating this as stored state that has to be resolved.` | The collision is on the hook id the instance returned for this attempt — the same shared id space the GitHub hooks use — and registering again requests another one, so retry once first. |
| 409 | `CONFLICT` | `GitLab project <id> collides with forge id <id> already registered as provider '<provider>'. An id's forge history never migrates between forges; registration refused.` | A registration under another forge already holds that numeric id, so this id cannot become a GitLab registration. |
| 502 | `UPSTREAM_FAILURE` | `Unable to save the repository registration.` | Saving the registration failed; check service health before retrying. |
| 401 | `GITHUB_CREDENTIALS` | `GitLab rejected the linked identity's token (HTTP 401) while trying to create the project webhook. Relink your GitLab identity on the Ledger page, then retry registration.` | The instance rejected the linked token itself when the hook was installed. Refresh the identity by relinking it, then retry. |
| 403 | `GITHUB_ACCESS` | `GitLab refused to create the project webhook (HTTP 403). The linked identity does not hold maintainer permission on this project, or the instance refuses webhook management for it. Check the token's access, then retry registration.` | The instance answered but refused the hook. Check the token's roles on the project. |
| 403 | `GITHUB_ACCESS` | `GitLab answered 404 for the request to create the project webhook. The project may have been renamed, moved or deleted. Check the project, then retry registration.` | The instance hid the hook endpoint or the project is gone. Check the project path and the token's access. |
| 429 | `GITHUB_RATE_LIMITED` | `GitLab rate-limited the request to create the project webhook (HTTP 429). Please retry registration later.` | The instance limited the hook creation. Wait, then retry. |
| 502 | `UPSTREAM_FAILURE` | `Unable to create the project webhook on GitLab.` | Every other hook-creation failure — a transport failure or an unexpected instance answer. Check the instance's health, then retry. |
| 503 | `ROLLBACK_INCOMPLETE` | `The repository registration could not be saved, and the project webhook Overflow created for it could not be deleted on GitLab. Nothing was registered; retry the registration, and a later successful registration or unregistration removes the abandoned webhook.` | The save failed and the compensating hook deletion failed too, so a hook Overflow created still exists on the instance. Nothing was registered and nothing is lost by retrying; the recorded hook is cleaned up by a later successful registration or unregistration. |
| 502 | `UPSTREAM_FAILURE` | `Unable to initialize repository registration.` | An unclassified flow failure interrupted registration, including reads against the GitLab instance or store/provider lookups. Check service health, the project path, the linked token and the instance before retrying; the error is logged on the server. |

### Reading a repository's existing labels

`GET /api/repositories/labels` lists the difficulty labels a repository or
project already carries. A catalog may only pick labels that already exist —
labels are never created here, and registration verifies server-side that the
submitted catalog names only labels the repository has. The route answers to
the signed-in browser session only: an API token is refused with the same
`401` a signed-out browser gets, because the route exists for the
registration form's catalog selectboxes. Like the ledger reads below, it is
answered without an origin check — a same-origin browser `fetch()` GET sends
no `Origin` header, so guarding the read would refuse the form itself.

The query names the repository in exactly one of two shapes; any other key
set is refused:

- GitHub: `owner` and `name`, each a repository path segment (a `.git`
  suffix on the name is stripped).
- GitLab: `provider=gitlab`, `instance` (the instance's URL), and `project`
  (the numeric id or its path with namespace).

Success is HTTP `200` with `{ "labels": ["<label name>", …] }`. Errors use
the registration error envelope. The GitHub arm reuses registration's
credential vocabulary for the account's stored GitHub authorization; the
GitLab arm reads the labels through the submitter's verified linked identity,
exactly as a GitLab registration does:

| HTTP | Code | Exact message | Meaning / next step |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | `Invalid repository labels request.` | The query matched neither shape above. |
| 401 | `UNAUTHENTICATED` | `Sign in is required.` | No signed-in session. The route refuses an API token: sign in through GitHub in the browser. |
| 401 | `GITHUB_CREDENTIALS` | `GitHub rejected the authorization Overflow holds for this account (HTTP 401) while trying to read the repository labels. To refresh the authorization, sign out of Overflow and sign in again with GitHub, then retry.` | (GitHub query) The stored authorization expired or was revoked. Sign out and back in, then retry. |
| 403 | `GITHUB_ACCESS` | `GitHub refused to read the repository labels (HTTP 403). GitHub answers 403 both when the Overflow OAuth application is not yet authorized and when it is temporarily limiting requests, and this response carries nothing that separates the two causes. Wait a minute and retry before changing anything. This may be caused by missing authorization for the Overflow OAuth application. Review Overflow's authorization at https://github.com/settings/applications, then retry.` | (GitHub query) Wait a minute and retry first; the answer cannot separate a missing authorization from a temporary limit. |
| 403 | `GITHUB_ACCESS` | `GitHub answered 404 for the request to read the repository labels. GitHub returns 404 rather than 403 when it will not reveal a resource, which can indicate missing authorization. The repository may also have been renamed, moved or deleted. This may be caused by missing authorization for the Overflow OAuth application. Review Overflow's authorization at https://github.com/settings/applications, then retry.` | (GitHub query) GitHub hid the labels read; treat it as missing authorization until checked. |
| 429 | `GITHUB_RATE_LIMITED` | `GitHub rate-limited the request to read the repository labels (HTTP <status>). Please retry later.` | (GitHub query) GitHub limited the read; GitHub may append a `Retry after <N> seconds.` sentence when it supplies a delay. Wait out any delay, then retry. |
| 502 | `UPSTREAM_FAILURE` | `Unable to read the repository labels on GitHub.` | (GitHub query) The account's stored GitHub credential was unavailable, or the read failed after the repository was found. |
| 503 | `CONFIGURATION` | `Token encryption is not configured.` | (GitLab query) The deployment has no `OVERFLOW_TOKEN_ENCRYPTION_KEY`, so linked identities cannot be read. Fix the server configuration; nothing about the request will help. |
| 400 | `INVALID_REQUEST` | `The instance URL must be an absolute URL.` / `The instance URL must use https.` / `The instance URL must name a host.` | (GitLab query) The `instance` value is malformed. Submit the instance's `https` URL. |
| 400 | `INVALID_REQUEST` | `The GitLab project id must be a positive integer.` / `Submit the GitLab project as a positive numeric id or a path with namespace, like group/project.` | (GitLab query) The `project` value is malformed. |
| 404 | `NOT_FOUND` | `No GitLab identity is linked for <instance>. Link one on the dashboard's Forge identities page, then retry.` | (GitLab query) Link a GitLab identity for exactly this instance, then retry. |
| 404 | `NOT_FOUND` | `No GitLab project with that id or path is visible through your linked identity. Check the project id or path and that the identity still has access, then retry.` | (GitLab query) The instance hid the project or the identity lost access to it. |
| 403 | `FORBIDDEN` | `GitLab refused the labels read through your linked identity (HTTP <status>). The identity may have been revoked; re-link it on the dashboard's Forge identities page, then retry.` | (GitLab query) The instance rejected or refused the identity's token. Re-link the identity, then retry. |
| 429 | `RATE_LIMITED` | `GitLab rate-limited the labels read (HTTP <status>). Please retry later.` | (GitLab query) Wait, then retry. |
| 502 | `UPSTREAM_FAILURE` | `Unable to read the repository labels on GitLab.` | (GitLab query) The identity lookup or the read behind the endpoint failed. |

Angle-bracketed text in the `Exact message` column is a value substituted at
runtime.

### Registration responses

Success is HTTP `201`. The example below shows an OAuth-hook registration
(identifiers vary). App registration returns the same fields with
`repository.githubWebhookId: null`; no webhook credential is returned.

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
  "initialImportScheduled": true,
  "claimPath": "NOT_CHECKED",
  "openingLabels": ["offered: small", "offered: medium", "offered: large"]
}
```

`openingLabels` is the array of the repository's opening label names as
registered. An existing issue is listed on the board once it carries one of
these; an issue that carries none is never listed, however long the wait.

`initialImportScheduled` reports whether the import of the work that already
exists in the repository was queued, not whether it has finished: the import
runs after the response, and an existing issue is listed on the board once it
carries one of the repository's opening labels — an issue that carries none is
never listed, however long the wait. If it is `false`, the repository is still
registered but nothing is queued; the periodic repair sweep brings its existing
work in later, or arrange a [reconciliation](OPERATING.md#reconciliation)
yourself. Registering the repository again is never the remedy.

Errors have `{ "error": { "code": "...", "message": "..." } }`. Match the HTTP
status and code, then use the message to distinguish causes. App registration
shares the authentication, request, catalog, public-visibility, account,
conflict and persistence checks. Repository and label reads still use the
sponsor's stored OAuth authorization, so their OAuth recovery rows apply to
both methods. Only `oauth_hook` runs the granted-scope probe, creates a
repository webhook or performs webhook rollback. The separate messages for
the App-authenticated installation lookup name the instance's registration
App credential and operator instead.

| HTTP | Code | Exact message | Meaning / next step |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | `Invalid repository registration request.` | Invalid JSON, missing or extra fields, or wrong field types. Correct the body. |
| 400 | `INVALID_INPUT` | `Submit one GitHub repository as owner/name or a canonical GitHub URL.` | Correct the repository reference. |
| 400 | `INVALID_INPUT` | `The repository is missing the difficulty labels <labels>. Create them on GitHub, then register again.` | The repository's existing labels do not include every label the submitted catalog names; `<labels>` is the backticked list of the missing ones. Create those labels on GitHub, then register again. |
| 400 | `INVALID_INPUT` | Catalog validation message listed below. | Correct the catalog names, labels, or points. |
| 401 | `UNAUTHENTICATED` | `The supplied API token was not accepted.` | The bearer credential has an invalid token format or is unknown (including a revoked token, and an expired one — an unused token whose 30-minute delivery window closed, or a confirmed token past the 90 days its first use started, so an expired token is refused exactly like an unknown one). Check the copied token or generate a replacement in the browser. |
| 401 | `UNAUTHENTICATED` | `Sign in is required.` | No recognized bearer credential and no signed-in session. Supply the bearer header or sign in. |
| 401 | `GITHUB_CREDENTIALS` | `GitHub rejected the authorization Overflow holds for this account (HTTP 401) while trying to <step>. To refresh the authorization, sign out of Overflow and sign in again with GitHub, then retry registration.` | GitHub rejected the stored GitHub authorization for the account (expired or revoked); the account's Overflow session is fine. Refresh the authorization by signing out and back in, then retry the registration. `<step>` is `read its granted permissions` when the rejection came from the granted-scope check that precedes OAuth-hook GitHub registration, otherwise the lookup, label-read, or webhook-create step that died. |
| 403 | `FORBIDDEN` | `The request origin is not allowed.` | A browser (session-cookie) request carried no `Origin` header or one that is not the origin of `OVERFLOW_APP_URL`. A bearer-token request never reaches this: its origin is not consulted. |
| 403 | `FORBIDDEN` | `The account is not eligible to register repositories.` | The account is banned or recalibrating. Resolve the account restriction; regenerating the token does not remove it. |
| 403 | `GITHUB_WEBHOOK_SCOPE_REQUIRED` | `The GitHub authorization Overflow holds for your account cannot administer repository webhooks: registration needs the admin:repo_hook scope. Use "Sign in to register a repository" to authorize webhook administration with the same GitHub account, then register again.` | For `registrationMethod: "oauth_hook"` only: the account signed in as a contributor, which grants GitHub nothing beyond public identity, and the scopes GitHub reports for the stored authorization (its `X-OAuth-Scopes`) include neither `admin:repo_hook` nor a scope that subsumes it for public repositories (`repo`, `public_repo`). Answered before any repository or webhook request, for session and bearer callers alike. In the browser, use the landing page's "Sign in to register a repository" or the same action on the registration page; GitHub keeps the account and adds the grant. A bearer token then works without being regenerated: it resolves to the account's stored authorization. |
| 403 | `FORBIDDEN` | `Only public GitHub repositories can be registered.` | Choose a public repository. |
| 403 | `FORBIDDEN` | `GitHub administrator permission is required for the submitted repository.` | The OAuth-hook method requires administrator permission for that repository. App-specific refusals below use different wording. |
| 403 | `GITHUB_ACCESS` | `GitHub refused to <step> (HTTP 403). GitHub answers 403 both when the Overflow OAuth application is not yet authorized and when it is temporarily limiting requests, and this response carries nothing that separates the two causes. Wait a minute and retry registration before changing anything. <cause> Review Overflow's authorization at https://github.com/settings/applications, then retry registration.` | GitHub refused a setup step without rate-limit evidence, so the answer cannot separate a missing Overflow OAuth authorization from a temporary limit; wait a minute and retry first. `<step>` is the lookup, label-read, or webhook-create step that died, and `<cause>` names the missing authorization — for an organization-owned repository, the owner approval the Overflow application needs there. |
| 403 | `GITHUB_ACCESS` | `GitHub answered 404 for the request to <step>. GitHub returns 404 rather than 403 when it will not reveal a resource, which can indicate missing authorization. The repository may also have been renamed, moved or deleted<since it was looked up>. <cause> Review Overflow's authorization at https://github.com/settings/applications, then retry registration.` | GitHub hid the resource the setup step asked for, which it does instead of refusing it; treat the step as unauthorized until checked. `<since it was looked up>` appears when the repository had already been looked up, and `<cause>` again names the missing authorization, with the organization-owned variant as above. |
| 409 | `CONFLICT` | `This GitHub repository is already registered.` | Use the existing registration. |
| 409 | `CONFLICT` | `The GitHub path <owner/name> is claimed by a different registration. The submitted repository is not registered, and it cannot be registered while another registration holds that path.` | The submitted repository has never been registered, but another registration holds its `owner/name`. Retrying repeats the same collision; the registration holding the path has to be resolved first. |
| 409 | `CONFLICT` | `The GitHub webhook created for the submitted repository collided with one a different registration already records. The submitted repository is not registered. Registering again requests a new webhook from GitHub, so retry once before treating this as stored state that has to be resolved.` | The submitted repository has never been registered. The collision is on the webhook id GitHub returned for the hook this attempt created, and registering again requests another webhook, so retry once first. Only a collision that repeats points at stored state that has to be resolved. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `The request must use the application/json content type.` | The request declared a `Content-Type` that is not `application/json`. This applies to bearer-token requests too, and is answered before the token is looked up. |
| 429 | `GITHUB_RATE_LIMITED` | `GitHub rate-limited the request to <step> (HTTP <status>). Please retry registration later.` | GitHub limited a setup step. `<status>` is 429, or 403 carrying rate-limit evidence; GitHub may append a `Retry after <N> seconds.` sentence when it supplies a delay, and the message ends with the retry instruction either way. Wait out the delay if given, then retry. `<step>` is `read its granted permissions` when the limit hit the granted-scope check that precedes OAuth-hook GitHub registration, otherwise the lookup, label-read, or webhook-create step. |
| 429 | `RATE_LIMITED` | `Too many requests of this kind. Retry after the number of seconds the Retry-After header names.` | The credential's hourly bound of repository changes (`OVERFLOW_RATE_LIMIT_REPOSITORIES_PER_HOUR`, default 10) is spent; registration, catalog change and unregistration draw on it together, keyed by the credential that acts. Wait out the response's `Retry-After` interval, then retry. |
| 500 | `MISCONFIGURED` | `The server is not configured to accept this request.` | The deployment's `OVERFLOW_APP_URL` is missing or malformed. Only a browser request reaches this; a bearer-token request does not read `OVERFLOW_APP_URL`. |
| 500 | `INTERNAL_ERROR` | `Unable to initialize repository registration.` | Credential/session or live-role lookup failed, or registration wiring could not be built. Check service configuration and account access; the cause is logged on the server. |
| 502 | `UPSTREAM_FAILURE` | `Unable to initialize repository registration.` | An unclassified flow failure interrupted registration, including forge reads, the GitHub granted-scope probe, or store/provider lookups. Check service health, forge availability and account access before retrying; the error is logged on the server. |
| 502 | `UPSTREAM_FAILURE` | `Unable to retrieve the submitted GitHub repository.` | GitHub repository lookup failed; check the reference, access, and GitHub availability. |
| 502 | `UPSTREAM_FAILURE` | `Unable to read the repository difficulty labels on GitHub.` | Reading the repository's existing labels failed after the repository itself was found; check GitHub access and availability. |
| 502 | `UPSTREAM_FAILURE` | `Unable to create the repository webhook on GitHub.` | Creating the webhook failed after the repository was found and its labels verified; check GitHub access and availability. |
| 502 | `UPSTREAM_FAILURE` | `Unable to save the repository registration.` | Database lookup or saving the registration failed; check service health before retrying. |
| 503 | `ROLLBACK_INCOMPLETE` | `The repository registration could not be saved, and the webhook Overflow created for it could not be deleted on GitHub. Nothing was registered; retry the registration, and a later successful registration or unregistration removes the abandoned webhook.` | The save failed and the compensating webhook deletion failed too, so a webhook Overflow created still exists on GitHub. Nothing was registered and nothing is lost by retrying; the recorded webhook is cleaned up by a later successful registration or unregistration. |
| 400 | `INVALID_INPUT` | `Install the registration App on this repository first, then retry registration.` | App installation lookup returned no installation for the submitted repository (GitHub 404). Install this instance's registration App on that repository, then retry. |
| 400 | `INVALID_INPUT` | `Registration through the App is not available on this instance.` | The instance has no configured registration App. Contact its operator. |
| 400 | `INVALID_INPUT` | `Registration through the App is only available for GitHub repositories.` | `provider: "gitlab"` was combined with `registrationMethod: "app"`; choose GitHub or the supported GitLab hook registration. |
| 401 | `GITHUB_CREDENTIALS` | `GitHub rejected this instance's registration App credential (HTTP 401) while trying to check the registration App installation. Contact the instance operator to verify the registration App ID and private key, then retry registration.` | The App-authenticated installation lookup was rejected. The instance operator must check the registration App credential; refreshing the sponsor's OAuth authorization does not change it. |
| 403 | `FORBIDDEN` | `GitHub did not report you as an administrator of this repository. Install the registration App on this repository and ensure you hold administrator permission, then retry registration.` | App registration fails closed when the sponsor's repository read omits `permissions`, or when `permissions.admin` is false or otherwise not exactly true. Both cases intentionally share this exact response. |
| 403 | `GITHUB_ACCESS` | `GitHub refused to check the registration App installation (HTTP 403). GitHub answers 403 both when the registration App installation lookup is refused and when it is temporarily limiting requests, and this response carries nothing that separates the two causes. Wait a minute and retry registration before changing anything. If the refusal persists, contact the instance operator to check the registration App configuration and its installation on this repository.` | The App installation lookup returned 403 without rate-limit evidence. Retry before changing configuration; persistent refusals need the instance operator's App checks. |
| 403 | `FORBIDDEN` | `A member account is required.` | The live-account lookup no longer resolves the credential's account. Applies to either method. |
| 409 | `CONFLICT` | `GitHub repository <id> collides with forge id <id> already registered as provider '<provider>'. An id's forge history never migrates between forges; registration refused.` | A different forge already holds the submitted GitHub repository id. Applies to either method, including inactive registrations; resolve that stored registration first. |
| 413 | `PAYLOAD_TOO_LARGE` | `The request body is too large.` | The registration body exceeded 128 KiB. Applies to either method. |
| 429 | `GITHUB_RATE_LIMITED` | `GitHub rate-limited the request to check the registration App installation (HTTP <status>). Please retry registration later.` | The App lookup was rate-limited: `<status>` is 429, or 403 with rate-limit evidence. No retry-after delay was supplied. |
| 429 | `GITHUB_RATE_LIMITED` | `GitHub rate-limited the request to check the registration App installation (HTTP <status>). Retry after 1 second. Please retry registration later.` | The App lookup supplied a one-second retry-after delay; `<status>` is 403 or 429. |
| 429 | `GITHUB_RATE_LIMITED` | `GitHub rate-limited the request to check the registration App installation (HTTP <status>). Retry after <N> seconds. Please retry registration later.` | The App lookup supplied a retry-after delay other than one second; `<status>` is 403 or 429 and `<N>` is the supplied delay. |
| 502 | `UPSTREAM_FAILURE` | `Unable to check the registration App installation on GitHub.` | The App installation lookup failed in another way, such as a transport error, malformed successful response or unclassified GitHub status. Check GitHub availability and the instance's App setup before retrying. |

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
on the *Register a repository* page does the same for a GitHub repository. The
version begins governing
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

### Unregister a repository

Send `DELETE /api/repositories` with the same credential rules the other
registration methods state — bearer token or browser session, with
`Content-Type: application/json` either way — and a JSON body naming exactly
one registration. A GitHub registration is named by `repositoryUrl` alone; a
GitLab project by `provider: "gitlab"`, `instanceUrl`, and `project` (the
numeric id or its path with namespace) — the reference fields a GitLab
registration takes, and nothing else; extra fields are rejected.

Unregistration removes the registration from the ledger. For a hook-based
registration, it also deletes the webhook Overflow installed on the forge.
Only the registration's sponsor can issue it — not another member, and not a
moderator — and the sponsor check runs before anything is touched on the
forge, so a refusal leaves the registration and its webhook exactly as they
were. A GitLab unregistration resolves the submitter's verified linked
identity for the instance exactly as a GitLab registration does, and is
refused the same way without one.

An App registration is deactivated locally without any GitHub API call. This
does not remove the GitHub installation's access to the repository. The
optional `appAccessRemains` response directs the sponsor to
https://github.com/settings/installations to manage that access.

The flow is idempotent: unregistering an already-unregistered registration
succeeds and reports it, so a repeated request is never an error.

Success is HTTP `200` with the repository projection registration returns,
two flags, and App-only access guidance:

```json
{
  "repository": { "…": "the same repository object registration returns" },
  "webhookDeleted": true,
  "alreadyUnregistered": false
}
```

| Field | Type and meaning |
| --- | --- |
| `repository` | Object: the same repository projection registration returns. |
| `webhookDeleted` | Boolean: whether this request deleted the forge webhook. Always `false` for an App registration. |
| `alreadyUnregistered` | Boolean: `true` when the registration was already unregistered before this request. |
| `appAccessRemains` | Optional `{ "message": string, "url": string }`, present only for App-registered rows and omitted for OAuth-hook and GitLab rows. Local deactivation leaves the GitHub App's installation access in place. |
| `appAccessRemains.message` | `The GitHub App still has access to this repository. Manage its access in your GitHub installation settings.` |
| `appAccessRemains.url` | `https://github.com/settings/installations`: the sponsor's GitHub installation-management page. |

`webhookDeleted` reports whether this request deleted the forge webhook: the
forge answering 404 for the hook — it was already gone — is the desired end
state, so the unregistration proceeds and reports `false`, and a registration
from before the webhook path or an App registration has nothing to delete
and reports `false` the same way. `alreadyUnregistered` is `true` when the row had been unregistered
before the request arrived.

Errors use the registration error envelope. The authentication, origin,
content-type and oversize answers are the ones the registration responses
table lists. The distinctive answers:

| HTTP | Code | Exact message | Meaning / next step |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | `Invalid repository unregistration request.` | Invalid JSON, extra fields, or wrong field types. Correct the body. |
| 400 | `INVALID_INPUT` | `Submit one GitHub repository as owner/name or a canonical GitHub URL.` | (GitHub shape) `repositoryUrl` is missing or malformed. |
| 400 | `INVALID_INPUT` | `A GitLab unregistration requires the instance URL and the project id or path.` | (GitLab shape) `instanceUrl` or `project` is missing or empty. |
| 400 | `INVALID_INPUT` | `The instance URL must be an absolute URL.` / `The instance URL must use https.` / `The instance URL must name a host.` | (GitLab shape) Correct `instanceUrl` to the instance's `https` URL. |
| 400 | `INVALID_INPUT` | `The GitLab project id must be a positive integer.` / `Submit the GitLab project as a positive numeric id or a path with namespace.` | (GitLab shape) Correct `project`. |
| 403 | `FORBIDDEN` | `Only the repository's sponsor can unregister it.` | The credential's account is not the registration's sponsor. |
| 404 | `NOT_FOUND` | `No registration holds the GitHub path <owner/name>, so there is nothing to unregister.` | (GitHub shape) Nothing is registered under that reference. |
| 404 | `NOT_FOUND` | `No GitLab registration matches that instance and project, so there is nothing to unregister.` | (GitLab shape) Nothing is registered for that instance and project. |
| 409 | `CONFLICT` | `<GitHub repository|GitLab project> <id> collides with forge id <id> already registered as provider '<provider>'. An id's forge history never migrates between forges; unregistration refused.` | The stored row moved to another forge; resolve that registration first. |
| 500 | `INTERNAL_ERROR` | `Unable to unregister the repository.` | Registration wiring could not be built. Check service configuration and account access; the cause is logged on the server. Credential/session and live-role lookup failures use the registration table's `500 INTERNAL_ERROR` answer and `Unable to initialize repository registration.` message. |
| 502 | `UPSTREAM_FAILURE` | `Unable to unregister the repository.` | An unclassified flow failure or the final write failed; check service health before retrying. |

A webhook deletion that fails for any reason other than the hook already
being gone leaves the local row untouched and surfaces as registration's
`GITHUB_CREDENTIALS`, `GITHUB_ACCESS`, `GITHUB_RATE_LIMITED` or
`UPSTREAM_FAILURE` vocabulary for the forge step that died.

## Linked forge identities

`/api/forge-identities` manages the signed-in member's GitLab identities.
All three methods require a browser session for a `MEMBER` or `MODERATOR`;
an Overflow API bearer token does not authenticate this route. `POST` and
`DELETE` additionally re-read the account's live role, require an `Origin`
equal to the origin of `OVERFLOW_APP_URL`, and accept only an absent `Content-Type` or
`application/json` (parameters such as `charset=utf-8` are allowed). Send
`Content-Type: application/json` with either JSON body. Both writes read at
most `4 KiB`; extra body fields are rejected.

| Method | Request | Success |
| --- | --- | --- |
| `GET /api/forge-identities` | No body or query required. | `200` `{ "identities": [<linked identity>, ...] }`. Each identity has `id`, `provider`, `instanceUrl`, `forgeLogin`, `verifiedAt`, and `tokenFailedAt` (a timestamp or `null`). No token is returned. |
| `POST /api/forge-identities` | `{ "instanceUrl": <string>, "token": <nonempty string> }`. The URL must be an absolute HTTPS instance URL. The GitLab token must verify with `read_api` or `api` scope; re-linking one's own identity refreshes it. | `201` `{ "identity": <linked identity> }`, in the same shape as a GET array entry. |
| `DELETE /api/forge-identities` | `{ "id": <string> }`, the linked identity id. | `200` `{ "deleted": true }`. Only the caller's own identity can be removed. |

All three methods answer failures through `{ "error": { "code": "...", "message": "..." } }`. A failed session lookup or store construction returns a JSON `502` with `UPSTREAM_FAILURE` and the fixed message below. `GET` gives the same response when the identity list read fails.

| HTTP | Code | Message / meaning |
| --- | --- | --- |
| 400 | `INVALID_REQUEST` | `Invalid forge identity link request.` (POST) or `Invalid forge identity unlink request.` (DELETE): malformed JSON or schema-invalid body. |
| 400 | `INVALID_INPUT` | (POST) The service's message identifies an invalid instance URL; submit an absolute HTTPS URL. |
| 401 | `UNAUTHENTICATED` | `Sign in is required.` A browser session is required for every method. |
| 401 | `UNVERIFIED` | (POST) The service's message explains why GitLab could not verify the token or its read scope. |
| 403 | `FORBIDDEN` | `The request origin is not allowed.` (writes): missing or foreign `Origin`. |
| 403 | `FORBIDDEN` | `A member account is required.` (writes): the signed-in account no longer exists. |
| 403 | `FORBIDDEN` | `That forge identity is already linked to another account.` (POST): the verified identity belongs to someone else. |
| 404 | `NOT_FOUND` | `No such forge identity is linked to this account.` (DELETE): the id is absent or belongs to another account. |
| 413 | `PAYLOAD_TOO_LARGE` | `The request body is too large.` (writes): the body exceeds `4 KiB`. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `The request must use the application/json content type.` (writes): a declared non-JSON media type. |
| 429 | `RATE_LIMITED` | `Too many requests of this kind. Retry after the number of seconds the Retry-After header names.` (writes): the account's hourly bound of link and unlink operations (`OVERFLOW_RATE_LIMIT_FORGE_IDENTITIES_PER_HOUR`, default 5) is spent. Wait out the response's `Retry-After` interval, then retry. |
| 500 | `MISCONFIGURED` | `The server is not configured to accept this request.` (writes): `OVERFLOW_APP_URL` is absent or malformed. |
| 502 | `UPSTREAM_FAILURE` | (All methods) Session lookup or store construction failed; (GET) the identity list read failed; (POST/DELETE) the live account-role lookup failed, the link/unlink service returned this code, or another error was thrown during linking/unlinking. Session, store, list, live-role, and unexpected link/unlink failures use `The forge identity operation could not complete.`; a service `UPSTREAM_FAILURE` uses the service's message. |
| 503 | `CONFIGURATION` | `Token encryption is not configured.` (POST): set `OVERFLOW_TOKEN_ENCRYPTION_KEY` on the server. |

## Account data and deletion

These HTTP routes back the signed-in member's **Your account data** dashboard
controls. They require a browser session for a `MEMBER` or `MODERATOR`, not an
Overflow API bearer token. Both mutations require an `Origin` equal to the
origin of `OVERFLOW_APP_URL`; a declared `Content-Type` must be `application/json`
(optional parameters are accepted). Their error envelope is
`{ "error": { "code": "...", "message": "..." } }`.

`POST /api/account/export` needs no request body. Success is `200` with a
download named `overflow-account-export.json`, `Content-Type:
application/json; charset=utf-8`, and `Cache-Control: no-store`. Its JSON
document has `formatVersion`, `exportedAt`, `account`, `apiToken`,
`forgeIdentities`, `sponsoredRepositories`, and the account's ledger,
moderation and reconciliation sections. Stored credentials appear only as
presence booleans; token hashes and webhook secrets are omitted. The
[operator account-export reference](OPERATING.md#account-deletion-and-export)
explains its data scope.

`DELETE /api/account` deletes the signed-in account. It requires a GitHub
sign-in within the last 10 minutes and a JSON body
`{ "confirmLogin": <GitHub login string> }`, read under `4 KiB`. The login is
compared with the account's current GitHub login after trimming and without
case sensitivity. Success is `200` `{ "deleted": true }` and ends the browser
session; if deletion succeeds but ending the session fails, the response is
`200` `{ "deleted": true, "sessionEnded": false }`. The
[operator deletion reference](OPERATING.md#account-deletion-and-export)
describes what the deletion retains and scrubs.

| HTTP | Code | Exact message | Applies to / meaning |
| --- | --- | --- | --- |
| 400 | `INVALID_REQUEST` | `A confirmation login is required.` | DELETE: unreadable or invalid JSON, or `confirmLogin` is missing or not a string. |
| 400 | `CONFIRMATION_MISMATCH` | `The confirmation login does not match your account.` | DELETE: enter the signed-in account's GitHub login. |
| 401 | `UNAUTHENTICATED` | `Sign in is required.` | Both: no eligible browser session. |
| 403 | `FORBIDDEN` | `The request origin is not allowed.` | Both: missing or foreign `Origin`. |
| 403 | `FORBIDDEN` | `A member account is required.` | Both: the session's account no longer exists. |
| 403 | `REAUTHENTICATION_REQUIRED` | `Confirm your GitHub sign-in to delete your account.` | DELETE: sign in with GitHub again before confirming deletion. |
| 409 | `SPONSOR_BLOCKED` | `Unregister your sponsored repositories before deleting your account.` | DELETE: `error.repositories` lists registrations that must be unregistered first. |
| 413 | `PAYLOAD_TOO_LARGE` | `The request body is too large.` | DELETE: body exceeds `4 KiB`. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `The request must use the application/json content type.` | Both: a declared non-JSON media type. |
| 429 | `RATE_LIMITED` | `Too many requests of this kind. Retry after the number of seconds the Retry-After header names.` | POST: the account's hourly export bound (`OVERFLOW_RATE_LIMIT_EXPORT_PER_HOUR`, default 3) is spent. Wait out the response's `Retry-After` interval, then retry. |
| 500 | `MISCONFIGURED` | `The server is not configured to accept this request.` | Both: `OVERFLOW_APP_URL` is absent or malformed. |
| 502 | `UPSTREAM_FAILURE` | `Unable to export account data.` or `Unable to delete account.` | The corresponding session, database, or operation failed. |

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
| `GET /api/issues` | Query parameters `repository`, `openingLabel`, `claimState`, `page`, `pageSize`, all optional. | An array of the issue projections the board renders, one page of them. |
| `GET /api/settlements` | None. | An array of the settlement-history rows the page renders. |
| `GET /api/settlements/<id>` | Path parameter `id`. | `{ "settlement": <settlement proof projection>, "corrections": <correction requests raised against the settlement, or null> }`. |
| `GET /api/calibration` | None. | `{ "comparison": <calibration comparison>, "selfWork": <self-work calibration rows, or null> }`. |

Every `GET /api/issues` row carries `asksOutsideRepository`, a boolean that is
always present. It is `true` while the issue carries the exact, case-sensitive
label `overflow: asks outside repository`, which the repository owner or any
collaborator with label rights on the forge applies to an issue that asks for
work outside its own repository. It survives edits to the
issue and clears only when the label is removed. `false` means only that the
label is absent: it vouches for nothing about what the issue asks for.

Every `GET /api/issues` row also carries `doneWhen`, which is always present.
It is `null` when the issue has no done-when statement. Otherwise it is an
object: `text` is the statement as the sponsor wrote it, as plain text with
HTML comments removed and at most 2 KiB, and `notice` is one fixed string, the
same on every row. The statement comes from the repository sponsor's earliest
comment starting "Done when", posted before the issue was first assigned and
not edited after that. GitLab records no assignment history, so on a GitLab
project the earliest such comment counts whenever it was posted or edited. It
is untrusted input. Run any command it names only in a sandbox that holds no
credentials, as the README section "Treat issue text as untrusted input"
describes. `notice` repeats this warning so it travels with the text.

The field lists of these projections are the server's compiled types, not a
schema this document maintains; this section records the endpoints, their
parameters, and their status behavior.

On `/api/issues`, a filter is applied only when the request names exactly one
value for it — a parameter named more than once is left unset. `claimState`
understands `CLAIMED` and `ALL`; anything unrecognized, including no value at
all, reads the unclaimed board (`OPEN`).

The board is served one page at a time. `page` is 1-based: an omitted,
malformed, or non-positive value reads as the first page. `pageSize` is rows
per request: the default is 200, anything above 500 clamps back to 500, and
anything below 1 reads as 1.
A request that sends no paging parameters reads the first page at the default
size — where a client of the unpaginated board previously received every
eligible row, it now receives at most 200, with `page` to fetch the further
pages. A page holding exactly `pageSize` rows is a full page, and a full page
means a next page may exist; a shorter page is the last one.

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
| 401 | `UNAUTHENTICATED` | `The supplied API token was not accepted.` | The bearer credential has an invalid token format or is unknown (including a revoked token, and an expired one — an unused token whose 30-minute delivery window closed, or a confirmed token past the 90 days its first use started, so an expired token is refused exactly like an unknown one). Check the copied token or generate a replacement in the browser. |
| 401 | `UNAUTHENTICATED` | `Sign in is required.` | No recognized bearer credential and no signed-in session. Supply the bearer header or sign in. |
| 403 | `FORBIDDEN` | `A member account is required.` | The credential resolved to an account that no longer exists: the member gate re-reads the account's role from the database at request time, so a session or token outliving its account is refused. |
| 404 | `NOT_FOUND` | `Settlement proof is not available.` | (`GET /api/settlements/<id>`) No settlement with this id, or the caller is not a party to it. Both are the same refusal. |
| 502 | `UPSTREAM_FAILURE` | `Unable to authorize the member request.` | Credential lookup or the role re-read failed; retry when the service recovers. |
| 502 | `UPSTREAM_FAILURE` | `Unable to load the eligible issues.` | (`GET /api/issues`) The read behind the endpoint failed; retry when the service recovers. |
| 502 | `UPSTREAM_FAILURE` | `Unable to load the settlement history.` | (`GET /api/settlements`) The read behind the endpoint failed; retry when the service recovers. |
| 502 | `UPSTREAM_FAILURE` | `Unable to load the settlement proof.` | (`GET /api/settlements/<id>`) The read behind the endpoint failed; retry when the service recovers. |
| 502 | `UPSTREAM_FAILURE` | `Unable to load the calibration comparison.` | (`GET /api/calibration`) The read behind the endpoint failed; retry when the service recovers. |
| 502 | `UPSTREAM_FAILURE` | `Unable to load the dashboard.` | (`GET /api/dashboard`) The read behind the endpoint failed; retry when the service recovers. |

## Moderation

The moderation queue, its audits, and the recalibration, credit-adjustment
and re-derivation tools behind the moderator page (`/moderation`). Every
moderation route requires a moderator: the request's credential — an `ovf_`
token or a signed-in session, under the same rules and precedence the
registration and ledger sections state — names the acting account, and the
account's `MODERATOR` role is re-read from the database at request time
rather than trusted to the credential. A token therefore works exactly where
its owner's browser session works.

The credential answers are shared by every moderation route:

| HTTP | Code | Exact message | Meaning / next step |
| --- | --- | --- | --- |
| 401 | `UNAUTHENTICATED` | `The supplied API token was not accepted.` | The bearer credential has an invalid format, or is unknown, revoked, or expired. Generate a replacement in the browser. |
| 401 | `UNAUTHENTICATED` | `Sign in is required.` | No recognized credential. Supply the bearer header or sign in. |
| 403 | `FORBIDDEN` | `Moderator authorization is required.` | The credential resolved to an account whose live role is not `MODERATOR`. |
| 502 | `UPSTREAM_FAILURE` | `Unable to authorize the moderator request.` | Credential or role lookup failed; retry when the service recovers. |

Mutating requests run the same credential guard registration runs: a
browser-session mutation is same-origin only, while a bearer-token mutation
is exempt from the origin check and still requires `Content-Type:
application/json`. The GET routes take no origin check at all — a
same-origin browser `fetch()` GET sends no `Origin` header, so guarding them
would refuse the moderation page itself. Every moderation body is a small
JSON document whose free-text fields (`reason`, `plan`) are trimmed and
capped at 2000 characters after trimming, and a body read past its route's
limit answers `413` `PAYLOAD_TOO_LARGE`. Extra fields are rejected on every
moderation body, and a query parameter named more than once is refused.

### The routes

| Method and path | Request | Success |
| --- | --- | --- |
| `GET /api/moderation/audits` | None. | `200`: the array of open account audits the moderation queue renders. |
| `GET /api/moderation/unwritable-closures` | None; moderator credential required. | `200` `{ "queue": <open unwritable closures>, "history": <past unwritable closures> }`. Each rejected-evidence closure includes `settlementId` or `calibrationId`, `latestCorrection`, and `viewerCanRequestCorrection`. |
| `GET /api/moderation/cohort` | Query: `targetAccountId` (required), `sampleStartedAt`, `sampleEndedAt` (required timestamps), `repositoryId` (optional). | `200` `{ "preview": <calibration cohort preview> }`. |
| `GET /api/moderation/recalibration` | Query: `targetAccountId` (required). | `200` `{ "preview": <the recalibration figure> }` — the trigger verdict over the latest substantiated audit's stored snapshot, beside every credit adjustment already applied. |
| `GET /api/moderation/rederivation` | None. | `200` `{ "rederivation": <per-repository derived-row status>, "startupRecoverySkipped": <boolean> }`. |
| `GET /api/moderation/moderators` | None. | `200` `{ "moderators": <the moderator roster> }`. |
| `POST /api/moderation/moderators` | `{ "targetAccountId": <uuid>, "moderator": <boolean> }`; `true` grants the role and `false` revokes it. | `200` `{ "change": <the recorded moderator role change> }`. |
| `POST /api/moderation` | `{ "targetAccountId": <uuid>, "repositoryId": <uuid, optional>, "sampleStartedAt": <timestamp>, "sampleEndedAt": <timestamp>, "reason": <nonblank, ≤2000 characters> }`. The sample end must be after the sample start. | `201` `{ "audit": <the opened account audit> }`. |
| `PATCH /api/moderation/<id>` | `{ "action": "dismiss" \| "substantiate", "reason": <nonblank, ≤2000 characters> }`. | `200` `{ "audit": <the decided audit> }`. |
| `PATCH /api/moderation` | `{ "targetAccountId": <uuid>, "plan": <nonblank, ≤2000 characters> }`. | `200` `{ "recalibration": <the closed recalibration> }`. |
| `PATCH /api/moderation/reversal` | `{ "targetAccountId": <uuid>, "reason": <nonblank, ≤2000 characters> }`. | `200` `{ "reversal": <the reversed ban> }` — the account returns to ACTIVE and exactly the repositories the sanction flagged are reactivated with their flag cleared; the confirmed-pattern count is untouched, so a later substantiated audit re-bans on its own figures. |
| `POST /api/moderation/recalibration/adjustment` | `{ "targetAccountId": <uuid>, "reason": <trimmed, may be blank, ≤2000 characters> }`. | `201` `{ "adjustment": <the applied credit adjustment> }` — the compensating adjustment the latest substantiated audit's snapshot supports. |
| `POST /api/moderation/adjustments/reversal` | `{ "adjustmentId": <uuid>, "reason": <nonblank, ≤2000 characters> }`. | `201` `{ "reversal": <the mirroring adjustment> }` — negative lines and its own moderation event; the original adjustment row is untouched. |
| `POST /api/moderation/rederivation` | `{ "repositoryId": <uuid> }`. | `200` `{ "request": <the queued re-derivation request> }`. |
| `GET /api/moderation/contests` | None. | `200`: the array of OPEN sanction contest requests the moderation page renders — account login, the sanction's state, the filed reason, the filed date, oldest first. |
| `POST /api/moderation/contests` | `{ "requestId": <uuid>, "decision": "GRANTED" \| "DENIED", "reason": <nonblank, ≤2000 characters> }`. | `200` `{ "request": <the decided contest request>, "sanctionLifted": <boolean>, "sanctionAlreadyGone": <boolean> }`. The deciding-moderator rule is enforced server-side: where the deciding moderator imposed the sanction and another live moderator exists, `403` `FORBIDDEN` carries the rule in the message; a sole-moderator decision is recorded on the request's `decidedBySoleModerator`. A granted contest lifts the contested sanction in the decision's transaction — `sanctionLifted` says so; where the sanction had already gone, the grant is recorded without a lift and `sanctionAlreadyGone` says so, with the journal line `sanction.contest.decide.already_gone` recording the same distinction. A denial moves nothing. |

Body limits: `32 KiB` on every moderation route except
`PATCH /api/moderation/<id>` and `PATCH /api/moderation/reversal`, whose
single-reason bodies are read under `8 KiB`.
The moderator role POST uses the `32 KiB` limit and the shared moderator
credential guard above: a live moderator session or its Overflow API token is
required. Its two body fields are required and extra fields are rejected.

### Moderation responses

A body that is missing, unparsable, or schema-invalid answers `422`
`INVALID_REQUEST`: message `Invalid moderation request.` on the moderation
routes, `Invalid re-derivation request.` on
`POST /api/moderation/rederivation`, `Invalid moderator role request.`
on `POST /api/moderation/moderators`, and `Invalid sanction contest decision.`
on `POST /api/moderation/contests`. A service refusal keeps the same
envelope with a fixed message, `Unable to process moderation request.`, and
the code tells the causes apart:

| HTTP | Code | Cause |
| --- | --- | --- |
| 403 | `FORBIDDEN` | The acting account is not allowed the action. |
| 404 | `NOT_FOUND` | The named record does not exist. |
| 409 | `CONFLICT` | The record's transition is not available from its current state. |
| 422 | `INVALID_INPUT` | The input broke a rule the service judges: a blank reason, an inverted sample window, a malformed timestamp. |
| 422 | `INSUFFICIENT_SAMPLES` | The calibration sample is too small to judge. |
| 500 | `INTERNAL_ERROR` | The moderation handler failed; retry when the service recovers. |

The queue reads depart from the fixed message. `GET /api/moderation/audits`
degrades on a failed read with `502` `UPSTREAM_FAILURE` and message
`Unable to load the moderation queue.` `GET /api/moderation/unwritable-closures`
answers a failed read with `502` `UPSTREAM_FAILURE` and message
`Unable to load the unwritable-closure queue.` The moderator roster route passes the
service's own message instead of the fixed one — `403`/`404`/`409` keep the
code and name the cause in the message, any other service code answers
`422` — and an outage behind it is `502` `UPSTREAM_FAILURE` with `Unable to
complete the moderator request.` The sanction contest routes pass the service's
message through the same way: `POST /api/moderation/contests` answers
`403`/`404`/`409`/`422` with the service's code and message — the `403`
`FORBIDDEN` being the disputes rule's imposer refusal — and an outage behind
either contests route is `502` `UPSTREAM_FAILURE`, `Unable to complete the
sanction contest request.` on the POST and `Unable to load the sanction
contest queue.` on the GET.

`POST /api/moderation/moderators` also has these request-level error rows;
the shared credential table and the roster service-error rules above apply:

| HTTP | Code | Exact message | Meaning / next step |
| --- | --- | --- | --- |
| 403 | `FORBIDDEN` | `The request origin is not allowed.` | A browser-session write has a missing or foreign `Origin`; use the Overflow page's origin. |
| 413 | `PAYLOAD_TOO_LARGE` | `The request body is too large.` | The body exceeds `32 KiB`. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | `The request must use the application/json content type.` | A declared non-JSON media type was sent; use `application/json`. |
| 422 | `INVALID_REQUEST` | `Invalid moderator role request.` | Malformed JSON, missing or extra fields, a non-UUID `targetAccountId`, or a non-boolean `moderator`. |
| 500 | `MISCONFIGURED` | `The server is not configured to accept this request.` | `OVERFLOW_APP_URL` is absent or malformed for a browser-session write. |

## Settlement and calibration overrides

A priced outcome a member believes is wrong is sent to correction: the member
opens a correction request, and a moderator lists, grants or declines open
requests. Over HTTP these are `POST /api/overrides`, `GET /api/overrides`
and `PATCH /api/overrides/<id>` — the same flows the MCP tools
`correction_open`, `correction_list` and `correction_decide` expose.

Opening a correction needs any member's credential; listing or deciding one needs a
moderator. The credential rules are the ones the registration and moderation
sections state, and the member gate's answers are the read responses'
own — including `403` `FORBIDDEN` `A member account is required.` for a
credential whose account no longer exists.

`POST /api/overrides` corrects exactly one priced outcome. The body is
either `{ "settlementId": <uuid>, "reason": … }` or
`{ "calibrationId": <uuid>, "reason": … }` — a body naming both matches
neither — with the reason trimmed, nonblank, and capped at 2000 characters.
Only a party to the outcome can open a correction against it: the creditor
or the debtor of the settlement, or the account a self-work calibration
belongs to. Success is HTTP `200` with
`{ "request": <the recorded correction request> }`.

`GET /api/overrides` takes no arguments and requires a moderator. Success is
HTTP `200` with a JSON array of the open correction requests, including each
request's `id` for a later decision. A failed read answers `502`
`UPSTREAM_FAILURE` with `Unable to load the open correction requests.`

`PATCH /api/overrides/<id>` decides a correction request. The body is either
`{ "action": "grant", "settledPoints": <integer 1 through 10>, "reason": … }`
or `{ "action": "decline", "reason": … }`. Success is HTTP `200` with
`{ "request": <the decided correction request> }`.

Bodies are read under `32 KiB` on the POST and `8 KiB` on the PATCH: a body
past its limit answers `413` `PAYLOAD_TOO_LARGE`, and an unparsable or
schema-invalid one answers `422` `INVALID_REQUEST` — `Invalid settlement
correction request.` on the POST, `Invalid settlement correction decision.`
on the PATCH. Service refusals pass the service's own message through the
error envelope:

| HTTP | Code | Exact message | Meaning / next step |
| --- | --- | --- | --- |
| 403 | `FORBIDDEN` | `Only the creditor or the debtor of a settlement, or the account a self-work calibration belongs to, can report it as incorrect.` | The credential's account is not a party to the named outcome. |
| 403 | `FORBIDDEN` | `Moderator authorization is required.` | (GET/PATCH) The credential's account is not a moderator. |
| 404 | `NOT_FOUND` | `No settlement, calibration or correction request was found under that identifier.` | Check the identifier. |
| 409 | `CONFLICT` | `This issue already has a correction request awaiting a moderator.` | (POST) The outcome already has an open request; wait for it to be decided instead of opening another. |
| 409 | `CONFLICT` | `This correction request has already been decided.` | (PATCH) Another moderator decided it first. |
| 422 | `INVALID_INPUT` | The message names the rule. | A blank reason, a missing identifier, or settled points outside 1 through 10. |
| 429 | `RATE_LIMITED` | `Too many requests of this kind. Retry after the number of seconds the Retry-After header names.` | (POST) The account's hourly bound of correction requests (`OVERFLOW_RATE_LIMIT_OVERRIDES_PER_HOUR`, default 5) is spent, the same bound the MCP `correction_open` tool draws on. Wait out the response's `Retry-After` interval, then retry. |
| 502 | `UPSTREAM_FAILURE` | `Unable to complete the settlement correction request.` | The service behind the route failed; retry when it recovers. |

## Sanction contests

The sanction case of the disputes framework: a sanctioned account asks for
the sanction it is living under to be contested, and a moderator decides.
Over HTTP the sanctioned side is `POST /api/contests` and
`GET /api/contests` — the account's own requests only, both open and
decided. A contest targets the account's LIVE sanction: the named moderation
event must be the account's own, its state must be `RECALIBRATING` or
`BANNED`, and it must be the enforcement state the account is still in. The
filing is itself a moderation event, and one OPEN request per sanction is
held by a partial unique index, the same shape the settlement-correction
section describes.

`POST /api/contests` takes `{ "sanctionEventId": <uuid>, "reason": … }` —
the reason trimmed, nonblank, and capped at 2000 characters — with any
member credential (session or token, the rules the other member sections
state). Success is HTTP `200` with
`{ "request": <the recorded contest request> }`.

`GET /api/contests` takes no arguments and reads only the credential's own
account. Success is HTTP `200` with a JSON array of that account's contest
requests, newest first, each carrying its `state` and — on a decided
request — its `decision`, `decidedBy`, `decidedBySoleModerator`,
`decidedReason` and `decidedAt`.

The POST body is read under `32 KiB`: a body past the limit answers `413`
`PAYLOAD_TOO_LARGE`, and an unparsable or schema-invalid one answers `422`
`INVALID_REQUEST` — `Invalid sanction contest request.` Service refusals
pass the service's own message through the error envelope:

| HTTP | Code | Exact message | Meaning / next step |
| --- | --- | --- | --- |
| 404 | `NOT_FOUND` | `No such account or sanction event.` | Check the event id. |
| 409 | `CONFLICT` | `This sanction cannot be contested right now.` | The event is not the account's live sanction, another request is already open on it, or the sanction has been lifted. |
| 422 | `INVALID_INPUT` | The message names the rule. | A blank reason or a missing event id. |
| 502 | `UPSTREAM_FAILURE` | `Unable to complete the sanction contest request.` | The service behind the route failed; retry when it recovers. |

## Closed PR disputes

The contributor of a CLOSED, unmerged pull request can request credit
when its change lands elsewhere. Both routes accept a session or API token;
the moderation route requires the account's current moderator role. Filing
and decision each record a moderation event. The contributor page is
`/disputes`; the queue and decided history appear on `/moderation`.

| Route | Request | Success |
| --- | --- | --- |
| `POST /api/disputes` | `{ "pullRequestUrl"?: <closed PR URL>, "pullRequestId"?: <stored PR uuid>, "reason": <nonblank, ≤2000 characters>, "landedPullRequestUrl"?: <URL>, "landedCommitUrl"?: <URL> }` | `200` `{ "request": <dispute request> }`. Supply exactly one of `pullRequestUrl` and `pullRequestId`; the credential's account must be the PR author, and the PR must be CLOSED and unmerged, with at most one OPEN dispute. |
| `GET /api/disputes` | None. | `200`: an array of the credential's own dispute requests, newest first, including decided history. |
| `POST /api/moderation/disputes` | `{ "requestId": <uuid>, "decision": "GRANTED" \| "DENIED", "reason": <nonblank, ≤2000 characters>, "figure"?: <integer 1–10> }` | `200` `{ "request": <decided dispute request> }`. A GRANTED decision requires `figure`; DENIED does not. The moderator identity comes from the credential, never from the body. |
| `GET /api/moderation/disputes` | None. | `200`: an array of all requests, OPEN first (oldest first), then decided history (newest first). |

A URL resolving to a stored PR follows the same rules as its UUID. For a PR
not yet stored, its repository must be registered; the forge must confirm it
is CLOSED and unmerged, and its numeric author identity must map to the filing
account (GitLab identities are scoped to the registered instance). Supply a
`landedPullRequestUrl` resolving to a recorded MERGED PR in that repository with
a recorded issue. The dispute uses that issue, and filing atomically stores the
closed PR, its raw-diff SHA-256 proof and its issue link. A commit-only landing
cannot identify an issue for an unrecorded PR and is refused with a named reason.

For a stored closed PR, filing uses an already stored MERGED PR for the same issue automatically. When
one exists, omit both landed URLs. Otherwise supply exactly one: a merged PR
URL for the same registered repository, or a landed commit URL. Supplying both
URLs, a non-merged or wrong-repository landing PR, or no landed evidence is
refused with `422` `INVALID_INPUT`. Reasons and supplied URLs are trimmed;
POST schemas reject unknown fields. Both POST bodies are limited to `32 KiB`.

Commit evidence must name a commit in a registered repository and resolve to
its author's Overflow account. GitHub commits resolve through the forge's
numeric author identity. Unresolvable commits and authors without an account
are refused with `409` `CONFLICT` and an explanation naming the reason.
GitLab commit URLs currently receive the unresolvable-author refusal.

A dispute request carries:

```json
{
  "id": "uuid",
  "contributorId": "uuid",
  "pullRequestId": "uuid",
  "issueId": "uuid",
  "landedPullRequestId": null,
  "landedCommitUrl": "https://github.com/owner/repo/commit/landed",
  "landedCommitAuthorId": "uuid",
  "requestReason": "The change landed elsewhere.",
  "state": "DECIDED",
  "decision": "GRANTED",
  "decidedBy": "uuid",
  "decidedBySoleModerator": true,
  "decidedReason": "The stored evidence supports the claim.",
  "decidedAt": "2026-10-02T10:00:00.000Z",
  "moderatorFigure": 5,
  "awardedPoints": 3,
  "createdAt": "2026-10-01T10:00:00.000Z"
}
```

The contributor can obtain the stored closed PR UUID from `authoredPullRequests` in their account export (`GET /api/account/export`).

The moderation queue also projects `comparison`: the closed and landed PR numbers, titles, canonical forge URLs, and their stored reviews and raw diffs. Missing or omitted evidence is null; commit landings show a validated forge commit link without fetching content.

`landedPullRequestId` is a UUID or null; `landedCommitUrl` is a string or null.
`landedCommitAuthorId` records the commit author's account UUID and is null
for PR landings and legacy commit evidence.
OPEN requests have null decision, decider, decision reason/time, figure and
award, and `decidedBySoleModerator: false`. A denial leaves figure and award
null. A grant records the figure and `awardedPoints = max(0, figure − stored
review rounds)`; an award of zero still grants the request. A sponsor,
contributor or landing author cannot decide while another live moderator
exists, including the recorded commit author. The sole-moderator path records `decidedBySoleModerator: true`.

A positive grant appends a sponsor-targeted credit adjustment with an award
leg to the contributor. A landing settlement credited to a third account is
reversed by an additional leg in that adjustment; a self-work landing or a
landing without a settlement has no reversal leg. A zero award still reverses any qualifying landing settlement through a
reversal-only adjustment. Only a zero award with no qualifying reversal creates
no adjustment; zero-amount lines are never written. Existing settlement and calibration creditors are preserved.

All errors use `{ "error": { "code": <code>, "message": <message> } }`.
Service refusals preserve the service's explanation. Status/code pairs are
shared by both routes:

| HTTP | Code | Meaning / next step |
| --- | --- | --- |
| 401 | `UNAUTHENTICATED` | A valid member credential is required. |
| 403 | `FORBIDDEN` | Wrong contributor, a non-moderator on the moderation route, a conflicted deciding moderator while another exists, or a refused request origin. |
| 404 | `NOT_FOUND` | The account or dispute request was not found. |
| 409 | `ALREADY_GRANTED` | This issue has already been credited through a granted dispute. A second grant is refused atomically; re-filing after denial remains allowed. |
| 409 | `CONFLICT` | The message names the failed check: repository registration, PR resolution or state, missing recorded issue, an existing OPEN request, an already credited issue, or an already decided request. |
| 413 | `PAYLOAD_TOO_LARGE` | POST body exceeds `32 KiB`. |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | POST declares a content type other than JSON. |
| 422 | `INVALID_REQUEST` | Unparsable or strict-schema-invalid POST body, including a missing grant figure. Message: `Invalid closed PR dispute request.` or `Invalid closed PR dispute decision.` |
| 422 | `INVALID_INPUT` | Service input or landed-evidence refusal; the message names the rule. |
| 422 | `INSUFFICIENT_EVIDENCE` | `Stored review evidence is required to grant this dispute.` The request stays open; inspect the evidence before granting. |
| 500 | `MISCONFIGURED` | The trusted application origin is not configured. |
| 502 | `UPSTREAM_FAILURE` | A POST failed internally (`Unable to complete the closed PR dispute request.`), or a GET read failed (`Unable to load your closed PR dispute requests.` / `Unable to load the closed PR dispute queue.`). |

## Readiness probe

`GET /api/readiness` answers whether the deployment is ready to serve. It
takes no credential and no body, and answers `Cache-Control: no-store` with:

- `200` `{ "status": "ready" }` when the database is reachable and every
  migration this build bundles is recorded applied, and
- `503` `{ "status": "unavailable" }` for every other outcome — a
  rejection, a probe past its 2-second query budget (under a 3-second hard
  cap), or a schema behind the build. A schema ahead of the build stays
  ready: that is the state a rollback to an older release runs against.

At most one probe runs per three-second window no matter how many requests
arrive — concurrent requests share the in-flight probe and its answer is
cached until the window expires — so the unauthenticated endpoint costs an
attacker at most one query per window.

## Public discovery and notices

These GET routes take no credential and no request body.

### MCP protected-resource discovery

`GET /.well-known/oauth-protected-resource` and
`GET /.well-known/oauth-protected-resource/api/mcp` return the same document.
The `WWW-Authenticate` header on `POST /api/mcp`'s `401` responses currently
names the root discovery URL:
`Bearer resource_metadata="<overflow-origin>/.well-known/oauth-protected-resource"`.
That `401` carries `Cache-Control: no-store`; the discovery handlers themselves
set no `Cache-Control` header.

| HTTP | Content-Type | Response |
| --- | --- | --- |
| 200 | `application/json` | `{ "resource": "<overflow-origin>/api/mcp", "bearer_methods_supported": ["header"] }`. |
| 500 | `application/json` | `{ "error": { "code": "MISCONFIGURED", "message": "The server is not configured to accept this request." } }`. |

`<overflow-origin>` is the origin of `OVERFLOW_APP_URL` (scheme, host and port;
any path is ignored). An absent, blank, malformed or opaque-origin `OVERFLOW_APP_URL`
produces the `500` above. The document advertises bearer credentials in the
`Authorization` header; it contains no `authorization_servers` field.

### Third-party notices

`GET /third-party-notices.txt` serves the build-generated production dependency
notices, including package names and versions, licence identifiers, full licence
texts and any accompanying notices. It reads the file from the running build's
distribution directory (`OVERFLOW_NEXT_DIST_DIR`, or `.next` when unset or blank),
pinning that directory's real path on first use so a later symlink switch
does not change the notices served by that process. The handler sets no
`Cache-Control` header.

| HTTP | Content-Type | Response |
| --- | --- | --- |
| 200 | `text/plain; charset=utf-8` | The generated notice text. |
| 404 | `text/plain;charset=UTF-8` | `Not Found` when the distribution directory or notice file is missing, or a path component is not a directory. |
| 500 | Framework error response | Other filesystem errors propagate to Next.js; the route defines no error-body shape for them. |

## Browser authentication routes

The `/api/auth/*` mount exports Auth.js's GET and POST handlers. No Overflow
API token or existing sign-in is required to reach them; browser cookies carry
the session and OAuth handshake state. The configured provider is GitHub only,
with JWT sessions. These response shapes and redirects belong to Auth.js,
not Overflow's `{ "error": { "code", "message" } }` envelope.

The framework response shapes, statuses, redirects and cache headers below are
observations of the installed `next-auth` 5.0.0-beta.32 (`@auth/core` 0.41.3).
They are governed by Auth.js and fall outside Overflow's response-shape and
versioning guarantee in the Stability and versioning section.

The table describes Auth.js with `basePath: "/api/auth"`, which must match
Overflow's fixed `/api/auth/*` mount. Overflow sets no explicit `basePath`.
Leave `AUTH_URL` and its legacy fallback `NEXTAUTH_URL` unset, or give the
selected URL a pathname of `/` or `/api/auth`. Any other non-root pathname
changes Auth.js's base path and the URLs shown here; an override outside
`/api/auth` generates URLs outside this mount.

| Method and path | HTTP / Content-Type | Response / purpose |
| --- | --- | --- |
| `GET /api/auth/providers` | `200`, `application/json` | `{ "github": { "id": "github", "name": "GitHub", "type": "oauth", "signinUrl": "<auth-origin>/api/auth/signin/github", "callbackUrl": "<auth-origin>/api/auth/callback/github" } }`. |
| `GET /api/auth/csrf` | `200`, `application/json` | `{ "csrfToken": "<csrf-token>" }`, with the corresponding CSRF cookie. |
| `GET /api/auth/session` | `200`, `application/json` | `null` without a usable session; otherwise the Auth.js session object with `user` and `expires`. Overflow adds `id`, `role`, `canAdministerWebhooks` and, when available, `authenticatedAt` to a resolved member's `user`. |
| `POST /api/auth/session` | `200`, `application/json` | Auth.js session update; requires the CSRF token and matching cookie. |
| `GET /api/auth/signin` | `200`, `text/html` | Auth.js's GitHub sign-in page. |
| `POST /api/auth/signin/github` | `302`, `Location` header | Starts GitHub OAuth; requires the CSRF token and matching cookie. |
| `GET /api/auth/callback/github` (also mounted for POST) | `302`, `Location` header | Completes the GitHub OAuth handshake, using its callback parameters and state cookies, and redirects back to the application or an auth error page. |
| `GET /api/auth/signout` | `200`, `text/html` | Auth.js's sign-out confirmation page. |
| `POST /api/auth/signout` | `302`, `Location` header | Clears the session cookie and redirects; requires the CSRF token and matching cookie. |
| `GET /api/auth/error` | `200`, `403` or `500`, `text/html` | Auth.js error page: the default is `200`, access-denied or verification errors use `403`, and configuration errors use `500`. |
| `GET /api/auth/verify-request` | `200`, `text/html` | Auth.js's built-in verification page remains reachable, though no email provider is configured. |

`<auth-origin>` is the origin Auth.js uses for the request, including any
`AUTH_URL` override (or `NEXTAUTH_URL` fallback) with the pathname described
above. Its GET session and CSRF answers set
`Cache-Control: private, no-cache, no-store`, `Expires: 0` and
`Pragma: no-cache`. The other normal responses above set no cache headers
in Auth.js, including the POST session update; Overflow's mount adds none.

For Auth.js redirects, a request carrying `X-Auth-Return-Redirect` can receive
`200` JSON `{ "url": "<redirect-url>" }` instead. Refused sign-in, callback
or sign-out flows normally redirect to an Auth.js error or sign-in page.
A failed POST session update answers `400` JSON `null`; an unrecognized auth
path answers `400` JSON `"Bad request."`. Invalid Auth.js configuration answers
`500` JSON `{ "message": "..." }` on non-page requests, or its `500` HTML
configuration page on page GETs. Use the browser sign-in flow rather than
treating these framework endpoints as token-authenticated member APIs;
[OPERATING.md](OPERATING.md#operating-an-instance-github-oauth-and-webhooks)
describes the OAuth setup.

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

The MCP endpoint shares the HTTP API's version and stability policy: the
served version — not the protocol version above — is `serverInfo.version`
in the `initialize` answer, and `GET /api/version` reports the same
number. The Stability and versioning section above is the contract both
surfaces follow.

### The tools

| Tool | Purpose |
| --- | --- |
| `issues_board` | List the eligible issues on the claim board, optionally filtered by repository, opening label or claim state, and paged with `page` and `pageSize`. Each row's `doneWhen` text is the sponsor's untrusted statement: run any command it names only in a sandbox holding no credentials (its `notice` says the same). |
| `settlements_list` | List the calling account's priced settlements. |
| `settlement_get` | Fetch one settlement's proof by its id. |
| `calibration_compare` | Fetch the calibration comparison for the calling account. |
| `dashboard_summary` | Fetch the calling account's dashboard summary. |
| `moderation_queue` | List the account audits currently open in the moderation queue. |
| `unwritable_closures` | List the unwritable closures in the rejected-evidence queue and its history, including each closure's settlement or calibration id and latest correction state. |
| `audit_open` | Open an account audit over a calibration sample. |
| `audit_decide` | Dismiss or substantiate an open account audit. |
| `correction_open` | Request a correction to a priced settlement or calibration outcome. |
| `correction_list` | List open settlement-correction requests with their ids for `correction_decide`. |
| `correction_decide` | Grant or decline a settlement correction request. |

Tool errors are not transport errors: the wrapped endpoint's
`{ "error": { "code": "...", "message": "..." } }` envelope comes back as the
result's text content with `isError: true`, so read the text to tell a
validation refusal from an upstream outage.

On `issues_board`, the optional paging arguments `page` (1-based) and
`pageSize` are positive integers — a string naming a number is accepted as
that number — and the board they produce matches the endpoint's: an omitted
paging argument reads as the first page at the default size of 200, values
above the endpoint's 500 cap clamp to it, and a page holding exactly
`pageSize` rows means a next page may exist. The other arguments keep their
shapes: a filter argument that is not a string is dropped from the query
rather than rejected, so an omitted argument and a malformed one read the
same board.
