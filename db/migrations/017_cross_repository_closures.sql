-- A closing reference can name a pull request in a repository Overflow does not
-- govern. Such a closure is recorded rather than settled, and the foreign pull
-- request is never materialized, so the row carries no pull_request_id, which
-- the kind check added by 012 already permits for every kind other than
-- SETTLEMENT_EVIDENCE_REJECTED.

alter type unwritable_closure_kind
  add value if not exists 'CROSS_REPOSITORY_CLOSING_PULL_REQUEST';
