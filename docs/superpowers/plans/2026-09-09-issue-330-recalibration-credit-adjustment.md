# Plan — issue 330: a moderator cannot see or act on a sponsor's outsider miscalibration, and a recalibration plan changes no points

Repository `Nitjsefnie/Overflow`. Branch `overflow-330`, worktree
`/tmp/overflow-wt-16cf61e0/overflow-330`, BASE `4100839`.
Repository contract: `/root/overflow/.claude/rules/overflow-session.md`.
Issue claimed (comment 5606126382, assigned via /claim workflow).

## What the issue needs

Two gaps, one feature:

1. **Visibility** — the self-versus-outsider calibration comparison exists
   (`compareCalibration` in `src/lib/calibration/statistics.ts`) and the
   moderation service computes it, but no moderator-facing surface attaches a
   threshold, sample-size context, or an action to it. The comparison is
   description, not a decision.
2. **Activation** — `closeRecalibration`
   (`src/lib/moderation/postgres-store.ts`) returns the sponsor to ACTIVE and
   records the plan as free text; nothing applies a correction to the ledger.
   Expected behavior: a moderator can activate a compensating adjustment that
   credits the outsiders the gap under-credited.

The ledger is a **view** (`ledger_entries`, union of the two sides of settled
cross-account settlements) over `settlements`, and `credits` on a settlement is
pinned by a CHECK constraint to `max(0, settled_points - review_rounds)`. That
shapes the whole design: points cannot be written as prose, and they cannot be
written as fake settlements without poisoning the fold's input.

## The constraint that is not a preference

**Trigger on counts, never on `outsider.meanDelta`.** An empty population and a
perfectly calibrated one both yield a mean delta of 0 (the #329 substitution,
live on the calibration page today). A mean-keyed trigger would offer a
moderator a compensation lever for a population that does not exist — the state
of every account on production today.

Formal trigger, used identically at every decision point (preview, close,
reversal precondition):

```
actionable ⟺
  comparison.selfWork.count ≥ MINIMUM_CALIBRATION_SAMPLE_SIZE   (10)
  && comparison.outsider.count ≥ MINIMUM_CALIBRATION_SAMPLE_SIZE (10)
  && comparison.differenceBetweenMeans > 0
```

`differenceBetweenMeans` is non-null exactly when both counts are positive, so
the floor checks imply non-null. The mean may be DISPLAYED as context; it is
never part of the trigger. Reusing `MINIMUM_CALIBRATION_SAMPLE_SIZE` (the
existing `openAccountAudit` floor) keeps one number on the board.

## Design decisions (each names its rejected alternative)

1. **Compensate-only.** The adjustment acts only when `differenceBetweenMeans >
   0` (outsiders settle systematically lower above their offers than the
   sponsor's own work does — outsiders under-credited). A negative gap shows
   the figure with no action. Rejected: clawing credit back on a negative gap —
   the first-ever debit of outsiders, a lever that punishes the more accurate
   sponsor; conservative option chosen. Rejected: acting on any nonzero gap in
   either direction.

2. **Integer points, exact-rational trigger arithmetic.** Total adjustment =
   `round(gap × outsider.count)`, computed in exact integer arithmetic
   (`gap = selfSum/selfCount − outSum/outCount`, so
   `totalExact = (selfSum × outCount − outSum × selfCount) / selfCount`,
   rounded half-up). Lines are distributed across affected creditors by their
   pair counts using largest-remainder, so the lines always sum to the total.
   Rejected: fractional points (the ledger is integer); rejected: an equal
   split that ignores how many sampled settlements each creditor has.

3. **The audit's stored snapshot is the sole evidence.** The adjustment is
   computed from the pairs frozen in `calibration_audits.cohort_definition` /
   `cohort_statistics` at open time — the evidence the moderator actually saw.
   At close time, each stored outsider pair must still resolve to a live
   settlement (by unique `proof_sha256`, same debtor, status SETTLED, unchanged
   offered/settled points), and each self pair likewise to a self-work
   calibration; any drift refuses the whole adjustment with CONFLICT. Rejected:
   recomputing the comparison fresh at close (moderation acting on evidence the
   moderator never saw). Rejected: partial compensation when some pairs
   resolve — silently partial action is worse than none.

4. **First-class adjustment rows, ledger view extended — settlements untouched.**
   Migration 035 adds `moderation_credit_adjustments` (one row per applied
   adjustment; state `APPLIED`/`REVERSED`; links the moderation event and the
   audit; stores gap, pair count, total) and `moderation_credit_adjustment_lines`
   (per-creditor lines, each referencing the settlement it compensates). The
   `ledger_entries` view is redefined to union per-line entries: creditor
   `+amount`, sponsor `−amount`. Balances then include compensation everywhere
   the view is read, without touching settlements, so the fold, reconciliation
   and re-derivation keep their exact inputs. Rejected: synthetic settlement
   rows (violates CHECK constraints and the unique proof fingerprint, poisons
   the fold); rejected: overriding the existing settlements' points (rewrites
   the evidence the gap was measured on, N-row blast radius, and shifts every
   downstream consumer at once).

