-- A closure with a merged closing pull request whose settlement evidence failed
-- the window checks was previously recorded nowhere. The kind separates it from
-- a closure with no closing pull request, and the check ties the pull request to
-- the kind that has one.

do $$
begin
  create type unwritable_closure_kind as enum ('NO_CLOSING_PULL_REQUEST', 'SETTLEMENT_EVIDENCE_REJECTED');
exception
  when duplicate_object then null;
end;
$$;

alter table unwritable_closures
  add column if not exists kind unwritable_closure_kind not null default 'NO_CLOSING_PULL_REQUEST';

update unwritable_closures
set pull_request_id = null
where kind = 'NO_CLOSING_PULL_REQUEST' and pull_request_id is not null;

alter table unwritable_closures
  drop constraint if exists unwritable_closures_kind_pull_request_check,
  add constraint unwritable_closures_kind_pull_request_check
    check ((kind = 'SETTLEMENT_EVIDENCE_REJECTED') = (pull_request_id is not null));
