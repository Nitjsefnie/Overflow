# Overflow MVP design

## Authority and supersession

This specification incorporates `usage-settle/2026-08-28-decisions` and `usage-settle/2026-08-31-architecture-ratified`. The user's 2026-09-04 direction supersedes those records in two places: Overflow is now a web platform backed by PostgreSQL, and formal review rounds reduce awarded credit. The older decisions remain authoritative everywhere else.

PostgreSQL is a rebuildable materialization of GitHub state, not an independent financial authority. Every settlement and balance must be reproducible by folding registered repositories through GitHub's GraphQL state. Webhooks make the materialization current; reconciliation proves or repairs it.

## Product intent

Overflow turns otherwise-expiring weekly LLM subscription capacity into reciprocal open-source work. Members claim issues from repositories that other members explicitly register, submit pull requests through GitHub, and receive mutual credit only when those pull requests merge. The zero-sum balance shows who has contributed more than they have received without settling each favour immediately.

The capacity never moves and credentials are never shared. Each member runs their own agent on their own account; only the resulting GitHub work and mutual-credit fold are shared.

## Actors

- A **member** signs in through GitHub, browses eligible issues, claims one through assignment, and can contribute to another member's registered repository.
- A **repository sponsor** is the member who explicitly registered a repository and is its accountable debtor.
- A **contributor** is the registered GitHub user who authored the pull request that actually closed the issue.
- A **moderator** reviews persistent calibration patterns and applies the graduated enforcement ladder.

One repository has one accountable sponsor in the MVP.

## GitHub-native source contract

### Authentication and explicit registration

- Authentication uses GitHub OAuth through Auth.js.
- OAuth requests `read:user`, `user:email`, `repo`, and `admin:repo_hook` to support private repositories and create a webhook during registration.
- A repository is registered only after a signed-in member submits `owner/name` or its canonical GitHub URL.
- Registration verifies repository administration permission, creates the webhook, and records only that repository. It never registers the rest of the member's accessible repositories.
- Registration stores a repository-specific difficulty scheme made of two explicit label catalogs and human-readable display names. Nothing derives meaning from label text.
- The opening catalog may use any vocabulary, such as `size/S`, `size/M`, and `size/L`. Each configured label maps to repository-chosen comparison points from 1 through 10, used only for calibration and exposure reservation.
- The closing/actual catalog may also use arbitrary label text, but its mappings must cover every integer from 1 through 10 exactly once because those mapped points award credit.
- The historical `perceived difficulty: N` / `actual difficulty: N` families are one selectable preset, not hardcoded behavior. Registration verifies that every configured label exists, creating missing labels.

### Difficulty facts

- **Offered difficulty** is the earliest configured opening-label event applied by the issue owner before the first assignment event. It is the posted price and the amount reserved while an outsider holds the assignment. Its event ID, actor, and timestamp are immutable proof; later configured opening-label mutations create policy violations without replacing the original. Bot-applied and post-assignment labels are not opening authority. A repository may display this as “perceived,” “estimate,” or another configured term.
- **Settled difficulty** is a configured closing-label event applied to the issue by that same owner no earlier than the closing pull request’s final commit and no later than merge, accompanied by a nonblank owner comment no earlier than that event and no later than merge that names the configured label text. Pull-request labels and contributor-applied issue labels cannot settle. The label event and rationale comment IDs, actors, and timestamps are retained as proof. A repository may display this as “actual,” “final,” or another configured term.
- Both labels live on the issue. The configured opening category maps to comparison points; the configured closing/actual category always maps to an integer from 1 through 10. The worker never prices their own work.
- A missing or ambiguous label makes a row unsettled. Overflow never guesses.
- Changing offered difficulty after the issue is filed creates a policy violation in the materialized audit trail; the original observed filing value remains the offered value used by the fold.

### Claims and settlement proof

- The issue assignee is the claim lock. The PR author is the creditor. These identities are intentionally distinct.
- A settlement exists only when one merged pull request closes the issue through GitHub's closing relationship.
- The issue-to-PR relationship must be read through GraphQL `closedByPullRequestsReferences`. REST issue timelines and cross-reference events are forbidden because they can return plausible but incorrect PRs when a closing keyword was added after the PR opened.
- A cross-person issue closed by hand or by commit message is `UNWRITABLE`: no ledger row is invented, and the repository is flagged because GitHub exposes no authoritative creditor relationship.
- A PR that closes several eligible issues creates one settlement per linked issue. A linked issue can settle only once; GraphQL state decides the closing PR.

### Events and reconciliation

