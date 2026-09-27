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
};

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

export async function listEligibleIssues(
  accountId: string,
  filters: EligibleIssueFilters = {},
  dependencies: { sql?: DashboardSql } = {},
): Promise<EligibleIssueProjection[]> {
  const sql = resolveBoardSql(dependencies);
  const repositoryFilter = normalizedFilter(filters.repository);
  const openingLabelFilter = normalizedFilter(filters.openingLabel);
  const claimState = filters.claimState ?? "OPEN";
  const rows = await sql<EligibleIssueRow[]>`
    with reservations as materialized (
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
      -- Replay completed-work history once for all accounts, never per issue.
      select account_id, credit_limit from account_credit_limits
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
      and sponsors.id <> ${accountId}
      and sponsors.enforcement_state in ('ACTIVE', 'WARNED', 'UNDER_AUDIT')
      and (
        issues.claim_assignee_github_login is not null
        or coalesce(sponsor_balances.balance, 0) > -coalesce(sponsor_credit_limits.credit_limit, 10)
        or repayment_issues.id is not null
      )
      and (${repositoryFilter}::text is null or repositories.owner_name = ${repositoryFilter})
      and (${openingLabelFilter}::text is null or issues.opening_label = ${openingLabelFilter})
      and (
        ${claimState}::text = 'ALL'
        or (${claimState}::text = 'OPEN' and issues.claim_assignee_github_login is null)
        or (${claimState}::text = 'CLAIMED' and issues.claim_assignee_github_login is not null)
      )
    ) as ranked
    order by
      -- Repayment priority follows exact settled balance; open reservations
      -- affect displayed headroom only, without changing ordering or eligibility.
      ranked.settled_balance desc,
      ranked.opening_reserve_points desc,
      ranked.created_at asc
  `;

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