5. **closeRecalibration gains an optional `applyAdjustment` decision.**
   Absent/false keeps today's behavior byte-identical (plan as prose). True
   requires the trigger to pass on the stored snapshot, then applies the
   adjustment in the SAME transaction that reactivates the sponsor: adjustment
   row + lines + moderation event. Refusal surfaces as
   `ModerationServiceError("INVALID_INPUT")` when the stored comparison does
   not support an adjustment. Rejected: a separate endpoint for apply — one
   decision moment, one transaction, one audit record.

6. **Reversibility: a mirrored reversal, never a delete.**
   `reverseModerationCreditAdjustment(adjustmentId, reason)` is a moderator
   action (any moderator; role-gated like every moderation action) that writes
   a new adjustment row with state `REVERSED` and `reversal_of` the original,
   carrying per-creditor NEGATIVE lines that mirror the original exactly, plus
   a moderation event recording the reversal reason — all in one transaction.
   The original row keeps its lines; nothing is deleted or mutated. A wrong
   adjustment is undone by any moderator through the moderation API/UI. The
   view unions the reversal's negative entries, so balances return to pre-
   adjustment values. Rejected: mutating or deleting the original (destroys
   the audit trail); rejected: only-sponsors-can-ask reversal — the action
   that moved credit is the action that can move it back, under a reason.

7. **The moderator sees the figure before and after.** New service method
   `previewRecalibration(targetAccountId)`: loads the latest SUBSTANTIATED
   audit for the account (same selection the close path uses:
   `order by decided_at desc nulls last, id desc limit 1`), computes the
   trigger against its stored snapshot, and returns the figure — counts, gap,
   actionable verdict, proposed integer total, and the per-creditor line
   preview — plus, separately, the account's already-applied adjustments so a
   moderator can see what is outstanding. NOT_FOUND when no SUBSTANTIATED
   audit exists. Rejected: reusing the audit-preview cohort endpoint (a
   different question: that one sizes a window for a NEW audit).

8. **UI home is the moderation surface, not the sponsor dashboard.** The
   recalibration close control lives in `src/components/moderation-controls.tsx`
   (`RecalibrationPlanControl`); the figure and the apply/reverse controls go
   there and in `src/app/moderation/page.tsx`. **Contention: this work must
   not edit `src/lib/calibration/statistics.ts`,
   `src/components/calibration-panel.tsx`, or
   `src/components/open-audit-form.tsx`** — other panes own them (the third
   via issue 331, PM notice 2026-09-09). The shared formatter
   `src/lib/format-signed.ts` takes `number`, never `number | null`: absent
   figures stay behind a null guard rather than widening that signature. The
   feature consumes `compareCalibration`'s output only; both files stay
   byte-identical. Apply defaults to OFF in the UI: the first moderator action
   that writes credit is a deliberate opt-in, not a checkbox that happens to
   be set.

9. **Where an edge is unresolvable, conservative + flagged.** Known edges: a
   negative gap (no action, shown); drift between stored snapshot and live
   rows (CONFLICT refusal); a settlement resolved but its creditor equals the
   sponsor (excluded from lines; if that leaves zero lines with a positive
   total, refuse). These surface in the PR body under known limitations
   rather than being decided silently.

## Data model (migration `035_moderation_credit_adjustments.sql`)