The production webhook endpoint at `/api/github/webhooks` verifies `X-Hub-Signature-256` against the raw body before parsing JSON and deduplicates `X-GitHub-Delivery`. It processes issue/assignment/label state, submitted formal reviews, pull-request merge state, and installation/repository availability.

`overflow reconcile` performs a fully paginated GraphQL fold for every active registered repository and upserts the PostgreSQL materialization. A PostgreSQL repository coordinator serializes each repository from before snapshot collection through materialization so an older worker cannot overwrite a newer result. Reconciliation must be idempotent and must report additions, removals, and changes. Deleting or rewriting GitHub facts legitimately changes the rebuilt materialization; the reconciliation audit records both versions.

## Rating and ledger rules

For an outsider settlement:

```text
rated difficulty = settled difficulty on the linked issue
review rounds     = unique formal CHANGES_REQUESTED GitHub review IDs submitted before merge
awarded credits   = max(0, rated difficulty - review rounds)
```

Review comments without a formal `CHANGES_REQUESTED` review are not review rounds. Additions, deletions, changed-file count, commit count, elapsed time, token use, and every other churn metric never enter the rating or award.

Each settlement stores debtor, creditor, offered difficulty, settled difficulty, review rounds, awarded credits, issue number, PR number, merge SHA, merge time, and a SHA-256 diff fingerprint. It does not store the patch or churn metrics.

The ledger is a view over settlements: contributor `+credits`, sponsor `-credits`. The view is balanced by construction, and balances are sums of those signed rows. There are no hand-entered adjustments.

If contributor and sponsor are the same GitHub user, the fold records `SELF_WORK` calibration evidence but creates no settlement and no ledger row. Self-work still retains the offered→settled pair because it is the sponsor's no-counterparty calibration baseline.

If the contributor has not joined Overflow, the row is `UNCLAIMED` until that GitHub identity signs in. The GitHub identity, proof, and amount remain derivable.

## Credit-limit boundary

The historical records ratified the mechanism but not the numeric floor. Overflow therefore calculates and displays each sponsor's reserved headroom without enforcing a default floor:

```text
available headroom = settled balance - sum(offered difficulty of open outsider-assigned issues)
```

No floor is enforced or configurable in this release, and negative headroom remains visible. Optional group floors are deferred until a later release can define and test a properly idempotent assignment-mutation protocol; the MVP does not expose a display-only switch or imply enforcement it does not perform.

## Statistical miscalibration ladder

Miscalibration is a persistent account-level pattern, never a dispute over one transaction. Individual settlement errors are allowed to be wrong and are not retroactively edited or arbitrated.

For each sponsor, Overflow calculates:

- the sponsor's self-work baseline distribution of `settled - offered`;
- the outsider settlement distribution of `settled - offered`;
- sample sizes, means, medians, and the difference between those means; and
- the underlying GitHub rows so a moderator can reproduce the figures.

Calibration windows use each associated pull request’s immutable GitHub merge timestamp, never the database creation time of a rebuilt settlement or self-work row. The selected time boundary and every pair’s merge timestamp remain in the cohort proof.

Automatic accusation is deliberately avoided. A moderator may open an account audit only when both the self-work and outsider samples contain at least 10 settled issues. That threshold is a provisional MVP ruling because the older decision record explicitly says five is too few but does not ratify a number.

- **Audit:** snapshot the reproducible cohort and mark the account `UNDER_AUDIT`; no ledger row changes.
- **Warn:** a substantiated first pattern records the evidence and warning; future settlements continue normally.
- **Recalibrate:** a substantiated second pattern changes the sponsor to `RECALIBRATING`, deactivates their registered repositories, and requires a moderator-recorded recalibration plan before reactivation.
- **Ban:** a substantiated third pattern changes the sponsor to `BANNED`, keeps their repositories inactive, and blocks new registration or settlement.

Dismissal returns the prior enforcement state. Every transition records actor, timestamp, reason, sample definition, summary statistics, and prior/new state. No stage creates, reverses, or changes a settlement.

Settlement eligibility is evaluated at the immutable GitHub merge timestamp from moderation-event history. A later warning, recalibration, or ban never deletes, rerates, or reclassifies an eligible historical settlement or self-work calibration; work merged while either participant was recalibrating or banned remains ineligible, including when an unclaimed identity is claimed later.

## Data model

