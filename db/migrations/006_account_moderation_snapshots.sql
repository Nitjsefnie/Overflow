alter type enforcement_state add value if not exists 'UNDER_AUDIT';
alter type enforcement_state add value if not exists 'WARNED';

alter table calibration_audits
add column if not exists prior_enforcement_state enforcement_state not null default 'ACTIVE',
add column if not exists cohort_definition jsonb not null default '{}'::jsonb,
add column if not exists cohort_statistics jsonb not null default '{}'::jsonb;

alter table calibration_audits
add constraint calibration_audits_cohort_definition_object_check
check (jsonb_typeof(cohort_definition) = 'object'),
add constraint calibration_audits_cohort_statistics_object_check
check (jsonb_typeof(cohort_statistics) = 'object');

do $$
declare
  constraint_name text;
begin
  select conname into constraint_name
  from pg_constraint
  where conrelid = 'calibration_audits'::regclass
    and contype = 'u'
    and pg_get_constraintdef(oid) = 'UNIQUE (account_id, repository_id, sample_started_at, sample_ended_at, reporter_id)';
  if constraint_name is not null then
    execute format('alter table calibration_audits drop constraint %I', constraint_name);
  end if;
end;
$$;

create unique index calibration_audits_one_open_account
on calibration_audits (account_id)
where state = 'OPEN';

alter table moderation_events
add column if not exists audit_id uuid references calibration_audits(id),
add column if not exists cohort_definition jsonb not null default '{}'::jsonb,
add column if not exists cohort_statistics jsonb not null default '{}'::jsonb,
add column if not exists recalibration_plan text;

alter table moderation_events
add constraint moderation_events_cohort_definition_object_check
check (jsonb_typeof(cohort_definition) = 'object'),
add constraint moderation_events_cohort_statistics_object_check
check (jsonb_typeof(cohort_statistics) = 'object'),
add constraint moderation_events_recalibration_plan_nonblank_check
check (recalibration_plan is null or length(trim(recalibration_plan)) > 0);

create function reject_calibration_audit_snapshot_change()
returns trigger
language plpgsql
as $$
begin
  if new.account_id is distinct from old.account_id
    or new.repository_id is distinct from old.repository_id
    or new.reporter_id is distinct from old.reporter_id
    or new.sample_started_at is distinct from old.sample_started_at
    or new.sample_ended_at is distinct from old.sample_ended_at
    or new.settled_sample_size is distinct from old.settled_sample_size
    or new.prior_enforcement_state is distinct from old.prior_enforcement_state
    or new.cohort_definition is distinct from old.cohort_definition
    or new.cohort_statistics is distinct from old.cohort_statistics then
    raise exception 'Calibration audit snapshot is immutable';
  end if;

  return new;
end;
$$;

create trigger calibration_audits_snapshot_immutable
before update of account_id, repository_id, reporter_id, sample_started_at, sample_ended_at,
  settled_sample_size, prior_enforcement_state, cohort_definition, cohort_statistics
on calibration_audits
for each row
execute function reject_calibration_audit_snapshot_change();
