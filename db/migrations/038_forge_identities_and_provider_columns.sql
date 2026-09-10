-- Issue 296 step 2, part 1: the forge-identity shape the settlement ledger
-- will consume for GitLab sources. Deliberately additive and inert: production
-- applies this migration and nothing reads the new shape until the
-- implementation PR lands, so GitHub rows keep their exact current behavior —
-- defaulted to 'github' where a provider column is not null, NULL where it is
-- nullable (the canonical github.com namespace needs no instance URL).
--
-- user_forge_identities links one Overflow user to one forge identity per
-- (provider, instance_url, forge_user_id) triple: gitlab.com and a self-hosted
-- instance are distinct namespaces, so the same numeric forge user under both
-- is two identities. forge_user_id is the forge's numeric id, never the login;
-- forge_login is display and diagnostics only, never a key. encrypted_token
-- matches users.encrypted_oauth_token's type. instance_url is stored
-- normalized (lowercase host with scheme, no path, no trailing slash); the
-- CHECK is a typo guard on that shape, not full URL validation. verified_at
-- is stamped at link time and re-stamped at re-verification. A provider CHECK
-- (house style) admits only what the flow can verify today; a future provider
-- arrives by migration, extending the accepted set.
create table user_forge_identities (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  provider text not null check (provider in ('gitlab')),
  instance_url text not null check (instance_url ~* '^https?://[^/]+$'),
  forge_user_id bigint not null check (forge_user_id > 0),
  forge_login text not null check (length(trim(forge_login)) > 0),
  encrypted_token bytea not null,
  verified_at timestamp with time zone not null default now(),
  created_at timestamp with time zone not null default now(),
  unique (provider, instance_url, forge_user_id)
);

-- The forge triples live only on non-GitHub rows: the partial unique index
-- excludes provider = 'github', whose NULL forge columns would otherwise
-- collapse every GitHub row into one index entry. The existing owner_name
-- unique constraint and every existing index are untouched.
alter table registered_repositories
  add column provider text not null default 'github',
  add column instance_url text,
  add column forge_project_id bigint;

create unique index registered_repositories_forge_identity_unique
  on registered_repositories (provider, instance_url, forge_project_id)
  where provider <> 'github';

alter table settlements
  add column provider text not null default 'github',
  add column instance_url text;
