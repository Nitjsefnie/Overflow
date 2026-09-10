-- A granted correction must schedule the ledger materialization that applies
-- it. The queue already carries the lifecycle a grant needs — one row per
-- repository, lease and retry semantics, and a materializer that applies
-- granted overrides on every run — so the grant enqueues that queue's OVERRIDE
-- reason inside the same transaction that flips the request to GRANTED. The
-- reason is left as first recorded, as with every other enqueue: it says why
-- the repository entered the queue.
alter table repository_reconciliation_jobs
  drop constraint repository_reconciliation_jobs_reason_check,
  add constraint repository_reconciliation_jobs_reason_check
    check (reason in ('WEBHOOK', 'REGISTRATION', 'SWEEP', 'REDERIVATION', 'OVERRIDE'));
