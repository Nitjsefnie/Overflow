-- Issue 48: sponsor-initiated unregistration deactivates the row instead of
-- deleting it, so settled history that foreign-keys into the row survives.
-- unregistered_at is null while the registration stands; a non-null value is
-- the instant the sponsor unregistered. Moderation deactivations leave it
-- null: they own `active`, this column owns the sponsor's departure, and the
-- constraint pins the invariant that an active row was never unregistered.
alter table registered_repositories
  add column unregistered_at timestamp with time zone,
  add constraint registered_repositories_unregister_state_check
    check (unregistered_at is null or active = false);
