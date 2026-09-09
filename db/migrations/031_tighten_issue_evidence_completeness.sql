-- Issues 19 and 141 are two holes in the same idiom. The evidence-completeness
-- CHECK constraints on `issues` spelled every mandatory text column as
-- `length(trim(col)) > 0`, and PostgreSQL's one-argument trim() strips spaces
-- and nothing else, so a tab or a newline satisfied the arm while carrying no
-- content (issue 141). Worse, the same arms are three-valued: a null text
-- column beside a present evidence timestamp made the arm NULL rather than
-- false, and a CHECK passes on NULL, so partially-null evidence records were
-- accepted outright (issue 19). Migration 018 already carried the repair
-- idiom in the trigger it rewrote: test for a non-whitespace character, and
-- make the null test explicit so the expression is two-valued.
--
-- Every mandatory text column in each complete branch is now
-- `col is not null and col ~ '\S'` -- false for null, false for whitespace-only
-- -- and settled_points gains an explicit `is not null` beside its range,
-- because `between` alone is three-valued and a CHECK passes on NULL: full
-- settled evidence beside null points was accepted, the same hole as the text
-- columns (issue 19). Nothing else changes: the absent branches, the points
-- range itself, the timestamp requirements and the fifteen-minute ordering
-- grace from migration 010 stand exactly as they were.
--
-- The UPDATE trigger behind `issues_opening_rating_immutable` (rewritten by
-- migration 018) refuses whitespace-only logins with the `!~ '\S'` spelling
-- already, so it has no trim() hole of its own and is left untouched; with the
-- CHECK fixed it is a backstop rather than the only guard.
--
-- ADD CONSTRAINT validates existing rows, so a database holding a
-- whitespace-only or partially-null evidence record fails this migration at
-- deploy time. That is deliberate: NOT VALID would leave the very records the
-- issues describe in place, and no such record is legitimate. Repair any the
-- fold wrote by completing or clearing the evidence by hand first.
alter table issues
drop constraint if exists issues_opening_source_complete_check;

alter table issues
add constraint issues_opening_source_complete_check check (
  (
    owner_github_login is null
    and opening_source_event_id is null
    and opening_source_actor_login is null
    and opening_source_at is null
  )
  or (
    owner_github_login is not null and owner_github_login ~ '\S'
    and opening_source_event_id is not null and opening_source_event_id ~ '\S'
    and opening_source_actor_login is not null and opening_source_actor_login ~ '\S'
    and opening_source_at is not null
  )
);

alter table issues
drop constraint if exists issues_settled_evidence_complete_check;

alter table issues
add constraint issues_settled_evidence_complete_check check (
  (
    settled_label is null
    and settled_points is null
    and settled_label_event_id is null
    and settled_label_actor_login is null
    and settled_label_applied_at is null
    and settled_rationale_comment_id is null
    and settled_rationale_actor_login is null
    and settled_rationale_commented_at is null
  )
  or (
    settled_label is not null and settled_label ~ '\S'
    and settled_points is not null and settled_points between 1 and 10
    and settled_label_event_id is not null and settled_label_event_id ~ '\S'
    and settled_label_actor_login is not null and settled_label_actor_login ~ '\S'
    and settled_label_applied_at is not null
    and settled_rationale_comment_id is not null and settled_rationale_comment_id ~ '\S'
    and settled_rationale_actor_login is not null and settled_rationale_actor_login ~ '\S'
    and settled_rationale_commented_at is not null
    and settled_label_applied_at <= settled_rationale_commented_at + interval '15 minutes'
  )
);
