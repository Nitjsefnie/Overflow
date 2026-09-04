import { compareCalibration, type CalibrationComparison, type CalibrationPair } from "@/lib/calibration/statistics";
import { getSql } from "@/lib/db/client";

/** A deliberately small SQL boundary that keeps dashboard projections easy to exercise without a database. */
export type DashboardSql = {
  <T extends readonly unknown[] = readonly unknown[]>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T>;
};

export type DashboardProjection = {
  settledBalance: number;
  earnedTotal: number;
  givenTotal: number;
  reservedPoints: number;
  availableHeadroom: number;
  recentSettlements: RecentSettlementProjection[];
  creditFloor?: number;
};

/** A dashboard-safe settlement summary that links a member to the complete proof page. */
export type RecentSettlementProjection = {
  id: string;
  repositoryName: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestUrl: string;
  proofSha256: string;
  credits: number;
  reviewRounds: number;
  settledAt: string;
};

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
  createdAt: string;
};

export type SettlementProofProjection = {
  id: string;
  status: "SETTLED" | "UNSETTLED" | "UNCLAIMED";
  repositoryName: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestUrl: string;
  proofSha256: string;
  openingComparisonPoints: number;
  settledPoints: number | null;
  reviewRounds: number;
  credits: number;
  settledAt: string;
};

export type OpenAuditProjection = {
  id: string;
  targetAccountId: string;
  targetLogin: string;
  reporterLogin: string;
  repositoryName: string | null;
  openedAt: string;
  settledSampleSize: number;
  differenceBetweenMeans: number;
};

export type DashboardQueryDependencies = {
  sql?: DashboardSql;
  creditFloor?: number;
};

type DashboardRow = {
  settled_balance: number | string | null;
  earned_total: number | string | null;
  given_total: number | string | null;
  reserved_points: number | string | null;
};

type RecentSettlementRow = {
  id: string;
  repository_name: string;
  issue_number: number | string;
  issue_title: string;
  issue_url: string;
  pull_request_number: number | string;
  pull_request_title: string;
  pull_request_url: string;
  proof_sha256: string;
  credits: number | string;
  review_rounds: number | string;
  settled_at: string | Date;
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
  created_at: string | Date;
};

type SettlementProofRow = {
  id: string;
  status: string;
  repository_name: string;
  issue_number: number | string;
  issue_title: string;
  issue_url: string;
  pull_request_number: number | string;
  pull_request_title: string;
  pull_request_url: string;
  proof_sha256: string;
  opening_comparison_points: number | string;
  settled_points: number | string | null;
  review_rounds: number | string;
  credits: number | string;
  settled_at: string | Date;
};

type CalibrationRow = {
  github_repository_id: number | string;
  github_issue_id: number | string;
  github_pull_request_id: number | string;
  proof_sha256: string;
  offered_difficulty: number | string;
  settled_difficulty: number | string;
};

type OpenAuditRow = {
  id: string;
  target_account_id: string;
  target_login: string;
  reporter_login: string;
  repository_name: string | null;
  opened_at: string | Date;
  settled_sample_size: number | string;
  cohort_statistics: unknown;
};

/**
 * Loads only materialized ledger and issue-reservation values. Headroom deliberately stays
 * negative when the cooperative has overcommitted: a configured floor is informational, never
 * a hidden clamp.
 */
export async function getDashboard(
  accountId: string,
  dependencies: DashboardQueryDependencies = {},
): Promise<DashboardProjection> {
  const sql = resolveSql(dependencies);
  const [row] = await sql<DashboardRow[]>`
    select
      coalesce((
        select balances.balance
        from balances
        where balances.account_id = ${accountId}
      ), 0)::integer as settled_balance,
      coalesce((
        select sum(ledger_entries.amount)
        from ledger_entries
        where ledger_entries.account_id = ${accountId}
          and ledger_entries.amount > 0
      ), 0)::integer as earned_total,
      abs(coalesce((
        select sum(ledger_entries.amount)
        from ledger_entries
        where ledger_entries.account_id = ${accountId}
          and ledger_entries.amount < 0
      ), 0))::integer as given_total,
      coalesce((
        select sum(issues.opening_reserve_points)
        from issues
        join registered_repositories as repositories on repositories.id = issues.repository_id
        join users as sponsors on sponsors.id = repositories.sponsor_id
        where repositories.sponsor_id = ${accountId}
          and issues.state = 'OPEN'
          and issues.claim_assignee_github_login is not null
          and lower(issues.claim_assignee_github_login) <> lower(sponsors.github_login)
      ), 0)::integer as reserved_points
  `;
  const recentSettlementRows = await sql<RecentSettlementRow[]>`
    select
      settlements.id,
      repositories.owner_name as repository_name,
      issues.issue_number,
      issues.title as issue_title,
      issues.url as issue_url,
      pull_requests.pull_request_number,
      pull_requests.title as pull_request_title,
      pull_requests.url as pull_request_url,
      settlements.proof_sha256,
      settlements.credits,
      settlements.review_rounds,
      settlements.created_at as settled_at
    from settlements
    join issues on issues.id = settlements.issue_id
    join pull_requests on pull_requests.id = settlements.pull_request_id
    join registered_repositories as repositories on repositories.id = issues.repository_id
    where (settlements.creditor_id = ${accountId} or settlements.debtor_id = ${accountId})
      and settlements.status in ('SETTLED', 'UNCLAIMED')
    order by settlements.created_at desc
    limit 5
  `;

  const settledBalance = readNumber(row?.settled_balance ?? 0, "Settled balance");
  const reservedPoints = readNumber(row?.reserved_points ?? 0, "Reserved points");
  const projection: DashboardProjection = {
    settledBalance,
    earnedTotal: readNumber(row?.earned_total ?? 0, "Earned total"),
    givenTotal: readNumber(row?.given_total ?? 0, "Given total"),
    reservedPoints,
    availableHeadroom: settledBalance - reservedPoints,
    recentSettlements: recentSettlementRows.map(toRecentSettlementProjection),
  };
  if (dependencies.creditFloor !== undefined) {
    projection.creditFloor = dependencies.creditFloor;
  }
  return projection;
}

