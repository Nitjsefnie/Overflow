import type { JSONValue } from "postgres";
import type { TransactionClient } from "@/lib/db/types";
import { FOLD_REVISION } from "@/lib/fold/fold-revision";
import { nullableTimestampToIso, toSafeInteger, recordChange, requiredId, type SettlementRow } from "@/lib/fold/postgres-row-mapping";
import type { FoldResult, FoldSettlement, SelfWorkCalibration, UnwritableClosure } from "@/lib/fold/repository-fold";
import type { ReconciliationDeltas } from "@/lib/fold/reconcile";
import { applyGrantedSelfWorkCalibrationOverride, applyGrantedSettlementOverride } from "@/lib/overrides/apply";
import { donatedSettlement } from "@/lib/fold/donation-mark";

type SelfWorkCalibrationRow = {
  id: string;
  fold_revision: number;
  pull_request_id: string;
  issue_id: string;
  github_pull_request_id: number | string;
  github_issue_id: number | string;
  user_id: string;
  opening_comparison_points: number;
  actual_points: number | null;
  actual_label: string | null;
  settled_label_event_id: string | null;
  settled_label_actor_login: string | null;
  settled_label_applied_at: string | Date | null;
  settled_rationale_comment_id: string | null;
  settled_rationale_actor_login: string | null;
  settled_rationale_commented_at: string | Date | null;
  merge_commit_oid: string | null;
  merged_at: string | Date | null;
};

type UnwritableClosureRow = {
  id: string;
  fold_revision: number;
  issue_id: string;
  github_issue_id: number | string;
  kind: UnwritableClosure["kind"];
  github_pull_request_id: number | string | null;
  reason: string;
};

export async function materializeSettlements(
  sql: TransactionClient,
  input: { repositoryId: string; runId: string; fold: FoldResult },
  issueIds: Map<number, string>,
  pullRequestIds: Map<number, string>,
  existingRows: readonly SettlementRow[],
  grantedOverrides: ReadonlyMap<number, number>,
): Promise<ReconciliationDeltas> {
  const existingByIssue = new Map(existingRows.map((row) => [toSafeInteger(row.github_issue_id), row]));
  let adds = 0;
  let changes = 0;
  let removals = 0;

  for (const folded of input.fold.settlements) {
    const current = existingByIssue.get(folded.githubIssueId);
    const settlement = donatedSettlement(applyGrantedOverride(folded, grantedOverrides), current);
    const issueId = requiredId(issueIds, settlement.githubIssueId, "Issue");
    const pullRequestId = requiredId(pullRequestIds, settlement.githubPullRequestId, "Pull request");
    const desired = settlementState(settlement);
    if (current === undefined) {
      await insertSettlement(sql, settlement, issueId, pullRequestId);
      await recordChange(sql, input.runId, pullRequestId, "SETTLEMENT", "ADD", null, desired);
      adds += 1;
      continue;
    }
    existingByIssue.delete(settlement.githubIssueId);
    const before = settlementStateFromRow(current);
    if (JSON.stringify(before) !== JSON.stringify(desired)) {
      await updateSettlement(sql, settlement, issueId, pullRequestId);
      await recordChange(sql, input.runId, pullRequestId, "SETTLEMENT", "CHANGE", before, desired);
      changes += 1;
    } else if (current.fold_revision < FOLD_REVISION) {
      // Recomputed but unchanged: refresh the stamp without creating a CHANGE
      // record or counting a delta for every row after a revision bump (issue 197).
      await sql`update settlements set fold_revision = ${FOLD_REVISION} where id = ${current.id}`;
    }
  }

  for (const row of existingByIssue.values()) {
    await sql`delete from settlements where id = ${row.id}`;
    await recordChange(
      sql,
      input.runId,
      row.pull_request_id,
      "SETTLEMENT",
      "REMOVE",
      settlementStateFromRow(row),
      null,
    );
    removals += 1;
  }

  return { adds, changes, removals };
}

/**
 * The points a moderator granted for each of this repository's issues.
 *
 * Keyed on the issue, because a settlement and a self-work calibration are the
 * two ways one issue's outcome is recorded and either can be corrected. A
 * correction cannot live in the row it corrects: materialization deletes and
 * rewrites both tables from immutable GitHub history on every run, so it is
 * read back here and applied to the fold's result before the row is written.
 * Where an issue has been corrected more than once the most recent grant wins,
 * so the map is filled in decision order and later grants overwrite earlier
 * ones.
 */
