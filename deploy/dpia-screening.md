# DPIA screening for contributor scoring

A data protection impact assessment (DPIA) screening record for the scoring
Overflow applies to contributor accounts. Screened and recorded on
**2026-09-30** against the code at `main` (revision `b811effd4cac0a549380425678219a3905812328`).
Every claim below carries its basis in the code or the notice; where a
statement rests on the running deployment rather than the code, it says so.

## Why a screening was needed

Overflow scores and ranks people. Settlements assign points to named
contributors, each account carries a credit limit derived from its repayment
history, and every account row carries an enforcement state that decides
whether its repositories can keep issues on the issues board. Scoring and
ranking people is a recognised DPIA trigger, so the screening duty applies and
this record discharges it. The record was written because the trigger exists,
not because an incident or a complaint raised the question.

## The scoring activities

Three activities score contributor accounts. For each: what it computes, the
data it uses, and where it lives in the code.

### a. Automated settlement pricing

When an issue closes, the fold — the reconciliation pass — computes a
settlement from the repository's own records: the settled difficulty label the
sponsor applied and the points it carries, the closing pull request's merge
record, and the distinct review rounds that stood when it merged. The credit
is the settled points less the number of distinct review rounds, never below
zero; the ledger entry credits the contributor and debits the sponsor with
that figure.

Data used: sponsor-applied `settled:` label (points, who applied it, when, and
the pricing rationale comment), the pull request's merge commit and merge
time, review submissions, and the pull request author's account identity.
Code: `src/lib/fold/repository-fold.ts` — review rounds are counted per pull
request (`countReviewRounds`, applied around line 523) and the credit
computation `Math.max(0, settledPoints - reviewRounds)` stands around line
1194; the rounds ride into the folded record through `rememberPullRequest`
(around line 1083).

### b. The per-account credit limit

Each account's history of repaying settled work produces a credit limit: ten
points plus one for every ten points of repaid debt. Once an account's settled
balance falls to minus that limit, its repositories' open issues leave the
issues board — all but one repayment issue — until completed work restores the
balance.

Data used: the account's settlement history (repaid and outstanding settled
points) and, through it, the same repository records settlement pricing reads.
Code: `src/lib/dashboard/eligible-issues.ts` — the credit limit is
`10 + floor(repaid_debt / 10)` (around line 220) and the board-withdrawal
predicate compares the settled balance against minus that limit (around line
238). The enforcement-state participation gate that also governs board
membership is `isParticipationEligibleAt` in
`src/lib/fold/repository-fold.ts` (around line 1465).

### c. The enforcement ladder

Every account row carries an enforcement state — active, warned, under audit,
recalibrating, or banned — and a confirmed-miscalibration count. The
enforcement state decides whether an account's repositories can keep issues on
the issues board; a recalibrating or banned account's issues leave it
entirely.

Data used: the enforcement state, the confirmed-miscalibration count, and the
moderation event history (each event's prior and new state with its
occurrence time). Code: the state union in `src/lib/db/types.ts` (line 9);
`deriveSubstantiatedState` in `src/lib/moderation/transitions.ts` derives
warned, recalibrating or banned from the confirmed-miscalibration count; the
participation gate that reads the state is `isParticipationEligibleAt` in
`src/lib/fold/repository-fold.ts` (around line 1465).

## The human-review routes

None of these activities ends in an irreversible automated sanction. Five
routes put a person between the scoring and its consequences, and all five
are disclosed in the `/account-data` notice.

**Sanctions are applied by moderators.** Enforcement transitions — moving an
account along warned, recalibrating and banned as confirmed miscalibrations
accumulate — are applied by people acting in a moderator session: the
moderation routes gate on `requiredModeratorSession`
(`src/lib/moderation/route-auth.ts`), the roster of moderators is resolved at
sign-in from the `MODERATOR_GITHUB_USER_IDS` environment entry with grants made
inside the product persisting in the database
(`src/lib/moderation/roles.ts`). The transition logic itself lives in
`src/lib/moderation/transitions.ts` and
`src/lib/moderation/postgres-store.ts`; the fold reads the resulting states,
it does not set them.

**Ban and recalibration reversal.** A moderator can reverse a recalibration
or a ban inside the product: `closeRecalibration` and `reverseBan` in
`src/lib/moderation/postgres-store.ts` return the account to ACTIVE and
write the moderation event, and both lift the deactivation the sanction
applied — the closure reactivates the account's whole still-registered
inactive set, the ban reversal only the rows migration 060's
`sanction_deactivated_at` flag records as sanction-deactivated. The ban
route is `src/app/api/moderation/reversal/route.ts`, which journals the
action as `ban.reverse` in the privileged-action log. The recalibration
closure is reached through the moderation route's POST action
(`src/app/api/moderation/route.ts`, which dispatches `closeRecalibration`
around line 137 and journals `recalibration.close`). The route is
disclosed in the `/account-data` notice's "Scoring and sanctions" section,
with the sanction's effects on the account's repositories. (Route recorded
2026-10-06, with the change that shipped it; the three routes above stand
as screened on 2026-09-30.)

