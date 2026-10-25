-- Catch-up tracking for diff-only sponsors; additive, unused by older workers.
create table reconciliation_sweep_catchups (
  repository_id uuid primary key references registered_repositories(id) on delete cascade,
  sponsor_id uuid not null references users(id) on delete cascade,
  state text not null default 'pending' check (state in ('pending', 'in_flight', 'completed', 'failed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz  not null default now()
);

create index reconciliation_sweep_catchups_sponsor_key
  on reconciliation_sweep_catchups (sponsor_id, state);
