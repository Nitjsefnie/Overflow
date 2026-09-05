-- Moderator status becomes product state instead of deployment configuration.
--
-- Before this, users.role was overwritten from MODERATOR_GITHUB_LOGINS on every
-- sign-in, so nothing inside the product could grant or revoke it durably. The
-- role column is unchanged; what is new is a record of who changed it and when,
-- so a grant is auditable rather than appearing from nowhere.

create table if not exists moderator_role_changes (
  id uuid primary key default gen_random_uuid(),
  target_account_id uuid not null references users (id),
  actor_id uuid not null references users (id),
  -- The role the target was moved TO, so the row reads as an event rather than
  -- requiring the reader to diff against the previous one.
  new_role user_role not null,
  created_at timestamp with time zone not null default now()
);

create index if not exists moderator_role_changes_target_idx
  on moderator_role_changes (target_account_id, created_at desc);
