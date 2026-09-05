create function is_valid_repository_difficulty_scheme(scheme jsonb)
returns boolean
language plpgsql
immutable
as $$
declare
  opening_label jsonb;
  actual_label jsonb;
  label_text text;
  actual_point integer;
  labels text[] := array[]::text[];
  actual_points boolean[] := array_fill(false, array[10]);
begin
  if jsonb_typeof(scheme) is distinct from 'object' then
    return false;
  end if;

  if jsonb_typeof(scheme -> 'openingName') is distinct from 'string'
    or length(btrim(scheme ->> 'openingName')) = 0 then
    return false;
  end if;

  if jsonb_typeof(scheme -> 'actualName') is distinct from 'string'
    or length(btrim(scheme ->> 'actualName')) = 0 then
    return false;
  end if;

  if jsonb_typeof(scheme -> 'openingLabels') is distinct from 'array' then
    return false;
  end if;

  if jsonb_array_length(scheme -> 'openingLabels') = 0 then
    return false;
  end if;

  if jsonb_typeof(scheme -> 'actualLabels') is distinct from 'array' then
    return false;
  end if;

  if jsonb_array_length(scheme -> 'actualLabels') = 0 then
    return false;
  end if;

  for opening_label in select value from jsonb_array_elements(scheme -> 'openingLabels') loop
    if jsonb_typeof(opening_label) is distinct from 'object'
      or jsonb_typeof(opening_label -> 'label') is distinct from 'string'
      or length(btrim(opening_label ->> 'label')) = 0
      or jsonb_typeof(opening_label -> 'comparisonPoints') is distinct from 'number'
      or jsonb_typeof(opening_label -> 'reservePoints') is distinct from 'number' then
      return false;
    end if;

    if (opening_label ->> 'comparisonPoints') !~ '^(?:[1-9]|10)$'
      or (opening_label ->> 'reservePoints') !~ '^(?:[1-9]|10)$' then
      return false;
    end if;

    label_text := opening_label ->> 'label';
    if label_text = any(labels) then
      return false;
    end if;
    labels := array_append(labels, label_text);
  end loop;

  for actual_label in select value from jsonb_array_elements(scheme -> 'actualLabels') loop
    if jsonb_typeof(actual_label) is distinct from 'object'
      or jsonb_typeof(actual_label -> 'label') is distinct from 'string'
      or length(btrim(actual_label ->> 'label')) = 0
      or jsonb_typeof(actual_label -> 'points') is distinct from 'number' then
      return false;
    end if;

    if (actual_label ->> 'points') !~ '^(?:[1-9]|10)$' then
      return false;
    end if;

    label_text := actual_label ->> 'label';
    if label_text = any(labels) then
      return false;
    end if;
    labels := array_append(labels, label_text);

    actual_point := (actual_label ->> 'points')::integer;
    if actual_points[actual_point] then
      return false;
    end if;
    actual_points[actual_point] := true;
  end loop;

  for actual_point in 1..10 loop
    if not actual_points[actual_point] then
      return false;
    end if;
  end loop;

  return true;
end;
$$;

-- Overflow prices work from a repository's difficulty scheme and registration in
-- src/lib/repositories/register.ts requires the sponsor to supply one, so there is no
-- defensible default to backfill: a fabricated scheme would misprice legacy work.
-- Repositories registered before this migration must be given a scheme by hand, or be
-- removed, before upgrading.
do $$
declare
  affected_count bigint;
  affected_owner_names text;
begin
  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'registered_repositories'
      and column_name = 'difficulty_scheme'
  ) then
    select count(*), (
      select string_agg(sample.owner_name, ', ' order by sample.owner_name)
      from (select owner_name from registered_repositories order by owner_name limit 5) as sample
    )
    into affected_count, affected_owner_names
    from registered_repositories;

    if affected_count > 0 then
      raise exception 'Repository difficulty scheme precondition failed: % repository(ies) predate the difficulty scheme. Repositories: %. Give each repository a difficulty scheme by adding the difficulty_scheme column and backfilling it by hand, or remove the legacy repositories, before upgrading.',
        affected_count, affected_owner_names;
    end if;
  end if;
end;
$$;

-- Split so the by-hand recovery above reaches a schema identical to a fresh install:
-- a single `add column if not exists ... not null check (...)` is skipped whole when the
-- column is already present, silently dropping the validity check.
alter table registered_repositories
add column if not exists difficulty_scheme jsonb;

alter table registered_repositories
alter column difficulty_scheme set not null;

alter table registered_repositories
add constraint registered_repositories_difficulty_scheme_check
check (is_valid_repository_difficulty_scheme(difficulty_scheme));
