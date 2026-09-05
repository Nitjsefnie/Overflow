-- A member's recourse when a settlement is wrong, and the moderator decision
-- that corrects it.
--
-- Settlements are derived state: the fold rebuilds them from immutable GitHub
-- history and materialization deletes and rewrites the rows, so a correction
-- written into `settlements` is destroyed by the next reconciliation. A granted
-- correction therefore lives here and is applied by the materializer every time
-- it rebuilds that issue's settlement.
--
-- The request is keyed on the issue rather than on the settlement for the same
-- reason: the settlement row is transient, the issue is not. It disappears with
-- its issue, because a correction to an issue no longer in the materialization
-- has nothing left to apply to.
--
-- No credits figure is stored. Credits are recomputed from the corrected
-- settled points and the review rounds the fold counted, so a stored number can
-- never disagree with the rule.

do $$
begin
  create type settlement_override_state as enum ('OPEN', 'GRANTED', 'DECLINED');
exception
  when duplicate_object then null;
end;
$$;

create table if not exists settlement_override_requests (
  id uuid primary key default gen_random_uuid(),
  issue_id uuid not null references issues (id) on delete cascade,
  requester_id uuid not null references users (id),
  reason text not null check (length(btrim(reason)) > 0),
  state settlement_override_state not null default 'OPEN',
  settled_points integer check (settled_points between 1 and 10),
  decided_by_id uuid references users (id),
  decision_reason text check (decision_reason is null or length(btrim(decision_reason)) > 0),
  created_at timestamp with time zone not null default now(),
  decided_at timestamp with time zone,
  constraint settlement_override_requests_decision_complete_check check (
    (
      state = 'OPEN'
      and settled_points is null
      and decided_by_id is null
      and decision_reason is null
      and decided_at is null
    )
    or (
      state = 'GRANTED'
      and settled_points is not null
      and decided_by_id is not null
      and decision_reason is not null
      and decided_at is not null
    )
    or (
      state = 'DECLINED'
      and settled_points is null
      and decided_by_id is not null
      and decision_reason is not null
      and decided_at is not null
    )
  )
);

-- One open request per settlement, so a member cannot flood the queue and a
-- moderator never has to reconcile two live requests about the same issue.
create unique index if not exists settlement_override_requests_one_open_idx
  on settlement_override_requests (issue_id)
  where state = 'OPEN';

create index if not exists settlement_override_requests_issue_idx
  on settlement_override_requests (issue_id, created_at desc);

create index if not exists settlement_override_requests_open_queue_idx
  on settlement_override_requests (created_at asc)
  where state = 'OPEN';
