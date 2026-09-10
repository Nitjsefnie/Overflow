-- Issue 296 step 2 (C1): GitLab repositories are registered hook-less by
-- design — the forge-evidence contract grades GitLab webhook items 27/28
-- PARTIAL and webhook ingestion is deferred — so the registration row must be
-- representable without a webhook id. The not-null on github_webhook_id made
-- that impossible; this migration drops only the not-null.
--
-- Safety, spelled out: the UNIQUE constraint survives because NULLs do not
-- collide under a Postgres unique index; the `github_webhook_id > 0` CHECK is
-- vacuous on NULL and is left in force for every non-null id; existing GitHub
-- rows keep their ids and are physically untouched; and every reader of the
-- column handles NULL — register.ts's GitLab registration path omits it,
-- repositories/postgres-store.ts stores and reads NULL (toSafeInteger passes
-- null through), and upgrade-webhooks.ts's drain skips NULL-id rows
-- explicitly, since a repository without a webhook has nothing to drain.
alter table registered_repositories
  alter column github_webhook_id drop not null;
