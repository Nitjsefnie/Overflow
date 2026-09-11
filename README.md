# Overflow

Overflow is a cooperative ledger for open-source work. A repository sponsor offers work, an outside contributor closes it through GitHub, and Overflow records a settled credit transfer with auditable proof.

**Overflow is already running at <https://overflow.nitjsefni.eu>.** Pointing you at that instance is what this repository is for. You do not need to deploy anything to use Overflow — sign in there and join the ledger that already exists. The setup instructions further down build a development environment for changing Overflow itself; they are not the way to use it.

`Nitjsefnie/Overflow` is itself registered in that instance, and the issues in this tracker are materialized there, so the mechanism described below can be watched working on this repository itself.

## Join the running instance

1. **Sign in.** Open <https://overflow.nitjsefni.eu> and choose *Sign in with GitHub*. That is the whole account setup — there is nothing to install and nothing to configure.
2. **Register a repository, catalogs and all, on one form.** *Register a repository* takes the repository and both of its catalogs and submits them together. Bring a public repository you administer. Registration writes to it: Overflow creates the catalog labels there and installs its webhook. [What the ledger records](#what-the-ledger-records) is the reference for what a catalog has to contain. Catalogs can be changed later — on the same page, or over the API — and a change never re-prices work that has already settled.
3. **Offer work, then settle it.** Apply an opening label when you file an issue. After the closing pull request's final commit and before you merge it, apply an actual-catalog label and post a comment naming that label — as the sponsor; nobody else's labels or comments price your repository's work, and a comment edited after the merge window closes no longer counts. Those are the labels Overflow created for you in step 2. [What the ledger records](#what-the-ledger-records) states the evidence each label has to satisfy, and [Scoring and calibration](#scoring-and-calibration) says what it is worth.
4. **Read the ledger.** A signed-in member gets *Ledger*, *Issues*, *Settlements*, *Register a repository*, *Calibration* and *Rules*.

Closing work needs no repository of your own. Take an issue in a repository that is already registered; the sections that follow are the terms the credit settles on, including what happens when you have not signed in yet.

## What the ledger records

- GitHub OAuth signs a member in at `/api/auth/callback/github`.
- Repository registration is explicit and one at a time. The submitted `owner/name` or canonical `https://github.com/owner/name` URL must be a public repository, and the signed-in person must have GitHub administrator permission for it.
- Each repository chooses its own opening catalog. S/M/L is allowed, but so are arbitrary labels such as `moonlit ridge`, `risk: high`, or anything else the repository understands. Each opening label carries comparison and reserve points from 1 through 10.
- Every actual catalog has exactly one editable mapping for each point from 1 through 10. The labels are repository-defined; the point mapping is the common settlement scale.
- The dashboard uses materialized ledger entries and balances. Available headroom is `settled balance − reserve points` for open issues assigned to outside contributors, and negative headroom remains visible. This release enforces no credit floor and exposes no floor configuration; optional group floors await a later idempotent assignment-enforcement design.

Closing-link evidence comes only from GitHub GraphQL `closedByPullRequestsReferences`. Opening difficulty is reconstructed from the earliest configured label that the repository sponsor applied before the first assignment. Settled difficulty requires exactly one active actual-catalog label, applied by the sponsor between the closing pull request's final commit and merge, plus a nonblank sponsor comment naming that label. Only the sponsor prices work; being the issue's author grants no pricing authority. Work completed by the sponsor is self-work calibration, not a settlement. Pull-request labels never price work.

A 15-minute tolerance applies to label and comment timing; the settlement window closes 15 minutes after merge. A rationale comment edited after that close does not count. The earliest qualifying comment at or after the standing label is used, including when a label is reapplied; if none exists, a comment up to 15 minutes before that label can count. Overflow retains the accepted event/comment identifiers and timestamps, the exact merge commit OID, and the diff fingerprint so every scoring input is reproducible.

Contributors and moderators are identified by their immutable GitHub account id; a GitHub login is displayed but never decides who is credited or who is a moderator.

## Scoring and calibration

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

## License

MIT — see [LICENSE](LICENSE). Contributions are accepted under the same terms.
