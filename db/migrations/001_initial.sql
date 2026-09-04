create extension if not exists pgcrypto;

create type user_role as enum ('MEMBER', 'MODERATOR');
create type enforcement_state as enum ('ACTIVE', 'RECALIBRATING', 'BANNED');
create type repository_visibility as enum ('PUBLIC', 'PRIVATE');
create type issue_state as enum ('OPEN', 'CLOSED');
create type pull_request_state as enum ('OPEN', 'CLOSED', 'MERGED');
create type settlement_status as enum ('SETTLED', 'UNSETTLED');
create type webhook_processing_state as enum ('PENDING', 'PROCESSED', 'FAILED');
create type reconciliation_status as enum ('PENDING', 'COMPLETED', 'FAILED');
create type calibration_audit_state as enum ('OPEN', 'DISMISSED', 'SUBSTANTIATED');

create table users (
  id uuid primary key default gen_random_uuid(),
  github_user_id bigint not null unique check (github_user_id > 0),
  github_login text not null unique check (length(trim(github_login)) > 0),
  avatar_url text,
  role user_role not null default 'MEMBER',
  enforcement_state enforcement_state not null default 'ACTIVE',
  confirmed_miscalibration_count integer not null default 0 check (confirmed_miscalibration_count >= 0),
  encrypted_oauth_token bytea,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table registered_repositories (
  id uuid primary key default gen_random_uuid(),
  github_repository_id bigint not null unique check (github_repository_id > 0),
  owner_name text not null unique check (length(trim(owner_name)) > 0),
  sponsor_id uuid not null references users(id),
  visibility repository_visibility not null,
  github_webhook_id bigint not null unique check (github_webhook_id > 0),
  active boolean not null default true,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now()
);

create table issues (
  id uuid primary key default gen_random_uuid(),
  github_issue_id bigint not null unique check (github_issue_id > 0),
  repository_id uuid not null references registered_repositories(id),
  issue_number integer not null check (issue_number > 0),
  title text not null,
  body text not null,
  url text not null,
  state issue_state not null,
  opening_label text not null check (length(trim(opening_label)) > 0),
  opening_comparison_points integer not null check (opening_comparison_points between 1 and 10),
  opening_reserve_points integer not null check (opening_reserve_points between 1 and 10),
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  unique (repository_id, issue_number)
);

create table pull_requests (
  id uuid primary key default gen_random_uuid(),
  github_pull_request_id bigint not null unique check (github_pull_request_id > 0),
  repository_id uuid not null references registered_repositories(id),
  issue_id uuid not null references issues(id),
  pull_request_number integer not null check (pull_request_number > 0),
  url text not null,
  title text not null,
  body text not null,
  author_id uuid references users(id),
  actual_label text,
  actual_points integer,
  state pull_request_state not null,
  merged_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  updated_at timestamp with time zone not null default now(),
  check (
    (actual_label is null and actual_points is null)
    or (
      actual_label is not null
      and length(trim(actual_label)) > 0
      and actual_points between 1 and 10
    )
  ),
  unique (repository_id, pull_request_number)
);

create table review_rounds (
  id uuid primary key default gen_random_uuid(),
  pull_request_id uuid not null references pull_requests(id),
  github_review_id bigint not null unique check (github_review_id > 0),
  submitted_at timestamp with time zone not null,
  created_at timestamp with time zone not null default now(),
  unique (pull_request_id, github_review_id)
);

create table settlements (
  id uuid primary key default gen_random_uuid(),
  pull_request_id uuid not null unique references pull_requests(id),
  issue_id uuid not null references issues(id),
  creditor_id uuid not null references users(id),
  debtor_id uuid not null references users(id),
  opening_comparison_points integer not null check (opening_comparison_points between 1 and 10),
  settled_points integer,
  review_rounds integer not null check (review_rounds >= 0),
  credits integer not null check (credits >= 0),
  proof_sha256 text not null unique check (proof_sha256 ~ '^[0-9a-f]{64}$'),
  status settlement_status not null,
  created_at timestamp with time zone not null default now(),
  check (
    (status = 'SETTLED' and settled_points between 1 and 10)
    or (status = 'UNSETTLED' and settled_points is null and credits = 0)
  ),
  check (
    status <> 'SETTLED'
    or credits = greatest(0, settled_points - review_rounds)
  )
);

create table self_work_calibrations (
  id uuid primary key default gen_random_uuid(),
  pull_request_id uuid not null unique references pull_requests(id),
  issue_id uuid not null references issues(id),
  user_id uuid not null references users(id),
  opening_comparison_points integer not null check (opening_comparison_points between 1 and 10),
  actual_points integer check (actual_points between 1 and 10),
  created_at timestamp with time zone not null default now()
);

create table unwritable_closures (
  id uuid primary key default gen_random_uuid(),
  pull_request_id uuid not null unique references pull_requests(id),
  reason text not null check (length(trim(reason)) > 0),
  created_at timestamp with time zone not null default now()
);

create table webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  github_delivery_id text not null unique check (length(trim(github_delivery_id)) > 0),
  event_name text not null check (length(trim(event_name)) > 0),
  processing_state webhook_processing_state not null default 'PENDING',
  error_message text,
  received_at timestamp with time zone not null default now(),
  processed_at timestamp with time zone
);

