-- Issue 197: a derived row needs to say which revision of the fold produced it,
-- so a correction to the fold can distinguish rows already recomputed from
-- those still carrying the old result. The stamp belongs on each derived row:
-- a repository can hold rows written by more than one revision of the logic.
--
-- Zero is deliberately the default. Rows written before this change were
-- produced by logic this system cannot name, so they must read as behind
-- revision 1. Defaulting them to the current revision would claim they had been
-- recomputed when no pass had examined them. Writers that know their revision
-- supply it explicitly; older writers and direct inserts remain unnamed.
--
-- A pass also refreshes the stamp when the desired business state is unchanged.
-- That update writes only the revision, without a reconciliation_changes row
-- or a delta: a revision bump must not create one CHANGE record per unchanged
-- derived row. The indexes support finding rows still below a known revision
-- without requiring a scan of every derived result.

alter table settlements
  add column fold_revision integer not null default 0 check (fold_revision >= 0);

alter table self_work_calibrations
  add column fold_revision integer not null default 0 check (fold_revision >= 0);

alter table unwritable_closures
  add column fold_revision integer not null default 0 check (fold_revision >= 0);

create index settlements_fold_revision_key on settlements using btree (fold_revision);
create index self_work_calibrations_fold_revision_key on self_work_calibrations using btree (fold_revision);
create index unwritable_closures_fold_revision_key on unwritable_closures using btree (fold_revision);
