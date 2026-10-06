import { getSql } from "@/lib/db/client";
import type { DashboardSql } from "@/lib/dashboard/queries";

/**
 * The eligible-issues board: the projection its readers render, the filters
 * that shape it, and the one query that prices it. Lives apart from
 * queries.ts so the dashboard hub stays under its recorded size.
 */

export type EligibleIssueProjection = {
  id: string;
  repositoryName: string;
  issueNumber: number;
  title: string;
  url: string;
  openingName: string;
  openingLabel: string;
  comparisonPoints: number;
  reservePoints: number;
  sponsorLogin?: string;
  assigneeGitHubLogin?: string | null;
  claimState?: "OPEN" | "CLAIMED";
  availableHeadroom?: number;
  createdAt: string;
};

export type EligibleIssueFilters = {
  repository?: string;
  openingLabel?: string;
  claimState?: "OPEN" | "CLAIMED" | "ALL";
  /** 1-based board page. Undefined, non-finite and non-positive values read as the first page; a page past the bound reads as the largest servable, and therefore empty, page. */
  page?: number;
  /** Rows per board page. Undefined and non-finite values read as the default; out-of-range values clamp to 1..500. */
  pageSize?: number;
};

/**
 * The board's page shape for an unpaginated client: the first page at the
 * default size. A page holding exactly this many rows is a full page, and a
 * full page means a next page may exist.
 */
export const ISSUES_BOARD_DEFAULT_PAGE_SIZE = 200;

/** The largest page size the board serves; anything above clamps back to it. */
export const ISSUES_BOARD_MAX_PAGE_SIZE = 500;

/**
 * The board's page window as a reader resolves it: the same clamp the query
 * applies, exported so a page can size its pager from the resolved window
 * without re-deriving the arithmetic. An unpaginated reader lands on the
 * first page at the default size.
 */
export function resolveIssuesBoardPage(
  page: number | undefined,
  pageSize: number | undefined,
): { page: number; pageSize: number } {
  const resolvedPageSize =
    pageSize === undefined || !Number.isFinite(pageSize)
      ? ISSUES_BOARD_DEFAULT_PAGE_SIZE
      : Math.min(ISSUES_BOARD_MAX_PAGE_SIZE, Math.max(1, Math.floor(pageSize)));
  const resolvedPage =
    page === undefined || !Number.isFinite(page) ? 1 : Math.max(1, Math.floor(page));
  // A page past the board's end reads as an empty page, never as a query the
  // server rejects: (page - 1) * pageSize is the SQL offset, and an unbounded
  // huge page drove it past the largest integer the statement binds exactly
  // (a 1e17 page once answered 502 UPSTREAM_FAILURE). The bound is a page, not
  // an offset, so the offset stays page-aligned and every reader — the
  // /issues pager included — resolves the same clamped window.
  const largestPage = Math.floor(Number.MAX_SAFE_INTEGER / resolvedPageSize) + 1;
  return { page: Math.min(resolvedPage, largestPage), pageSize: resolvedPageSize };
}

/**
 * The one clamp every board caller passes through: whatever page and page
 * size reach the query, the SQL is always paged with a limit inside the
 * documented range and an offset no caller can steer outside it.
 */
function resolveBoardPage(
  page: number | undefined,
  pageSize: number | undefined,
): { limit: number; offset: number } {
  const resolved = resolveIssuesBoardPage(page, pageSize);
  return { limit: resolved.pageSize, offset: (resolved.page - 1) * resolved.pageSize };
}

type EligibleIssueRow = {
  id: string;
  repository_name: string;
  issue_number: number | string;
  title: string;
  url: string;
  opening_name: string;
  opening_label: string;
  opening_comparison_points: number | string;
  opening_reserve_points: number | string;
  sponsor_login?: string;
  claim_assignee_github_login?: string | null;
  available_headroom?: number | string;
  created_at: string | Date;
};

