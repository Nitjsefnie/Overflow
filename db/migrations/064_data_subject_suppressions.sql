-- Issue 1071: a data-subject removal keyed by forge provider and numeric forge
-- id must survive the next reconciliation pass. Rows written into the derived
-- stores name a never-signed-in person by login and numeric id, and every fold
-- re-reads and re-writes them from the forge; the removal therefore records a
-- suppression here, and the fold's import path checks this table inside its
-- publication transaction before writing any derived row.
--
-- The key is (provider, forge_id). A forge numeric id is authoritative within
-- one provider; the fold matches logins only as display copies of rows the id
-- already names. Two GitLab instances can number the same id differently, so a
-- suppression by provider and id over-covers across instances rather than
-- under-covers: the request is honoured more widely than asked, never less.
-- login is the resolved display copy at decision time (null when none was
-- found); decided_at is the removal instant. The row is unique per key, so a
-- re-run of the removal is idempotent and refreshes the decision stamp.
create table data_subject_suppressions (
  id uuid primary key default gen_random_uuid(),
  provider text not null check (provider in ('github', 'gitlab')),
  forge_id bigint not null check (forge_id > 0),
  login text check (login is null or length(trim(login)) > 0),
  decided_at timestamp with time zone not null default now(),
  unique (provider, forge_id)
);
