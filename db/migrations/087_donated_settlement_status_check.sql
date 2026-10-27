-- A separate file: 086's DONATED label is unreadable in the transaction that added it.
-- Nullable columns are tested `is not null` first; a NULL CHECK passes.
alter table settlements
drop constraint if exists settlements_materialized_status_check,
add constraint settlements_materialized_status_check check (
  (
    status = 'SETTLED'
    and creditor_id is not null
    and settled_points is not null
    and settled_points between 1 and 10
    and credits = greatest(0, settled_points - review_rounds)
    and donation_comment_id is null
  )
  or (
    status = 'UNCLAIMED'
    and creditor_id is null
    and creditor_github_login is not null
    and length(trim(creditor_github_login)) > 0
    and settled_points is not null
    and settled_points between 1 and 10
    and credits = greatest(0, settled_points - review_rounds)
    and donation_comment_id is null
  )
  or (
    status = 'DONATED'
    and donation_comment_id is not null
    and (
      creditor_id is not null
      or (creditor_github_login is not null and length(trim(creditor_github_login)) > 0)
    )
    and settled_points is not null
    and settled_points between 1 and 10
    and credits = greatest(0, settled_points - review_rounds)
  )
  or (
    status = 'UNSETTLED'
    and settled_points is null
    and credits = 0
    and donation_comment_id is null
  )
);
