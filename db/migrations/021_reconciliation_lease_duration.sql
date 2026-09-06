-- A NULL duration identifies a lease claimed before builds recorded its window.
-- NOT VALID preserves those existing RUNNING rows for the rollout reclaim arm;
-- PostgreSQL still enforces the check on every subsequent insert or update.
-- Reclaim sets the marker, and every outcome that releases a lease clears it.
alter table repository_reconciliation_jobs
  add column lease_duration_ms integer,
  add constraint repository_reconciliation_jobs_lease_duration_check check (
    (state = 'RUNNING' and lease_duration_ms is not null and lease_duration_ms > 0)
    or
    (state <> 'RUNNING' and lease_duration_ms is null)
  ) not valid;
