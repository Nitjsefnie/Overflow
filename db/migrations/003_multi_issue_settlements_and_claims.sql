alter type settlement_status add value if not exists 'UNCLAIMED';

alter table reconciliation_runs
add column if not exists repository_id uuid references registered_repositories(id);

alter table issues
add column if not exists claim_assignee_github_login text;

alter table pull_requests
alter column issue_id drop not null;

alter table pull_requests
add column if not exists author_github_login text,
add column if not exists proof_sha256 text check (proof_sha256 is null or proof_sha256 ~ '^[0-9a-f]{64}$');

create table if not exists pull_request_issues (
  pull_request_id uuid not null references pull_requests(id),
  issue_id uuid not null references issues(id),
  created_at timestamp with time zone not null default now(),
  primary key (pull_request_id, issue_id)
);

insert into pull_request_issues (pull_request_id, issue_id)
select id, issue_id
from pull_requests
where issue_id is not null
on conflict do nothing;

do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'settlements'::regclass
    and contype = 'f'
    and pg_get_constraintdef(oid) like 'FOREIGN KEY (pull_request_id, issue_id)%';
  if constraint_name is not null then
    execute format('alter table settlements drop constraint %I', constraint_name);
  end if;

  select conname into constraint_name
  from pg_constraint
  where conrelid = 'self_work_calibrations'::regclass
    and contype = 'f'
    and pg_get_constraintdef(oid) like 'FOREIGN KEY (pull_request_id, issue_id)%';
  if constraint_name is not null then
    execute format('alter table self_work_calibrations drop constraint %I', constraint_name);
  end if;
end;
$$;

alter table settlements
drop constraint if exists settlements_pull_request_id_key,
drop constraint if exists settlements_proof_sha256_key,
drop constraint if exists settlements_check,
drop constraint if exists settlements_check1;

alter table settlements
alter column creditor_id drop not null,
add column if not exists creditor_github_login text;

alter table settlements
add constraint settlements_pull_request_issue_unique unique (pull_request_id, issue_id),
add constraint settlements_issue_unique unique (issue_id),
add constraint settlements_pull_request_issue_fkey
  foreign key (pull_request_id, issue_id) references pull_request_issues(pull_request_id, issue_id),
add constraint settlements_materialized_status_check check (
  (
    status = 'SETTLED'
    and creditor_id is not null
    and settled_points is not null
    and settled_points between 1 and 10
    and credits = greatest(0, settled_points - review_rounds)
  )
  or (
    status = 'UNCLAIMED'
    and creditor_id is null
    and creditor_github_login is not null
    and length(trim(creditor_github_login)) > 0
    and settled_points is not null
    and settled_points between 1 and 10
    and credits = greatest(0, settled_points - review_rounds)
  )
  or (
    status = 'UNSETTLED'
    and settled_points is null
    and credits = 0
  )
);

alter table self_work_calibrations
drop constraint if exists self_work_calibrations_pull_request_id_key,
add constraint self_work_calibrations_pull_request_issue_unique unique (pull_request_id, issue_id),
add constraint self_work_calibrations_pull_request_issue_fkey
  foreign key (pull_request_id, issue_id) references pull_request_issues(pull_request_id, issue_id);

alter table unwritable_closures
add column if not exists issue_id uuid references issues(id);

update unwritable_closures
set issue_id = pull_requests.issue_id
from pull_requests
where pull_requests.id = unwritable_closures.pull_request_id
  and unwritable_closures.issue_id is null;

alter table unwritable_closures
alter column pull_request_id drop not null,
alter column issue_id set not null,
drop constraint if exists unwritable_closures_pull_request_id_key,
add constraint unwritable_closures_issue_unique unique (issue_id);
