-- Additive per-sponsor sweep rounds.
create table reconciliation_sweep_rounds (
  sponsor_id uuid primary key references users(id) on delete cascade,
  window_start timestamptz not null check (isfinite(window_start)),
  spent integer not null default 0 check (spent >= 0),
  rotation_cursor text,
  next_enqueue_at timestamptz not null check (isfinite(next_enqueue_at))
);
