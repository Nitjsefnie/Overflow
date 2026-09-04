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

alter table registered_repositories
add column difficulty_scheme jsonb not null
check (is_valid_repository_difficulty_scheme(difficulty_scheme));
