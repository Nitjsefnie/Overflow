-- An unregistered repository keeps no webhook credential.
--
-- Unregistration now clears the credential selector, the encrypted webhook
-- secret and the configuration instant in the same write that sets
-- `unregistered_at`: nothing reads them again, and a re-registration mints and
-- stores a fresh credential. This clears the same three columns on every row
-- unregistered before that change, which would otherwise hold its encrypted
-- secret forever (a repeat unregister answers ALREADY_UNREGISTERED without
-- writing).
--
-- The selection is `unregistered_at`, never `active` alone. A moderation
-- deactivation sets `active = false` with `unregistered_at` null, and closing
-- the recalibration reactivates that row without minting a new credential, so
-- it must keep the one it has.
--
-- All three columns are cleared together, as the credential constraints from
-- 043 require. `updated_at` is left as it was: this is a scrub of data no code
-- path reads, not a change to the registration. Replaying the statement
-- matches no row, so it is safe to run again.

update registered_repositories
set webhook_credential_id = null, encrypted_webhook_secret = null, webhook_configured_at = null
where unregistered_at is not null and webhook_credential_id is not null;