/**
 * The board statement, exactly as Postgres receives it: the tagged template's
 * static text with each interpolated value's positional parameter, $1 through
 * $11, and the values bound in the same order by listEligibleIssues below.
 *
 * The board serves through sql.unsafe — the unnamed-statement path — on
 * purpose. The driver issues tagged-template statements as named prepared
 * statements, and PostgreSQL's plan_cache_mode = auto switches a named
 * statement to its generic plan on the sixth execution: with parameter values
 * unknown, the outer select's issues leg was priced at a handful of rows
 * against tens of thousands, and every execution after the fifth paid
 * nested-loop joins for the mis-estimate. An unnamed statement is re-planned
 * with the actual parameter values on every execution, so the collapse never
 * happens. The values still bind as parameters; nothing is interpolated into
 * this text, and the statement's text is byte-identical to the tagged
 * template it replaced. Future edits must keep the CTE-block formatting: the
 * migration-056 plan pins' `cteBlock()` parser matches `^\s*CTE <name>$`
 * headers and reads the deeper-indented lines under each, so a reflow that
 * moves a `CTE <name>` header onto a shared line breaks those pins.
 */
const BOARD_QUERY = `
    with candidate_sponsors as materialized (
      -- The sponsors whose open issues can reach the board before any
      -- credit-limit test: every predicate the board and the repayment
      -- exception apply to a sponsor, minus the presentation filters. Both
      -- consumers below need a limit only for sponsors this set already
      -- contains, so scoping the replay to it changes no output row.
      select distinct repositories.sponsor_id
      from issues
      join registered_repositories as repositories on repositories.id = issues.repository_id
      join users as sponsors on sponsors.id = repositories.sponsor_id
      where issues.state = 'OPEN'
        and repositories.active = true and repositories.unavailable_reason is null
        and sponsors.id <> $1
        and sponsors.enforcement_state in ('ACTIVE', 'WARNED', 'UNDER_AUDIT')
    ),
    reservations as materialized (
      -- The reservation total is priced once per sponsor here, and joined to
      -- that sponsor's issue rows below, rather than re-derived as correlated
      -- subplans once per output row. Materialized on purpose: a
      -- plain left join to a grouped subquery gets flattened by the planner
      -- back into a per-row parameterized aggregate, which is the defect this
      -- reshape exists to remove.
      select
        sponsored.sponsor_id,
        sum(reserved.opening_reserve_points) as reserved_points
      from registered_repositories as sponsored
      join users as sponsors on sponsors.id = sponsored.sponsor_id
      join issues as reserved on reserved.repository_id = sponsored.id
      where reserved.state = 'OPEN'
        and reserved.claim_assignee_github_login is not null
        -- Same identity rule as getDashboard's reserved_points above: the
        -- login decides claimed-ness only, who claims is decided by the
        -- immutable account id (migrations 013 and 032), and IS DISTINCT FROM
        -- so a claimed issue whose assignee id is not yet reconciled cannot
        -- prove self-assignment and stays reserved until GitHub backfills it.
        and reserved.claim_assignee_github_user_id is distinct from sponsors.github_user_id
      group by sponsored.sponsor_id
    ),
    sponsor_balances as materialized (
      -- One balances pass per query for the same reason; the view already
      -- holds one row per account, so the join cannot fan out.
      select account_id, balance from balances
    ),
    sponsor_credit_limits as materialized (
      -- The account_credit_limits view's replay (migration 044), scoped to
      -- the candidate sponsors. The window partitions by account, so the
      -- replay of a candidate's history is unchanged by every non-candidate's
      -- events being absent; the scoping keeps a world of settlement-heavy
      -- accounts that sponsor no open work from pricing the board's limits.
      -- The predicate sits on the event legs, so a non-candidate row never
      -- reaches the window.
      with credit_events as (
        select
          legs.account_id,
          legs.amount,
          pull_requests.merged_at as occurred_at,
          0 as event_kind,
          ''::text as adjustment_key,
          repositories.provider,
          coalesce(repositories.instance_url, '') as instance_url,
          coalesce(repositories.forge_project_id, repositories.github_repository_id) as repository_key,
          pull_requests.pull_request_number,
          issues.issue_number
        from settlements
        join pull_requests on pull_requests.id = settlements.pull_request_id
        join issues on issues.id = settlements.issue_id
        join registered_repositories as repositories on repositories.id = pull_requests.repository_id
        cross join lateral (values
          (settlements.creditor_id, settlements.credits),
          (settlements.debtor_id, -settlements.credits)
        ) as legs(account_id, amount)
        where settlements.status = 'SETTLED'
          and settlements.credits > 0
          and settlements.creditor_id <> settlements.debtor_id
          and legs.account_id in (select sponsor_id from candidate_sponsors)
        union all
        -- Moderation changes the balance a later contribution repays, but
        -- neither an adjustment nor its reversal is itself completed work.
        -- These immutable events use their creation time and UUID; they are
        -- not re-materialized.
        select legs.account_id, legs.amount, adjustments.created_at, 1,
          adjustments.id::text, repositories.provider,
          coalesce(repositories.instance_url, ''),
          coalesce(repositories.forge_project_id, repositories.github_repository_id),
          pull_requests.pull_request_number, issues.issue_number
        from moderation_credit_adjustments as adjustments
        join moderation_credit_adjustment_lines as lines on lines.adjustment_id = adjustments.id
        join settlements on settlements.id = lines.settlement_id
        join pull_requests on pull_requests.id = settlements.pull_request_id
        join issues on issues.id = settlements.issue_id
        join registered_repositories as repositories on repositories.id = pull_requests.repository_id
        cross join lateral (values
          (lines.creditor_id, lines.amount),
          (adjustments.target_account_id, -lines.amount)
        ) as legs(account_id, amount)
        where legs.account_id in (select sponsor_id from candidate_sponsors)
      ),
      running_balances as (
        select *, coalesce(sum(amount) over (
          partition by account_id
          order by occurred_at nulls first, event_kind, adjustment_key,
            provider, instance_url, repository_key, pull_request_number, issue_number
          rows between unbounded preceding and 1 preceding
        ), 0) as balance_before
        from credit_events
      ),
      repayments as (
        select account_id,
          sum(case when event_kind = 0
            then least(greatest(amount, 0), greatest(-balance_before, 0))
            else 0 end) as repaid_debt
        from running_balances
        group by account_id
      )
      select account_id, 10 + floor(repaid_debt / 10) as credit_limit
      from repayments
    ),
    repayment_issues as materialized (
      -- One unclaimed opening per exhausted sponsor, across all active
      -- repositories. Pick before presentation filters so filtering cannot
      -- nominate a different exception. Immutable forge keys break price/age ties.
      select distinct on (repositories.sponsor_id)
        repositories.sponsor_id, issues.id
      from issues
      join registered_repositories as repositories on repositories.id = issues.repository_id
      join users as sponsors on sponsors.id = repositories.sponsor_id
      left join sponsor_balances on sponsor_balances.account_id = sponsors.id
      left join sponsor_credit_limits on sponsor_credit_limits.account_id = sponsors.id
      where issues.state = 'OPEN'
        and issues.claim_assignee_github_login is null
        and repositories.active = true and repositories.unavailable_reason is null
        and sponsors.enforcement_state in ('ACTIVE', 'WARNED', 'UNDER_AUDIT')
        and coalesce(sponsor_balances.balance, 0) <= -coalesce(sponsor_credit_limits.credit_limit, 10)
      order by repositories.sponsor_id,
        issues.opening_reserve_points asc, issues.created_at asc,
        repositories.provider, coalesce(repositories.instance_url, ''),
        coalesce(repositories.forge_project_id, repositories.github_repository_id),
        issues.issue_number
    )
    select
      ranked.*
    from (
    select
      issues.id,
      repositories.owner_name as repository_name,
      sponsors.github_login as sponsor_login,
      issues.issue_number,
      issues.title,
      issues.url,
      repositories.difficulty_scheme ->> 'openingName' as opening_name,
      issues.opening_label,
      issues.opening_comparison_points,
      issues.opening_reserve_points,
      issues.claim_assignee_github_login,
      coalesce(sponsor_balances.balance, 0) as settled_balance,
      (
        coalesce(sponsor_balances.balance, 0)
        - coalesce(reservations.reserved_points, 0)
      )::integer as available_headroom,
      issues.created_at
    from issues
    join registered_repositories as repositories on repositories.id = issues.repository_id
    join users as sponsors on sponsors.id = repositories.sponsor_id
    left join sponsor_balances on sponsor_balances.account_id = sponsors.id
    left join sponsor_credit_limits on sponsor_credit_limits.account_id = sponsors.id
    left join reservations on reservations.sponsor_id = sponsors.id
    left join repayment_issues on repayment_issues.id = issues.id
    where issues.state = 'OPEN'
      and repositories.active = true and repositories.unavailable_reason is null
      and sponsors.id <> $2
      and sponsors.enforcement_state in ('ACTIVE', 'WARNED', 'UNDER_AUDIT')
      and (
        issues.claim_assignee_github_login is not null
        or coalesce(sponsor_balances.balance, 0) > -coalesce(sponsor_credit_limits.credit_limit, 10)
        or repayment_issues.id is not null
      )
      and ($3::text is null or repositories.owner_name = $4)
      and ($5::text is null or issues.opening_label = $6)
      and (
        $7::text = 'ALL'
        or ($8::text = 'OPEN' and issues.claim_assignee_github_login is null)
        or ($9::text = 'CLAIMED' and issues.claim_assignee_github_login is not null)
      )
    ) as ranked
    order by
      -- Repayment priority follows exact settled balance; open reservations
      -- affect displayed headroom only, without changing ordering or eligibility.
      ranked.settled_balance desc,
      ranked.opening_reserve_points desc,
      ranked.created_at asc,
      -- The unique page-cut tiebreaker: rows can tie on everything above, and
      -- without a final total order a page boundary could drop or duplicate a
      -- row between requests.
      ranked.id asc
    limit $10 offset $11
  `;

