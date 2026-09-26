-- Each registered repository's current policy-violation set, so that a
-- reconciliation run records a violation in reconciliation_changes only when it
-- newly appears for its repository, instead of re-recording every violation the
-- fold still reports on every run.
--
-- The set is replaced by each successful publication, inside the same
-- transaction that records the new ones: a violation that vanishes is removed
-- here, so if it later reappears it is recorded again.
--
-- Equality is jsonb equality of the violation object, which ignores key order.
--
-- The key is an md5 digest of the violation, not the violation itself: a btree
-- index row holds at most about 2.7 kB, and a violation carries prose that can
-- exceed it, which would abort every publication for that repository. jsonb's
-- text form is canonical (key order and whitespace normalised), so equal
-- violations share a digest. Lookups still compare the jsonb values.
--
-- The table starts empty. The first run after this migration records each
-- repository's current set once, which is bounded by that set's size, rather
-- than seeding it from the historical rows.
--
-- The foreign key has no delete rule, like the other per-repository derived
-- state (repository_reconciliation_usage, repository_reconciliation_jobs): no
-- application path deletes a registered repository; unregistering one clears
-- `active` instead.

create table repository_policy_violations (
  repository_id uuid not null references registered_repositories(id),
  violation jsonb not null,
  violation_digest text generated always as (md5(violation::text)) stored,
  primary key (repository_id, violation_digest)
);
