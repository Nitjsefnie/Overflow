-- The moderation credit adjustment (issue 330): when a recalibration audit finds a
-- sponsor's settled sample underdelivering its openings, a moderator may adjust the
-- sponsor's credit balance to match what the opened work should have earned, paid to
-- the creditors of the compensated settlements.
--
-- An adjustment and its reversal are BOTH rows with state 'APPLIED'; a row with a
-- non-null reversal_of IS the reversal, and its lines carry the negative of the
-- original's per-line amounts. Nothing ever mutates or deletes these rows: the pair
-- of rows cancels in every derived view, so append-only survives. A 'REVERSED' state
-- on the original would require an UPDATE, which is exactly what this shape avoids.
--
-- Two partial unique indexes keep one adjustment outcome per audit: at most one
-- non-reversal adjustment per calibration audit (the reversal rows are excluded from
-- that index, so they do not collide with the original), and at most one reversal
-- per original adjustment.
create type adjustment_state as enum ('APPLIED', 'REVERSED');

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

create table moderation_credit_adjustment_lines (
  adjustment_id uuid not null references moderation_credit_adjustments(id),
  settlement_id uuid not null references settlements(id),
  creditor_id uuid not null references users(id),
  amount integer not null check (amount <> 0),
  primary key (adjustment_id, settlement_id)
);

create unique index one_adjustment_per_audit
  on moderation_credit_adjustments (calibration_audit_id)
  where reversal_of is null;

create unique index one_reversal_per_adjustment
  on moderation_credit_adjustments (reversal_of)
  where reversal_of is not null;

-- The ledger extends with two legs per adjustment line: the creditor is credited at
-- the adjustment's creation moment against the compensated settlement's provenance,
-- and the target (sponsor) account is debited symmetrically. Reversal lines carry
-- negative amounts and flow through the same legs unchanged.
create or replace view ledger_entries as
select
  settlements.id as settlement_id,
  settlements.creditor_id as account_id,
  settlements.debtor_id as counterparty_id,
  settlements.credits as amount,
  settlements.created_at
from settlements
where
  settlements.status = 'SETTLED'
  and settlements.credits > 0
  and settlements.creditor_id <> settlements.debtor_id
union all
select
  settlements.id as settlement_id,
  settlements.debtor_id as account_id,
  settlements.creditor_id as counterparty_id,
  -settlements.credits as amount,
  settlements.created_at
from settlements
where
  settlements.status = 'SETTLED'
  and settlements.credits > 0
  and settlements.creditor_id <> settlements.debtor_id
union all
select
  lines.settlement_id as settlement_id,
  lines.creditor_id as account_id,
  adjustments.target_account_id as counterparty_id,
  lines.amount as amount,
  adjustments.created_at
from moderation_credit_adjustment_lines as lines
join moderation_credit_adjustments as adjustments on adjustments.id = lines.adjustment_id
union all
select
  lines.settlement_id as settlement_id,
  adjustments.target_account_id as account_id,
  lines.creditor_id as counterparty_id,
  -lines.amount as amount,
  adjustments.created_at
from moderation_credit_adjustment_lines as lines
join moderation_credit_adjustments as adjustments on adjustments.id = lines.adjustment_id;
