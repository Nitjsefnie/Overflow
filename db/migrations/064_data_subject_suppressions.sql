-- Unreleased 064: a forge person is namespaced by normalized HTTPS origin.
-- All verified aliases survive repeat removals; login is the representative display copy.
create table data_subject_suppressions (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('github', 'gitlab')),
  instance_url text not null check (instance_url ~ '^https://[^/?#]+$' and instance_url = lower(instance_url)),
  forge_id bigint not null check (forge_id > 0),
  login text check (login is null or length(trim(login)) > 0),
  logins text[] not null default '{}' check (array_position(logins, null) is null),
  decided_at timestamp with time zone not null default now(),
  unique (provider, instance_url, forge_id)
);
