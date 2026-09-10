-- Issue 296: user_forge_identities follows the house convention for
-- `references users` — no on-delete clause. Migration 011 documents the rule
-- for exactly this table shape: an account that still holds a credential is
-- not deleted out from under it, so deleting a user with a linked forge
-- identity must fail on the foreign key rather than silently remove the
-- linkage. Migration 038 shipped the constraint with `on delete cascade` and
-- production has already applied it, so the repair is a follow-up migration
-- rather than an edit to 038: drop the constraint and re-add it bare, under
-- the same auto-generated name a fresh database receives from the 038 column
-- syntax, so a migrated database and a created one are indistinguishable.
alter table user_forge_identities
  drop constraint user_forge_identities_user_id_fkey,
  add constraint user_forge_identities_user_id_fkey
    foreign key (user_id) references users(id);
