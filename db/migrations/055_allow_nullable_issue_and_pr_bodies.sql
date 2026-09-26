-- The fold and the webhook view stop persisting issue and pull request body
-- text (issue 681): bodies stop being written, forward-only. Existing values
-- are runbook territory, so the columns stay and lose only their NOT NULL,
-- letting the materializer leave them unset from here on.

alter table issues alter column body drop not null;
alter table pull_requests alter column body drop not null;
