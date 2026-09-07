-- A re-derivation request has both a time and an identity. The timestamp says
-- when outstanding work was requested and remains useful to an operator, but
-- cannot say which request a worker captured: two callers can supply the same
-- millisecond, and a later caller can carry an earlier clock reading. Keeping
-- the greatest timestamp is correct for display and still makes those distinct
-- requests indistinguishable to a completion that compares only their times.
--
-- The generation names the request independently of its timestamp. Every
-- accepted request increments it on the repository's existing queue row, under
-- the same conflict update that preserves a RUNNING lease and asks for a
-- follow-up. A claim captures that generation and completion compares only that
-- value before discharging the timestamp. A request arriving during the fold
-- therefore survives even when its supplied time is equal to or older than the
-- one the fold saw. Retry, defer and failure preserve both columns; a completion
-- retaining the row does not reset its generation, so an old claim can never
-- match a later request on that row by recycling a counter value.
--
-- Existing rows start at generation zero, including outstanding requests made
-- before generations were recorded. They can be captured and completed as they
-- stand; the next request advances them to one. Keeping the counter on the queue
-- row gives the request the queue's existing ownership and locking guarantees
-- without a second table whose lifecycle would have to track the same work.
alter table repository_reconciliation_jobs
  add column rederivation_generation bigint not null default 0
    check (rederivation_generation >= 0);
