-- Sweep requests have an identity separate from webhook follow-up work. A
-- successful claim consumes only its captured generation; a newer sweep or an
-- unfinished held/retried sweep retains full-pass authority.
alter table repository_reconciliation_jobs
  add column sweep_generation bigint not null default 0 check (sweep_generation >= 0),
  add column claimed_sweep_generation bigint check (claimed_sweep_generation >= 0);
