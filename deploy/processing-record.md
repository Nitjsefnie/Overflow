# Record of processing activities

**Recorded:** 2026-10-08

**Source notice:** `/account-data`, version 1.7, effective 2026-10-08
**Scope:** Processing described by the account-data notice and the current Overflow implementation. The controller is the operator of the deployment described by the notice. Controller name and contact routes are operator configuration; when the hosted deployment has no overrides, its hosted identity and route values are used. A self-hosted operator supplies its own values.

This record follows the four activities in the notice's “Purposes and legal bases” section. The balancing notes record the operator's reasoning and remaining impact; they are not a specialist legal opinion.

## Activity: signed_in_service

### Name and purpose

Run the service for signed-in members: authenticate and maintain accounts, accept repository registrations, support repository claims and linked forge identities, and provide the shared ledger and account dashboards.

### Data categories

- Account identity and administration: internal account id, numeric GitHub user id, GitHub login, role, enforcement state, confirmed-miscalibration count, and account timestamps.
- GitHub authorization: encrypted OAuth token and whether the granted permission includes webhook administration.
- Linked GitLab identities: instance base URL, numeric GitLab user id, login, encrypted personal access token, link and successful-verification times, and the time of a rejected background reconciliation read when one is recorded.
- Signed-in state: encrypted 30-day cookie containing the GitHub login, account reference, role, last sign-in time, and webhook-administration permission state. No server-side session rows are kept.
- API-token metadata and the member's repositories, claims, and dashboard records.
- Avatar inventory: no avatar URL is collected, stored, or carried in the session. The account export keeps the `avatarUrl` key as a stable null during its 30-day deprecation window; its earliest removal is 2026-11-07, with version 2.0.0.

### Data subjects

Signed-in members, repository sponsors, contributors with accounts, and moderators. A linked GitLab identity may belong to the same person as a signed-in account.

### Recipients

The deployment operator and hosting provider administer the account database. Cloudflare handles request metadata, the session cookie, and data submitted in transit. GitHub receives sign-in and repository/webhook requests; the relevant GitLab instance receives token-verified reads and webhook requests. Members see their own account and dashboard data; sponsors see their repository and claim information; moderators see the account and moderation information needed for their duties. Database copies are held by the host and in the encrypted reduced backup sent to Discord, as described under `logs_backups_security`.

### Retention

The account row persists while the account exists and does not expire automatically. Account deletion pseudonymises the row rather than removing it, clears the GitHub token and API token, and removes linked GitLab tokens and logins while retaining the linked instances, numeric ids, and link dates. A GitLab identity otherwise persists until unlinked; unlinking deletes its fields and encrypted token. GitHub authorization revocation makes its stored token unusable at its next use but does not delete the account row. The signed-in cookie expires after 30 days and signing out clears it. An unused API token expires after 30 minutes; its first authenticated use starts a 90-day lifetime, and account deletion removes it immediately. Backups can retain prior copies for the periods described under `logs_backups_security`.

### Basis

Performance of a contract: providing the service the signed-in member uses.

## Activity: non_member_forge_data

### Name and purpose

Read public forge data about people who have never signed in, so reconciliation can maintain the ledger and settlement proofs for repositories registered by a sponsor.

### Data categories

- Forge provider and numeric id, login, issue and pull-request titles, URLs and states, issue authors, claim assignees, and pull-request authors.
- Per-repository cache data: issue titles, authors, assignees, label and assignment history, comment authors and ids, and the title and author of closing pull requests. For merged closing pull requests, the cache also holds diffs and review-round data; reviewer logins and review text are not kept in that cache.
- Change-log entries containing logins and titles, and moderation notes that can name the account that applied a label.
- For a data-subject removal, a `data_subject_suppressions` row records the forge provider, numeric forge id, optional resolved login, and decision time. The provider/id key prevents later reconciliation from writing that person's identifiers again.
- Reconciliation does not write issue, pull-request, or comment body text. Body text written before 2026-09-26 may remain until repository unregistration. No display name is stored for a person who has never signed in.

### Data subjects

People who authored or were assigned work in a registered public repository, including issue commenters, issue claim assignees, and pull-request authors, whether or not they have an Overflow account.

### Recipients

GitHub or the relevant GitLab instance supplies the public repository data. Cloudflare handles requests in transit, and the hosting provider stores the database. Signed-in members may see claim-assignee logins and issue titles; a repository sponsor sees its claim assignees, issue titles, and related pull-request titles in the sponsor surfaces; credited members see settlement-related titles; moderators see moderation notes and issue/pull-request titles in moderation surfaces. Visitors who are not signed in are not shown data about people who have never signed in. Backups may hold copies as described under `logs_backups_security`.

### Retention

While a repository remains readable and registered, reconciliation refreshes its data; entries no longer returned by a later pass are removed. If a repository becomes unreadable, its stored copy remains until it can be read again. Unregistering stops re-reads but does not remove logins, ids, titles, change-log entries, or closing-pull-request diffs and reviews; stored body text is scrubbed unless a recent settlement is still being computed. Completed or failed reconciliation runs and their change-log entries are pruned after 90 days. Webhook receipts are pruned 30 days after successful processing, 90 days after failure, or 90 days after receipt for abandoned deliveries; an unexpired pending receipt is retained. Suppression rows have no expiry field or fixed expiry in the current implementation and remain available to prevent re-import. Backups can retain prior copies for the periods described under `logs_backups_security`.

### Basis

Legitimate interests: operating a public work-attribution tracker and maintaining accurate attribution and settlement proofs for public work in repositories a sponsor has registered.

### Balancing note

