-- Issue 197: a run must record whether it was admitted to re-derive results,
-- either because a caller requested it or because derived rows carried an older
-- fold revision. The queue timestamp records work still owed; this flag records
-- the intent of a particular pass, including one that later fails.
--
-- Existing runs default to false because they did not record that intent. Their
-- full GitHub reads do not establish that they were requested re-derivations:
-- every pass still reads every issue today. Issue 196 will use the flag to bypass
-- the incremental fetch's per-repository watermark. No fetch changes here.
alter table reconciliation_runs
  add column rederivation boolean not null default false;
