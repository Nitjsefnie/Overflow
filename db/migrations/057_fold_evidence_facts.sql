-- Evidence facts (issues 850 + 853): the evidence document's two wholesale-rewritten
-- jsonb arrays move to row-per-fact storage. One row per subject, keyed by the
-- subject's numeric GitHub id, lets a fold pass write only the facts whose content
-- changed instead of rewriting the whole document — which is what orphaned the old
-- document's TOAST on every pass — and bounds every stored jsonb value to one fact,
-- so no evidence write can exceed jsonb's size ceiling again.
--
-- DDL only, by constraint: old evidence rows are not data-migrated. The format
-- bump that ships with this migration (RECONCILIATION_EVIDENCE_FORMAT 3 -> 4)
-- makes the fold treat every existing cache as incompatible and perform one full
-- pass, which repopulates the facts table from upstream; the dropped columns are
-- dropped with their data. A migration that moved old rows would have to read and
-- rewrite every repository's full document under ACCESS EXCLUSIVE-class locks, for
-- data a single fold pass rebuilds anyway.
alter table repository_reconciliation_evidence drop column issues;

alter table repository_reconciliation_evidence drop column pull_requests;

alter table repository_reconciliation_evidence
  add column omitted_oversized_facts integer not null default 0;

create table repository_reconciliation_evidence_facts (
  repository_id uuid not null references repository_reconciliation_evidence(repository_id) on delete cascade,
  kind text not null check (kind in ('issue', 'pull_request')),
  subject_key text not null,
  payload jsonb not null,
  primary key (repository_id, kind, subject_key)
);
