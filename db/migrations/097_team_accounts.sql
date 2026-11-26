-- A team is an account of its own: its balance is the balances row keyed by
-- teams.id, never a users row. Its lead is a member from creation.
create table teams (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid not null unique references users (id),
  name text not null constraint teams_name_nonblank_check check (length(btrim(name)) > 0),
  created_at timestamp with time zone not null default now()
);

create unique index teams_name_key on teams (lower(name));

-- Membership is history: a removed account that is re-added gets a new row,
-- and the only change a row takes is setting its still-null left_at once.
-- A member at time t: joined_at <= t and (left_at is null or t < left_at).
create table team_memberships (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams (id),
  user_id uuid not null references users (id),
  joined_at timestamp with time zone not null default now(),
  left_at timestamp with time zone,
  constraint team_memberships_left_after_joined_check check (left_at is null or left_at >= joined_at)
);

create unique index team_memberships_one_open_per_account on team_memberships (user_id) where left_at is null;
create index team_memberships_team_idx on team_memberships (team_id);

create or replace function reject_team_membership_change()
returns trigger
language plpgsql
as $$
begin
  if tg_op = 'UPDATE' and old.left_at is null and new.left_at is not null
    and to_jsonb(new) - 'left_at' = to_jsonb(old) - 'left_at' then
    return new;
  end if;
  raise exception 'Team membership history is immutable';
end;
$$;

drop trigger if exists team_memberships_history on team_memberships;
create trigger team_memberships_history
before update or delete on team_memberships
for each row
execute function reject_team_membership_change();

-- A lead's move of whole points from the team's balance to a member's.
create table team_distributions (
  id uuid primary key default gen_random_uuid(),
  team_id uuid not null references teams (id),
  member_id uuid not null references users (id),
  points integer not null constraint team_distributions_points_positive_check check (points > 0),
  created_at timestamp with time zone not null default now()
);

create index team_distributions_team_idx on team_distributions (team_id, created_at);

create or replace function reject_team_distribution_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Team distribution history is immutable';
end;
$$;

drop trigger if exists team_distributions_immutable on team_distributions;
create trigger team_distributions_immutable
before update or delete on team_distributions
for each row
execute function reject_team_distribution_change();

-- creditor_id stays the pull request's author; team_id names where the credit lands.
alter table settlements
  add column team_id uuid references teams (id),
  add constraint settlements_team_requires_creditor_check check (team_id is null or creditor_id is not null);

-- Plain history like settlement_id (migration 091): no foreign key to cascade.
alter table moderation_credit_adjustment_lines add column team_id uuid;

-- Migration 090's legs with every creditor leg of a settlement (its own, a
-- moderator line's, a dispute landing reversal's) booked to the team the
-- credit landed on, plus each distribution's two legs.
create or replace view ledger_entries as
select
  settlements.id as settlement_id,
  coalesce(settlements.team_id, settlements.creditor_id) as account_id,
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
  coalesce(settlements.team_id, settlements.creditor_id) as counterparty_id,
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
  coalesce(lines.team_id, lines.creditor_id) as account_id,
  adjustments.target_account_id as counterparty_id,
  lines.amount as amount,
  adjustments.created_at
from moderation_credit_adjustment_lines as lines
join moderation_credit_adjustments as adjustments on adjustments.id = lines.adjustment_id
union all
select
  lines.settlement_id as settlement_id,
  adjustments.target_account_id as account_id,
  coalesce(lines.team_id, lines.creditor_id) as counterparty_id,
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
  (coalesce(settlements.team_id, settlements.creditor_id), settlements.debtor_id, -settlements.credits),
  (settlements.debtor_id, coalesce(settlements.team_id, settlements.creditor_id), settlements.credits)
) as legs(account_id, counterparty_id, amount)
where disputes.decision = 'GRANTED'
  and settlements.status = 'SETTLED'
  and settlements.credits > 0
  and settlements.creditor_id <> settlements.debtor_id
union all
select null, distributions.team_id, distributions.member_id, -distributions.points, distributions.created_at
from team_distributions as distributions
union all
select null, distributions.member_id, distributions.team_id, distributions.points, distributions.created_at
from team_distributions as distributions;

-- Migration 091's replay with the same team booking; a distribution moves
-- balance like a moderation event and is never completed work.
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
    (coalesce(settlements.team_id, settlements.creditor_id), settlements.credits),
    (settlements.debtor_id, -settlements.credits)
  ) as legs(account_id, amount)
  where settlements.status = 'SETTLED'
    and settlements.credits > 0
    and settlements.creditor_id <> settlements.debtor_id
  union all
  -- Moderation changes the balance a later contribution repays, but neither
  -- an adjustment nor its reversal is itself completed work. These immutable
  -- events use their creation time and UUID; they are not re-materialized.
  -- A line whose settlement is gone still counts; its null source keys only
  -- order rows within its adjustment, which no event_kind 0 sum depends on.
  select legs.account_id, legs.amount, adjustments.created_at, 1,
    adjustments.id::text, repositories.provider,
    coalesce(repositories.instance_url, ''),
    coalesce(repositories.forge_project_id, repositories.github_repository_id),
    pull_requests.pull_request_number, issues.issue_number
  from moderation_credit_adjustments as adjustments
  join moderation_credit_adjustment_lines as lines on lines.adjustment_id = adjustments.id
  left join settlements on settlements.id = lines.settlement_id
  left join pull_requests on pull_requests.id = settlements.pull_request_id
  left join issues on issues.id = settlements.issue_id
  left join registered_repositories as repositories on repositories.id = pull_requests.repository_id
  cross join lateral (values
    (coalesce(lines.team_id, lines.creditor_id), lines.amount),
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
    (coalesce(settlements.team_id, settlements.creditor_id), -settlements.credits, 'creditor'),
    (settlements.debtor_id, settlements.credits, 'debtor')
  ) as legs(account_id, amount, leg)
  where disputes.decision = 'GRANTED'
    and settlements.status = 'SETTLED'
    and settlements.credits > 0
    and settlements.creditor_id <> settlements.debtor_id
  union all
  -- A distribution has no source repository; its UUID orders it.
  select legs.account_id, legs.amount, distributions.created_at, 3,
    distributions.id::text, null, null, null, null, null
  from team_distributions as distributions
  cross join lateral (values
    (distributions.team_id, -distributions.points),
    (distributions.member_id, distributions.points)
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
