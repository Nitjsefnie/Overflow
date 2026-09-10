-- Issue 451: a registration whose save fails leaves the webhook it created on
-- GitHub with no local record that could clean it up. This table is written
-- BEFORE the compensating deletion is attempted, so the webhook id survives
-- every failure combination, and it is the queue the best-effort drain after
-- every successful registration or unregistration works from. No foreign key
-- on purpose: the record has to outlive the registered row it names, and the
-- owner path is denormalized so the drain needs no join to reach GitHub.
create table abandoned_webhook_cleanups (
  github_repository_id bigint not null,
  owner_name text not null,
  webhook_id bigint not null,
  created_at timestamp with time zone not null default now(),
  primary key (github_repository_id, webhook_id)
);
