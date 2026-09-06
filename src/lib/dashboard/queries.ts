import { compareCalibration, type CalibrationComparison, type CalibrationPair } from "@/lib/calibration/statistics";
import { getSql } from "@/lib/db/client";
import type { ReconciliationJobState } from "@/lib/fold/reconciliation-jobs";

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
  enforcementState?: string;
  openClaims: OpenClaimProjection[];
  registeredRepositories: RegisteredRepositoryProjection[];
  enforcementNotices: EnforcementNoticeProjection[];
};

export type OpenClaimProjection = {
  id: string;
  repositoryName: string;
  issueNumber: number;
  title: string;
  url: string;
  assigneeGitHubLogin: string;
  openingName: string;
  openingLabel: string;
  reservePoints: number;
};

export type RegisteredRepositoryProjection = {
  id: string;
  ownerName: string;
  visibility: string;
  active: boolean;
  openingName: string;
  actualName: string;
  unavailableReason: string | null;
  /** `IDLE` is the no-row case: a job deletes its own row on success, so nothing outstanding is nothing to say. */
  reconciliationState: "IDLE" | ReconciliationJobState;
  reconciliationLastFailureAt: Date | null;
};

export type EnforcementNoticeProjection = {
  id: string;
  priorState: string;
  newState: string;
  reason: string;
  createdAt: string;
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

export type SettlementStatus = "SETTLED" | "UNSETTLED" | "UNCLAIMED";

/** One row of the member's settlement history, including work that was found and scored zero. */
export type SettlementHistoryProjection = {
  id: string;
  status: SettlementStatus;
  repositoryName: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  credits: number;
  reviewRounds: number;
  balanceEffect: number;
  settledAt: string;
};

/** The settlement history is unpaginated, so it is capped at a depth a member can still read. */
export const SETTLEMENT_HISTORY_LIMIT = 200;

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

export type SettlementProofProjection = {
  id: string;
  status: SettlementStatus;
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
  openingName?: string;
  actualName?: string;
  openingLabel?: string;
  settledLabel?: string | null;
  settledLabelEventId?: string | null;
  settledLabelActorLogin?: string | null;
  settledLabelAppliedAt?: string | null;
  settledRationaleCommentId?: string | null;
  settledRationaleActorLogin?: string | null;
  settledRationaleCommentedAt?: string | null;
  mergeCommitOid?: string | null;
  mergedAt?: string | null;
  balanceEffect?: number;
};

/**
 * The evidence behind a closure the fold calibrated instead of settling.
 *
 * A sponsor who closes their own issue is both parties, so no credits move and
 * there is no settlement row to point at. The comparison the account is judged
 * on is recorded here instead, and the actual figure is absent whenever the
 * closure's settled evidence was rejected.
 */
export type SelfWorkCalibrationProofProjection = {
  id: string;
  repositoryName: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  pullRequestNumber: number;
  pullRequestTitle: string;
  pullRequestUrl: string;
  proofSha256: string | null;
  openingComparisonPoints: number;
  actualPoints: number | null;
  openingName?: string;
  actualName?: string;
  openingLabel?: string;
  actualLabel?: string | null;
  mergeCommitOid?: string | null;
  mergedAt?: string | null;
};

/** One row of the sponsor's self-work calibrations, enough to link to its proof. */
export type SelfWorkCalibrationProjection = {
  id: string;
  repositoryName: string;
  issueNumber: number;
  issueTitle: string;
  openingComparisonPoints: number;
  actualPoints: number | null;
  mergedAt: string | null;
};

/** The calibration list is unpaginated, so it is capped the way the settlement history is. */
export const SELF_WORK_CALIBRATION_HISTORY_LIMIT = 200;

export type OpenAuditProjection = {
  id: string;
  targetAccountId: string;
  targetLogin: string;
  reporterLogin: string;
  repositoryName: string | null;
  openedAt: string;
  settledSampleSize: number;
  differenceBetweenMeans: number;
  state?: string;
  priorEnforcementState?: string;
  sampleStartedAt?: string;
  sampleEndedAt?: string;
  cohortDefinition?: unknown;
  cohortStatistics?: unknown;
};

export type UnwritableClosureProjection = {
  id: string;
  kind:
    | "NO_CLOSING_PULL_REQUEST"
    | "SETTLEMENT_EVIDENCE_REJECTED"
    | "CROSS_REPOSITORY_CLOSING_PULL_REQUEST";
  reason: string;
  recordedAt: string;
  repositoryName: string;
  issueNumber: number;
  issueTitle: string;
  issueUrl: string;
  pullRequest: { number: number; title: string; url: string } | null;
  settlementId: string | null;
  settlementParties: { creditorLogin: string | null; debtorLogin: string } | null;
  calibrationId: string | null;
  calibrationOwnerLogin: string | null;
  latestCorrection: { state: "OPEN" | "GRANTED" | "DECLINED"; requestedAt: string } | null;
};

export type EnforcementHistoryProjection = {
  id: string;
  targetAccountId: string;
  targetLogin: string;
  actorLogin: string;
  priorState: string;
  newState: string;
  reason: string;
  recalibrationPlan: unknown;
  createdAt: string;
};

export type RecalibratingAccountProjection = {
  id: string;
  githubLogin: string;
  confirmedPatternCount: number;
};

/**
 * One account a moderator may open an audit against. The pair counts are unwindowed and unscoped, so
 * they are an upper bound on what any particular sample window yields; the audit preview is what tells
 * a moderator whether a specific window qualifies.
 */
export type AuditCandidateProjection = {
  id: string;
  githubLogin: string;
  enforcementState: string;
  selfWorkPairCount: number;
  outsiderPairCount: number;
  openAuditId: string | null;
};

export type ModerationRepositoryProjection = {
  id: string;
  ownerName: string;
};

export type DashboardQueryDependencies = {
  sql?: DashboardSql;
};

type DashboardRow = {
  settled_balance: number | string | null;
  earned_total: number | string | null;
  given_total: number | string | null;
  reserved_points: number | string | null;
  enforcement_state?: string;
};

type OpenClaimRow = {
  id: string;
  repository_name: string;
  issue_number: number | string;
  title: string;
  url: string;
  assignee_github_login: string;
  opening_name: string;
  opening_label: string;
  reserve_points: number | string;
};

type RegisteredRepositoryRow = {
  id: string;
  owner_name: string;
  visibility: string;
  active: boolean;
  opening_name: string;
  actual_name: string;
  unavailable_reason: string | null;
  reconciliation_state: string | null;
  reconciliation_last_failure_at: Date | string | null;
};

type EnforcementNoticeRow = {
  id: string;
  prior_state: string;
  new_state: string;
  reason: string;
  created_at: string | Date;
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

type SettlementHistoryRow = {
  id: string;
  status: string;
  repository_name: string;
  issue_number: number | string;
  issue_title: string;
  issue_url: string;
  credits: number | string;
  review_rounds: number | string;
  balance_effect: number | string;
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
  sponsor_login?: string;
  claim_assignee_github_login?: string | null;
  available_headroom?: number | string;
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
  opening_name?: string;
  actual_name?: string;
  opening_label?: string;
  settled_label?: string | null;
  settled_label_event_id?: string | null;
  settled_label_actor_login?: string | null;
  settled_label_applied_at?: string | Date | null;
  settled_rationale_comment_id?: string | null;
  settled_rationale_actor_login?: string | null;
  settled_rationale_commented_at?: string | Date | null;
  merge_commit_oid?: string | null;
  merged_at?: string | Date | null;
  balance_effect?: number | string;
};

type SelfWorkCalibrationProofRow = {
  id: string;
  repository_name: string;
  issue_number: number | string;
  issue_title: string;
  issue_url: string;
  pull_request_number: number | string;
  pull_request_title: string;
  pull_request_url: string;
  proof_sha256: string | null;
  opening_comparison_points: number | string;
  actual_points: number | string | null;
  opening_name?: string;
  actual_name?: string;
  opening_label?: string;
  actual_label?: string | null;
  merge_commit_oid?: string | null;
  merged_at?: string | Date | null;
};

type SelfWorkCalibrationRow = {
  id: string;
  repository_name: string;
  issue_number: number | string;
  issue_title: string;
  opening_comparison_points: number | string;
  actual_points: number | string | null;
  merged_at: string | Date | null;
};

type CalibrationRow = {
  github_repository_id: number | string;
  github_issue_id: number | string;
  github_pull_request_id: number | string;
  merged_at: string | Date;
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
  state?: string;
  prior_enforcement_state?: string;
  sample_started_at?: string | Date;
  sample_ended_at?: string | Date;
  cohort_definition?: unknown;
};

type UnwritableClosureRow = {
  id: string;
  kind: UnwritableClosureProjection["kind"];
  reason: string;
  recorded_at: string | Date;
  repository_name: string;
  issue_number: number | string;
  issue_title: string;
  issue_url: string;
  pull_request_number: number | string | null;
  pull_request_title: string | null;
  pull_request_url: string | null;
  settlement_id: string | null;
  creditor_login: string | null;
  debtor_login: string | null;
  calibration_id: string | null;
  calibration_owner_login: string | null;
  correction_state: "OPEN" | "GRANTED" | "DECLINED" | null;
  correction_requested_at: string | Date | null;
};

type EnforcementHistoryRow = {
  id: string;
  target_account_id: string;
  target_login: string;
  actor_login: string;
  prior_state: string;
  new_state: string;
  reason: string;
  recalibration_plan: unknown;
  created_at: string | Date;
};

type RecalibratingAccountRow = {
  id: string;
  github_login: string;
  confirmed_miscalibration_count: number | string;
};

type AuditCandidateRow = {
  id: string;
  github_login: string;
  enforcement_state: string;
  self_work_pair_count: number | string;
  outsider_pair_count: number | string;
  open_audit_id: string | null;
};

type ModerationRepositoryRow = {
  id: string;
  owner_name: string;
};

/** Loads materialized ledger and reservation values; overcommitment remains visible as negative headroom. */
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
      ), 0)::integer as reserved_points,
      (select users.enforcement_state::text from users where users.id = ${accountId}) as enforcement_state
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
  const openClaimRows = await sql<OpenClaimRow[]>`
    select
      issues.id,
      repositories.owner_name as repository_name,
      issues.issue_number,
      issues.title,
      issues.url,
      issues.claim_assignee_github_login as assignee_github_login,
      repositories.difficulty_scheme ->> 'openingName' as opening_name,
      issues.opening_label,
      issues.opening_reserve_points as reserve_points
    from issues
    join registered_repositories as repositories on repositories.id = issues.repository_id
    where repositories.sponsor_id = ${accountId}
      and issues.state = 'OPEN'
      and issues.claim_assignee_github_login is not null
    order by issues.created_at asc, issues.id
  `;
  // A repository owns at most one reconciliation job, enforced by a unique constraint, so a plain
  // left join cannot multiply the repository rows and needs no precedence ordering to pick a job.
  const registeredRepositoryRows = await sql<RegisteredRepositoryRow[]>`
    select
      repositories.id,
      repositories.owner_name,
      repositories.visibility::text,
      repositories.active,
      repositories.difficulty_scheme ->> 'openingName' as opening_name,
      repositories.difficulty_scheme ->> 'actualName' as actual_name,
      repositories.unavailable_reason,
      jobs.state::text as reconciliation_state,
      jobs.last_failure_at as reconciliation_last_failure_at
    from registered_repositories as repositories
    left join repository_reconciliation_jobs as jobs on jobs.repository_id = repositories.id
    where repositories.sponsor_id = ${accountId}
    order by repositories.owner_name, repositories.id
  `;
  const enforcementNoticeRows = await sql<EnforcementNoticeRow[]>`
    select id, prior_state::text, new_state::text, reason, created_at
    from moderation_events
    where target_user_id = ${accountId}
    order by created_at desc, id desc
    limit 10
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
    openClaims: openClaimRows.map((claim) => ({
      id: readText(claim.id, "Claim identifier"),
      repositoryName: readText(claim.repository_name, "Claim repository"),
      issueNumber: readNumber(claim.issue_number, "Claim issue number"),
      title: readText(claim.title, "Claim title"),
      url: readText(claim.url, "Claim URL"),
      assigneeGitHubLogin: readText(claim.assignee_github_login, "Claim assignee"),
      openingName: readText(claim.opening_name, "Claim opening catalog name"),
      openingLabel: readText(claim.opening_label, "Claim opening label"),
      reservePoints: readNumber(claim.reserve_points, "Claim reserve points"),
    })),
    registeredRepositories: registeredRepositoryRows.map((repository) => ({
      id: readText(repository.id, "Repository identifier"),
      ownerName: readText(repository.owner_name, "Repository name"),
      visibility: readText(repository.visibility, "Repository visibility"),
      active: repository.active,
      openingName: readText(repository.opening_name, "Repository opening catalog name"),
      actualName: readText(repository.actual_name, "Repository actual catalog name"),
      unavailableReason: repository.unavailable_reason === null
        ? null
        : readText(repository.unavailable_reason, "Repository unavailability reason"),
      reconciliationState: readReconciliationState(
        repository.reconciliation_state,
        "Repository reconciliation state",
      ),
      reconciliationLastFailureAt: readNullableDate(
        repository.reconciliation_last_failure_at,
        "Repository reconciliation failure time",
      ),
    })),
    enforcementNotices: enforcementNoticeRows.map((notice) => ({
      id: readText(notice.id, "Enforcement notice identifier"),
      priorState: readText(notice.prior_state, "Prior enforcement state"),
      newState: readText(notice.new_state, "New enforcement state"),
      reason: readText(notice.reason, "Enforcement reason"),
      createdAt: readTimestamp(notice.created_at, "Enforcement time"),
    })),
  };
  if (row?.enforcement_state !== undefined) {
    projection.enforcementState = readText(row.enforcement_state, "Enforcement state");
  }
  return projection;
}

export async function listEligibleIssues(
  accountId: string,
  filters: EligibleIssueFilters = {},
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<EligibleIssueProjection[]> {
  const sql = resolveSql(dependencies);
  const repositoryFilter = normalizedFilter(filters.repository);
  const openingLabelFilter = normalizedFilter(filters.openingLabel);
  const claimState = filters.claimState ?? "OPEN";
  const rows = await sql<EligibleIssueRow[]>`
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
      (
        coalesce((select balances.balance from balances where balances.account_id = sponsors.id), 0)
        - coalesce((
          select sum(reserved.opening_reserve_points)
          from issues as reserved
          where reserved.repository_id in (
            select sponsored.id from registered_repositories as sponsored where sponsored.sponsor_id = sponsors.id
          )
            and reserved.state = 'OPEN'
            and reserved.claim_assignee_github_login is not null
            and lower(reserved.claim_assignee_github_login) <> lower(sponsors.github_login)
        ), 0)
      )::integer as available_headroom,
      issues.created_at
    from issues
    join registered_repositories as repositories on repositories.id = issues.repository_id
    join users as sponsors on sponsors.id = repositories.sponsor_id
    where issues.state = 'OPEN'
      and repositories.active = true
      and sponsors.id <> ${accountId}
      and sponsors.enforcement_state in ('ACTIVE', 'WARNED', 'UNDER_AUDIT')
      and (${repositoryFilter}::text is null or repositories.owner_name = ${repositoryFilter})
      and (${openingLabelFilter}::text is null or issues.opening_label = ${openingLabelFilter})
      and (
        ${claimState}::text = 'ALL'
        or (${claimState}::text = 'OPEN' and issues.claim_assignee_github_login is null)
        or (${claimState}::text = 'CLAIMED' and issues.claim_assignee_github_login is not null)
      )
    order by
      issues.opening_reserve_points desc,
      issues.created_at asc
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

