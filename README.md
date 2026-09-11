# Overflow

Overflow is a cooperative ledger for open-source work. A repository sponsor offers work, an outside contributor closes it, and Overflow records a settled credit transfer with auditable proof.

**Overflow is already running at <https://overflow.nitjsefni.eu>.** Pointing you at that instance is what this repository is for: there is nothing to deploy — sign in there and join the ledger that already exists. `Nitjsefnie/Overflow` is itself registered in that instance, and the issues in this tracker are materialized there, so the mechanism described below can be watched working on this repository itself.

## Join the running instance

**Sign in.** Open <https://overflow.nitjsefni.eu> and choose *Sign in with GitHub*. That is the whole account setup — there is nothing to install and nothing to configure.

**Register a repository, catalogs and all, on one form.** *Register a repository* takes a public GitHub repository you administer and both of its catalogs, and submits them together. Every label the catalogs name must already exist on the repository; registration verifies them and installs Overflow's webhook. [How credit settles](#how-credit-settles) is the reference for what a catalog has to contain. Catalogs can be changed later — on the same page, or over the API — and a change never re-prices work that has already settled.

**Offer work, then settle it.** Apply an opening label when you file an issue. After the closing pull request's final commit and before you merge it, apply an actual-catalog label and post a comment naming that label — as the sponsor; nobody else's labels or comments price your repository's work, and a comment edited after the merge window closes no longer counts. [How credit settles](#how-credit-settles) states the evidence each label has to satisfy and what it is worth.

**Read the ledger.** A signed-in member gets *Ledger*, *Issues*, *Settlements*, *Members*, *Register a repository*, *Calibration* and *Rules*.

Closing work needs no repository of your own. Take an issue in a repository that is already registered; the terms below say when the credit settles, including what happens when you have not signed in yet.

## Forges

### GitHub

GitHub is the forge Overflow is built around: it is the sign-in, the *Register a repository* form and the API both take GitHub repositories, registration installs a webhook so the ledger follows the repository as it changes, and every settlement rule below applies in full.

### GitLab

An account can also link a GitLab identity and register GitLab projects. The support is partial; this is what it does and does not do today.

What works:

