-- Issue 1125: a sanctioned account's recourse when it believes a sanction is
-- wrong, and the moderation-event trail the request leaves behind.
--
-- The disputes framework names two contestable cases: a settlement (the
-- correction loop of migration 009 and src/lib/overrides) and a sanction. The
-- sanction case had no table: the legal pages promised a sanction could be
-- contested, and the disputes work of issue 954 unified the pages' wording,
-- but no product surface existed behind the promise. This table is the
-- product surface for the sanction case, serving the dispute the legal pages
-- name as "contesting a sanction": the sanctioned account asks, a moderator
-- decides (Task 2 lands the decision path), and the request's filing and its
-- decision are both recorded as moderation events.
--
-- One OPEN request per sanction is held by the partial unique index at the
-- bottom, the same shape migration 009 uses for correction requests: an
-- account cannot flood the queue, and a moderator never has to reconcile two
-- live requests about the same sanction. A DECIDED row sits outside the
-- index's OPEN slice, so a fresh request on the same sanction after a decision
-- is permitted.
--
-- The columns Task 2's decision writes: state ('OPEN' or 'DECIDED'), decision
-- ('GRANTED' or 'DENIED'), decided_by, decided_by_sole_moderator (true when
-- the instance had exactly one live moderator at the decision, so the record
-- says so where the rules promise "not the one who imposed it" cannot apply),
-- decided_reason and decided_at. The decision_complete_check keeps an OPEN row
-- free of every decision field and requires all of them on a DECIDED row.

create table sanction_contest_requests (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references users (id),
  sanction_event_id uuid not null references moderation_events (id),
  request_reason text not null
    constraint sanction_contest_requests_request_reason_nonblank_check
      check (length(btrim(request_reason)) > 0)
    constraint sanction_contest_requests_request_reason_length_check
      check (char_length(request_reason) <= 2000),
  state text not null default 'OPEN'
    constraint sanction_contest_requests_state_allowed_check
      check (state in ('OPEN', 'DECIDED')),
  decision text
    constraint sanction_contest_requests_decision_allowed_check
      check (decision is null or decision in ('GRANTED', 'DENIED')),
  decided_by uuid references users (id),
  decided_by_sole_moderator boolean not null default false,
  decided_reason text
    constraint sanction_contest_requests_decided_reason_nonblank_check
      check (decided_reason is null or length(btrim(decided_reason)) > 0)
    constraint sanction_contest_requests_decided_reason_length_check
      check (char_length(decided_reason) <= 2000),
  decided_at timestamp with time zone,
  created_at timestamp with time zone not null default now(),
  constraint sanction_contest_requests_decision_complete_check check (
    (
      state = 'OPEN'
      and decision is null
      and decided_by is null
      and decided_by_sole_moderator = false
      and decided_reason is null
      and decided_at is null
    )
    or (
      state = 'DECIDED'
      and decision is not null
      and decided_by is not null
      and decided_reason is not null
      and decided_at is not null
    )
  )
);

-- One open request per sanction.
create unique index sanction_contest_requests_one_open_per_sanction
  on sanction_contest_requests (sanction_event_id)
  where state = 'OPEN';

-- Moderation events are append-only history (migration 007's immutability
-- trigger), so the filing and the decision are events in it, and this column
-- is the link back from an event to the request it served. The reference
-- carries no ON DELETE rule on purpose: a request row is never deleted, and an
-- ON DELETE SET NULL would attempt an UPDATE the immutability trigger
-- forbids — the same shape migration 054 declines for credential_token_id.
alter table moderation_events
  add column contest_request_id uuid references sanction_contest_requests (id);
