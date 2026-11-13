alter table reconciliation_sweep_passes
  add column failed_runs integer not null default 0 check (failed_runs >= 0);
