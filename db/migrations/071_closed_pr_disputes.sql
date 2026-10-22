-- A contributor may dispute a closed PR when its contribution landed elsewhere.
-- As with sanction contests (061), only one request per PR may remain OPEN.
create table closed_pr_dispute_requests (
  id uuid primary key default gen_random_uuid(),
  contributor_id uuid not null references users (id),
  pull_request_id uuid not null references pull_requests (id),
  issue_id uuid not null references issues (id),
  landed_pull_request_id uuid references pull_requests (id),
  landed_commit_url text
    constraint closed_pr_dispute_requests_landed_commit_url_nonblank_check
      check (landed_commit_url is null or length(btrim(landed_commit_url)) > 0),
  request_reason text not null
    constraint closed_pr_dispute_requests_request_reason_nonblank_check
      check (length(btrim(request_reason)) > 0)
    constraint closed_pr_dispute_requests_request_reason_length_check
      check (char_length(request_reason) <= 2000),
  state text not null default 'OPEN'
    constraint closed_pr_dispute_requests_state_allowed_check
      check (state in ('OPEN', 'DECIDED')),
  decision text
    constraint closed_pr_dispute_requests_decision_allowed_check
      check (decision is null or decision in ('GRANTED', 'DENIED')),
  decided_by uuid references users (id),
  decided_by_sole_moderator boolean not null default false,
  decided_reason text
    constraint closed_pr_dispute_requests_decided_reason_nonblank_check
      check (decided_reason is null or length(btrim(decided_reason)) > 0)
    constraint closed_pr_dispute_requests_decided_reason_length_check
      check (char_length(decided_reason) <= 2000),
  decided_at timestamp with time zone,
  moderator_figure integer
    constraint closed_pr_dispute_requests_moderator_figure_range_check
      check (moderator_figure between 1 and 10),
  awarded_points integer
    constraint closed_pr_dispute_requests_awarded_points_nonnegative_check
      check (awarded_points >= 0),
  created_at timestamp with time zone not null default now(),
  constraint closed_pr_dispute_requests_landed_evidence_check check (
    (landed_pull_request_id is not null and landed_commit_url is null)
    or (landed_pull_request_id is null and landed_commit_url is not null)
  ),
  constraint closed_pr_dispute_requests_decision_complete_check check (
    (
      state = 'OPEN'
      and decision is null
      and decided_by is null
      and decided_by_sole_moderator = false
      and decided_reason is null
      and decided_at is null
      and moderator_figure is null
      and awarded_points is null
    )
    or (
      state = 'DECIDED'
      and decision is not null
      and decided_by is not null
      and decided_reason is not null
      and decided_at is not null
      and (
        (decision = 'GRANTED' and moderator_figure is not null and awarded_points is not null)
        or (decision = 'DENIED' and moderator_figure is null and awarded_points is null)
      )
    )
  )
);

create unique index closed_pr_dispute_requests_one_open_per_pull_request
  on closed_pr_dispute_requests (pull_request_id)
  where state = 'OPEN';

-- Each row is one grant's adjustment. Its positive award and negative landing
-- reversal share this row; there is no separate reversal adjustment or state.
create table dispute_credit_adjustments (
  id uuid primary key default gen_random_uuid(),
  moderation_event_id uuid not null references moderation_events (id),
  dispute_id uuid not null references closed_pr_dispute_requests (id),
  target_account_id uuid not null references users (id),
  reason text not null check (length(btrim(reason)) > 0),
  created_at timestamp with time zone not null default now()
);

-- Every adjustment is a grant row, so the uniqueness covers the whole table.
create unique index one_adjustment_per_dispute
  on dispute_credit_adjustments (dispute_id);

create table dispute_credit_adjustment_lines (
  id uuid primary key default gen_random_uuid(),
  adjustment_id uuid not null references dispute_credit_adjustments (id),
  settlement_id uuid references settlements (id),
  creditor_id uuid not null references users (id),
  amount integer not null check (amount <> 0)
);

-- Preserve 035's legs and add the same symmetric pair for each dispute line.
-- Award lines have no settlement; negative reversal amounts flow unchanged.
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
join moderation_credit_adjustments as adjustments on adjustments.id = lines.adjustment_id
union all
select
  lines.settlement_id as settlement_id,
  lines.creditor_id as account_id,
  adjustments.target_account_id as counterparty_id,
  lines.amount as amount,
  adjustments.created_at
from dispute_credit_adjustment_lines as lines
join dispute_credit_adjustments as adjustments on adjustments.id = lines.adjustment_id
union all
select
  lines.settlement_id as settlement_id,
  adjustments.target_account_id as account_id,
  lines.creditor_id as counterparty_id,
  -lines.amount as amount,
  adjustments.created_at
from dispute_credit_adjustment_lines as lines
join dispute_credit_adjustments as adjustments on adjustments.id = lines.adjustment_id;

-- Moderation history is immutable (007). As in 061, use no ON DELETE action:
-- SET NULL would update an event and violate its immutability trigger.
alter table moderation_events
  add column dispute_request_id uuid references closed_pr_dispute_requests (id);
