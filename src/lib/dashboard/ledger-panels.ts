import { getSql } from "@/lib/db/client";
import { readNumber, readText, type DashboardSql } from "@/lib/dashboard/queries";

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
