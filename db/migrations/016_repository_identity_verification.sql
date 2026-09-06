-- Reconciliation records here that a registered repository's numeric identity no
-- longer resolves to a public repository. This is deliberately not the `active`
-- column: `active` is the moderation lever that src/lib/moderation/postgres-store.ts
-- clears and restores when a sponsor is recalibrated or reinstated, so recording
-- unavailability there would let a moderation reinstatement silently re-enable a
-- repository GitHub no longer serves.
--
-- `unavailable_since` is when the current unavailability was first observed, not
-- when it was last confirmed: an unavailability that persists for the same reason
-- keeps the timestamp of the first observation.

alter table registered_repositories
add column unavailable_reason text
  constraint registered_repositories_unavailable_reason_check
  check (unavailable_reason is null or unavailable_reason in ('NOT_FOUND', 'NOT_PUBLIC', 'IDENTITY_MISMATCH')),
add column unavailable_since timestamp with time zone;

alter table registered_repositories
add constraint registered_repositories_unavailability_check
  check ((unavailable_reason is null) = (unavailable_since is null));
