# Overflow MVP design

## Product intent

Overflow turns otherwise-expiring weekly LLM subscription capacity into reciprocal open-source work. Members choose issues from repositories that other members have explicitly registered, submit pull requests through GitHub, and receive mutual credit only when those pull requests merge. The ledger is zero-sum: every positive contribution entry has an equal negative sponsor entry, so the group can see who has contributed more than they have received without settling each favour immediately.

## MVP boundary

The first release is one Next.js application backed by PostgreSQL. It authenticates members through GitHub, lets a member register one repository at a time, creates and consumes GitHub webhooks, syncs eligible issues, awards merged work, exposes balances and activity, and gives moderators an auditable enforcement workflow.

The MVP does not meter LLM tokens, execute agents, dispatch work, transfer money, or automatically register repositories visible to a user's GitHub account.

## Actors

- A **member** signs in through GitHub, browses eligible issues, and can contribute to another member's registered repository.
- A **repository sponsor** is the member who registered a repository. The sponsor receives the debit when another member earns credit there.
- A **contributor** is a registered member whose GitHub identity authored a merged pull request.
- A **moderator** resolves calibration audits and advances the graduated enforcement ladder.

One repository has one accountable sponsor in the MVP. Organizations and teams can nominate a shared sponsor in a later release.

## GitHub contract

### Authentication and repository registration

- Authentication uses GitHub OAuth through Auth.js.
- OAuth requests `read:user`, `user:email`, `repo`, and `admin:repo_hook` because the MVP supports private repositories and creates a repository webhook during explicit registration.
- A repository is registered only after a signed-in member submits `owner/name` or a canonical GitHub repository URL.
- Registration fetches the repository from GitHub, requires the member to have repository administration permission, creates the platform webhook, and records only that repository.
- Registration never imports or registers the rest of the member's accessible repositories.
- Registration creates the ten shared labels `overflow:1` through `overflow:10` when missing and imports currently open labelled issues.

### Events

The webhook endpoint verifies the `X-Hub-Signature-256` HMAC against the raw request body before parsing JSON. `X-GitHub-Delivery` is stored with a unique constraint, making redelivery idempotent.

The MVP processes:

- `issues` events to upsert or close eligible issue records as labels or state change;
- `pull_request_review` with action `submitted` and state `changes_requested` to record one unique review round by GitHub review ID; and
- `pull_request` with action `closed` and `merged = true` to evaluate a contribution.

### Eligible work

- An eligible issue is open in an active registered repository and has exactly one label matching `overflow:1` through `overflow:10`.
- A pull request must close exactly one eligible issue. Closing references are resolved from GitHub's API rather than inferred from line counts.
- The PR author must have signed in to Overflow. Otherwise the merge is recorded as `UNCLAIMED` and can be reconciled when that GitHub identity joins.
- A banned contributor or inactive repository cannot create a posted award.

## Rating and award rules

The issue's `overflow:N` label is the approximate difficulty declared when work is offered. A pull request may carry one `overflow:N` label to recalibrate the final difficulty after maintainers have reviewed the issue and the actual diff. If a valid PR difficulty label exists it wins; otherwise the issue difficulty is used. Multiple difficulty labels make the award `NEEDS_AUDIT` instead of guessing.

No line additions, deletions, files-changed count, commit count, elapsed time, or other churn metric enters the rating or the award. GitHub issue and PR URLs, titles, bodies, labels, and a SHA-256 fingerprint of the fetched diff are kept as the evidence trail; source patches are fetched on demand and are not copied into the database.

For an eligible non-self contribution:

```text
rated difficulty = PR overflow label, otherwise issue overflow label
review rounds     = unique changes-requested GitHub review IDs submitted before merge
awarded credits   = max(0, rated difficulty - review rounds)
```

Every award posts exactly two immutable ledger entries under one transaction: `+awarded credits` to the contributor and `-awarded credits` to the repository sponsor. A zero-credit contribution is still recorded but posts no ledger entries.

If contributor and sponsor are the same GitHub user, the contribution is recorded as `SELF_WORK`, its awarded credits are zero, and it creates no ledger transaction or entries. This invariant applies even if identities, repository ownership, or labels later change.

Late or redelivered review events trigger an idempotent award recomputation. Corrections append reversing and replacement transactions; posted ledger rows are never edited or deleted.

## Moderation and miscalibration ladder

Any member can open one audit per contribution with a concrete reason. Opening an audit appends a reversal transaction that temporarily removes the disputed award from both balances. A moderator compares the linked issue and PR diff, never churn statistics, and either dismisses or substantiates the audit.

