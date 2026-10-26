-- Mixed-version review: additive state; older workers ignore nullable anchors.
alter table reconciliation_sweep_passes add column walk_anchors jsonb;

create table reconciliation_sweep_walk_subjects (
  pass_id uuid not null references reconciliation_sweep_passes(pass_id) on delete cascade,
  kind text not null check (kind in ('issue','pull_request')),
  subject_key bigint not null,
  updated_at timestamptz not null check (isfinite(updated_at)),
  payload jsonb not null,
  primary key (pass_id, kind, subject_key)
);
