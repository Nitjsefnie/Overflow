# Overflow

## Who this is for

You spent Tuesday evening fixing someone else's flaky test. The bug in your own tracker just turned eleven months old. You had time to help then. You need help now. What if that Tuesday could pay for it?

**Let your spare weeks pay for the dry ones.** Overflow is a shared ledger for open-source work, for people and small teams whose capacity comes and goes. When you have spare hands, agent quota or CI quota, work on others' issues and earn credit. Spend it on your own backlog when you're depleted. No money changes hands. There is no token.

## Where to register

Go to <https://overflow.nitjsefni.eu> and sign in with GitHub. Register a repository you administer on one form: the repository and its two label catalogs. The catalog labels must already exist. Overflow installs the webhook for you.

**You don't need a repository to start earning.** Take an issue in one that's already registered. This repository is on that ledger too. You can watch the exchange happen in its own tracker.

## How it works

1. A repository sponsor puts a price on an issue with an opening label.
2. An outside contributor does the work and opens a pull request that closes the issue.
3. Between the closing PR's final commit and merge, the sponsor confirms the price with an actual-catalog label and a comment naming it.
4. The PR merges. The contributor's account is credited and the sponsor's is debited.

**Credit earned in their tracker can pay for work in yours.** Each repository chooses its labels. Its two catalogs map them to points on the shared 1–10 scale.

## Why it can't be abused

**More room to borrow comes from paying it back.** Every account starts with a credit limit of 10 below zero. At or below that limit, its unclaimed issues disappear from discovery. Already-claimed issues can still complete, even if they take the balance farther below the limit. Only settled credits count toward the cutoff. Claims never count.

Completed work for others repays a negative balance immediately. Repay enough to rise above the cutoff and your unclaimed issues reappear. Every 10 credits repaid while negative adds 1 to your limit. Only the portion that repays debt counts. Self-work creates no credit.

Only the sponsor prices work, at merge time, after the work exists. A claim is not a payment. Only a merged closing PR settles. Distinct review rounds are subtracted from the actual points, so repeated requests for changes reduce the credit earned.

Every settlement records the label event, the sponsor's comment, the merge commit and a diff fingerprint. Every number from GitHub work is reproducible from GitHub. Accounts are audited by comparing outsider settlements with paired self-work samples: audit, warn, recalibrate, ban. Accounts use immutable GitHub account ids. Changing your login doesn't erase your balance.

## The rest

Settled credits are `max(0, actual points − distinct review rounds)`. Label and comment timing has a fifteen-minute tolerance; the settlement window closes fifteen minutes after merge. The full rules are on the instance's *Rules* page, the same text the ledger enforces.

GitHub is the sign-in and primary forge. To register GitLab projects, link a GitLab identity with a `read_api` personal access token, then use the form or API. Webhooks, initial import, catalog changes and unregistration all work. Two differences are by design: review rounds count zero on GitLab merge requests, and GitLab has no `not_planned` state, so that gate is skipped.

**You can copy the software. You can't copy the neighbours.** Running your own instance is pointless for joining this exchange. A second ledger starts empty, with nobody to settle with. Join the existing instance to earn and spend credit with others.

Reference links:

- [API.md](API.md) — API tokens, programmatic registration and catalog changes with every error message, the ledger read endpoints, and the MCP endpoint for agent harnesses.
- [OPERATING.md](OPERATING.md) — development setup, GitHub OAuth and webhook configuration, the production service, reconciliation, CI, and the environment reference.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to change Overflow, and the conventions of this repository that reject work silently.
- [deploy/README.md](deploy/README.md) — the production deployment procedure.

MIT — see [LICENSE](LICENSE).
