-- The fold accepts a rationale comment written up to fifteen minutes before the
-- settled label it explains (EVIDENCE_ORDERING_GRACE_MS in
-- src/lib/fold/repository-fold.ts). The check from migration 007 demanded the
-- label first, and because materialization writes a repository's whole fold in
-- one transaction, a single issue with that ordering rolled back every row and
-- the repository could not reconcile at all. The database now tolerates the
-- same window the fold does; every other term of the check is unchanged.

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
    length(trim(settled_label)) > 0
    and settled_points between 1 and 10
    and length(trim(settled_label_event_id)) > 0
    and length(trim(settled_label_actor_login)) > 0
    and settled_label_applied_at is not null
    and length(trim(settled_rationale_comment_id)) > 0
    and length(trim(settled_rationale_actor_login)) > 0
    and settled_rationale_commented_at is not null
    and settled_label_applied_at <= settled_rationale_commented_at + interval '15 minutes'
  )
);
