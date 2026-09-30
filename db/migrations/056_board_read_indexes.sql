-- Secondary indexes for the member board read (issue 825).
--
-- The board read (src/lib/dashboard/eligible-issues.ts) reaches the issues
-- table through four legs, and until now issues carried no secondary index
-- beyond the primary key and the (repository_id, issue_number) and
-- (id, repository_id) unique constraints of 001_initial.sql. The legs whose
-- predicate is selective — a claimed-open minority, or unclaimed openings
-- beside a settled backlog — therefore read the whole table to find their
-- rows, and that cost grows with everything retained rather than with what
-- each leg needs.
--
-- The claim-state split is the selective part. Two partial indexes mirror the
-- two claim-state predicates the query actually applies:
--
-- issues_board_claimed_open_idx backs the reservations leg, which sums
-- opening_reserve_points over a sponsor's OPEN issues that carry a claim
-- assignee (state = 'OPEN' and claim_assignee_github_login is not null), and
-- the CLAIMED board filter. Claimed-open issues are a small minority of the
-- retained table, so the index stays small and the leg stops reading the rest.
--
-- issues_board_unclaimed_open_idx backs the repayment-issues leg, which picks
-- each exhausted sponsor's cheapest unclaimed opening ordered by
-- opening_reserve_points then created_at (the DISTINCT ON of
-- repayment_issues), and the OPEN board filter. Its key columns start with
-- repository_id — the join predicate every leg shares, for which
-- unique (repository_id, issue_number) already provides the FK-side support —
-- and continue with the leg's ordering columns.
--
-- The other two legs stay unindexed on purpose. candidate_sponsors and the
-- main select filter issues only by state = 'OPEN', which matches most of a
-- retained board's rows: no index can beat a scan that must visit nearly
-- every row, and an index there would only add write cost.
--
-- No CONCURRENTLY: the migration runner wraps each migration in one
-- transaction, and CREATE INDEX CONCURRENTLY cannot run inside a transaction
-- block. Production issues holds 1303 rows / 4.2 MB, so an in-transaction
-- build is instant at the scale that exists today.

create index if not exists issues_board_claimed_open_idx
  on issues (repository_id)
  where state = 'OPEN' and claim_assignee_github_login is not null;

create index if not exists issues_board_unclaimed_open_idx
  on issues (repository_id, opening_reserve_points, created_at)
  where state = 'OPEN' and claim_assignee_github_login is null;
