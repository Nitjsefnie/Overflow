-- A deliberate request to recompute a repository's derived rows must survive
-- the request that noticed a fold defect, just as an ordinary reconciliation
-- job survives a missed webhook. The timestamp names the latest outstanding
-- request; it is not the time a fold ran or the revision that produced its rows.
-- Those rows carry their own fold_revision stamp, while this column records work
-- still owed even when the repository's upstream input has not changed.
--
-- The request belongs on the repository's single queue row rather than in a
-- second table with its own lifecycle. That preserves the one-row-per-repository
-- invariant and lets the existing lease, retry and failure paths carry the
-- request until a pass completes. A request arriving while a fold is RUNNING
-- sets follow_up_requested just like an enqueue, without disturbing its lease.
-- Ordinary enqueues and unsuccessful passes leave this timestamp standing.
--
-- A claim captures the timestamp. Completion clears it only if it still equals
-- that captured value, including the case where both are null; a newer request
-- belongs to the follow-up pass because the completed fold did not see it.
-- Requests advance the timestamp monotonically so an older arrival cannot make
-- newer work look discharged. The reason remains why this row first entered
-- the queue, so REDERIVATION extends the existing reasons rather than replacing
-- them or being written over a reason already recorded by an ordinary enqueue.
alter table repository_reconciliation_jobs
  add column rederivation_requested_at timestamp with time zone,
  drop constraint repository_reconciliation_jobs_reason_check,
  add constraint repository_reconciliation_jobs_reason_check
    check (reason in ('WEBHOOK', 'REGISTRATION', 'SWEEP', 'REDERIVATION'));