- `users`: GitHub identity, login, avatar, role, enforcement state, confirmed-pattern count, encrypted OAuth token.
- `registered_repositories`: GitHub repository identity, owner/name, sponsor, visibility, webhook identity, active state, opening/actual label catalogs and display names, and last reconciliation time.
- `issues`: GitHub issue identity, repository, owner/assignee identities, original offered difficulty, current settled difficulty, label validity, state, and GitHub timestamps.
- `pull_requests`: GitHub PR identity, repository, author identity, merge SHA/time, diff fingerprint, and GraphQL closing relation.
- `review_rounds`: repository/PR plus unique formal changes-requested review ID and submitted time.
- `settlements`: the derived outsider row, proof, difficulties, penalty, amount, and materialization version.
- `self_work_calibrations`: derived offered→settled pair with issue/PR proof and no amount.
- `unwritable_closures`: cross-person close with no authoritative merged-PR link.
- `webhook_deliveries`: delivery ID, event, processing state, error, and timestamps.
- `reconciliation_runs` and `reconciliation_changes`: source snapshot provenance and drift repair history.
- `calibration_audits` and `moderation_events`: account-level cohort evidence and enforcement transitions.

SQL views `ledger_entries`, `balances`, and `calibration_statistics` derive the user-facing ledger and audit measures from these facts.

## Application surfaces

- `/`: product explanation and GitHub sign-in.
- `/dashboard`: balance, earned/given totals, reserved headroom, open claims, registered repositories, recent settlements, and enforcement notices.
- `/repositories/new`: explicit repository registration form and GitHub setup result.
- `/issues`: filterable eligible issue board with the repository-configured opening-rating name, sponsor, assignee state, and headroom status.
- `/settlements/:id`: issue and PR proof, repository-configured opening/settlement rating names, review penalty, and balance effect.
- `/calibration`: the signed-in sponsor's self-work versus outsider calibration history.
- `/moderation`: moderator-only account-level audit queue, cohort evidence, recalibration, and enforcement history.
- `/api/auth/[...nextauth]`, `/api/github/webhooks`, `/api/repositories`, and `/api/moderation` provide authenticated integration boundaries.

The visual direction is a calm, dense exchange ledger: warm paper, ink typography, acid-lime credits, coral debits, compact evidence tables, and direct GitHub provenance. It should feel like infrastructure for trusted peers, not a gig marketplace.

## Security and failure handling

- OAuth access tokens are encrypted with AES-256-GCM using a base64-encoded 32-byte `TOKEN_ENCRYPTION_KEY`; plaintext is never persisted or logged.
- Webhook verification uses constant-time comparison and rejects missing, malformed, or invalid signatures with `401`.
- Mutations require a server-side session; moderation reads, mutations, and UI re-resolve the current user role from PostgreSQL on every request or render and require `role = MODERATOR`. A cached JWT role is not authorization.
- GitHub-generated strings render as text, never raw HTML. SQL is parameterized.
- Registration rolls back local activation and attempts webhook cleanup if setup fails.
- Webhook failures remain retryable and recorded. Reconciliation is the correctness backstop for missed or reordered events.

## Verification

- Pure tests cover arbitrary label catalogs including S/M/L, exact 1–10 coverage for actual mappings, duplicate/overlapping mappings, offered-rating immutability, score calculation, self-work suppression, balance folding, calibration statistics, token encryption, URL parsing, and signature verification.
- Service tests cover explicit registration, permission denial, GraphQL-only closing links, webhook idempotency, review deduplication, merge settlement, hand-close unwritable debt, unclaimed members, reconciliation drift, and account-level enforcement.
- PostgreSQL behavior tests run the real migration in an ephemeral PostgreSQL 17 container and exercise constraints and views.
- Component tests cover signed-out landing, dashboard summaries/headroom, issue cards, settlement proof, calibration comparison, registration errors, and moderator controls.
- GitHub Actions gates pushes to `main`, pull requests targeting `main`, and manual dispatches with explicit read-only permissions, per-ref/PR concurrency, commit-pinned actions, PostgreSQL 17 migration, `pnpm test --run`, `pnpm lint`, `pnpm typecheck`, and `pnpm build`; actionlint and zizmor separately gate workflow correctness and security.
- `pnpm test --run`, `pnpm lint`, `pnpm typecheck`, and `pnpm build` must pass from a clean checkout.

## Explicitly deferred

- Measuring, pooling, or brokering members' LLM subscription capacity.
- Automated LLM difficulty judgment; maintainers apply governed actual-difficulty labels from issue and diff evidence.
- Optional group credit floors and their idempotent assignment-enforcement protocol; only the headroom calculation ships in the MVP.
- Automated statistical accusations or a group-vote ban mechanism.
- Multiple sponsors per repository, groups/teams, cash settlement, transferable credits, and partial credit before merge.
- Hosted deployment, billing, email/push notifications, and agent execution.