export async function loadGrantedSettlementOverrides(
  sql: TransactionClient,
  repositoryId: string,
): Promise<Map<number, number>> {
  const rows = await sql<{ github_issue_id: number | string; settled_points: number | string }[]>`
    select issues.github_issue_id, overrides.settled_points
    from settlement_override_requests as overrides
    join issues on issues.id = overrides.issue_id
    where issues.repository_id = ${repositoryId}
      and overrides.state = 'GRANTED'
      and overrides.settled_points is not null
    order by overrides.decided_at asc, overrides.id asc
  `;
  const grantedPoints = new Map<number, number>();
  for (const row of rows) {
    grantedPoints.set(toSafeInteger(row.github_issue_id), toSafeInteger(row.settled_points));
  }
  return grantedPoints;
}

function applyGrantedOverride(
  settlement: FoldSettlement,
  grantedOverrides: ReadonlyMap<number, number>,
): FoldSettlement {
  const settledPoints = grantedOverrides.get(settlement.githubIssueId);
  return settledPoints === undefined
    ? settlement
    : applyGrantedSettlementOverride(settlement, settledPoints);
}

function applyGrantedCalibrationOverride(
  calibration: SelfWorkCalibration,
  grantedOverrides: ReadonlyMap<number, number>,
): SelfWorkCalibration {
  const actualPoints = grantedOverrides.get(calibration.githubIssueId);
  return actualPoints === undefined
    ? calibration
    : applyGrantedSelfWorkCalibrationOverride(calibration, actualPoints);
}

export async function loadExistingSettlements(
  sql: TransactionClient,
  repositoryId: string,
): Promise<SettlementRow[]> {
  return sql<SettlementRow[]>`
    select
      settlements.id, settlements.fold_revision, settlements.issue_id, settlements.pull_request_id,
      issues.github_issue_id, pull_requests.github_pull_request_id,
      settlements.creditor_id, settlements.creditor_github_login, settlements.creditor_github_user_id, settlements.debtor_id,
      settlements.opening_comparison_points, settlements.settled_points, settlements.review_rounds,
      settlements.credits, settlements.proof_sha256, settlements.status, settlements.donation_comment_id,
      issues.settled_label, issues.settled_label_event_id, issues.settled_label_actor_login,
      issues.settled_label_applied_at, issues.settled_rationale_comment_id,
      issues.settled_rationale_actor_login, issues.settled_rationale_commented_at,
      pull_requests.merge_commit_oid, pull_requests.merged_at
    from settlements
    join issues on issues.id = settlements.issue_id
    join pull_requests on pull_requests.id = settlements.pull_request_id
    where issues.repository_id = ${repositoryId}
  `;
}

async function insertSettlement(
  sql: TransactionClient,
  settlement: FoldSettlement,
  issueId: string,
  pullRequestId: string,
): Promise<void> {
  await sql`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, creditor_github_login, creditor_github_user_id, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status, fold_revision,
      provider, instance_url, donation_comment_id
    )
    values (
      ${pullRequestId}, ${issueId}, ${settlement.creditorId}, ${settlement.creditorGitHubLogin}, ${settlement.creditorGitHubUserId}, ${settlement.debtorId},
      ${settlement.openingComparisonPoints}, ${settlement.settledPoints}, ${settlement.reviewRounds},
      ${settlement.credits}, ${settlement.proofSha256}, ${settlement.status}, ${FOLD_REVISION},
      ${settlement.provider ?? "github"}, ${settlement.instanceUrl ?? null}, ${settlement.donationCommentId ?? null}
    )
  `;
}

async function updateSettlement(
  sql: TransactionClient,
  settlement: FoldSettlement,
  issueId: string,
  pullRequestId: string,
): Promise<void> {
  await sql`
    update settlements
    set pull_request_id = ${pullRequestId}, issue_id = ${issueId}, creditor_id = ${settlement.creditorId},
        creditor_github_login = ${settlement.creditorGitHubLogin},
        creditor_github_user_id = ${settlement.creditorGitHubUserId}, debtor_id = ${settlement.debtorId},
        opening_comparison_points = ${settlement.openingComparisonPoints}, settled_points = ${settlement.settledPoints},
        review_rounds = ${settlement.reviewRounds}, credits = ${settlement.credits}, proof_sha256 = ${settlement.proofSha256},
        status = ${settlement.status}, fold_revision = ${FOLD_REVISION},
        provider = ${settlement.provider ?? "github"}, instance_url = ${settlement.instanceUrl ?? null},
        donation_comment_id = ${settlement.donationCommentId ?? null}
    where issue_id = ${issueId}
  `;
}