- **Linking a GitLab identity** to your GitHub-signed-in account: on the *Ledger* page under *Forge identities* → *Link a GitLab instance*, or `POST /api/forge-identities` with your browser session (an API token cannot link or unlink an identity). Any instance works, self-hosted included; gitlab.com and a self-hosted instance are separate identities. One GitLab identity can be linked to only one Overflow account.
- **The token** is a personal access token with the `read_api` scope, or the broader `api` scope; `read_user` alone is refused. Overflow verifies it against the instance when you link, stores it encrypted, and never returns it.
- **Registering a GitLab project** over `POST /api/repositories` with `provider: "gitlab"`, the `instanceUrl`, and the `project` as its numeric id or its `group/project` path — see [API.md](API.md#submitting-a-gitlab-project). You need a verified identity on that exact instance; its token is what Overflow reads the project with. The catalog labels must already exist on the project.
- **Crediting a GitLab contributor.** Settlements record the forge they came from, and a merge-request author who links their GitLab identity later claims their past GitLab settlements retroactively.

What is not available on GitLab:

- **Sign-in.** GitHub is the only sign-in and the only account key; a GitLab identity is linked to a GitHub-signed-in account. This is by design.
- **The *Register a repository* form.** GitLab registration is API-only. Not built yet.
- **Webhooks.** Registration installs nothing on the project and schedules no initial import. A GitLab project is picked up only by the periodic reconciliation sweep, which runs at startup and every six hours. Webhook ingestion is deferred, not ruled out.
- **Changing the catalog.** `PATCH /api/repositories` has no GitLab path. Unregistration has none either: the GitHub-shaped `DELETE /api/repositories` accepts a `group/project` path as `repositoryUrl`, and a project under a nested group cannot be unregistered. Not built yet.
- **Review rounds.** GitLab approvals are not changes-requested reviews, so review rounds on a GitLab merge request always count zero. This is a recorded asymmetry, by design until GitLab has a native equivalent.
- **Closure reasons and claim automation.** A GitLab issue carries no `not_planned` state, so that gate is skipped, and the claim-path check is always `NOT_CHECKED` because GitLab CI offers no evidence surface for it. Both by design.
- **Checks at registration.** Registration does not check that the project is public or that you maintain it; a private project is declined when reconciliation reaches it. A token that stops working fails that project's reconciliation, and nothing marks the identity as needing re-verification. Not built yet.
- **Settling at all.** As of this writing no GitLab project has settled: the gateway supplies no closing merge requests, label events or comments for an issue, so the fold sees nothing to settle. Tracked as #539.

## How credit settles

- Each repository chooses its own opening catalog. S/M/L is allowed, but so are arbitrary labels such as `moonlit ridge`, `risk: high`, or anything else the repository understands. Each opening label carries comparison and reserve points from 1 through 10.
- Every actual catalog has exactly one editable mapping for each point from 1 through 10. The labels are repository-defined; the point mapping is the common settlement scale.
- The dashboard uses materialized ledger entries and balances. Available headroom is `settled balance − reserve points` for open issues assigned to outside contributors, and negative headroom remains visible. This release enforces no credit floor and exposes no floor configuration; optional group floors await a later idempotent assignment-enforcement design.

Closing-link evidence comes only from GitHub GraphQL `closedByPullRequestsReferences`. Opening difficulty is reconstructed from the earliest configured label that the repository sponsor applied before the first assignment. Settled difficulty requires exactly one active actual-catalog label, applied by the sponsor between the closing pull request's final commit and merge, plus a nonblank sponsor comment naming that label. Only the sponsor prices work; being the issue's author grants no pricing authority. Work completed by the sponsor is self-work calibration, not a settlement. Pull-request labels never price work.

A 15-minute tolerance applies to label and comment timing; the settlement window closes 15 minutes after merge. A rationale comment edited after that close does not count. The earliest qualifying comment at or after the standing label is used, including when a label is reapplied; if none exists, a comment up to 15 minutes before that label can count. Overflow retains the accepted event/comment identifiers and timestamps, the exact merge commit OID, and the diff fingerprint so every scoring input is reproducible.

Contributors and moderators are identified by their immutable GitHub account id; a GitHub login is displayed but never decides who is credited or who is a moderator.

For an outside contributor, settled credits are:

```text
credits = max(0, actual points − distinct review rounds)
```

There is no churn metric. Review rounds are the distinct changes-requested reviews submitted before merge, counted as they stood when the pull request merged: a review dismissed after the merge still counts, and one dismissed before the merge does not. A dismissal exactly at merge also leaves the round counted; no timing tolerance applies to reviews. A dismissed review counts only if its dismissal history establishes that it requested changes; missing history or an unknown previous state does not count.

Calibration compares paired self-work samples with outsider settlements; it does not measure activity retention. Self-work is useful calibration evidence, but it creates no ledger entry. If an outside contributor has not signed in yet, their completed work remains an unclaimed settlement until their GitHub identity is claimed.

Moderation is account-level and evidence-led:

```text
audit → warn → recalibrate → ban
```

Open an audit only with the required paired samples, warn when the record supports it, require recalibration before reactivation, and ban only after confirmed patterns persist.

## Running your own instance is not the way to use Overflow

Each instance keeps its own ledger. Balances, reserves, settlements, proof records and calibration history live in that instance's own PostgreSQL database, and nothing in this codebase moves them between deployments. A second instance therefore starts empty and stays private to itself: no registered repositories, no counterpart to settle with, and no credit that anyone else can see or honour. Signing in at <https://overflow.nitjsefni.eu> is what puts your work in a ledger other people are already reading.

## Reference

- [API.md](API.md) — API tokens, programmatic registration and catalog changes with every error message, the ledger read endpoints, and the MCP endpoint for agent harnesses.
- [OPERATING.md](OPERATING.md) — development setup, GitHub OAuth and webhook configuration, the production service, reconciliation, CI, and the environment reference.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to change Overflow, and the conventions of this repository that reject work silently.
- [deploy/README.md](deploy/README.md) — the production deployment procedure.

## License

MIT — see [LICENSE](LICENSE). Contributions are accepted under the same terms.
