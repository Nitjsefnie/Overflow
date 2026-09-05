-- The hash of an Overflow-issued API token, which lets a member drive the
-- product from a script instead of the web form.
--
-- Only the hash is stored. The token itself exists in exactly two places: the
-- response body of the route that mints it, and the browser that receives it.
-- A member who loses it regenerates rather than recovers.
--
-- `user_id` is unique, so "one active token per account" is a property of the
-- schema and not of whichever statement happens to write it: regeneration is
-- an upsert on that constraint, which revokes and reissues atomically instead
-- of leaving a window where the account has two live tokens or none.
--
-- `token_hash` is unique, so a duplicated insert or a hash collision cannot
-- leave two accounts sharing one credential.
--
-- The foreign key carries no `on delete` clause, matching every other
-- reference to `users` in the initial migration: an account that still holds a
-- token cannot be deleted out from under it.

create table if not exists api_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references users (id),
  token_hash bytea not null unique,
  created_at timestamp with time zone not null default now()
);
