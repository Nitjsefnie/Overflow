-- Materialization deletes the issues and pull requests the fold no longer
-- contains, and until now it recorded none of them: a run that emptied a
-- repository reported no removals and left no change to read. The change log
-- names the entity a change is about, so recording those deletions needs the
-- two kinds that were missing from it.

alter type reconciliation_entity_kind add value if not exists 'ISSUE';

alter type reconciliation_entity_kind add value if not exists 'PULL_REQUEST';