```sql
create table moderation_credit_adjustments (
  id uuid primary key default gen_random_uuid(),
  moderation_event_id uuid not null references moderation_events(id),
  calibration_audit_id uuid not null references calibration_audits(id),
  target_account_id uuid not null references users(id),
  gap_per_pair numeric not null,
  pair_count integer not null check (pair_count > 0),
  total_amount integer not null check (total_amount > 0),
  state adjustment_state not null default 'APPLIED',
  reversal_of uuid references moderation_credit_adjustments(id),
  reason text not null check (length(trim(reason)) > 0),
  created_at timestamp with time zone not null default now(),
  reversed_at timestamp with time zone
);

create type adjustment_state as enum ('APPLIED', 'REVERSED');

create table moderation_credit_adjustment_lines (
  adjustment_id uuid not null references moderation_credit_adjustments(id),
  settlement_id uuid not null references settlements(id),
  creditor_id uuid not null references users(id),
  amount integer not null check (amount <> 0),
  primary key (adjustment_id, settlement_id)
);
```

(Exact DDL — enum-before-table ordering, CHECK shapes, and whether the
reversal's lines carry negative amounts vs. signed `state` semantics — is the
implementer's to finalize per this plan's rules; the constraints above are the
floor. A reversal row itself has `state = 'REVERSED'`? NO — terminology: the
ORIGINAL row transitions to `REVERSED`-mirrored semantics is NOT used; the
original stays `APPLIED` and the reversal row references it via `reversal_of`,
state `APPLIED` with negative lines… — DECIDED, see below.)

**Decision, stated plainly:** an applied adjustment and its reversal are both
rows with `state = 'APPLIED'`; the reversal row's `reversal_of` points at the
original and its lines carry negative amounts. A row with a non-null
`reversal_of` IS a reversal. The original is effectively undone by the pair of
rows; no row ever mutates after insert. (A `REVERSED` state on the original
would require an UPDATE, weakening append-only.)

The new `ledger_entries` shape unions the settlement sides (unchanged) with:

```sql
union all
select l.creditor_id, l.creditor_id, ... credit side per line
union all
select sponsor side: −(line amount) per line, per adjustment
```