async function updateSelfWorkCalibration(
  sql: TransactionClient,
  calibration: SelfWorkCalibration,
  issueId: string,
  pullRequestId: string,
): Promise<void> {
  await sql`
    update self_work_calibrations
    set pull_request_id = ${pullRequestId}, issue_id = ${issueId}, user_id = ${calibration.userId},
        opening_comparison_points = ${calibration.openingComparisonPoints},
        actual_points = ${calibration.actualPoints}, fold_revision = ${FOLD_REVISION}
    where issue_id = ${issueId}
  `;
}

export async function materializeSelfWorkCalibrations(
  sql: TransactionClient,
  input: { repositoryId: string; runId: string; fold: FoldResult },
  issueIds: Map<number, string>,
  pullRequestIds: Map<number, string>,
  existingRows: readonly SelfWorkCalibrationRow[],
  grantedOverrides: ReadonlyMap<number, number>,
): Promise<ReconciliationDeltas> {
  const existingByIssue = new Map(
    existingRows.map((row) => [toSafeInteger(row.github_issue_id), row]),
  );
  let adds = 0;
  let changes = 0;
  let removals = 0;

  for (const folded of input.fold.selfWorkCalibrations) {
    // Corrected before the desired state is computed, so the reconciliation
    // change this run records is the row it goes on to write.
    const calibration = applyGrantedCalibrationOverride(folded, grantedOverrides);
    const pullRequestId = requiredId(pullRequestIds, calibration.githubPullRequestId, "Pull request");
    const issueId = requiredId(issueIds, calibration.githubIssueId, "Issue");
    const current = existingByIssue.get(calibration.githubIssueId);
    const desired = selfWorkCalibrationState(calibration);
    if (current === undefined) {
      await sql`
        insert into self_work_calibrations (
          pull_request_id, issue_id, user_id, opening_comparison_points, actual_points, fold_revision
        )
        values (
          ${pullRequestId}, ${issueId}, ${calibration.userId},
          ${calibration.openingComparisonPoints}, ${calibration.actualPoints}, ${FOLD_REVISION}
        )
      `;
      await recordChange(
        sql,
        input.runId,
        pullRequestId,
        "SELF_WORK_CALIBRATION",
        "ADD",
        null,
        desired,
      );
      adds += 1;
      continue;
    }

    existingByIssue.delete(calibration.githubIssueId);
    const before = selfWorkCalibrationStateFromRow(current);
    if (JSON.stringify(before) !== JSON.stringify(desired)) {
      await updateSelfWorkCalibration(sql, calibration, issueId, pullRequestId);
      await recordChange(
        sql,
        input.runId,
        pullRequestId,
        "SELF_WORK_CALIBRATION",
        "CHANGE",
        before,
        desired,
      );
      changes += 1;
    } else if (current.fold_revision < FOLD_REVISION) {
      await sql`update self_work_calibrations set fold_revision = ${FOLD_REVISION} where id = ${current.id}`;
    }
  }

  for (const row of existingByIssue.values()) {
    await sql`delete from self_work_calibrations where id = ${row.id}`;
    await recordChange(
      sql,
      input.runId,
      row.pull_request_id,
      "SELF_WORK_CALIBRATION",
      "REMOVE",
      selfWorkCalibrationStateFromRow(row),
      null,
    );
    removals += 1;
  }

  return { adds, changes, removals };
}

export async function loadExistingSelfWorkCalibrations(
  sql: TransactionClient,
  repositoryId: string,
): Promise<SelfWorkCalibrationRow[]> {
  return sql<SelfWorkCalibrationRow[]>`
    select
      self_work_calibrations.id,
      self_work_calibrations.fold_revision,
      self_work_calibrations.pull_request_id,
      self_work_calibrations.issue_id,
      pull_requests.github_pull_request_id,
      issues.github_issue_id,
      self_work_calibrations.user_id,
      self_work_calibrations.opening_comparison_points,
      self_work_calibrations.actual_points,
      issues.settled_label as actual_label,
      issues.settled_label_event_id,
      issues.settled_label_actor_login,
      issues.settled_label_applied_at,
      issues.settled_rationale_comment_id,
      issues.settled_rationale_actor_login,
      issues.settled_rationale_commented_at,
      pull_requests.merge_commit_oid,
      pull_requests.merged_at
    from self_work_calibrations
    join pull_requests on pull_requests.id = self_work_calibrations.pull_request_id
    join issues on issues.id = self_work_calibrations.issue_id
    where issues.repository_id = ${repositoryId}
    order by issues.github_issue_id, pull_requests.github_pull_request_id
  `;
}

