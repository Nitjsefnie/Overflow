alter table issues
add column if not exists owner_github_login text,
add column if not exists opening_source_event_id text,
add column if not exists opening_source_actor_login text,
add column if not exists opening_source_at timestamp with time zone,
add column if not exists settled_label text,
add column if not exists settled_points integer,
add column if not exists settled_label_event_id text,
add column if not exists settled_label_actor_login text,
add column if not exists settled_label_applied_at timestamp with time zone,
add column if not exists settled_rationale_comment_id text,
add column if not exists settled_rationale_actor_login text,
add column if not exists settled_rationale_commented_at timestamp with time zone;

alter table issues
add constraint issues_opening_source_complete_check check (
  (
    owner_github_login is null
    and opening_source_event_id is null
    and opening_source_actor_login is null
    and opening_source_at is null
  )
  or (
    length(trim(owner_github_login)) > 0
    and length(trim(opening_source_event_id)) > 0
    and length(trim(opening_source_actor_login)) > 0
    and opening_source_at is not null
  )
),
add constraint issues_settled_evidence_complete_check check (
  (
    settled_label is null
    and settled_points is null
    and settled_label_event_id is null
    and settled_label_actor_login is null
    and settled_label_applied_at is null
    and settled_rationale_comment_id is null
    and settled_rationale_actor_login is null
    and settled_rationale_commented_at is null
  )
  or (
    length(trim(settled_label)) > 0
    and settled_points between 1 and 10
    and length(trim(settled_label_event_id)) > 0
    and length(trim(settled_label_actor_login)) > 0
    and settled_label_applied_at is not null
    and length(trim(settled_rationale_comment_id)) > 0
    and length(trim(settled_rationale_actor_login)) > 0
    and settled_rationale_commented_at is not null
    and settled_label_applied_at <= settled_rationale_commented_at
  )
);

create or replace function reject_opening_rating_change()
returns trigger
language plpgsql
as $$
begin
  if new.opening_label is distinct from old.opening_label
    or new.opening_comparison_points is distinct from old.opening_comparison_points
    or new.opening_reserve_points is distinct from old.opening_reserve_points then
    if old.opening_source_event_id is not null
      or new.owner_github_login is null
      or new.opening_source_event_id is null
      or new.opening_source_actor_login is null
      or new.opening_source_at is null then
      raise exception 'Issue opening rating is immutable';
    end if;
  end if;

  if new.owner_github_login is distinct from old.owner_github_login
    or new.opening_source_event_id is distinct from old.opening_source_event_id
    or new.opening_source_actor_login is distinct from old.opening_source_actor_login
    or new.opening_source_at is distinct from old.opening_source_at then
    if old.owner_github_login is not null
      or old.opening_source_event_id is not null
      or old.opening_source_actor_login is not null
      or old.opening_source_at is not null then
      raise exception 'Issue opening rating is immutable';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists issues_opening_rating_immutable on issues;
create trigger issues_opening_rating_immutable
before update of opening_label, opening_comparison_points, opening_reserve_points,
  owner_github_login, opening_source_event_id, opening_source_actor_login, opening_source_at
on issues
for each row
execute function reject_opening_rating_change();

alter table pull_requests
add column if not exists merge_commit_oid text,
add column if not exists final_commit_at timestamp with time zone;

-- Legacy PR labels were never authoritative settlement input. Retain settled
-- amounts on derived rows, but require future pricing proof to come from issues.
alter table pull_requests
drop column if exists actual_label,
drop column if exists actual_points;

alter table pull_requests
add constraint pull_requests_merge_commit_oid_check
check (merge_commit_oid is null or merge_commit_oid ~ '^[0-9a-f]{40}$');

create or replace function enforcement_state_at(
  target_user uuid,
  event_time timestamp with time zone
)
returns enforcement_state
language sql
stable
as $$
  select coalesce(
    (
      select events.new_state
      from moderation_events as events
      where events.target_user_id = target_user
        and events.created_at <= event_time
      order by events.created_at desc, events.id desc
      limit 1
    ),
    (
      select events.prior_state
      from moderation_events as events
      where events.target_user_id = target_user
        and events.created_at > event_time
      order by events.created_at asc, events.id asc
      limit 1
    ),
    (
      select users.enforcement_state
      from users
      where users.id = target_user
    )
  )
$$;

create or replace function participation_eligible_at(
  target_user uuid,
  event_time timestamp with time zone
)
returns boolean
language sql
stable
as $$
  select enforcement_state_at(target_user, event_time) in ('ACTIVE', 'WARNED', 'UNDER_AUDIT')
$$;

create or replace function reject_moderation_event_change()
returns trigger
language plpgsql
as $$
begin
  raise exception 'Moderation event history is immutable';
end;
$$;

drop trigger if exists moderation_events_immutable on moderation_events;
create trigger moderation_events_immutable
before update or delete on moderation_events
for each row
execute function reject_moderation_event_change();
