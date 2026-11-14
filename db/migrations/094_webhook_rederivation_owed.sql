-- Set before an already-finalized webhook's upgrade asks the forge, cleared once
-- the repository's re-derivation is queued: a later webhooks:upgrade run queues
-- one whose queue write failed or whose forge response was lost. Nullable, so a
-- release that never writes it keeps working against this schema.
alter table registered_repositories add column webhook_rederivation_owed_at timestamptz;
