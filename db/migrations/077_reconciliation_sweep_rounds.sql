-- Mixed-version review: additive per-sponsor state, unused by older workers.
-- Nothing is carried from reconciliation_sweep_round (the singleton the
-- replaced store still serves): each sponsor's window anchors at its first
-- sweep after deploy, so the singleton's spent never becomes a sponsor's debt.
-- The old table stays in place untouched for a later contract release.
create table reconciliation_sweep_rounds (
  sponsor_id uuid primary key references users(id) on delete cascade,
  window_start timestamptz not null check (isfinite(window_start)),
  spent integer not null default 0 check (spent >= 0),
  rotation_cursor text,
  next_enqueue_at timestamptz not null check (isfinite(next_enqueue_at))
);
