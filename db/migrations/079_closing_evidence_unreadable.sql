-- A walk that could not read one issue's closing pull request connection
-- prices nothing from it: the fold records this kind so a moderator sees the
-- closure whose closing evidence was never read, instead of a settlement
-- derived from the empty connection the walk reported.

alter type unwritable_closure_kind
  add value if not exists 'CLOSING_EVIDENCE_UNREADABLE';
