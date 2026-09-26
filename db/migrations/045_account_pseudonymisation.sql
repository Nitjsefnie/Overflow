-- Issue 650: deleting an account pseudonymises it rather than removing the row.
-- users.deleted_at marks a pseudonymised account. The row, its id and its
-- github_user_id survive because the ledger attributes work by them, so dropping
-- either would orphan completed work. The CHECK pins that a deleted row carries neither
-- avatar nor OAuth token; clearing deleted_at (re-registration) may restore both
-- in the same statement.
alter table users
  add column deleted_at timestamp with time zone,
  add constraint users_deleted_account_scrubbed_check
    check (deleted_at is null or (avatar_url is null and encrypted_oauth_token is null));

-- user_forge_identities.encrypted_token becomes nullable because a deleted
-- account's identities keep their (provider, instance_url, forge_user_id)
-- triple, which GitLab authorship resolves through, but not their token.
alter table user_forge_identities
  alter column encrypted_token drop not null;
