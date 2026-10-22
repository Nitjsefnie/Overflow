do $$
declare
  affected_count bigint;
  affected_issue_ids text;
begin
  with affected as (
    select issue_id
    from closed_pr_dispute_requests
    where decision = 'GRANTED'
    group by issue_id
    having count(*) > 1
  )
  select count(*), string_agg(issue_id::text, ', ' order by issue_id)
  into affected_count, affected_issue_ids
  from affected;

  if affected_count > 0 then
    raise exception 'Closed PR dispute precondition failed: % issue(s) hold more than one granted dispute. Issue ids: %. Resolve duplicate grants before upgrading.',
      affected_count, affected_issue_ids;
  end if;
end;
$$;

create unique index closed_pr_dispute_requests_one_grant_per_issue
  on closed_pr_dispute_requests (issue_id)
  where decision = 'GRANTED';
