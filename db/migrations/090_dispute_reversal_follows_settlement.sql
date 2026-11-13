-- A granted dispute reverses its landing settlement for as long as that settlement pays its
-- author, whatever its status at grant time. The reversal mirrors the settlement credit legs
-- under the same predicate, stamped at the grant; stored reversal lines are inert history.
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
where lines.settlement_id is null
union all
select
  lines.settlement_id as settlement_id,
  adjustments.target_account_id as account_id,
  lines.creditor_id as counterparty_id,
  -lines.amount as amount,
  adjustments.created_at
from dispute_credit_adjustment_lines as lines
join dispute_credit_adjustments as adjustments on adjustments.id = lines.adjustment_id
where lines.settlement_id is null
union all
select
  settlements.id as settlement_id,
  legs.account_id,
  legs.counterparty_id,
  legs.amount,
  disputes.decided_at as created_at
from closed_pr_dispute_requests as disputes
join settlements on settlements.pull_request_id = disputes.landed_pull_request_id
  and settlements.issue_id = disputes.issue_id
cross join lateral (values
  (settlements.creditor_id, settlements.debtor_id, -settlements.credits),
  (settlements.debtor_id, settlements.creditor_id, settlements.credits)
) as legs(account_id, counterparty_id, amount)
where disputes.decision = 'GRANTED'
  and settlements.status = 'SETTLED'
  and settlements.credits > 0
  and settlements.creditor_id <> settlements.debtor_id;

create or replace view account_credit_limits as
with credit_events as (
  select
    legs.account_id,
    legs.amount,
    pull_requests.merged_at as occurred_at,
    0 as event_kind,
    ''::text as adjustment_key,
    repositories.provider,
    coalesce(repositories.instance_url, '') as instance_url,
    coalesce(repositories.forge_project_id, repositories.github_repository_id) as repository_key,
    pull_requests.pull_request_number,
    issues.issue_number
  from settlements
  join pull_requests on pull_requests.id = settlements.pull_request_id
  join issues on issues.id = settlements.issue_id
  join registered_repositories as repositories on repositories.id = pull_requests.repository_id
  cross join lateral (values
    (settlements.creditor_id, settlements.credits),
    (settlements.debtor_id, -settlements.credits)
  ) as legs(account_id, amount)
  where settlements.status = 'SETTLED'
    and settlements.credits > 0
    and settlements.creditor_id <> settlements.debtor_id
  union all
  -- Moderation changes the balance a later contribution repays, but neither
  -- an adjustment nor its reversal is itself completed work. These immutable
  -- events use their creation time and UUID; they are not re-materialized.
  select legs.account_id, legs.amount, adjustments.created_at, 1,
    adjustments.id::text, repositories.provider,
    coalesce(repositories.instance_url, ''),
    coalesce(repositories.forge_project_id, repositories.github_repository_id),
    pull_requests.pull_request_number, issues.issue_number
  from moderation_credit_adjustments as adjustments
  join moderation_credit_adjustment_lines as lines on lines.adjustment_id = adjustments.id
  join settlements on settlements.id = lines.settlement_id
  join pull_requests on pull_requests.id = settlements.pull_request_id
  join issues on issues.id = settlements.issue_id
  join registered_repositories as repositories on repositories.id = pull_requests.repository_id
  cross join lateral (values
    (lines.creditor_id, lines.amount),
    (adjustments.target_account_id, -lines.amount)
  ) as legs(account_id, amount)
  union all
  -- Dispute awards and landing reversals affect debt, but never count as completed work.
  select legs.account_id, legs.amount, adjustments.created_at, 2,
    adjustments.id::text || ':' || lines.id::text || ':' || legs.leg,
    repositories.provider, coalesce(repositories.instance_url, ''),
    coalesce(repositories.forge_project_id, repositories.github_repository_id),
    pull_requests.pull_request_number, issues.issue_number
  from dispute_credit_adjustments as adjustments
  join dispute_credit_adjustment_lines as lines on lines.adjustment_id = adjustments.id
  join closed_pr_dispute_requests as disputes on disputes.id = adjustments.dispute_id
  join pull_requests on pull_requests.id = disputes.pull_request_id
  join issues on issues.id = disputes.issue_id
  join registered_repositories as repositories on repositories.id = pull_requests.repository_id
  cross join lateral (values
    (lines.creditor_id, lines.amount, 'creditor'),
    (adjustments.target_account_id, -lines.amount, 'target')
  ) as legs(account_id, amount, leg)
  where lines.settlement_id is null
  union all
  select legs.account_id, legs.amount, disputes.decided_at, 2,
    disputes.id::text || ':reversal:' || legs.leg,
    repositories.provider, coalesce(repositories.instance_url, ''),
    coalesce(repositories.forge_project_id, repositories.github_repository_id),
    pull_requests.pull_request_number, issues.issue_number
  from closed_pr_dispute_requests as disputes
  join settlements on settlements.pull_request_id = disputes.landed_pull_request_id
    and settlements.issue_id = disputes.issue_id
  join pull_requests on pull_requests.id = disputes.pull_request_id
  join issues on issues.id = disputes.issue_id
  join registered_repositories as repositories on repositories.id = pull_requests.repository_id
  cross join lateral (values
    (settlements.creditor_id, -settlements.credits, 'creditor'),
    (settlements.debtor_id, settlements.credits, 'debtor')
  ) as legs(account_id, amount, leg)
  where disputes.decision = 'GRANTED'
    and settlements.status = 'SETTLED'
    and settlements.credits > 0
    and settlements.creditor_id <> settlements.debtor_id
), running_balances as (
  select *, coalesce(sum(amount) over (
    partition by account_id
    order by occurred_at nulls first, event_kind, adjustment_key,
      provider, instance_url, repository_key, pull_request_number, issue_number
    rows between unbounded preceding and 1 preceding
  ), 0) as balance_before
  from credit_events
), repayments as (
  select account_id,
    sum(case when event_kind = 0
      then least(greatest(amount, 0), greatest(-balance_before, 0))
      else 0 end) as repaid_debt
  from running_balances
  group by account_id
)
select account_id, repaid_debt, 10 + floor(repaid_debt / 10) as credit_limit
from repayments;
