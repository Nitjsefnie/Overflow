-- The sweep's size measure; additive, unmeasured reads as zero.
create table repository_reconciliation_sizes (
  repository_id uuid primary key references registered_repositories(id) on delete cascade,
  total_count integer not null check (total_count >= 0),
  measured_at timestamptz not null check (isfinite(measured_at))
);