- **Audit:** the case is open and the disputed transaction is held through compensating entries.
- **Warn:** the first substantiated case corrects that award, appends a warning, and increments the sponsor's confirmed-miscalibration count.
- **Recalibrate:** the second substantiated case corrects that award, changes the sponsor to `RECALIBRATING`, deactivates sponsored repositories, and exposes recent awards for moderator review. A moderator can append corrections and close recalibration before repositories reactivate.
- **Ban:** the third substantiated case changes the sponsor to `BANNED`, keeps sponsored repositories inactive, and blocks new awards or registrations.

Dismissal appends a reinstatement transaction. Substantiation appends a replacement transaction at the moderator's corrected 1–10 difficulty less the already-recorded review rounds. Every transition records actor, timestamp, reason, prior state, and new state.

## Data model

- `users`: GitHub identity, login, avatar, role, enforcement state, confirmed-miscalibration count, encrypted OAuth token.
- `registered_repositories`: GitHub repository identity, owner/name, sponsor, visibility, webhook identity, active state.
- `issues`: GitHub issue identity, repository, number, title/body URL, state, approximate difficulty.
- `review_rounds`: repository/PR number plus unique GitHub review ID and timestamp.
- `contributions`: repository, PR identity and evidence, contributor, sponsor, issue, rated difficulty, review rounds, award, merge time, status.
- `ledger_transactions`: immutable reasoned transaction grouped by contribution or audit.
- `ledger_entries`: immutable signed integer amount, account user, counterparty, transaction.
- `webhook_deliveries`: delivery ID, event name, processing state, error and timestamps.
- `calibration_audits`: contribution, reporter, moderator, state, rationale, decision, corrected difficulty and timestamps.
- `moderation_events`: target user, actor, transition, reason and timestamp.

Database constraints enforce difficulty `1..10`, non-negative review counts and awards, unique external IDs, one repository sponsor, one contribution per GitHub PR, one audit per reporter/contribution, and balanced ledger transactions.

## Application surfaces

- `/`: product explanation and GitHub sign-in.
- `/dashboard`: balance, earned/given totals, open work, registered repositories, recent ledger activity, and moderation notices.
- `/repositories/new`: explicit repository registration form and its GitHub permission/webhook result.
- `/issues`: filterable eligible issue board with difficulty and repository sponsor.
- `/contributions/:id`: rating evidence, review penalty, ledger result, and audit action.
- `/moderation`: moderator-only queue, decisions, recalibration tools, and enforcement history.
- `/api/auth/[...nextauth]`: Auth.js handlers.
- `/api/github/webhooks`: raw-body verified GitHub webhook receiver.
- `/api/repositories` and `/api/audits`: authenticated mutation endpoints.

The visual direction is a dense but calm exchange ledger: warm paper background, ink typography, acid-lime positive balances, coral debits, compact data tables, and clear provenance links back to GitHub. It should feel like infrastructure for trusted peers, not a gig marketplace.

## Security and failure handling

- OAuth access tokens are encrypted with AES-256-GCM using a base64-encoded 32-byte `TOKEN_ENCRYPTION_KEY`; plaintext tokens are never persisted or logged.
- Webhook signatures use constant-time comparison and reject missing, malformed, or invalid signatures with `401`.
- Mutations require a server-side session; moderation additionally requires `role = MODERATOR`.
- GitHub API failures during registration roll back local registration and attempt webhook cleanup. Webhook delivery failures are recorded and return a retryable non-2xx response.
- All GitHub-generated strings are rendered as text, never raw HTML.
- SQL is parameterized. State transitions and ledger posting run inside database transactions.

## Verification

- Pure unit tests cover difficulty label parsing, score calculation, self-work suppression, ledger balancing, token encryption, URL parsing, signature verification, and enforcement transitions.
- Service tests with fakes cover explicit repository registration, permission denial, webhook idempotency, issue synchronization, review-round deduplication, merge awarding, late-review correction, unclaimed contributions, audit hold/dismiss/substantiate, recalibration, and ban behavior.
- Component tests cover signed-out landing, dashboard summaries, issue cards, registration errors, and moderator controls.
- `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` must pass from a clean checkout.
- `git check-ignore -v` must prove seeded junk remains ignored while representative source, test, migration, and documentation files are tracked.

## Deployment and operations

The repository ships `.env.example`, `docker-compose.yml` for local PostgreSQL, SQL migrations, a migration command, and setup/run documentation. Production requires a public HTTPS base URL so GitHub can reach the webhook endpoint. Deployment-provider automation, email, background queues, and scheduled reconciliation are deferred.

## Explicitly deferred

- Measuring or brokering members' LLM subscription capacity.
- Automated LLM difficulty judgment; the MVP uses human GitHub labels plus audit.
- Multiple sponsors per repository, organizations, teams, invitations, and private groups.
- Multi-issue PR awards, partial credit before merge, cash settlement, and transferable credits.
- A GitHub App installation flow; the MVP uses an OAuth app and per-repository webhook registration.
- Hosted deployment, billing, notifications, and a job queue.
