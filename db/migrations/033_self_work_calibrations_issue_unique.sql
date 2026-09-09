-- One outcome per issue, now enforced on self-work calibrations too. `settlements`
-- has carried `settlements_issue_unique` since 003, while `self_work_calibrations`
-- kept only the (pull_request_id, issue_id) pair, so an issue closed by more than
-- one pull request over its life could hold a second calibration row and silently
-- weight one issue twice in the calibration statistics. Nothing else refuses a
-- duplicate: the fold's materializer removal loop deletes surplus calibrations
-- silently on the next reconciliation, so this precondition is the only guard.
-- Resolve duplicates by deleting the surplus rows for the offending issues, keeping
-- one per issue, before upgrading.
do $$
declare
  affected_count bigint;
  affected_issue_ids text;
begin
  with affected as (
    select issue_id
    from self_work_calibrations
    group by issue_id
    having count(*) > 1
  )
  select count(*), (
    select string_agg(sample.issue_id::text, ', ' order by sample.issue_id)
    from (select issue_id from affected order by issue_id limit 5) as sample
  )
  into affected_count, affected_issue_ids
  from affected;

  if affected_count > 0 then
    raise exception 'Self-work calibration precondition failed: % issue(s) hold more than one self-work calibration. Issue ids: %. Delete the surplus calibration rows for the offending issues, keeping one per issue, before upgrading.',
      affected_count, affected_issue_ids;
  end if;
end;
$$;

alter table self_work_calibrations add constraint self_work_calibrations_issue_unique unique (issue_id);