create table reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  requested_by_user_id uuid references users(id),
  status reconciliation_status not null default 'PENDING',
  started_at timestamp with time zone not null default now(),
  completed_at timestamp with time zone,
  error_message text
);

create table reconciliation_changes (
  id uuid primary key default gen_random_uuid(),
  reconciliation_run_id uuid not null references reconciliation_runs(id),
  pull_request_id uuid references pull_requests(id),
  change_kind text not null check (length(trim(change_kind)) > 0),
  before_state jsonb,
  after_state jsonb,
  created_at timestamp with time zone not null default now()
);

create table calibration_audits (
  id uuid primary key default gen_random_uuid(),
  settlement_id uuid not null references settlements(id),
  reporter_id uuid not null references users(id),
  moderator_id uuid references users(id),
  state calibration_audit_state not null default 'OPEN',
  rationale text not null check (length(trim(rationale)) > 0),
  decision text,
  corrected_points integer check (corrected_points between 1 and 10),
  opened_at timestamp with time zone not null default now(),
  decided_at timestamp with time zone,
  unique (settlement_id, reporter_id)
);

create table moderation_events (
  id uuid primary key default gen_random_uuid(),
  target_user_id uuid not null references users(id),
  actor_id uuid not null references users(id),
  prior_state enforcement_state not null,
  new_state enforcement_state not null,
  reason text not null check (length(trim(reason)) > 0),
  created_at timestamp with time zone not null default now()
);

create function reject_opening_rating_change()
returns trigger
language plpgsql
as $$
begin
  if new.opening_label is distinct from old.opening_label
    or new.opening_comparison_points is distinct from old.opening_comparison_points
    or new.opening_reserve_points is distinct from old.opening_reserve_points then
    raise exception 'Issue opening rating is immutable';
  end if;

  return new;
end;
$$;

create trigger issues_opening_rating_immutable
before update of opening_label, opening_comparison_points, opening_reserve_points on issues
for each row
execute function reject_opening_rating_change();

create view ledger_entries as
select
  settlements.id as settlement_id,
  settlements.creditor_id as account_id,
  settlements.debtor_id as counterparty_id,
  settlements.credits as amount,
  settlements.created_at
from settlements
where settlements.status = 'SETTLED' and settlements.credits > 0
union all
select
  settlements.id as settlement_id,
  settlements.debtor_id as account_id,
  settlements.creditor_id as counterparty_id,
  -settlements.credits as amount,
  settlements.created_at
from settlements
where settlements.status = 'SETTLED' and settlements.credits > 0;

create view balances as
select
  account_id,
  sum(amount)::integer as balance
from ledger_entries
group by account_id;

create view calibration_statistics as
select
  issues.repository_id,
  count(settlements.id)::integer as settlement_count,
  coalesce(avg(settlements.settled_points - settlements.opening_comparison_points), 0) as average_points_delta
from issues
left join settlements on settlements.issue_id = issues.id
group by issues.repository_id;
