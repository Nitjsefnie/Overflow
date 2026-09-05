-- 003 had to write the 'UNCLAIMED' limb of settlements_materialized_status_check against
-- status::text, because PostgreSQL will not read an enum label in the transaction that
-- ALTER TYPE ... ADD VALUE added it. Databases that applied 003 before that change kept the
-- enum-typed limb, so the two disagree on how the check is stored while meaning the same thing.
--
-- settlement_status committed long ago by the time this runs, so the label is readable again.
-- Restating the whole check leaves every deployment with one definition, and one that a later
-- ALTER TYPE ... RENAME VALUE would carry with it instead of silently falling behind.
alter table settlements
drop constraint if exists settlements_materialized_status_check,
add constraint settlements_materialized_status_check check (
  (
    status = 'SETTLED'
    and creditor_id is not null
    and settled_points is not null
    and settled_points between 1 and 10
    and credits = greatest(0, settled_points - review_rounds)
  )
  or (
    status = 'UNCLAIMED'
    and creditor_id is null
    and creditor_github_login is not null
    and length(trim(creditor_github_login)) > 0
    and settled_points is not null
    and settled_points between 1 and 10
    and credits = greatest(0, settled_points - review_rounds)
  )
  or (
    status = 'UNSETTLED'
    and settled_points is null
    and credits = 0
  )
);
