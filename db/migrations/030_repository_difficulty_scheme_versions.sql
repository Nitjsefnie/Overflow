-- Issue 180: a repository's difficulty catalog becomes a version series. The
-- current catalog stays in registered_repositories.difficulty_scheme for every
-- existing reader, and this table holds the version each catalog begins
-- governing at. An edit is an append here, never a destructive rewrite, so a
-- closure resolves against the version whose window contains the instant its
-- evidence window closed and an already-settled figure keeps its price.
--
-- Keyed on the numeric GitHub repository id: the identity a rename cannot move
-- is what every cross-check in this repository aims by.
create table repository_difficulty_scheme_versions (
  github_repository_id bigint not null references registered_repositories(github_repository_id),
  version_number integer not null check (version_number > 0),
  scheme jsonb not null check (is_valid_repository_difficulty_scheme(scheme)),
  effective_from timestamp with time zone not null,
  primary key (github_repository_id, version_number)
);

-- One version per existing repository, numbered from one: the catalog a
-- repository was registered with has governed its work since registration, so
-- registration time is the instant the backfilled version begins governing.
-- `is_valid_repository_difficulty_scheme` (migration 002) and migration 002's
-- own precondition already guarantee every current scheme is present and valid.
insert into repository_difficulty_scheme_versions
  (github_repository_id, version_number, scheme, effective_from)
select github_repository_id, 1, difficulty_scheme, created_at
from registered_repositories;
