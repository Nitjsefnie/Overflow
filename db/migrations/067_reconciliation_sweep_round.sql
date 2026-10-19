-- Mixed-version review: additive state, unused by older workers. Old workers
-- cannot enforce the new ceiling; deploy the request-aware worker everywhere.
create table reconciliation_sweep_round (
  singleton boolean primary key default true check (singleton),
  window_start timestamptz not null check (isfinite(window_start)),
  spent integer not null default 0 check (spent >= 0),
  rotation_cursor text,
  next_enqueue_at timestamptz not null check (isfinite(next_enqueue_at))
);

create table reconciliation_sweep_passes (
  repository_id uuid primary key references registered_repositories(id) on delete cascade,
  pass_id uuid not null unique,
  scan_started_at timestamptz not null check (isfinite(scan_started_at)),
  evidence_version text,
  dirty_subjects jsonb not null,
  walk_cursor text
);

-- Successful responses from a paused full walk are replayed locally on resume.
-- Each response is separate, so a long walk never rewrites a growing JSON blob.
create table reconciliation_sweep_pages (
  pass_id uuid not null references reconciliation_sweep_passes(pass_id) on delete cascade,
  request_key text not null,
  payload jsonb not null,
  primary key (pass_id, request_key)
);
