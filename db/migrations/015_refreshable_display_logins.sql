-- The immutable opening proof is the event, not the name. A GitHub
-- `LabeledEvent` node id names one event whose actor account cannot change, and
-- an issue's author cannot change either, so `opening_source_event_id` and
-- `opening_source_at` are the proof and stay frozen once attached.
--
-- `owner_github_login` and `opening_source_actor_login` are display text, as
-- migration 013 already states for the other login columns: GitHub logins are
-- mutable and reusable. Freezing them alongside the proof made every
-- reconciliation after an account rename fail, because GitHub then reports the
-- new login against the same unchanged opening event. Let the display text be
-- refreshed. `issues_opening_source_complete_check` still forbids blanking a
-- login while opening evidence remains attached.

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

  if new.opening_source_event_id is distinct from old.opening_source_event_id
    or new.opening_source_at is distinct from old.opening_source_at then
    if old.opening_source_event_id is not null
      or old.opening_source_at is not null then
      raise exception 'Issue opening rating is immutable';
    end if;
  end if;

  return new;
end;
$$;
