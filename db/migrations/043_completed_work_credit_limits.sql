-- Replay effective settlements, not materialization writes: corrections replace
-- historical amounts and a full re-derivation must produce the same limit.
-- Merge time orders completed work. Immutable forge/repository/PR/issue keys
-- break ties without depending on settlement UUIDs, insertion order or logins.
-- Legacy rows without merge provenance precede dated work in that stable order.
create view account_credit_limits as
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
