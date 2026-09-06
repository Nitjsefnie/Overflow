-- Migration runs before the service restarts: unmarked leases and claims from
-- the old build must remain writable. Only a supplied duration must be positive.
alter table repository_reconciliation_jobs
  add column lease_duration_ms integer,
  add column lease_duration_token uuid,
  add constraint repository_reconciliation_jobs_lease_duration_check check (
    lease_duration_ms is null or lease_duration_ms > 0
  );

-- A direct expired-lease takeover does not run an outcome/release statement.
-- Bind the marker to its lease token so an old writer cannot inherit it when
-- it claims a row previously held by a duration-aware build. New claims write
-- both tokens together; old claims leave the binding behind and lose the marker.
create function clear_stale_reconciliation_lease_duration() returns trigger
language plpgsql as $$
begin
  if new.lease_token is not null
     and new.lease_token is distinct from old.lease_token
     and new.lease_duration_token is distinct from new.lease_token then
    new.lease_duration_ms := null;
  end if;
  if new.lease_duration_ms is null then
    new.lease_duration_token := null;
  end if;
  return new;
end;
$$;

create trigger repository_reconciliation_jobs_lease_duration_owner
before update of lease_token, lease_duration_ms on repository_reconciliation_jobs
for each row execute function clear_stale_reconciliation_lease_duration();
