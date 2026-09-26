-- Record which credential authorized a privileged action, and when an API
-- token was last used. last_used_at is stamped by the token lookup, throttled
-- to once per minute, so an owner can distinguish an idle token from one in use.
--
-- credential_kind distinguishes a session from a token. Sessions are JWTs
-- without a stored id; credential_token_id names one api_tokens issuance,
-- whose id rotates on regeneration. Neither field contains credential secrets.
-- A token id names one issuance only while this release writes tokens: after a
-- release-level rollback, the previous release's upsert neither rotates the id
-- nor clears last_used_at.
--
-- credential_token_id deliberately has no foreign key: deleteAccount deletes
-- api_tokens rows, and a plain FK with no delete rule would block deletion.
-- ON DELETE SET NULL would attempt an UPDATE forbidden by moderation_events'
-- immutability trigger. moderator_role_changes has no such trigger, but setting
-- its token id to NULL would produce ('token', NULL), which its CHECK rejects,
-- so account deletion would fail there too.
--
-- Mixed-version safe: deployment migrates before the new build starts, and a
-- rollback also runs the previous release against this schema. Every new column
-- is nullable with no default, and both checks accept all-null credentials,
-- which is what that release's unchanged INSERT statements write. Existing
-- history is validated by a scan, never updated, so adding the CHECK does not
-- fire moderation_events' BEFORE UPDATE immutability trigger.

alter table moderator_role_changes
  add column credential_kind text,
  add column credential_token_id uuid,
  add constraint moderator_role_changes_credential_check check (
    coalesce(
      (credential_kind is null and credential_token_id is null)
      or (credential_kind = 'session' and credential_token_id is null)
      or (credential_kind = 'token' and credential_token_id is not null),
      false
    )
  );

alter table moderation_events
  add column credential_kind text,
  add column credential_token_id uuid,
  add constraint moderation_events_credential_check check (
    coalesce(
      (credential_kind is null and credential_token_id is null)
      or (credential_kind = 'session' and credential_token_id is null)
      or (credential_kind = 'token' and credential_token_id is not null),
      false
    )
  );

-- Take api_tokens' ACCESS EXCLUSIVE lock only after history CHECK validation.
alter table api_tokens add column last_used_at timestamptz;
