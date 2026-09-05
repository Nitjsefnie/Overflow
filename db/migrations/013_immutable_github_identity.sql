-- Credit ownership and identity claims are bound to the immutable GitHub
-- account id. The login columns stay as display text: GitHub logins are
-- mutable and reusable, so a login can name a different person than the one
-- who authored the work.
--
-- No backfill from logins: deriving an id from a login is the defect being
-- removed. Rows written before this migration keep a null id and are rewritten
-- from GitHub by the next reconciliation of their repository; until then they
-- are claimable by nobody, which is the safe direction.

alter table pull_requests
add column if not exists author_github_user_id bigint;

alter table pull_requests
add constraint pull_requests_author_github_user_id_check
check (author_github_user_id is null or author_github_user_id > 0);

alter table settlements
add column if not exists creditor_github_user_id bigint;

alter table settlements
add constraint settlements_creditor_github_user_id_check
check (creditor_github_user_id is null or creditor_github_user_id > 0);

-- A login is display text now, so two accounts may show the same one: the
-- current holder of a recycled login must be able to sign in while a renamed
-- account that never signed in again still displays the old name.
alter table users
drop constraint if exists users_github_login_key;
