import { getSql } from "@/lib/db/client";
import { readNumber, readText, type DashboardSql } from "@/lib/dashboard/queries";

export type PickupProjection = {
  outsideAssignedPostedPrice: number;
  unassignedPostedPrice: number;
  outsideAssignedIssueCount: number;
  unassignedIssueCount: number;
};

type PickupRow = {
  outside_assigned_posted_price: number | string;
  unassigned_posted_price: number | string;
  outside_assigned_issue_count: number | string;
  unassigned_issue_count: number | string;
};

export async function listPickup(
  dependencies: { sql?: DashboardSql } = {},
): Promise<PickupProjection> {
  const sql = dependencies.sql ?? (getSql() as unknown as DashboardSql);
  const [row] = await sql<PickupRow[]>`
    with open_issues as (
      select issues.opening_reserve_points,
        issues.claim_assignee_github_login is not null
          and issues.claim_assignee_github_user_id is distinct from sponsors.github_user_id as outside_assigned,
        issues.claim_assignee_github_login is null as unassigned
      from issues
      join registered_repositories as repositories on repositories.id = issues.repository_id
      join users as sponsors on sponsors.id = repositories.sponsor_id
      where issues.state = 'OPEN'
    )
    select
      coalesce(sum(opening_reserve_points) filter (where outside_assigned), 0) as outside_assigned_posted_price,
      coalesce(sum(opening_reserve_points) filter (where unassigned), 0) as unassigned_posted_price,
      count(*) filter (where outside_assigned) as outside_assigned_issue_count,
      count(*) filter (where unassigned) as unassigned_issue_count
    from open_issues
  `;
  return {
    outsideAssignedPostedPrice: readNumber(row.outside_assigned_posted_price, "Outside-assigned posted price"),
    unassignedPostedPrice: readNumber(row.unassigned_posted_price, "Unassigned posted price"),
    outsideAssignedIssueCount: readNumber(row.outside_assigned_issue_count, "Outside-assigned issue count"),
    unassignedIssueCount: readNumber(row.unassigned_issue_count, "Unassigned issue count"),
  };
}

export type CreditIssuedProjection = {
  bucketStartedAt: string;
  issuedTotal: number;
};

type CreditIssuedRow = {
  bucket_started_at: string;
  issued_total: number | string;
};

export async function listCreditIssued(
  dependencies: { sql?: DashboardSql } = {},
): Promise<CreditIssuedProjection[]> {
  const sql = dependencies.sql ?? (getSql() as unknown as DashboardSql);
  const rows = await sql<CreditIssuedRow[]>`
    with creditor_legs as (
      select pull_requests.merged_at at time zone 'UTC' as issued_at, settlements.credits as amount
      from settlements
      join pull_requests on pull_requests.id = settlements.pull_request_id
      where settlements.status = 'SETTLED'
        and settlements.credits > 0
        and settlements.creditor_id <> settlements.debtor_id
        and pull_requests.merged_at is not null
      union all
      select adjustments.created_at at time zone 'UTC', lines.amount
      from moderation_credit_adjustment_lines as lines
      join moderation_credit_adjustments as adjustments on adjustments.id = lines.adjustment_id
      where lines.amount > 0
      union all
      select adjustments.created_at at time zone 'UTC', lines.amount
      from dispute_credit_adjustment_lines as lines
      join dispute_credit_adjustments as adjustments on adjustments.id = lines.adjustment_id
      where lines.amount > 0
    ), hourly as (
      select date_bin('1 hour', issued_at, timestamp '2000-01-01') as bucket_start,
        sum(amount) as issued_total
      from creditor_legs
      group by bucket_start
    )
    select to_char(bucket_start, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') as bucket_started_at, issued_total
    from hourly
    order by bucket_start desc
    limit 100
  `;
  return rows.map((row) => ({
    bucketStartedAt: readText(row.bucket_started_at, "Credit-issued bucket start"),
    issuedTotal: readNumber(row.issued_total, "Credit issued"),
  }));
}