export async function listEligibleIssues(
  accountId: string,
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<EligibleIssueProjection[]> {
  const sql = resolveSql(dependencies);
  const rows = await sql<EligibleIssueRow[]>`
    select
      issues.id,
      repositories.owner_name as repository_name,
      issues.issue_number,
      issues.title,
      issues.url,
      repositories.difficulty_scheme ->> 'openingName' as opening_name,
      issues.opening_label,
      issues.opening_comparison_points,
      issues.opening_reserve_points,
      issues.created_at
    from issues
    join registered_repositories as repositories on repositories.id = issues.repository_id
    join users as sponsors on sponsors.id = repositories.sponsor_id
    where issues.state = 'OPEN'
      and issues.claim_assignee_github_login is null
      and repositories.active = true
      and sponsors.id <> ${accountId}
      and sponsors.enforcement_state in ('ACTIVE', 'WARNED', 'UNDER_AUDIT')
    order by
      issues.opening_reserve_points desc,
      issues.created_at asc
  `;

  return rows.map((row) => ({
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
  }));
}

export async function getSettlementProof(
  accountId: string,
  settlementId: string,
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<SettlementProofProjection | null> {
  const sql = resolveSql(dependencies);
  const [row] = await sql<SettlementProofRow[]>`
    select
      settlements.id,
      settlements.status::text as status,
      repositories.owner_name as repository_name,
      issues.issue_number,
      issues.title as issue_title,
      issues.url as issue_url,
      pull_requests.pull_request_number,
      pull_requests.title as pull_request_title,
      pull_requests.url as pull_request_url,
      settlements.proof_sha256,
      settlements.opening_comparison_points,
      settlements.settled_points,
      settlements.review_rounds,
      settlements.credits,
      settlements.created_at as settled_at
    from settlements
    join issues on issues.id = settlements.issue_id
    join pull_requests on pull_requests.id = settlements.pull_request_id
    join registered_repositories as repositories on repositories.id = issues.repository_id
    where settlements.id = ${settlementId}
      and (settlements.creditor_id = ${accountId} or settlements.debtor_id = ${accountId})
    limit 1
  `;
  if (row === undefined) {
    return null;
  }

  return {
    id: readText(row.id, "Settlement identifier"),
    status: readSettlementStatus(row.status),
    repositoryName: readText(row.repository_name, "Repository name"),
    issueNumber: readNumber(row.issue_number, "Issue number"),
    issueTitle: readText(row.issue_title, "Issue title"),
    issueUrl: readText(row.issue_url, "Issue URL"),
    pullRequestNumber: readNumber(row.pull_request_number, "Pull request number"),
    pullRequestTitle: readText(row.pull_request_title, "Pull request title"),
    pullRequestUrl: readText(row.pull_request_url, "Pull request URL"),
    proofSha256: readText(row.proof_sha256, "Settlement proof"),
    openingComparisonPoints: readNumber(row.opening_comparison_points, "Opening comparison points"),
    settledPoints: row.settled_points === null ? null : readNumber(row.settled_points, "Settled points"),
    reviewRounds: readNumber(row.review_rounds, "Review rounds"),
    credits: readNumber(row.credits, "Credits"),
    settledAt: readTimestamp(row.settled_at, "Settlement time"),
  };
}

export async function getCalibrationComparison(
  accountId: string,
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<CalibrationComparison> {
  const sql = resolveSql(dependencies);
  const selfWorkRows = await sql<CalibrationRow[]>`
    select
      repositories.github_repository_id,
      issues.github_issue_id,
      pull_requests.github_pull_request_id,
      pull_requests.proof_sha256,
      self_work_calibrations.opening_comparison_points as offered_difficulty,
      self_work_calibrations.actual_points as settled_difficulty
    from self_work_calibrations
    join issues on issues.id = self_work_calibrations.issue_id
    join pull_requests on pull_requests.id = self_work_calibrations.pull_request_id
    join registered_repositories as repositories on repositories.id = issues.repository_id
    where self_work_calibrations.user_id = ${accountId}
      and self_work_calibrations.actual_points is not null
      and pull_requests.proof_sha256 is not null
    order by repositories.github_repository_id, issues.github_issue_id, pull_requests.github_pull_request_id
  `;
  const outsiderRows = await sql<CalibrationRow[]>`
    select
      repositories.github_repository_id,
      issues.github_issue_id,
      pull_requests.github_pull_request_id,
      settlements.proof_sha256,
      settlements.opening_comparison_points as offered_difficulty,
      settlements.settled_points as settled_difficulty
    from settlements
    join issues on issues.id = settlements.issue_id
    join pull_requests on pull_requests.id = settlements.pull_request_id
    join registered_repositories as repositories on repositories.id = issues.repository_id
    where settlements.debtor_id = ${accountId}
      and settlements.creditor_id is not null
      and settlements.creditor_id <> ${accountId}
      and settlements.status = 'SETTLED'
      and settlements.settled_points is not null
    order by repositories.github_repository_id, issues.github_issue_id, pull_requests.github_pull_request_id
  `;

  return compareCalibration(selfWorkRows.map(toCalibrationPair), outsiderRows.map(toCalibrationPair));
}

export async function listOpenAudits(
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<OpenAuditProjection[]> {
  const sql = resolveSql(dependencies);
  const rows = await sql<OpenAuditRow[]>`
    select
      calibration_audits.id,
      calibration_audits.account_id as target_account_id,
      targets.github_login as target_login,
      reporters.github_login as reporter_login,
      repositories.owner_name as repository_name,
      calibration_audits.opened_at,
      calibration_audits.settled_sample_size,
      calibration_audits.cohort_statistics
    from calibration_audits
    join users as targets on targets.id = calibration_audits.account_id
    join users as reporters on reporters.id = calibration_audits.reporter_id
    left join registered_repositories as repositories on repositories.id = calibration_audits.repository_id
    where calibration_audits.state = 'OPEN'
    order by calibration_audits.opened_at asc
  `;

  return rows.map((row) => ({
    id: readText(row.id, "Audit identifier"),
    targetAccountId: readText(row.target_account_id, "Target account identifier"),
    targetLogin: readText(row.target_login, "Target login"),
    reporterLogin: readText(row.reporter_login, "Reporter login"),
    repositoryName: row.repository_name === null ? null : readText(row.repository_name, "Repository name"),
    openedAt: readTimestamp(row.opened_at, "Audit opening time"),
    settledSampleSize: readNumber(row.settled_sample_size, "Settled sample size"),
    differenceBetweenMeans: readDifferenceBetweenMeans(row.cohort_statistics),
  }));
}

export function readConfiguredCreditFloor(value = process.env.CREDIT_FLOOR): number | undefined {
  if (value === undefined || value.trim().length === 0) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : undefined;
}

function resolveSql(dependencies: Pick<DashboardQueryDependencies, "sql">): DashboardSql {
  return dependencies.sql ?? (getSql() as unknown as DashboardSql);
}

function toCalibrationPair(row: CalibrationRow): CalibrationPair {
  return {
    githubRepositoryId: readNumber(row.github_repository_id, "GitHub repository identifier"),
    githubIssueId: readNumber(row.github_issue_id, "GitHub issue identifier"),
    githubPullRequestId: readNumber(row.github_pull_request_id, "GitHub pull request identifier"),
    proofSha256: readText(row.proof_sha256, "GitHub proof fingerprint"),
    offeredDifficulty: readNumber(row.offered_difficulty, "Offered difficulty"),
    settledDifficulty: readNumber(row.settled_difficulty, "Settled difficulty"),
  };
}

function toRecentSettlementProjection(row: RecentSettlementRow): RecentSettlementProjection {
  return {
    id: readText(row.id, "Settlement identifier"),
    repositoryName: readText(row.repository_name, "Repository name"),
    issueNumber: readNumber(row.issue_number, "Issue number"),
    issueTitle: readText(row.issue_title, "Issue title"),
    issueUrl: readText(row.issue_url, "Issue URL"),
    pullRequestNumber: readNumber(row.pull_request_number, "Pull request number"),
    pullRequestTitle: readText(row.pull_request_title, "Pull request title"),
    pullRequestUrl: readText(row.pull_request_url, "Pull request URL"),
    proofSha256: readText(row.proof_sha256, "Settlement proof"),
    credits: readNumber(row.credits, "Credits"),
    reviewRounds: readNumber(row.review_rounds, "Review rounds"),
    settledAt: readTimestamp(row.settled_at, "Settlement time"),
  };
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

function readSettlementStatus(value: string): SettlementProofProjection["status"] {
  if (value === "SETTLED" || value === "UNSETTLED" || value === "UNCLAIMED") {
    return value;
  }
  throw new Error("Settlement status was invalid.");
}

function readDifferenceBetweenMeans(value: unknown): number {
  if (typeof value !== "object" || value === null || !("differenceBetweenMeans" in value)) {
    return 0;
  }
  return readNumber(value.differenceBetweenMeans, "Calibration difference between means");
}
