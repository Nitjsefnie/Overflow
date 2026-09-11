-- Issue 551: a linked GitLab token that stops working (revoked, expired, or its
-- scope reduced) is discovered only when a reconciliation read made through the
-- identity fails with a 401/403. Nothing recorded that: the row kept reading as
-- verified, the failure repeated every sweep, and the sponsor had no signal that
-- the fix is to re-link. This column is the failure marker: nullable, no default,
-- stamped `token_failed_at = now()` by the store's markTokenRejected on every
-- rejected read (so repeated failures re-stamp it fresh), and returned to NULL by
-- the re-link's upsertIdentity, which also re-stamps verified_at. verified_at
-- keeps its meaning — the last successful verification — and is never cleared.
alter table user_forge_identities
  add column token_failed_at timestamp with time zone;
