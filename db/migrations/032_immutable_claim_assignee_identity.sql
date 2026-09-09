-- The claim assignment binds to the immutable GitHub account id. The login
-- column stays as display text: GitHub logins are mutable and reusable, so a
-- login can name a different account than the one assigned to the issue.
--
-- No backfill from logins: deriving an id from a login is the defect being
-- removed. Rows written before this migration keep a null id and are rewritten
-- from GitHub by the next reconciliation of their repository; until then a
-- claimed issue without an id cannot prove self-assignment, so its reserve
-- points stay counted as reserved — the safe direction.

alter table issues
add column if not exists claim_assignee_github_user_id bigint;

alter table issues
add constraint issues_claim_assignee_github_user_id_check
check (claim_assignee_github_user_id is null or claim_assignee_github_user_id > 0);
