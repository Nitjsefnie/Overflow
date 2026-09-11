-- Issue 547: a GitLab registration installs a project hook, so a registration
-- whose save fails can orphan a GitLab hook exactly as a GitHub registration
-- can orphan a GitHub one (issue 451). The cleanup table is extended to name
-- the forge a hook lives on:
--
--   provider     'github' for every pre-547 record; 'gitlab' for the new ones.
--   instance_url the hook instance's normalized base URL, required to address
--                the hook (a GitLab project is addressed instance + project);
--                null for GitHub records, which address hooks by numeric id.
--
-- The primary key is extended to (github_repository_id, provider, webhook_id):
-- a GitLab orphan and a GitHub orphan can carry the same numeric repository id
-- and the same numeric hook id, and both records must coexist. GitHub and
-- GitLab rows of registered_repositories never share a numeric id (the
-- cross-forge collision guard at registration), so within one provider the
-- numeric repository id stays unique.
--
-- The existing github_webhook_id column on registered_repositories carries the
-- GitLab hook id too from this migration on (dual use, issue 547): the column
-- keeps its name, its `> 0` CHECK, and its NOT NULL-free shape from migration
-- 040. Every non-null value names the hook id the registration's own forge
-- created, whatever the forge is.
alter table abandoned_webhook_cleanups
  add column provider text not null default 'github',
  add column instance_url text;

alter table abandoned_webhook_cleanups drop constraint abandoned_webhook_cleanups_pkey;

alter table abandoned_webhook_cleanups
  add primary key (github_repository_id, provider, webhook_id);
