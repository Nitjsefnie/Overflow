import {
  compareCalibration,
  type CalibrationComparison,
  type CalibrationPair,
  type RepositoryCalibrationEntry,
} from "@/lib/calibration/statistics";
import {
  defaultSnapshotScope, readNullableMergeOid, readNullableText, readNullableTimestamp, readNumber, readSettlementStatus,
  readText, readTimestamp, resolveSql,
  type DashboardQueryDependencies, type DashboardSql, type SettlementStatus,
} from "@/lib/dashboard/queries";

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
 * The evidence behind a closure the fold calibrated instead of settling. A sponsor
 * who closes their own issue is both parties, so no credits move and there is no
 * settlement row to point at. The comparison the account is judged on is recorded
 * here instead, and the actual figure is absent whenever the closure's settled
 * evidence was rejected.
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

/**
 * One account a moderator may open an audit against. The pair counts are unwindowed and unscoped, so
 * they are an upper bound on what any particular sample window yields; the audit preview is what tells
 * a moderator whether a specific window qualifies.
 */
export type AuditCandidateProjection = {
  id: string;
  githubLogin: string;
  githubUserId: number;
  enforcementState: string;
  selfWorkPairCount: number;
  outsiderPairCount: number;
  openAuditId: string | null;
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

type AuditCandidateRow = {
  id: string;
  github_login: string;
  github_user_id: number | string;
  enforcement_state: string;
  self_work_pair_count: number | string;
  outsider_pair_count: number | string;
  open_audit_id: string | null;
};

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
        when settlements.status = 'SETTLED' and settlements.creditor_id = ${accountId} and settlements.team_id is null then settlements.credits
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
        when settlements.status = 'SETTLED' and settlements.creditor_id = ${accountId} and settlements.team_id is null then settlements.credits
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
    projection.settledRationaleCommentedAt = readNullableTimestamp(row.settled_rationale_commented_at, "Settled rationale time");
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
 * `user_id` is what makes it theirs. The actual label is read back from the issue
 * rather than the calibration, because the fold writes the label on the issue and
 * the points on the calibration. Both are absent together on a closure whose
 * settled evidence was rejected.
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
 * Every closure this account was calibrated on, newest merge first, including the ones
 * with no actual figure: a calibration that recorded nothing is the one a sponsor most needs to find.
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
 * The one cohort selection both calibration projections derive from: the account's
 * own calibrated closures, and the outsider settlements the account owes on. One
 * selection per request — the projections are pure derivations of this result, so a
 * caller cannot project without loading, and a reconciliation commit landing between
 * two independent selections cannot make the breakdown stop being a partition
 * of the pooled comparison. `repository_name` is carried for the grouping
 * reader; the pooled one ignores it.
 */
export type CalibrationCohorts = {
  selfWorkRows: RepositoryCalibrationRow[];
  outsiderRows: RepositoryCalibrationRow[];
};

/**
 * The one cohort read per request: load the account's two cohorts once and hand the
 * result to both projections. Neither projection selects. Both selections run inside
 * one repeatable-read transaction (the snapshot scope), so a reconciliation commit
 * landing between them cannot split the cohort pair across two committed states — at
 * READ COMMITTED each statement takes its own snapshot, so the pair could straddle one.
 * The projections are pure derivations of the pair, so the breakdown stays a
 * partition of the pooled comparison.
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
 * The pooled calibration comparison over one loaded cohort pair. A pure derivation:
 * the selection ran once in loadCalibrationCohorts, so this and the per-repository
 * breakdown read the same rows by construction.
 */
export function getCalibrationComparison(cohorts: CalibrationCohorts): CalibrationComparison {
  return compareCalibration(
    cohorts.selfWorkRows.map(toCalibrationPair),
    cohorts.outsiderRows.map(toCalibrationPair),
  );
}

/**
 * The same comparison as getCalibrationComparison, split one entry per repository,
 * derived from the same one loaded cohort pair: neither projection reads, so the
 * breakdown cannot straddle a commit the pooled figure did not see. The registered
 * repositories do not offer one opening scale — a uniform 1..10 in one, five rungs
 * in another — so the pooled figure averages different measurements into one mean.
 * Each entry compares a repository's own two cohorts, so a member reads each scale
 * on its own terms. A repository appears whenever either cohort has a pair in it,
 * including the one whose other cohort is empty: dropping that repository would
 * hide the cohort the member has, and compareCalibration already declines to
 * report a difference there.
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

export async function listAuditCandidates(
  dependencies: Pick<DashboardQueryDependencies, "sql"> = {},
): Promise<AuditCandidateProjection[]> {
  const sql = resolveSql(dependencies);
  // Pair predicates match loadCalibrationCohorts and the moderation store's pair readers; change all three together.
  // Aggregate each side once: neither self_work_calibrations.user_id nor settlements.debtor_id is indexed.
  // Comparing creditor_id <> debtor_id binds the outsider group to users.id through the join.
  const rows = await sql<AuditCandidateRow[]>`
    select
      users.id, users.github_user_id,
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
    where users.deleted_at is null order by users.github_login, users.id
  `;
  return rows.map((row) => ({
    id: readText(row.id, "Audit candidate identifier"),
    githubLogin: readText(row.github_login, "Audit candidate login"),
    githubUserId: readNumber(row.github_user_id, "Audit candidate GitHub user identifier"),
    enforcementState: readText(row.enforcement_state, "Audit candidate enforcement state"),
    selfWorkPairCount: readNumber(row.self_work_pair_count, "Self-work pair count"),
    outsiderPairCount: readNumber(row.outsider_pair_count, "Outsider pair count"),
    openAuditId: row.open_audit_id === null ? null : readText(row.open_audit_id, "Open audit identifier"),
  }));
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

function readDifferenceBetweenMeans(value: unknown): number {
  if (typeof value !== "object" || value === null || !("differenceBetweenMeans" in value)) {
    return 0;
  }
  return readNumber(value.differenceBetweenMeans, "Calibration difference between means");
}
