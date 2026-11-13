-- Mixed-version review: additive. The default lets the previous release keep
-- inserting passes without naming the column; it never counts or resets runs.
alter table reconciliation_sweep_passes
  add column failed_runs integer not null default 0 check (failed_runs >= 0);
