-- Additive per-repository spend in the sponsor's current sweep window.
create table reconciliation_sweep_repository_spend (
  repository_id uuid primary key references registered_repositories(id) on delete cascade,
  window_start timestamptz not null check (isfinite(window_start)),
  spent integer not null check (spent >= 0)
);