export async function materializeUnwritableClosures(
  sql: TransactionClient,
  input: { repositoryId: string; runId: string; fold: FoldResult },
  issueIds: Map<number, string>,
  pullRequestIds: Map<number, string>,
): Promise<ReconciliationDeltas> {
  const existingRows = await sql<UnwritableClosureRow[]>`
    select unwritable_closures.id, unwritable_closures.fold_revision, unwritable_closures.issue_id, issues.github_issue_id,
      unwritable_closures.kind::text, pull_requests.github_pull_request_id, unwritable_closures.reason
    from unwritable_closures
    join issues on issues.id = unwritable_closures.issue_id
    left join pull_requests on pull_requests.id = unwritable_closures.pull_request_id
    where issues.repository_id = ${input.repositoryId}
    order by issues.github_issue_id
  `;
  const existingByIssue = new Map(
    existingRows.map((row) => [toSafeInteger(row.github_issue_id), row]),
  );
  let adds = 0;
  let changes = 0;
  let removals = 0;

  for (const closure of input.fold.unwritableClosures) {
    const issueId = requiredId(issueIds, closure.githubIssueId, "Issue");
    const pullRequestId = closure.githubPullRequestId === null
      ? null
      : requiredId(pullRequestIds, closure.githubPullRequestId, "Pull request");
    const current = existingByIssue.get(closure.githubIssueId);
    const desired = unwritableClosureState(closure);
    if (current === undefined) {
      await sql`
        insert into unwritable_closures (issue_id, pull_request_id, kind, reason, fold_revision)
        values (${issueId}, ${pullRequestId}, ${closure.kind}, ${closure.reason}, ${FOLD_REVISION})
      `;
      await recordChange(sql, input.runId, null, "UNWRITABLE_CLOSURE", "ADD", null, desired);
      adds += 1;
      continue;
    }

    existingByIssue.delete(closure.githubIssueId);
    const before = unwritableClosureStateFromRow(current);
    if (JSON.stringify(before) !== JSON.stringify(desired)) {
      await sql`
        update unwritable_closures
        set pull_request_id = ${pullRequestId}, kind = ${closure.kind}, reason = ${closure.reason},
            fold_revision = ${FOLD_REVISION}
        where id = ${current.id}
      `;
      await recordChange(sql, input.runId, null, "UNWRITABLE_CLOSURE", "CHANGE", before, desired);
      changes += 1;
    } else if (current.fold_revision < FOLD_REVISION) {
      await sql`update unwritable_closures set fold_revision = ${FOLD_REVISION} where id = ${current.id}`;
    }
  }

  for (const row of existingByIssue.values()) {
    await sql`delete from unwritable_closures where id = ${row.id}`;
    await recordChange(
      sql,
      input.runId,
      null,
      "UNWRITABLE_CLOSURE",
      "REMOVE",
      unwritableClosureStateFromRow(row),
      null,
    );
    removals += 1;
  }

  return { adds, changes, removals };
}

function settlementState(settlement: FoldSettlement): JSONValue {
  return {
    githubIssueId: settlement.githubIssueId,
    githubPullRequestId: settlement.githubPullRequestId,
    creditorId: settlement.creditorId,
    creditorGitHubLogin: settlement.creditorGitHubLogin,
    creditorGitHubUserId: settlement.creditorGitHubUserId,
    debtorId: settlement.debtorId,
    openingComparisonPoints: settlement.openingComparisonPoints,
    settledLabel: settlement.settledLabel,
    settledPoints: settlement.settledPoints,
    settledLabelEventId: settlement.settledLabelEventId,
    settledLabelActorLogin: settlement.settledLabelActorLogin,
    settledLabelAppliedAt: nullableTimestampToIso(settlement.settledLabelAppliedAt),
    settledRationaleCommentId: settlement.settledRationaleCommentId,
    settledRationaleActorLogin: settlement.settledRationaleActorLogin,
    settledRationaleCommentedAt: nullableTimestampToIso(settlement.settledRationaleCommentedAt),
    mergeCommitOid: settlement.mergeCommitOid,
    mergedAt: nullableTimestampToIso(settlement.mergedAt),
    reviewRounds: settlement.reviewRounds,
    credits: settlement.credits,
    proofSha256: settlement.proofSha256,
    status: settlement.status,
    donationCommentId: settlement.donationCommentId ?? null,
  };
}

