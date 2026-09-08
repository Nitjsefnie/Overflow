-- Raw mirrored fields are ordered by GitHub's issue update time, never the
-- local updated_at. Legacy rows have unknown provenance until GitHub is read.
alter table issues add column github_updated_at timestamp with time zone;
