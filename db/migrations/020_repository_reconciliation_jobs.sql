-- The durable queue of repositories whose materialization is known to be
-- behind. A webhook that fails leaves the repository stale, and nothing but a
-- later event used to repair it; a job row survives the request that noticed,
-- so the repair happens whether or not anyone touches the repository again.
--
-- One row per repository, whatever its state, enforced by a total unique
-- constraint. A successful job deletes its own row, so the absence of a row is
-- what "nothing outstanding" means. An event arriving mid-fold therefore cannot
-- open a second row: it sets `follow_up_requested` on the row being worked, and
-- the completing worker turns that flag back into a fresh PENDING job instead
-- of deleting the row.
--
-- The alternative — a partial unique index excluding RUNNING, so that a
-- follow-up row could be inserted beside the one being folded — was rejected.
-- It makes the queue's shape a worker obligation rather than a schema
-- guarantee, and worse, every path out of RUNNING (`defer`, `retry`, `fail`)
-- returns its own row to PENDING or FAILED and collides with that follow-up
-- row. That collision lands on the ordinary "webhook arrives during a fold that
-- then fails" path, which is precisely the path this table exists to survive.
--
-- The lease a claim writes runs for a fixed window (RECONCILIATION_LEASE_MINUTES
-- in src/lib/fold/reconciliation-worker.ts) and is never renewed. A fold that
-- overruns it is reclaimed by another worker, which then takes the repository
-- advisory lock the first one still holds, so the two serialize and the cost is
-- one redundant idempotent fold rather than a corrupted one. That is why there
-- is no heartbeat: it would buy nothing here, and a lease long enough to make
-- overrun impossible would strand a repository for that long after a crash.
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
  follow_up_requested boolean not null default false,
  created_at timestamp with time zone not null default now(),
  constraint repository_reconciliation_jobs_repository_key unique (repository_id),
  constraint repository_reconciliation_jobs_lease_check check (
    (state = 'RUNNING' and lease_token is not null and lease_expires_at is not null)
    or
    (state <> 'RUNNING' and lease_token is null and lease_expires_at is null)
  )
);

create index repository_reconciliation_jobs_due_key
  on repository_reconciliation_jobs (run_after)
  where state = 'PENDING';