export async function listEligibleIssues(
  accountId: string,
  filters: EligibleIssueFilters = {},
  dependencies: { sql?: DashboardSql } = {},
): Promise<EligibleIssueProjection[]> {
  const sql = resolveBoardSql(dependencies);
  const repositoryFilter = normalizedFilter(filters.repository);
  const openingLabelFilter = normalizedFilter(filters.openingLabel);
  const claimState = filters.claimState ?? "OPEN";
  const boardPage = resolveBoardPage(filters.page, filters.pageSize);
  const rows = await sql.unsafe<EligibleIssueRow[]>(BOARD_QUERY, [
    accountId,
    accountId,
    repositoryFilter,
    repositoryFilter,
    openingLabelFilter,
    openingLabelFilter,
    claimState,
    claimState,
    claimState,
    boardPage.limit,
    boardPage.offset,
  ]);

  return rows.map((row) => {
    const projection: EligibleIssueProjection = {
      id: readText(row.id, "Issue identifier"),
      repositoryName: readText(row.repository_name, "Repository name"),
      issueNumber: readNumber(row.issue_number, "Issue number"),
      title: readText(row.title, "Issue title"),
      url: readText(row.url, "Issue URL"),
      openingName: readText(row.opening_name, "Opening catalog name"),
      openingLabel: readText(row.opening_label, "Opening label"),
      comparisonPoints: readNumber(row.opening_comparison_points, "Opening comparison points"),
      reservePoints: readNumber(row.opening_reserve_points, "Opening reserve points"),
      createdAt: readTimestamp(row.created_at, "Issue creation time"),
    };
    if (row.sponsor_login !== undefined) {
      projection.sponsorLogin = readText(row.sponsor_login, "Issue sponsor login");
    }
    if (row.claim_assignee_github_login !== undefined) {
      projection.assigneeGitHubLogin = row.claim_assignee_github_login;
      projection.claimState = row.claim_assignee_github_login === null ? "OPEN" : "CLAIMED";
    }
    if (row.available_headroom !== undefined) {
      projection.availableHeadroom = readNumber(row.available_headroom, "Sponsor available headroom");
    }
    return projection;
  });
}

function resolveBoardSql(dependencies: { sql?: DashboardSql }): DashboardSql {
  return dependencies.sql ?? (getSql() as unknown as DashboardSql);
}

function readNumber(value: unknown, label: string): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`${label} was not a number.`);
  }
  return parsed;
}

function readText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new Error(`${label} was not text.`);
  }
  return value;
}

function readTimestamp(value: string | Date, label: string): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value !== "string") {
    throw new Error(`${label} was not a timestamp.`);
  }
  return value;
}

function normalizedFilter(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}