**Correction and override requests.** A member may request a correction to a
priced settlement or calibration, and a moderator grants or declines it
(`src/lib/overrides/service.ts`, the `SettlementOverrideService`; requests are
held in the `settlement_override_requests` table, written by
`src/lib/overrides/postgres-store.ts`). This lets a creditor or sponsor
contest a settlement the fold priced automatically.

**Sanction contest requests.** The account under a sanction can ask for the
sanction to be contested, and a moderator decides the request. The filing
route is `src/app/api/contests/route.ts`, gated to the sanctioned account's
own session; the decision route is
`src/app/api/moderation/contests/route.ts`, gated to a moderator session,
which journals the decision as `sanction.contest.decide` in the
privileged-action log. Requests are held in the `sanction_contest_requests`
table (migration 061), and the store refuses a decision by the moderator who
imposed the sanction while another live moderator exists
(`decideSanctionContest` in `src/lib/moderation/sanction-contest-store.ts`);
with exactly one live moderator, that moderator decides and the request
records that it did. The filing and the decision are each written as
moderation events, through `moderation_events.contest_request_id`.

**Manual credit adjustments.** Moderators can adjust credit balances by hand
through the recalibration adjustment route
(`src/app/api/moderation/recalibration/adjustment/route.ts`), which applies
the compensating adjustment the latest substantiated audit's snapshot
supports. The `/account-data` notice's "Scoring and sanctions" section
discloses that moderators apply sanctions and can adjust balances.

## Screening result per trigger

Screened against the recognised triggers, with the basis for each result:

| Trigger | Result | Basis |
| --- | --- | --- |
| Scoring or ranking of people | **Triggered** | Settlement credit scoring, credit limits and the enforcement ladder (activities a–c above). |
| Large-scale processing | No | One deployment, a handful of registered repositories, thousands of ledger rows; the largest historical table was a change log, since pruned — a running-deployment observation from the 2026-09-30 audit of the live stores, not a property of the reviewed tree. |
| Systematic monitoring | Partial | Reconciliation re-reads contributor activity on a schedule, but only within repositories registered with a sponsor token, and the processing is disclosed. |
| Special-category data | None | No health, biometric, genetic, political, religious or similar fields anywhere in the schema (`db/migrations/`). |
| Combining datasets | Inherent, disclosed | Forge identity is joined to ledger identity — the join is the product: contributor activity is priced into a ledger, and the notice discloses it. |
| LLM-driven decisions | None | No LLM calls anywhere in the runtime; pricing is arithmetic over repository records. |

The trigger that fired is the first one. The others were screened and did not
fire: scale is small, monitoring is scoped and disclosed, no special-category
data is processed, the dataset combination is inherent to the product and
disclosed, and no decision is made by a model that is not reproducible
arithmetic.

## Conclusion

**No full DPIA is required at this time.** The reasoning, stated so the
conclusion can be re-derived and challenged:

- The enforcement ladder passes through a human moderator: transitions are
  applied by moderators, a recalibration or a ban can be reversed by a
  moderator inside the product, priced settlements can be contested through
  correction requests decided by a moderator, and balances can be adjusted by
  hand. The one fully automated lever is the credit-limit withdrawal — an
  account's issues leave the board on balance alone once its balance reaches
  minus the limit — and its review route is the correction-request and
  manual-adjustment surface above.
- Scale is small: one deployment, a handful of registered repositories,
  thousands of rows.
- No special-category data is processed.
- The processing is disclosed in the `/account-data` notice, with correction
  routes built into the product.

Two qualifications belong in the record. First, the adequacy judgment —
whether the law requires a full DPIA of this instance — is
specialist-dependent, and this record does not settle it. The recording duty
is not specialist-dependent: where screening is triggered, the outcome is
recorded, and this record is that recording. Second, a screening conclusion is
a judgement as of its date, not a finding that holds forever: the revisit
triggers below reopen it.

## Revisit triggers

The conclusion is revisited, and this record updated, when any of the
following happens:

- any move to automated sanctioning without a human decider — an enforcement
  transition applied by the product rather than by a moderator;
- processing at materially larger scale — more repositories, accounts or
  volume than the current handful of registered repositories;
- new data categories, especially any special-category data entering the
  schema;
- a new scoring signal, or a new dataset combination beyond forge identity
  joined to ledger identity;
- a supervisory authority, or a specialist opinion the operator has sought,
  saying this instance requires a full DPIA.

Any one of these reopens the screening; the record is then updated with a new
dated conclusion, not by editing this one in place.

## Where the processing is disclosed

The `/account-data` notice is the transparency surface for everything this
record screens: its "Scoring and sanctions" section describes the automated
pricing, the credit limit, the enforcement states, and what a sanction does
to the account's repositories, and its rights sections describe export,
rectification and correction. The operating model — who
decides what, and what stops when the maintainer is unavailable — is
[OPERATING.md](../OPERATING.md), section "Governance: single-maintainer
operation". Incident handling for this processing lives in
[incident-response.md](incident-response.md).