The operational interest is to attribute public work accurately and make settlement proofs reproducible. The collection is scoped to registered repositories and public forge records; no new issue, pull-request, or comment body text is written, and visitors are not shown the identities of people who have never signed in. Export and removal are keyed by forge provider and numeric id, and a suppression prevents a later import from restoring removed identifiers. Against that interest, identifiers and titles can remain while a repository is registered, cached data includes comment authors, unregistering retains attribution records, and removal preserves the ledger and moderation record. These limits reduce exposure but do not eliminate the impact on a non-member. Reassess this balance if the collected fields, visibility, or retention change.

## Activity: logs_backups_security

### Name and purpose

Keep operational and security logs, recover the service from failure, and handle abuse and security events, including traffic handled by Cloudflare.

### Data categories

- Web access and error logs for every visitor: IP address, time, requested path, response status, referring page, and browser user agent. Error logs also record the request IP.
- Cloudflare request metadata, the session cookie, and submitted data in transit, including GitLab tokens.
- Application journal lines, which can contain repository owner/name, logins, error details, or parts of a record involved in a database or forge error.
- Privileged-action audit entries: acting account, a reference to the credential used (not the credential), client IP address, and action. Failure alerts can include excerpts from journal lines and personal data in those lines.
- Database backups, including pre-deletion data; the off-host backup contains a reduced table set and is encrypted without its private key on the host.

### Data subjects

All visitors, signed-in members, people whose forge data is processed, moderators, and anyone whose data appears in an error, privileged-action record, or backup.

### Recipients

Cloudflare, Inc. handles site traffic. The hosting provider stores the database, on-host backups, and system journal. The operator has access to operational records; the separate privileged-action IP export is root-only on the host. Failure-alert excerpts pass through the host's mail relay and Google LLC's mail relay to the operator's mailbox. Discord Inc. stores the encrypted reduced backup in a private channel and receives no decryption key. Cloudflare, Google, and Discord are US-based; the hosting provider's region is not stated in the notice. The notice documents no transfer mechanism.

### Retention

Web access/error logs are kept for 14 rotations, normally about 15 days. The host system journal has a shared size limit and no fixed time limit. Privileged-action lines carrying client IPs are also kept in a root-only host export for 90 days. Same-host daily database backups older than 14 days are pruned only after a later backup succeeds, normally at about 15 days; failed backups can extend retention. The encrypted reduced Discord copy is deleted after 14 days. These backups can preserve data after it is deleted from the live database.

### Basis

Legitimate interests: securing and operating the service, handling abuse and security events, and recovering service data after a failure.

### Balancing note

The operator's interests are service security, abuse investigation, and recovery. Routine access logs rotate after about 15 days, the separate privileged-action IP export is root-only and expires after 90 days, and the off-host reduced backup is encrypted with a key not held on the host and expires after 14 days. The countervailing impact is substantial for logs: they include IP addresses and request metadata, Cloudflare receives cookies and submitted data in transit, and error details or backups may include personal data and content that has since been removed from the live database. Rotation, access restriction, encryption, and bounded backup retention limit that impact, while the system journal's actual lifetime depends on host-wide volume and failed backups can extend retention. Reassess log content and backup retention when the deployment or incident process changes.

## Activity: automated_scoring_moderation

### Name and purpose

Compute settlement credits and account credit limits, maintain moderation and enforcement records, apply or review sanctions, and support correction, override, adjustment, and contest decisions.

### Data categories

- Settlement inputs and outcomes: sponsor-applied difficulty label, points and rationale, closing pull-request merge record, review rounds, contributor and sponsor identities, settlement amount, and ledger balances.
- Repayment history and account credit limit, used to decide how many open issues remain on the issues board.
- Enforcement state, confirmed-miscalibration count, moderation events and their prior/new states, times, reasons and plans, audit and calibration records, correction and override requests and decisions, credit adjustments, and sanction-contest reasons and decisions.
- Forge logins, ids, titles, diffs and review-round data used as settlement evidence, as listed under `non_member_forge_data`.

### Data subjects

Contributors and sponsors, including contributors without an Overflow account; members whose account standing or credit limit is assessed; moderators who make decisions; and people named in a correction, audit, or contest record.

### Recipients

GitHub and GitLab instances supply source records. The hosting provider stores the ledger and moderation database, and Cloudflare handles requests in transit. Members see their own settlements and history; sponsors see claims and sponsor-side settlement records; moderators see moderation records, queues, and closure history. The deployment operator administers the database. Copies in backups, and any journal excerpts in failure alerts, have the recipients described under `logs_backups_security`.

### Retention

Ledger and moderation records do not automatically expire. Account deletion pseudonymises the account while retaining its shared-ledger attribution and moderation records, including reasons attached to the pseudonymised account. Reconciliation refreshes source-derived records while a repository is registered; unregistration stops refresh but preserves ledger records and specified cache data. Completed or failed reconciliation runs and their change-log entries are pruned after 90 days. Webhook receipts follow the 30-day and 90-day windows described under `non_member_forge_data`. Backups can retain prior copies for the periods described under `logs_backups_security`.

### Basis

Legitimate interests: keeping the ledger's records accurate and its rules enforceable.

### Balancing note

Accurate settlements and enforceable participation rules support the shared ledger and protect sponsors and contributors from incorrect attribution. The processing has a material effect: settlement pricing is automated, a credit-limit threshold can remove all but one repayment issue from the board, and enforcement state controls repository participation. The system records the inputs and outcomes; members can request corrections, contest sanctions, and use moderator review, reversal, or manual adjustment routes. Human review provides a route to challenge moderation outcomes, but it does not make the credit-limit board effect a human decision. Those effects and the retained pseudonymised record are counterweights that require ongoing operator review of accuracy, challenge handling, and the impact on contributors.

## Open specialist question

Whether the small-organisation exemption affects the obligation to maintain this record is an open question for a privacy specialist. This record makes no claim that the exemption applies or that it does not apply.
