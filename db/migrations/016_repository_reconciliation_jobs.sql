-- The durable queue of repositories whose materialization is known to be
-- behind. A webhook that fails leaves the repository stale, and nothing but a
-- later event used to repair it; a job row survives the request that noticed,
-- so the repair happens whether or not anyone touches the repository again.
--
-- The outstanding index is partial rather than a plain unique constraint on
-- `repository_id`: a repository may hold at most one job that is waiting or has
-- given up, while a job that is already RUNNING must not block a follow-up job
-- for an event that arrived mid-fold. What the index guarantees is therefore
-- exactly that one waiting-or-failed row per repository, and nothing here bounds
-- RUNNING rows. The familiar ceiling of two rows per repository holds only if
-- the worker never holds two concurrent leases for one repository, which is the
-- worker's obligation rather than the schema's. A successful job deletes its own
-- row.
--
-- The lease check keeps `state` and the lease columns from drifting apart. A
-- claim sets all three together and a release clears them together, so a
-- crashed worker leaves a row whose expiry says it is reclaimable rather than a
-- RUNNING row with no lease at all.
--
-- Deliberately absent: any column holding an upstream error message. An
-- upstream GitHub error can carry the sponsor's token in a URL, and
-- `src/lib/fold/reconcile.ts` already records a fixed message for that reason,
-- so the visible failure state here is `state`, `attempt_count` and
-- `last_failure_at`, and the cause reaches the service log only.

create type repository_reconciliation_job_state as enum ('PENDING', 'RUNNING', 'FAILED');

create table repository_reconciliation_jobs (
  id uuid primary key default gen_random_uuid(),
  repository_id uuid not null references registered_repositories(id),
  reason text not null check (reason in ('WEBHOOK', 'REGISTRATION', 'SWEEP')),
  state repository_reconciliation_job_state not null default 'PENDING',
  attempt_count integer not null default 0 check (attempt_count >= 0),
  run_after timestamp with time zone not null default now(),
  lease_token uuid,
  lease_expires_at timestamp with time zone,
  last_failure_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  constraint repository_reconciliation_jobs_lease_check check (
    (state = 'RUNNING' and lease_token is not null and lease_expires_at is not null)
    or
    (state <> 'RUNNING' and lease_token is null and lease_expires_at is null)
  )
);

create unique index repository_reconciliation_jobs_outstanding_key
  on repository_reconciliation_jobs (repository_id)
  where state in ('PENDING', 'FAILED');

create index repository_reconciliation_jobs_due_key
  on repository_reconciliation_jobs (run_after)
  where state = 'PENDING';
