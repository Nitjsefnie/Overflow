-- The reconciliation size measure: one row per registered repository holding
-- the issues-plus-pull-requests count the sweep refreshes at most once per six
-- hours. Unmeasured repositories count as size zero, so the table starts
-- empty. Additive: no older worker reads or writes the table.
create table repository_reconciliation_sizes (
  repository_id uuid primary key references registered_repositories(id) on delete cascade,
  total_count integer not null check (total_count >= 0),
  measured_at timestamptz not null check (isfinite(measured_at))
);
