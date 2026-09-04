do $$
begin
  create type reconciliation_entity_kind as enum (
    'SETTLEMENT',
    'SELF_WORK_CALIBRATION',
    'UNWRITABLE_CLOSURE',
    'POLICY_VIOLATION'
  );
exception
  when duplicate_object then null;
end;
$$;

alter table reconciliation_changes
add column if not exists entity_kind reconciliation_entity_kind;

update reconciliation_changes
set entity_kind = case
  when change_kind = 'POLICY_VIOLATION' then 'POLICY_VIOLATION'::reconciliation_entity_kind
  else 'SETTLEMENT'::reconciliation_entity_kind
end
where entity_kind is null;

alter table reconciliation_changes
alter column entity_kind set not null;

alter table reconciliation_changes
add constraint reconciliation_changes_change_kind_allowed_check
check (change_kind in ('ADD', 'CHANGE', 'REMOVE', 'POLICY_VIOLATION'));

do $$
begin
  if exists (
    select 1
    from pull_request_issues as links
    join pull_requests on pull_requests.id = links.pull_request_id
    join issues on issues.id = links.issue_id
    where pull_requests.repository_id <> issues.repository_id
  ) then
    raise exception 'Cross-repository pull request issue associations must be remediated before this migration.';
  end if;
end;
$$;

alter table pull_requests
add constraint pull_requests_id_repository_unique unique (id, repository_id);

alter table pull_request_issues
add column if not exists repository_id uuid;

update pull_request_issues as links
set repository_id = pull_requests.repository_id
from pull_requests
where pull_requests.id = links.pull_request_id
  and links.repository_id is null;

alter table pull_request_issues
alter column repository_id set not null,
drop constraint if exists pull_request_issues_pull_request_id_fkey,
drop constraint if exists pull_request_issues_issue_id_fkey,
add constraint pull_request_issues_pull_request_repository_fkey
  foreign key (pull_request_id, repository_id)
  references pull_requests (id, repository_id),
add constraint pull_request_issues_issue_repository_fkey
  foreign key (issue_id, repository_id)
  references issues (id, repository_id);

alter table webhook_deliveries
add column if not exists processing_lease_token uuid,
add column if not exists lease_expires_at timestamp with time zone,
add column if not exists attempt_count integer not null default 0
check (attempt_count >= 0);

update webhook_deliveries
set processing_lease_token = coalesce(processing_lease_token, gen_random_uuid()),
    lease_expires_at = coalesce(lease_expires_at, now())
where processing_state = 'PENDING';

update webhook_deliveries
set processing_lease_token = null,
    lease_expires_at = null
where processing_state <> 'PENDING';

alter table webhook_deliveries
add constraint webhook_deliveries_processing_lease_check
check (
  (processing_state = 'PENDING' and processing_lease_token is not null and lease_expires_at is not null)
  or
  (processing_state <> 'PENDING' and processing_lease_token is null and lease_expires_at is null)
);