function settlementStateFromRow(row: SettlementRow): JSONValue {
  return {
    githubIssueId: toSafeInteger(row.github_issue_id),
    githubPullRequestId: toSafeInteger(row.github_pull_request_id),
    creditorId: row.creditor_id,
    creditorGitHubLogin: row.creditor_github_login,
    creditorGitHubUserId: row.creditor_github_user_id === null ? null : toSafeInteger(row.creditor_github_user_id),
    debtorId: row.debtor_id,
    openingComparisonPoints: row.opening_comparison_points,
    settledLabel: row.settled_label,
    settledPoints: row.settled_points,
    settledLabelEventId: row.settled_label_event_id,
    settledLabelActorLogin: row.settled_label_actor_login,
    settledLabelAppliedAt: nullableTimestampToIso(row.settled_label_applied_at),
    settledRationaleCommentId: row.settled_rationale_comment_id,
    settledRationaleActorLogin: row.settled_rationale_actor_login,
    settledRationaleCommentedAt: nullableTimestampToIso(row.settled_rationale_commented_at),
    mergeCommitOid: row.merge_commit_oid,
    mergedAt: nullableTimestampToIso(row.merged_at),
    reviewRounds: row.review_rounds,
    credits: row.credits,
    proofSha256: row.proof_sha256,
    status: row.status,
    donationCommentId: row.donation_comment_id,
  };
}

function selfWorkCalibrationState(calibration: SelfWorkCalibration): JSONValue {
  return {
    githubIssueId: calibration.githubIssueId,
    githubPullRequestId: calibration.githubPullRequestId,
    userId: calibration.userId,
    openingComparisonPoints: calibration.openingComparisonPoints,
    actualLabel: calibration.actualLabel,
    actualPoints: calibration.actualPoints,
    actualLabelEventId: calibration.actualLabelEventId,
    actualLabelActorLogin: calibration.actualLabelActorLogin,
    actualLabelAppliedAt: nullableTimestampToIso(calibration.actualLabelAppliedAt),
    rationaleCommentId: calibration.rationaleCommentId,
    rationaleActorLogin: calibration.rationaleActorLogin,
    rationaleCommentedAt: nullableTimestampToIso(calibration.rationaleCommentedAt),
    mergeCommitOid: calibration.mergeCommitOid,
    mergedAt: nullableTimestampToIso(calibration.mergedAt),
  };
}

function selfWorkCalibrationStateFromRow(row: SelfWorkCalibrationRow): JSONValue {
  return {
    githubIssueId: toSafeInteger(row.github_issue_id),
    githubPullRequestId: toSafeInteger(row.github_pull_request_id),
    userId: row.user_id,
    openingComparisonPoints: row.opening_comparison_points,
    actualLabel: row.actual_label,
    actualPoints: row.actual_points,
    actualLabelEventId: row.settled_label_event_id,
    actualLabelActorLogin: row.settled_label_actor_login,
    actualLabelAppliedAt: nullableTimestampToIso(row.settled_label_applied_at),
    rationaleCommentId: row.settled_rationale_comment_id,
    rationaleActorLogin: row.settled_rationale_actor_login,
    rationaleCommentedAt: nullableTimestampToIso(row.settled_rationale_commented_at),
    mergeCommitOid: row.merge_commit_oid,
    mergedAt: nullableTimestampToIso(row.merged_at),
  };
}

function unwritableClosureState(closure: UnwritableClosure): JSONValue {
  return {
    githubIssueId: closure.githubIssueId,
    kind: closure.kind,
    githubPullRequestId: closure.githubPullRequestId,
    reason: closure.reason,
  };
}

function unwritableClosureStateFromRow(row: UnwritableClosureRow): JSONValue {
  return unwritableClosureState({
    githubIssueId: toSafeInteger(row.github_issue_id),
    kind: row.kind,
    githubPullRequestId: row.github_pull_request_id === null ? null : toSafeInteger(row.github_pull_request_id),
    reason: row.reason,
  });
}
