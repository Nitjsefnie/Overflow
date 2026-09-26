-- Record which credential authorized a privileged action, and when an API
-- token was last used. last_used_at is stamped by the token lookup, throttled
-- to once per minute, so an owner can distinguish an idle token from one in use.
--
-- credential_kind distinguishes a session from a token. Sessions are JWTs
-- without a stored id; credential_token_id names one api_tokens issuance,
-- whose id rotates on regeneration. Neither field contains credential secrets.
--
-- credential_token_id deliberately has no foreign key: deleteAccount deletes
-- api_tokens rows, while moderation_events has an immutability trigger. An FK
-- would block deletion, and ON DELETE SET NULL would attempt a forbidden UPDATE
-- and erase the historical credential reference.
--
-- Mixed-version safe: deployment migrates before the new build starts, and a
-- rollback also runs the previous release against this schema. Every new column
-- is nullable with no default, and both checks accept all-null credentials,
-- which is what that release's unchanged INSERT statements write. Existing
-- history is validated by a scan, never updated, so adding the CHECK does not
-- fire moderation_events' BEFORE UPDATE immutability trigger.

alter table api_tokens add column last_used_at timestamptz;

alter table moderator_role_changes
  add column credential_kind text,
  add column credential_token_id uuid,
  add constraint moderator_role_changes_credential_check check (
    (credential_kind is null and credential_token_id is null)
    or (credential_kind = 'session' and credential_token_id is null)
    or (credential_kind = 'token' and credential_token_id is not null)
  );

alter table moderation_events
  add column credential_kind text,
  add column credential_token_id uuid,
  add constraint moderation_events_credential_check check (
    (credential_kind is null and credential_token_id is null)
    or (credential_kind = 'session' and credential_token_id is null)
    or (credential_kind = 'token' and credential_token_id is not null)
  );
