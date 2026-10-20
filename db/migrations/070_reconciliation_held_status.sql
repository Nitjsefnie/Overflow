alter type reconciliation_status add value 'HELD';

create type reconciliation_held_by as enum ('SWEEP_REQUEST_BUDGET', 'GRAPHQL_BUDGET');

alter table reconciliation_runs
  add column held_by reconciliation_held_by;
