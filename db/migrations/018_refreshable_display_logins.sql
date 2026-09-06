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
-- refreshed from one nonblank login to another, and keep blanking refused.
--
-- Refusing blank is the trigger's job in every spelling, because
-- `issues_opening_source_complete_check` catches only some of them: its
-- `length(trim(...)) > 0` arms use the one-argument `trim()`, which strips
-- spaces and nothing else, so a tab or a newline passes that check. The trigger
-- below tests for a non-whitespace character instead, and refuses a login that
-- becomes null or whitespace-only while opening evidence is still attached.
--
-- Both blanking arms are keyed on the transition rather than on the new value
-- alone. A row written before this migration may already hold a whitespace-only
-- login, and an arm reading only the new value would refuse every later update
-- to that row's logins — the repair among them — wedging the row for good.
-- Refusing only a nonblank-to-blank transition leaves such a row writable.
--
-- The completeness check accepts a null login while opening evidence is
-- attached: a SQL CHECK is three-valued, and with the timestamp present a null
-- login leaves that check's second arm null rather than false. The reading holds
-- only for the attached case, because the same arm's fourth conjunct
-- `opening_source_at is not null` is two-valued, so a null login alongside a
-- missing timestamp makes the arm false and the row is refused outright. The
-- gap is tracked as issue 19 and is why the trigger carries the null transition.
--
-- This replaces the body of the function behind trigger
-- `issues_opening_rating_immutable`, created in migration 007. That trigger's
-- `before update of ...` column list still lives there, unchanged, and is what
-- decides which updates reach this function at all.
create or replace function reject_opening_rating_change()
returns trigger
language plpgsql
as $$
-- A login is blanked when it stops carrying a non-whitespace character. `\S`
-- matches one, and `~` against null is null rather than false, so the null tests
-- are needed alongside the pattern rather than subsumed by it.
declare
  owner_login_blanked boolean :=
    (new.owner_github_login is null or new.owner_github_login !~ '\S')
    and old.owner_github_login is not null and old.owner_github_login ~ '\S';
  actor_login_blanked boolean :=
    (new.opening_source_actor_login is null or new.opening_source_actor_login !~ '\S')
    and old.opening_source_actor_login is not null and old.opening_source_actor_login ~ '\S';
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

  if owner_login_blanked or actor_login_blanked then
    if new.opening_source_event_id is not null
      or new.opening_source_at is not null then
      raise exception 'Issue opening rating is immutable';
    end if;
  end if;

  return new;
end;
$$;
