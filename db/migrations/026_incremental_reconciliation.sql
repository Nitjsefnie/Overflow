create table repository_reconciliation_evidence (
  repository_id uuid primary key references registered_repositories(id) on delete cascade,
  version integer not null check (version > 0),
  format_version integer not null check (format_version > 0),
  checkpoint timestamptz not null,
  last_full_pass_at timestamptz not null,
  issues jsonb not null check (jsonb_typeof(issues) = 'array'),
  pull_requests jsonb not null check (jsonb_typeof(pull_requests) = 'array')
);

-- Acknowledgement removes rows. A sequence prevents delete/reinsert from
-- recycling a generation still held by a stale pass.
create sequence repository_reconciliation_dirty_generation;

create table repository_reconciliation_dirty_subjects (
  repository_id uuid not null references registered_repositories(id) on delete cascade,
  kind text not null check (kind in ('ISSUE', 'PULL_REQUEST')),
  github_subject_id bigint not null check (github_subject_id > 0),
  subject_number integer not null check (subject_number > 0),
  generation bigint not null default nextval('repository_reconciliation_dirty_generation'),
  primary key (repository_id, kind, github_subject_id)
);