(Exact SQL the implementer writes from the existing view's column contract:
`settlement_id, account_id, counterparty_id, amount, created_at`. For
adjustment lines the settlement_id column carries the compensated settlement's
id so consumers can trace provenance; `created_at` is the adjustment row's.)

Migration 035 is allocated to this branch. Migration list also updates
`tests/db/schema.test.ts`, and every new file passes the .gitignore proof
(`git check-ignore -q <path>` exit 1 + `git status --porcelain` lists it).

## Tasks

Rules for every task: TDD (red → green before implementation commits), run the
covering tests bare, obey the .gitignore mechanic for every new file, keep the
contention files byte-identical, one logical commit per task, commit trailer
exactly `Co-Authored-By: GLM-5.3-Flash <noreply@z.ai>`.

## Task 1: pure adjustment domain — src/lib/moderation/adjustment.ts, tests/moderation/adjustment.test.ts
Exports (names may be refined, semantics fixed):
- `describeCalibrationActionability(comparison): { actionable: boolean; reason: string }`
  — the formal trigger, counting floors + positive gap; never reads meanDelta.
- `computeAdjustmentTotal(comparison): { gapPerPair: number; pairCount: number; totalAmount: number }`
  — exact-rational total per decision 2; refuses (throws) when
  `differenceBetweenMeans` is null or non-positive.
- `distributeAdjustmentLines(totalAmount, pairs: { creditorKey, settlementKey, weight }[]): lines[]`
  — largest-remainder distribution by weight (the creditor's pair count), lines
  sum exactly to totalAmount.
Mutant-planting targets: a mean-keyed trigger MUST fail the trigger tests
(this is the issue's named substitution — plant it, watch it fail).

## Task 2: migration 035 + view extension.
`db/migrations/035_moderation_credit_adjustments.sql` per the data model;
extend `ledger_entries`; update `tests/db/schema.test.ts` migration list.
Tests: schema/migration coverage via the existing migration-list assertion
plus a container test asserting the view carries an adjustment's entries and
that an inserted adjustment moves `balances` both ways (apply + reversal).

## Task 3: store layer — src/lib/moderation/postgres-store.ts, tests/moderation/postgres-store.test.ts (container)
- `loadRecalibrationPreview(targetAccountId)` → latest SUBSTANTIATED audit +
  stored snapshot + live-resolution verification of every stored pair (decision
  3), or a structured drift/unresolvable result the service maps to CONFLICT.
- `closeRecalibration({…, applyAdjustment?: boolean})` — same transaction:
  lock, resolve pairs, compute total+lines via Task 1 functions, verify no
  drift, insert adjustment + lines + moderation event (reason records the
  plan and that an adjustment was applied), return closure with adjustment
  summary or null.
- `reverseModerationCreditAdjustment({ actorId, adjustmentId, reason })` —
  mirrored negative lines, `reversal_of`, moderation event, one transaction;
  refuses an already-reversed original (invalid_state).
- Existing closeRecalibration behavior with no `applyAdjustment` stays
  byte-identical; existing tests must pass unchanged.

## Task 4: service layer — src/lib/moderation/service.ts, tests/moderation/service.test.ts
- `previewRecalibration(actor, targetAccountId)` — moderator-gated; maps store
  results to the preview figure (decision 7) or NOT_FOUND/CONFLICT errors.
- `closeRecalibration(actor, targetAccountId, plan, applyAdjustment?)` —
  extends the existing signature; validates the trigger is satisfiable only
  via the store's stored-snapshot check (no parallel computation in the
  service); INVALID_INPUT mapping decided at review against the store's
  structured refusals.
- `reverseModerationCreditAdjustment(actor, adjustmentId, reason)` —
  moderator-gated pass-through with the store's conflict/not-found mapping.
- Enumerate ModerationStore implementers BEFORE extending the interface
  (grep `implements ModerationStore` + test fakes) and update each.

## Task 5: API routes (`src/app/api/moderation/`, `tests/api/moderation.test.ts`).
- PATCH `/api/moderation` accepts optional `applyAdjustment` boolean in the
  close schema (strict schema, so the field is additive).
- GET `/api/moderation/recalibration?targetAccountId=…` → the preview figure.
- POST `/api/moderation/adjustments/reversal` `{ adjustmentId, reason }` →
  the reversal; same error mapping as the rest of the moderation API.
- Enumerate every creator of the route dependencies object (the exported
  `ModerationRouteService` Pick grows by two method names — grep it).

## Task 6: moderator UI — src/components/moderation-controls.tsx, src/app/moderation/page.tsx, tests/components/moderation-controls.test.tsx
- The recalibration area shows the stored-snapshot figure: both counts, the
  gap, the actionable verdict (with the reason when not actionable), the
  proposed integer total, and the per-creditor line preview.
- The close control gains the apply-adjustment opt-in (default OFF) whose
  disabled state and label reflect the preview verdict.
- An applied-adjustments list for the target with a reversal control (reason
  input, POST to the reversal endpoint).
- Contentions stay byte-identical.

## Verification (whole branch, before draft is marked ready)

The rule-6 CI set, bare, in the worktree:
`pnpm db:migrate && pnpm test --run && pnpm lint && pnpm typecheck && pnpm build`.
No workflow changes → no actionlint. Docker suites run against the container
runtime on this box; a 120s closesql timeout under load is box load (rule:
re-run on the unchanged SHA before calling it a defect).

## Review, scoring, and the PR

- Per-task review: task-reviewer with a writable disposable checkout named in
  the brief; it plants and RUNS mutants in real modules (both guard and
  runtime verdicts) and reads the feedback corpus at
  `/root/daedalus-public/review-references/` (method/, claims/, contributing/
  apply to every review; append what recurred; push). Containment scoped to
  scratch/report files; the corpus is the exception.
- Final whole-branch review: code-reviewer, same corpus rules, tests
  backgrounded at review start.
- Scorer: independent agent; diff computed three-dot from the merge base,
  both SHAs fresh at brief time; inputs are the diff, the issue body, the
  labels.
- Every child commits with `Co-Authored-By: GLM-5.3-Flash <noreply@z.ai>`
  verbatim; audited with
  `git log --format='%H%x09%(trailers:key=Co-Authored-By,valueonly)' origin/main..HEAD`
  comparing values literally before any push.
- PR body: `.github/PULL_REQUEST_TEMPLATE.md`, complete from the FIRST push
  (the pr-gate auto-closes a stub and a force-push while closed is fatal —
  PM warning 2026-09-09). Design decisions carry their rejected alternatives;
  the reversal story states how a wrong adjustment is undone and by whom.
- End-game: check `gh pr view --json state,isDraft` before ANY force-push;
  label `settled:` on the ISSUE with the literal backticked label in a comment
  as the last actions before merging; nothing pushed in between; merge next.