/**
 * Lists every settlement the account is party to, newest first. `UNSETTLED` rows stay in the list because
 * work that merged and scored zero is part of the record a balance was built from.
 */
export async function listSettlementHistory(
  accountId: string,
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<SettlementHistoryProjection[]> {
  const sql = resolveSql(dependencies);
  const rows = await sql<SettlementHistoryRow[]>`
    select
      settlements.id,
      settlements.status::text as status,
      repositories.owner_name as repository_name,
      issues.issue_number,
      issues.title as issue_title,
      issues.url as issue_url,
      settlements.credits,
      settlements.review_rounds,
      settlements.created_at as settled_at,
      case
        when settlements.status = 'SETTLED' and settlements.creditor_id = ${accountId} then settlements.credits
        when settlements.status = 'SETTLED' and settlements.debtor_id = ${accountId} then -settlements.credits
        else 0
      end::integer as balance_effect
    from settlements
    join issues on issues.id = settlements.issue_id
    join registered_repositories as repositories on repositories.id = issues.repository_id
    where (settlements.creditor_id = ${accountId} or settlements.debtor_id = ${accountId})
    order by settlements.created_at desc, settlements.id desc
    limit ${SETTLEMENT_HISTORY_LIMIT}
  `;
  return rows.map((row) => ({
    id: readText(row.id, "Settlement identifier"),
    status: readSettlementStatus(row.status),
    repositoryName: readText(row.repository_name, "Repository name"),
    issueNumber: readNumber(row.issue_number, "Issue number"),
    issueTitle: readText(row.issue_title, "Issue title"),
    issueUrl: readText(row.issue_url, "Issue URL"),
    credits: readNumber(row.credits, "Credits"),
    reviewRounds: readNumber(row.review_rounds, "Review rounds"),
    balanceEffect: readNumber(row.balance_effect, "Balance effect"),
    settledAt: readTimestamp(row.settled_at, "Settlement time"),
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
      repositories.difficulty_scheme ->> 'openingName' as opening_name,
      repositories.difficulty_scheme ->> 'actualName' as actual_name,
      issues.issue_number,
      issues.title as issue_title,
      issues.url as issue_url,
      issues.opening_label,
      issues.settled_label,
      issues.settled_label_event_id,
      issues.settled_label_actor_login,
      issues.settled_label_applied_at,
      issues.settled_rationale_comment_id,
      issues.settled_rationale_actor_login,
      issues.settled_rationale_commented_at,
      pull_requests.pull_request_number,
      pull_requests.title as pull_request_title,
      pull_requests.url as pull_request_url,
      pull_requests.merge_commit_oid,
      pull_requests.merged_at,
      settlements.proof_sha256,
      settlements.opening_comparison_points,
      settlements.settled_points,
      settlements.review_rounds,
      settlements.credits,
      settlements.created_at as settled_at,
      case
        when settlements.status = 'SETTLED' and settlements.creditor_id = ${accountId} then settlements.credits
        when settlements.status = 'SETTLED' and settlements.debtor_id = ${accountId} then -settlements.credits
        else 0
      end::integer as balance_effect
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

  const projection: SettlementProofProjection = {
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
  if (row.opening_name !== undefined) {
    projection.openingName = readText(row.opening_name, "Opening catalog name");
  }
  if (row.actual_name !== undefined) {
    projection.actualName = readText(row.actual_name, "Actual catalog name");
  }
  if (row.opening_label !== undefined) {
    projection.openingLabel = readText(row.opening_label, "Opening label");
  }
  if (row.settled_label !== undefined) {
    projection.settledLabel = row.settled_label;
    projection.settledLabelEventId = row.settled_label_event_id ?? null;
    projection.settledLabelActorLogin = row.settled_label_actor_login ?? null;
    projection.settledLabelAppliedAt = readNullableTimestamp(row.settled_label_applied_at, "Settled label time");
    projection.settledRationaleCommentId = row.settled_rationale_comment_id ?? null;
    projection.settledRationaleActorLogin = row.settled_rationale_actor_login ?? null;
    projection.settledRationaleCommentedAt = readNullableTimestamp(
      row.settled_rationale_commented_at,
      "Settled rationale time",
    );
  }
  if (row.merge_commit_oid !== undefined) {
    projection.mergeCommitOid = readNullableMergeOid(row.merge_commit_oid);
    projection.mergedAt = readNullableTimestamp(row.merged_at, "Merge time");
  }
  if (row.balance_effect !== undefined) {
    projection.balanceEffect = readNumber(row.balance_effect, "Balance effect");
  }
  return projection;
}

/**
 * The proof a sponsor can read for their own closure, withheld from every other
 * account: the calibration is the only record of work they were priced on, and
 * `user_id` is what makes it theirs.
 *
 * The actual label is read back from the issue rather than the calibration,
 * because the fold derives one settled difficulty per closure and writes the
 * label on the issue and the points on the calibration. Both are absent
 * together on a closure whose settled evidence was rejected.
 */
export async function getSelfWorkCalibrationProof(
  accountId: string,
  calibrationId: string,
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<SelfWorkCalibrationProofProjection | null> {
  const sql = resolveSql(dependencies);
  const [row] = await sql<SelfWorkCalibrationProofRow[]>`
    select
      self_work_calibrations.id,
      repositories.owner_name as repository_name,
      repositories.difficulty_scheme ->> 'openingName' as opening_name,
      repositories.difficulty_scheme ->> 'actualName' as actual_name,
      issues.issue_number,
      issues.title as issue_title,
      issues.url as issue_url,
      issues.opening_label,
      issues.settled_label as actual_label,
      pull_requests.pull_request_number,
      pull_requests.title as pull_request_title,
      pull_requests.url as pull_request_url,
      pull_requests.merge_commit_oid,
      pull_requests.merged_at,
      pull_requests.proof_sha256,
      self_work_calibrations.opening_comparison_points,
      self_work_calibrations.actual_points
    from self_work_calibrations
    join issues on issues.id = self_work_calibrations.issue_id
    join pull_requests on pull_requests.id = self_work_calibrations.pull_request_id
    join registered_repositories as repositories on repositories.id = issues.repository_id
    where self_work_calibrations.id = ${calibrationId}
      and self_work_calibrations.user_id = ${accountId}
    limit 1
  `;
  if (row === undefined) {
    return null;
  }

  const projection: SelfWorkCalibrationProofProjection = {
    id: readText(row.id, "Calibration identifier"),
    repositoryName: readText(row.repository_name, "Repository name"),
    issueNumber: readNumber(row.issue_number, "Issue number"),
    issueTitle: readText(row.issue_title, "Issue title"),
    issueUrl: readText(row.issue_url, "Issue URL"),
    pullRequestNumber: readNumber(row.pull_request_number, "Pull request number"),
    pullRequestTitle: readText(row.pull_request_title, "Pull request title"),
    pullRequestUrl: readText(row.pull_request_url, "Pull request URL"),
    proofSha256: row.proof_sha256 === null ? null : readText(row.proof_sha256, "Closing-link proof"),
    openingComparisonPoints: readNumber(row.opening_comparison_points, "Opening comparison points"),
    actualPoints: row.actual_points === null ? null : readNumber(row.actual_points, "Actual points"),
  };
  if (row.opening_name !== undefined) {
    projection.openingName = readText(row.opening_name, "Opening catalog name");
  }
  if (row.actual_name !== undefined) {
    projection.actualName = readText(row.actual_name, "Actual catalog name");
  }
  if (row.opening_label !== undefined) {
    projection.openingLabel = readText(row.opening_label, "Opening label");
  }
  if (row.actual_label !== undefined) {
    projection.actualLabel = readNullableText(row.actual_label, "Actual label");
  }
  if (row.merge_commit_oid !== undefined) {
    projection.mergeCommitOid = readNullableMergeOid(row.merge_commit_oid);
    projection.mergedAt = readNullableTimestamp(row.merged_at, "Merge time");
  }
  return projection;
}

/**
 * Every closure this account was calibrated on, newest merge first, including
 * the ones with no actual figure: a calibration that recorded nothing is the
 * one a sponsor most needs to find.
 */
export async function listSelfWorkCalibrations(
  accountId: string,
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<SelfWorkCalibrationProjection[]> {
  const sql = resolveSql(dependencies);
  const rows = await sql<SelfWorkCalibrationRow[]>`
    select
      self_work_calibrations.id,
      repositories.owner_name as repository_name,
      issues.issue_number,
      issues.title as issue_title,
      self_work_calibrations.opening_comparison_points,
      self_work_calibrations.actual_points,
      pull_requests.merged_at
    from self_work_calibrations
    join issues on issues.id = self_work_calibrations.issue_id
    join pull_requests on pull_requests.id = self_work_calibrations.pull_request_id
    join registered_repositories as repositories on repositories.id = issues.repository_id
    where self_work_calibrations.user_id = ${accountId}
    order by pull_requests.merged_at desc nulls last, self_work_calibrations.id desc
    limit ${SELF_WORK_CALIBRATION_HISTORY_LIMIT}
  `;
  return rows.map((row) => ({
    id: readText(row.id, "Calibration identifier"),
    repositoryName: readText(row.repository_name, "Repository name"),
    issueNumber: readNumber(row.issue_number, "Issue number"),
    issueTitle: readText(row.issue_title, "Issue title"),
    openingComparisonPoints: readNumber(row.opening_comparison_points, "Opening comparison points"),
    actualPoints: row.actual_points === null ? null : readNumber(row.actual_points, "Actual points"),
    mergedAt: readNullableTimestamp(row.merged_at, "Merge time"),
  }));
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
      pull_requests.merged_at,
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
      pull_requests.merged_at,
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

export async function listUnwritableClosures(
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<UnwritableClosureProjection[]> {
  const sql = resolveSql(dependencies);
  const rows = await sql<UnwritableClosureRow[]>`
    select
      unwritable_closures.id,
      unwritable_closures.kind::text,
      unwritable_closures.reason,
      unwritable_closures.created_at as recorded_at,
      repositories.owner_name as repository_name,
      issues.issue_number,
      issues.title as issue_title,
      issues.url as issue_url,
      pull_requests.pull_request_number,
      pull_requests.title as pull_request_title,
      pull_requests.url as pull_request_url,
      settlements.id as settlement_id,
      creditors.github_login as creditor_login,
      debtors.github_login as debtor_login,
      calibrations.id as calibration_id,
      calibration_owners.github_login as calibration_owner_login,
      latest_correction.state::text as correction_state,
      latest_correction.created_at as correction_requested_at
    from unwritable_closures
    join issues on issues.id = unwritable_closures.issue_id
    join registered_repositories as repositories on repositories.id = issues.repository_id
    left join pull_requests on pull_requests.id = unwritable_closures.pull_request_id
    left join settlements on settlements.issue_id = issues.id
    left join users as creditors on creditors.id = settlements.creditor_id
    left join users as debtors on debtors.id = settlements.debtor_id
    left join self_work_calibrations as calibrations on calibrations.issue_id = issues.id
    left join users as calibration_owners on calibration_owners.id = calibrations.user_id
    left join lateral (
      select settlement_override_requests.state, settlement_override_requests.created_at
      from settlement_override_requests
      where settlement_override_requests.issue_id = issues.id
      order by settlement_override_requests.created_at desc, settlement_override_requests.id desc
      limit 1
    ) as latest_correction on true
    order by unwritable_closures.created_at desc, issues.github_issue_id asc
  `;

  return rows.map((row) => ({
    id: readText(row.id, "Closure identifier"),
    kind: row.kind,
    reason: readText(row.reason, "Closure reason"),
    recordedAt: readTimestamp(row.recorded_at, "Closure recording time"),
    repositoryName: readText(row.repository_name, "Repository name"),
    issueNumber: readNumber(row.issue_number, "Issue number"),
    issueTitle: readText(row.issue_title, "Issue title"),
    issueUrl: readText(row.issue_url, "Issue URL"),
    pullRequest: row.pull_request_number === null ? null : {
      number: readNumber(row.pull_request_number, "Pull request number"),
      title: readText(row.pull_request_title, "Pull request title"),
      url: readText(row.pull_request_url, "Pull request URL"),
    },
    settlementId: row.settlement_id === null ? null : readText(row.settlement_id, "Settlement identifier"),
    settlementParties: row.settlement_id === null ? null : {
      creditorLogin: row.creditor_login === null ? null : readText(row.creditor_login, "Creditor login"),
      debtorLogin: readText(row.debtor_login, "Debtor login"),
    },
    calibrationId: row.calibration_id === null ? null : readText(row.calibration_id, "Calibration identifier"),
    calibrationOwnerLogin:
      row.calibration_owner_login === null
        ? null
        : readText(row.calibration_owner_login, "Calibration owner login"),
    latestCorrection: row.correction_state === null ? null : {
      state: row.correction_state,
      requestedAt: readTimestamp(row.correction_requested_at!, "Correction request time"),
    },
  }));
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
      calibration_audits.state::text,
      calibration_audits.prior_enforcement_state::text,
      calibration_audits.opened_at,
      calibration_audits.sample_started_at,
      calibration_audits.sample_ended_at,
      calibration_audits.settled_sample_size,
      calibration_audits.cohort_definition,
      calibration_audits.cohort_statistics
    from calibration_audits
    join users as targets on targets.id = calibration_audits.account_id
    join users as reporters on reporters.id = calibration_audits.reporter_id
    left join registered_repositories as repositories on repositories.id = calibration_audits.repository_id
    where calibration_audits.state = 'OPEN'
    order by calibration_audits.opened_at asc
  `;

  return rows.map((row) => {
    const projection: OpenAuditProjection = {
      id: readText(row.id, "Audit identifier"),
      targetAccountId: readText(row.target_account_id, "Target account identifier"),
      targetLogin: readText(row.target_login, "Target login"),
      reporterLogin: readText(row.reporter_login, "Reporter login"),
      repositoryName: row.repository_name === null ? null : readText(row.repository_name, "Repository name"),
      openedAt: readTimestamp(row.opened_at, "Audit opening time"),
      settledSampleSize: readNumber(row.settled_sample_size, "Settled sample size"),
      differenceBetweenMeans: readDifferenceBetweenMeans(row.cohort_statistics),
    };
    if (row.state !== undefined) projection.state = readText(row.state, "Audit state");
    if (row.prior_enforcement_state !== undefined) {
      projection.priorEnforcementState = readText(row.prior_enforcement_state, "Prior enforcement state");
    }
    if (row.sample_started_at !== undefined) {
      projection.sampleStartedAt = readTimestamp(row.sample_started_at, "Sample start");
    }
    if (row.sample_ended_at !== undefined) {
      projection.sampleEndedAt = readTimestamp(row.sample_ended_at, "Sample end");
    }
    if (row.cohort_definition !== undefined) projection.cohortDefinition = row.cohort_definition;
    if (row.cohort_statistics !== undefined) projection.cohortStatistics = row.cohort_statistics;
    return projection;
  });
}

export async function listEnforcementHistory(
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<EnforcementHistoryProjection[]> {
  const sql = resolveSql(dependencies);
  const rows = await sql<EnforcementHistoryRow[]>`
    select
      moderation_events.id,
      moderation_events.target_user_id as target_account_id,
      targets.github_login as target_login,
      actors.github_login as actor_login,
      moderation_events.prior_state::text,
      moderation_events.new_state::text,
      moderation_events.reason,
      moderation_events.recalibration_plan,
      moderation_events.created_at
    from moderation_events
    join users as targets on targets.id = moderation_events.target_user_id
    join users as actors on actors.id = moderation_events.actor_id
    order by moderation_events.created_at desc, moderation_events.id desc
    limit 100
  `;
  return rows.map((row) => ({
    id: readText(row.id, "Moderation event identifier"),
    targetAccountId: readText(row.target_account_id, "Moderation target identifier"),
    targetLogin: readText(row.target_login, "Moderation target login"),
    actorLogin: readText(row.actor_login, "Moderation actor login"),
    priorState: readText(row.prior_state, "Prior enforcement state"),
    newState: readText(row.new_state, "New enforcement state"),
    reason: readText(row.reason, "Moderation reason"),
    recalibrationPlan: row.recalibration_plan,
    createdAt: readTimestamp(row.created_at, "Moderation event time"),
  }));
}

export async function listRecalibratingAccounts(
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<RecalibratingAccountProjection[]> {
  const sql = resolveSql(dependencies);
  const rows = await sql<RecalibratingAccountRow[]>`
    select id, github_login, confirmed_miscalibration_count
    from users
    where enforcement_state = 'RECALIBRATING'
    order by github_login, id
  `;
  return rows.map((row) => ({
    id: readText(row.id, "Recalibrating account identifier"),
    githubLogin: readText(row.github_login, "Recalibrating account login"),
    confirmedPatternCount: readNumber(row.confirmed_miscalibration_count, "Confirmed pattern count"),
  }));
}

export async function listAuditCandidates(
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<AuditCandidateProjection[]> {
  const sql = resolveSql(dependencies);
  // These cohort predicates are shared with getCalibrationComparison above and with
  // listSelfWorkPairs/listOutsiderSettlementPairs in src/lib/moderation/postgres-store.ts; change all three together.
  // Each side aggregates once and joins on the account, rather than re-aggregating per account row:
  // neither self_work_calibrations.user_id nor settlements.debtor_id is indexed. Inside the outsider
  // group the comparison's creditor_id <> account test is spelled against settlements.debtor_id, which
  // the join then binds to users.id.
  const rows = await sql<AuditCandidateRow[]>`
    select
      users.id,
      users.github_login,
      users.enforcement_state::text,
      coalesce(self_work.pair_count, 0) as self_work_pair_count,
      coalesce(outsider.pair_count, 0) as outsider_pair_count,
      calibration_audits.id as open_audit_id
    from users
    left join (
      select self_work_calibrations.user_id, count(*) as pair_count
      from self_work_calibrations
      join pull_requests on pull_requests.id = self_work_calibrations.pull_request_id
      where self_work_calibrations.actual_points is not null
        and pull_requests.proof_sha256 is not null
      group by self_work_calibrations.user_id
    ) as self_work on self_work.user_id = users.id
    left join (
      select settlements.debtor_id, count(*) as pair_count
      from settlements
      where settlements.creditor_id is not null
        and settlements.creditor_id <> settlements.debtor_id
        and settlements.status = 'SETTLED'
        and settlements.settled_points is not null
      group by settlements.debtor_id
    ) as outsider on outsider.debtor_id = users.id
    left join calibration_audits
      on calibration_audits.account_id = users.id
      and calibration_audits.state = 'OPEN'
    order by users.github_login, users.id
  `;
  return rows.map((row) => ({
    id: readText(row.id, "Audit candidate identifier"),
    githubLogin: readText(row.github_login, "Audit candidate login"),
    enforcementState: readText(row.enforcement_state, "Audit candidate enforcement state"),
    selfWorkPairCount: readNumber(row.self_work_pair_count, "Self-work pair count"),
    outsiderPairCount: readNumber(row.outsider_pair_count, "Outsider pair count"),
    openAuditId: row.open_audit_id === null ? null : readText(row.open_audit_id, "Open audit identifier"),
  }));
}

export async function listModerationRepositories(
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<ModerationRepositoryProjection[]> {
  const sql = resolveSql(dependencies);
  const rows = await sql<ModerationRepositoryRow[]>`
    select id, owner_name
    from registered_repositories
    where active = true
    order by owner_name, id
  `;
  return rows.map((row) => ({
    id: readText(row.id, "Repository identifier"),
    ownerName: readText(row.owner_name, "Repository name"),
  }));
}

function resolveSql(dependencies: Pick<DashboardQueryDependencies, "sql">): DashboardSql {
  return dependencies.sql ?? (getSql() as unknown as DashboardSql);
}

function toCalibrationPair(row: CalibrationRow): CalibrationPair {
  return {
    githubRepositoryId: readNumber(row.github_repository_id, "GitHub repository identifier"),
    githubIssueId: readNumber(row.github_issue_id, "GitHub issue identifier"),
    githubPullRequestId: readNumber(row.github_pull_request_id, "GitHub pull request identifier"),
    mergedAt: readTimestamp(row.merged_at, "GitHub merge time"),
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

/**
 * A column that is legitimately absent, still checked when it is present.
 *
 * Null is the answer on the closure this product has to render — a settled
 * label the fold refused to write — so it passes through, but anything else
 * non-textual is a projection reading the wrong column and says so.
 */
function readNullableText(value: unknown, label: string): string | null {
  return value === null ? null : readText(value, label);
}

/**
 * The queue's state for one repository, where no row at all is the settled answer.
 *
 * A job deletes its own row when it succeeds, so a missing row means the repository agrees with
 * GitHub rather than that its state is unknown. A state the queue cannot hold is a projection
 * reading the wrong column, and saying so beats rendering it to a sponsor as if it meant something.
 */
function readReconciliationState(value: unknown, label: string): "IDLE" | ReconciliationJobState {
  if (value === null) {
    return "IDLE";
  }
  const state = readText(value, label);
  const known: readonly ReconciliationJobState[] = ["PENDING", "RUNNING", "FAILED"];
  for (const candidate of known) {
    if (state === candidate) {
      return candidate;
    }
  }
  throw new Error(`${label} was not a known job state.`);
}

/**
 * A timestamp the page renders rather than compares, kept as a `Date` because the driver hands
 * `timestamp with time zone` back as one and a string form would only be parsed again to format it.
 */
function readNullableDate(value: unknown, label: string): Date | null {
  if (value === null) {
    return null;
  }
  const parsed = value instanceof Date ? value : new Date(readText(value, label));
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} was not a timestamp.`);
  }
  return parsed;
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

function readNullableTimestamp(value: string | Date | null | undefined, label: string): string | null {
  return value === null || value === undefined ? null : readTimestamp(value, label);
}

function readNullableMergeOid(value: string | null): string | null {
  if (value === null) {
    return null;
  }
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new Error("Merge commit OID was invalid.");
  }
  return value;
}

function normalizedFilter(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized === undefined || normalized.length === 0 ? null : normalized;
}

function readSettlementStatus(value: string): SettlementStatus {
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
