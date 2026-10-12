-- Index the referencing side of the FK checks performed by parent deletes:
-- reconciliation_changes_run_idx serves reconciliation_runs deletion after
-- retention removes its changes; reconciliation_changes_pull_request_idx
-- serves the ON DELETE SET NULL check/update when a pull_requests row goes;
-- unwritable_closures_pull_request_idx serves that table's pull_requests FK.
-- Production read 2026-10-12: reconciliation_changes has 63,397 rows / 14 MB
-- heap; unwritable_closures has 277 rows. CREATE INDEX takes a SHARE lock on
-- each table, blocking INSERT/UPDATE/DELETE for the build duration while
-- reads continue. At these sizes the build is expected to be sub-second.
-- CONCURRENTLY is not used because scripts/migrate.ts runs each migration
-- inside a transaction. These plain, additive indexes preserve old writers.
create index reconciliation_changes_run_idx
  on reconciliation_changes (reconciliation_run_id);
create index reconciliation_changes_pull_request_idx
  on reconciliation_changes (pull_request_id);
create index unwritable_closures_pull_request_idx
  on unwritable_closures (pull_request_id);
