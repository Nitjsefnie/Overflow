import {
  compareCalibration,
  type CalibrationComparison,
  type CalibrationPair,
  type RepositoryCalibrationEntry,
} from "@/lib/calibration/statistics";
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
  openAudit: MemberOpenAuditProjection | null;
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

/**
 * The member's own notice that a calibration audit is open on their account: its
 * identity and the day it opened. The audit's rationale, cohort definition and
 * statistics stay moderator-facing, so the notice exists independently of
 * anything a moderator typed.
 */
export type MemberOpenAuditProjection = {
  id: string;
  openedAt: string;
};

/** A dashboard-safe settlement summary that links a member to the complete proof page. */
export type RecentSettlementProjection = {
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
  viewerCanRequestCorrection: boolean;
  latestCorrection: { state: "OPEN" | "GRANTED" | "DECLINED"; requestedAt: string } | null;
};

export type UnwritableClosureQueues = {
  queue: UnwritableClosureProjection[];
  history: UnwritableClosureProjection[];
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

/**
 * A scope that runs a whole projection's reads against one database snapshot.
 *
 * `getDashboard` hands its callback every read the projection makes, so a
 * commit landing mid-projection cannot show the callback two different
 * committed states (issue 443). Tests supply their own to observe or replace
 * the transaction boundary without a database.
 */
export type DashboardBegin = <T>(run: (sql: DashboardSql) => Promise<T>) => Promise<T>;

export type DashboardQueryDependencies = {
  sql?: DashboardSql;
  begin?: DashboardBegin;
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

type MemberOpenAuditRow = {
  id: string;
  opened_at: string | Date;
};

type RecentSettlementRow = {
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

type RepositoryCalibrationRow = CalibrationRow & {
  repository_name: string;
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
  viewer_can_request_correction: boolean;
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

/**
 * The member dashboard: one projection, one database snapshot.
 *
 * Loads materialized ledger and reservation values; overcommitment remains
 * visible as negative headroom.
 *
 * The six reads below all describe the same committed instant. Each is its own
 * autocommit statement, so without a shared snapshot a commit landing after the
 * first read splits the projection across two states of the ledger — a balance
 * from before it beside a settlement history from after it (issue 443). The
 * snapshot scope closes that tear.
 */
export async function getDashboard(
  accountId: string,
  dependencies: DashboardQueryDependencies = {},
): Promise<DashboardProjection> {
  const sql = resolveSql(dependencies);
  const snapshotScope = dependencies.begin ?? defaultSnapshotScope(sql);
  return snapshotScope((txSql) => readDashboardProjection(txSql, accountId));
}

/** Reads the dashboard's six queries and builds their projection, all through one sql. */
async function readDashboardProjection(
  sql: DashboardSql,
  accountId: string,
): Promise<DashboardProjection> {
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
          -- Claimed-ness is the login's existence; who claims is decided by the
          -- immutable account id (migrations 013 and 032). IS DISTINCT FROM so a
          -- claimed issue whose assignee id is not yet reconciled cannot prove
          -- self-assignment and stays reserved until GitHub backfills it.
          and issues.claim_assignee_github_user_id is distinct from sponsors.github_user_id
      ), 0)::integer as reserved_points,
      (select users.enforcement_state::text from users where users.id = ${accountId}) as enforcement_state
  `;
  const recentSettlementRows = await sql<RecentSettlementRow[]>`
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
  // At most one OPEN audit can exist per account — the partial unique index
  // calibration_audits_one_open_account (migration 006) covers (account_id) where
  // state = 'OPEN' — so this read cannot multiply rows and needs no precedence
  // ordering to pick one. The notice is the audit's identity and opening time
  // alone: nothing here consults the enforcement state or a moderator's text, so
  // the member's dashboard shows it whatever the account's state happens to be.
  const [openAuditRow] = await sql<MemberOpenAuditRow[]>`
    select id, opened_at
    from calibration_audits
    where calibration_audits.account_id = ${accountId}
      and calibration_audits.state = 'OPEN'
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
    openAudit: openAuditRow === undefined ? null : {
      id: readText(openAuditRow.id, "Open audit identifier"),
      openedAt: readTimestamp(openAuditRow.opened_at, "Open audit opening time"),
    },
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
    with reservations as materialized (
      -- The reservation total is priced once per sponsor here, and joined to
      -- that sponsor's issue rows below, rather than re-derived as correlated
      -- subplans once per output row (and twice more inside the order-by tier,
      -- which re-reads the headroom expression). Materialized on purpose: a
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
      (
        coalesce(sponsor_balances.balance, 0)
        - coalesce(reservations.reserved_points, 0)
      )::integer as available_headroom,
      issues.created_at
    from issues
    join registered_repositories as repositories on repositories.id = issues.repository_id
    join users as sponsors on sponsors.id = repositories.sponsor_id
    left join sponsor_balances on sponsor_balances.account_id = sponsors.id
    left join reservations on reservations.sponsor_id = sponsors.id
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
    ) as ranked
    order by
      -- Sponsor headroom tiers lead the ordering so a sponsor who has drawn
      -- far more work than they have returned surfaces below one who has
      -- not: positive headroom first (returned more than drawn), then
      -- balance (the band down to minus ten absorbs the zero cliff, where a
      -- first outsider claim would otherwise bury the sponsor the moment
      -- their first issue is claimed), then everything deeper. The threshold
      -- of minus ten is a design choice: roughly one full opening of reserve
      -- beyond balance, so ranking past it takes more than a single unredeemed
      -- opening's worth of drawing. The tier orders but never filters.
      case
        when ranked.available_headroom > 0 then 0
        when ranked.available_headroom >= -10 then 1
        else 2
      end,
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

/**
 * The one cohort selection both calibration projections derive from: the
 * account's own calibrated closures, and the outsider settlements the account
 * owes on. One selection per request — the projections are pure derivations
 * of this result (getCalibrationComparison pools the pairs,
 * getCalibrationComparisonByRepository groups them per repository), so a
 * caller cannot project without loading, and a reconciliation commit landing
 * between two independent selections can no longer make the breakdown stop
 * being a partition of the pooled comparison (issue 435).
 * `repository_name` is carried for the grouping reader; the pooled one ignores
 * it.
 */
export type CalibrationCohorts = {
  selfWorkRows: RepositoryCalibrationRow[];
  outsiderRows: RepositoryCalibrationRow[];
};

/**
 * The one cohort read per request: load the account's two cohorts once and
 * hand the result to both projections. Neither projection selects.
 *
 * Both selections run inside one repeatable-read transaction (the snapshot
 * scope), so a reconciliation commit landing between them cannot split the
 * cohort pair across two committed states — at READ COMMITTED each statement
 * takes its own snapshot, and the self-work selection then answers from before
 * the commit while the outsider selection answers from after it. The
 * projections are pure derivations of the pair, so the breakdown stays a
 * partition of the pooled comparison (issue 499).
 */
export async function loadCalibrationCohorts(
  accountId: string,
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<CalibrationCohorts> {
  const sql = resolveSql(dependencies);
  const snapshotScope = defaultSnapshotScope(sql);
  return snapshotScope((txSql) => readCalibrationCohorts(txSql, accountId));
}

/** Reads the two cohort selections, both through the one transaction sql. */
async function readCalibrationCohorts(
  sql: DashboardSql,
  accountId: string,
): Promise<CalibrationCohorts> {
  const selfWorkRows = await sql<RepositoryCalibrationRow[]>`
    select
      repositories.github_repository_id,
      repositories.owner_name as repository_name,
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
  const outsiderRows = await sql<RepositoryCalibrationRow[]>`
    select
      repositories.github_repository_id,
      repositories.owner_name as repository_name,
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
  return { selfWorkRows, outsiderRows };
}

/**
 * The pooled calibration comparison over one loaded cohort pair. A pure
 * derivation: the selection ran once in loadCalibrationCohorts, so this and
 * the per-repository breakdown read the same rows by construction.
 */
export function getCalibrationComparison(cohorts: CalibrationCohorts): CalibrationComparison {
  return compareCalibration(
    cohorts.selfWorkRows.map(toCalibrationPair),
    cohorts.outsiderRows.map(toCalibrationPair),
  );
}

/**
 * The same comparison as getCalibrationComparison, split one entry per
 * repository, derived from the same one loaded cohort pair: neither
 * projection reads, so the breakdown cannot straddle a commit the pooled
 * figure did not see.
 *
 * The registered repositories do not offer the same opening scale — a uniform
 * 1..10 in one, five rungs in another — so the pooled figure above averages two
 * different measurements into one mean. Each entry compares a repository's own
 * two cohorts, so a member reads each scale on its own terms.
 *
 * A repository appears whenever either cohort has a pair in it, including the
 * one whose other cohort is empty: dropping that repository would hide the
 * cohort the member has, and compareCalibration already declines to report a
 * difference there.
 */
export function getCalibrationComparisonByRepository(
  cohorts: CalibrationCohorts,
): RepositoryCalibrationEntry[] {
  const { selfWorkRows, outsiderRows } = cohorts;

  const groups = new Map<number, { repositoryName: string; selfWork: CalibrationPair[]; outsider: CalibrationPair[] }>();
  const collect = (rows: readonly RepositoryCalibrationRow[], cohort: "selfWork" | "outsider") => {
    for (const row of rows) {
      const pair = toCalibrationPair(row);
      const group = groups.get(pair.githubRepositoryId) ?? {
        repositoryName: readText(row.repository_name, "Repository name"),
        selfWork: [],
        outsider: [],
      };
      group[cohort].push(pair);
      groups.set(pair.githubRepositoryId, group);
    }
  };
  collect(selfWorkRows, "selfWork");
  collect(outsiderRows, "outsider");

  // Sorted here rather than relied on from the two selections: each answers in
  // repository order on its own, but the second one's repositories are appended
  // after the first one's, so the merged order is not the query's.
  return [...groups.entries()]
    .sort(([left], [right]) => left - right)
    .map(([githubRepositoryId, group]) => ({
      githubRepositoryId,
      repositoryName: group.repositoryName,
      comparison: compareCalibration(group.selfWork, group.outsider),
    }));
}

export async function listUnwritableClosures(
  viewerId: string,
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<UnwritableClosureQueues> {
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
      case
        when settlements.id is not null then
          coalesce(settlements.creditor_id = ${viewerId}, false) or settlements.debtor_id = ${viewerId}
        when calibrations.id is not null then calibrations.user_id = ${viewerId}
        else false
      end as viewer_can_request_correction,
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

  const closures: UnwritableClosureProjection[] = rows.map((row) => ({
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
    viewerCanRequestCorrection: row.viewer_can_request_correction,
    latestCorrection: row.correction_state === null ? null : {
      state: row.correction_state,
      requestedAt: readTimestamp(row.correction_requested_at!, "Correction request time"),
    },
  }));

  const queues: UnwritableClosureQueues = { queue: [], history: [] };
  for (const closure of closures) {
    if (closure.latestCorrection?.state === "GRANTED") {
      queues.history.push(closure);
    } else {
      queues.queue.push(closure);
    }
  }
  return queues;
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
  // These cohort predicates are shared with loadCalibrationCohorts above and with
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

/**
 * The transaction options that give a projection one snapshot to read.
 *
 * `repeatable read` is the point: in `read committed` — PostgreSQL's default —
 * every statement takes its own snapshot, so a transaction there would still
 * tear. `read only` because a projection never writes, and `read only`
 * transactions neither assign an xid nor hold write locks. SERIALIZABLE would
 * buy nothing beyond that one snapshot and would charge dashboards
 * serialization-failure retries for it.
 */
const SNAPSHOT_SCOPE_OPTIONS = "read only isolation level repeatable read";

/**
 * The default snapshot scope for a resolved sql.
 *
 * The real postgres client carries a `begin`, so the projection's reads run
 * inside one read-only repeatable-read transaction on it. An injected seam
 * without a `begin` — the unit-test fakes — keeps its current behavior and
 * reads autocommit, unchanged.
 */
function defaultSnapshotScope(sql: DashboardSql): DashboardBegin {
  // Held in a const so the typeof narrowing survives into the returned closure;
  // narrowing a property access does not.
  const begin = (
    sql as {
      begin?: (options: string, run: (sql: DashboardSql) => Promise<unknown>) => Promise<unknown>;
    }
  ).begin;
  if (typeof begin === "function") {
    return <T>(run: (sql: DashboardSql) => Promise<T>): Promise<T> =>
      begin(SNAPSHOT_SCOPE_OPTIONS, run) as Promise<T>;
  }
  return (run) => run(sql);
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
    status: readSettlementStatus(row.status),
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
 * Keyed by the shared union, so the compiler is what notices a state added to
 * `ReconciliationJobState`: a missing key fails this build, where a hand-kept list would instead
 * throw on the dashboard of every sponsor who owns a repository in that state.
 */
const reconciliationJobStates: { [State in ReconciliationJobState]: State } = {
  PENDING: "PENDING",
  RUNNING: "RUNNING",
  FAILED: "FAILED",
};

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
  for (const candidate of Object.values(reconciliationJobStates)) {
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
