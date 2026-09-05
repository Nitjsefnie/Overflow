-- Opening authority moved to the repository sponsor. Existing non-sponsor opening
-- evidence would trip the immutable-opening check in src/lib/fold/postgres-store.ts
-- on the next reconciliation. Resolve affected rows through the settlement override
-- path or by hand before upgrading.
do $$
declare
  affected_count bigint;
  affected_issue_ids text;
begin
  with affected as (
    select issues.id
    from issues
    join registered_repositories on registered_repositories.id = issues.repository_id
    join users on users.id = registered_repositories.sponsor_id
    where issues.opening_source_actor_login is not null
      and lower(issues.opening_source_actor_login) <> lower(users.github_login)
  )
  select count(*), (
    select string_agg(sample.id::text, ', ' order by sample.id)
    from (select id from affected order by id limit 5) as sample
  )
  into affected_count, affected_issue_ids
  from affected;

  if affected_count > 0 then
    raise exception 'Opening authority precondition failed: % issue(s) have non-sponsor opening evidence. Issue ids: %. Resolve affected rows through the settlement override path or by hand before upgrading.',
      affected_count, affected_issue_ids;
  end if;
end;
$$;
