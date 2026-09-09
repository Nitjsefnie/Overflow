/**
 * The recalibration credit adjustment store (issue 330).
 *
 * Applies and reverses a sponsor's credit adjustment from the pairs frozen in
 * the latest SUBSTANTIATED audit's stored snapshot — the evidence the moderator
 * actually saw. Every stored pair must still resolve to its live settlement or
 * self-work calibration unchanged, or the whole adjustment is refused: partial
 * compensation is worse than none. The adjustments are first-class rows the
 * ledger view unions; settlements are never touched. A reversal is a mirrored
 * second row, so nothing here ever mutates or deletes an adjustment.
 */
import type { JSONValue } from "postgres";
import type { CalibrationPair } from "@/lib/calibration/statistics";
import type { EnforcementState, SqlClient, TransactionClient } from "@/lib/db/types";
import { getSql } from "@/lib/db/client";
import {
  type AdjustmentLine,
  type AdjustmentLineInput,
  type AdjustmentTotal,
  type CalibrationActionability,
  type CalibrationCohortTotals,
  ModerationAdjustmentError,
  computeAdjustmentTotal,
  describeCalibrationActionability,
  distributeAdjustmentLines,
} from "@/lib/moderation/adjustment";
import type { CalibrationCohortSnapshot } from "@/lib/moderation/service";

/** Why a credit-adjustment action was refused with a conflict. */
export type RecalibrationCreditConflict =
  | { cause: "SNAPSHOT_DRIFT"; description: string }
  | { cause: "ALREADY_APPLIED" }
  | { cause: "ALREADY_REVERSED" };

/**
 * The structured refusals the service maps: `not_found` to NOT_FOUND,
 * `conflict` to CONFLICT, `not_actionable` to INVALID_INPUT.
 */
export type RecalibrationCreditFailure =
  | { kind: "not_found" }
  | { kind: "conflict"; detail: RecalibrationCreditConflict }
  | { kind: "not_actionable"; actionability: CalibrationActionability };

export type RecalibrationPreviewResult =
  | { kind: "ok"; value: RecalibrationPreview }
  | RecalibrationCreditFailure;

export type CreditAdjustmentResult =
  | { kind: "ok"; value: CreditAdjustmentRecord }
  | RecalibrationCreditFailure;

export type CreditAdjustmentLineRecord = {
  settlementId: string;
  creditorId: string;
  amount: number;
};

export type CreditAdjustmentRecord = {
  id: string;
  moderationEventId: string;
  calibrationAuditId: string;
  targetAccountId: string;
  gapPerPair: number;
  pairCount: number;
  totalAmount: number;
  /** Non-null on a reversal row, naming the adjustment it mirrors. */
  reversalOf: string | null;
  reason: string;
  createdAt: string;
  lines: readonly CreditAdjustmentLineRecord[];
};

export type RecalibrationPreview = {
  audit: { id: string; decidedAt: string | null };
  snapshot: CalibrationCohortSnapshot;
  actionability: CalibrationActionability;
  /** The exact cohort sums taken from the stored pairs, never from the float means. */
  totals: CalibrationCohortTotals;
  /** Null when the stored comparison is not actionable: there is no figure to act on. */
  figure: AdjustmentTotal | null;
  /** Empty unless a positive figure distributes across the resolved settlements. */
  lines: readonly CreditAdjustmentLineRecord[];
};

export type RecalibrationCreditStore = {
  loadRecalibrationPreview(targetAccountId: string): Promise<RecalibrationPreviewResult>;
  applyRecalibrationCreditAdjustment(input: {
    actorId: string;
    targetAccountId: string;
    reason: string;
  }): Promise<CreditAdjustmentResult>;
  reverseModerationCreditAdjustment(input: {
    actorId: string;
    adjustmentId: string;
    reason: string;
  }): Promise<CreditAdjustmentResult>;
  listCreditAdjustments(targetAccountId: string): Promise<CreditAdjustmentRecord[]>;
};

export class PostgresRecalibrationCreditStore implements RecalibrationCreditStore {
  public constructor(private readonly sql: SqlClient = getSql()) {}

  /**
   * Shows the moderator the figure the latest SUBSTANTIATED audit's stored
   * snapshot supports, with every stored pair verified against its live row.
   * A missing audit is `not_found`; drifted evidence is a conflict, never a
   * figure computed from evidence that no longer holds.
   */
  public async loadRecalibrationPreview(targetAccountId: string): Promise<RecalibrationPreviewResult> {
    const [audit] = await this.sql<SubstantiatedAuditRow[]>`
      select id, account_id, repository_id, decided_at, cohort_definition, cohort_statistics
      from calibration_audits
      where account_id = ${targetAccountId} and state = ${"SUBSTANTIATED"}
      order by decided_at desc nulls last, id desc
      limit 1
    `;
    if (audit === undefined) {
      return { kind: "not_found" };
    }

    const snapshot = parseStoredSnapshot(audit);
    if (snapshot === null) {
      return snapshotDrift("The audit's stored calibration snapshot was malformed.");
    }
    const resolution = await resolveStoredPairs(this.sql, targetAccountId, snapshot);
    if (resolution.kind === "conflict") {
      return resolution;
    }
    const evaluation = evaluateStoredSnapshot(targetAccountId, snapshot, resolution.value);
    if (evaluation.kind === "conflict") {
      return evaluation;
    }

    return {
      kind: "ok",
      value: {
        audit: {
          id: audit.id,
          decidedAt: audit.decided_at === null ? null : toIsoTimestamp(audit.decided_at),
        },
        snapshot,
        actionability: evaluation.actionability,
        totals: evaluation.totals,
        figure: evaluation.figure,
        lines: evaluation.lines,
      },
    };
  }

  /**
   * Applies the adjustment in one transaction: lock the target, load the latest
   * SUBSTANTIATED audit for update, verify every stored pair still matches its
   * live row, require the trigger, compute the exact figure and its lines, then
   * insert the adjustment, its lines and the moderation event. Uniqueness is
   * DB-enforced: a second apply for the same audit loses to the
   * `one_adjustment_per_audit` partial unique index and surfaces as a conflict.
   */
  public applyRecalibrationCreditAdjustment(input: {
    actorId: string;
    targetAccountId: string;
    reason: string;
  }): Promise<CreditAdjustmentResult> {
    return this.applyRecalibrationCreditAdjustmentInTransaction(input).catch((error) => {
      // Two applies racing past the same audit are separated by the partial
      // unique index. postgres.js treats a failed query as fatal to its whole
      // transaction, so the violation surfaces as the begin promise's
      // rejection — mapped here to the same conflict a read would refuse.
      if (isUniqueViolation(error)) {
        return { kind: "conflict", detail: { cause: "ALREADY_APPLIED" } };
      }
      throw error;
    });
  }

  private applyRecalibrationCreditAdjustmentInTransaction(input: {
    actorId: string;
    targetAccountId: string;
    reason: string;
  }): Promise<CreditAdjustmentResult> {
    return this.sql.begin(async (transaction) => {
      const [target] = await transaction<{ id: string; enforcement_state: EnforcementState }[]>`
        select id, enforcement_state from users where id = ${input.targetAccountId} for update
      `;
      if (target === undefined) {
        return { kind: "not_found" };
      }

      const [audit] = await transaction<SubstantiatedAuditRow[]>`
        select id, account_id, repository_id, decided_at, cohort_definition, cohort_statistics
        from calibration_audits
        where account_id = ${target.id} and state = ${"SUBSTANTIATED"}
        order by decided_at desc nulls last, id desc
        limit 1
        for update
      `;
      if (audit === undefined) {
        return { kind: "not_found" };
      }

      const snapshot = parseStoredSnapshot(audit);
      if (snapshot === null) {
        return snapshotDrift("The audit's stored calibration snapshot was malformed.");
      }
      const resolution = await resolveStoredPairs(transaction, target.id, snapshot);
      if (resolution.kind === "conflict") {
        return resolution;
      }
      const evaluation = evaluateStoredSnapshot(target.id, snapshot, resolution.value);
      if (evaluation.kind === "conflict") {
        return evaluation;
      }
      if (evaluation.figure === null) {
        return { kind: "not_actionable", actionability: evaluation.actionability };
      }
      if (evaluation.figure.totalAmount === 0) {
        // A real positive gap whose figure rounds to zero points compensates
        // nobody, and the adjustment table represents no such row (its
        // total_amount check requires a positive total). Refused the same way
        // the preview shows it: a zero figure with no lines.
        return {
          kind: "not_actionable",
          actionability: { actionable: false, reason: "NO_POSITIVE_CALIBRATION_GAP" },
        };
      }

      const { comparison, ...cohortDefinition } = snapshot;
      const [event] = await transaction<{ id: string }[]>`
        insert into moderation_events (
          target_user_id, actor_id, audit_id, prior_state, new_state, reason,
          cohort_definition, cohort_statistics, recalibration_plan
        )
        values (
          ${target.id}, ${input.actorId}, ${audit.id},
          ${target.enforcement_state}, ${target.enforcement_state}, ${input.reason},
          ${transaction.json(cohortDefinition as unknown as JSONValue)},
          ${transaction.json(comparison as unknown as JSONValue)},
          null
        )
        returning id
      `;
      if (event === undefined) {
        throw new Error("Moderation event insert returned no row.");
      }

      const [adjustment] = await transaction<{ id: string; created_at: string | Date }[]>`
        insert into moderation_credit_adjustments (
          moderation_event_id, calibration_audit_id, target_account_id,
          gap_per_pair, pair_count, total_amount, state, reason
        )
        values (
          ${event.id}, ${audit.id}, ${target.id},
          ${evaluation.figure.gapPerPair}, ${evaluation.figure.pairCount}, ${evaluation.figure.totalAmount},
          ${"APPLIED"}, ${input.reason}
        )
        returning id, created_at
      `;
      if (adjustment === undefined) {
        throw new Error("Credit adjustment insert returned no row.");
      }

      const lines = [...evaluation.lines].sort(bySettlementId);
      for (const line of lines) {
        await transaction`
          insert into moderation_credit_adjustment_lines (adjustment_id, settlement_id, creditor_id, amount)
          values (${adjustment.id}, ${line.settlementId}, ${line.creditorId}, ${line.amount})
        `;
      }

      return {
        kind: "ok",
        value: {
          id: adjustment.id,
          moderationEventId: event.id,
          calibrationAuditId: audit.id,
          targetAccountId: target.id,
          gapPerPair: evaluation.figure.gapPerPair,
          pairCount: evaluation.figure.pairCount,
          totalAmount: evaluation.figure.totalAmount,
          reversalOf: null,
          reason: input.reason,
          createdAt: toIsoTimestamp(adjustment.created_at),
          lines,
        },
      };
    }) as Promise<CreditAdjustmentResult>;
  }

  /**
   * Reverses an applied adjustment by writing a mirrored second row: state
   * APPLIED, `reversal_of` naming the original, per-line negative amounts over
   * the same settlements and creditors, and its own moderation event — all in
   * one transaction. The original row is never updated; the pair of rows
   * cancels in every derived view. A second reversal loses to the
   * `one_reversal_per_adjustment` partial unique index.
   */
  public reverseModerationCreditAdjustment(input: {
    actorId: string;
    adjustmentId: string;
    reason: string;
  }): Promise<CreditAdjustmentResult> {
    return this.reverseModerationCreditAdjustmentInTransaction(input).catch((error) => {
      // Two reversals racing for the same original are separated by the
      // partial unique index. postgres.js treats a failed query as fatal to
      // its whole transaction, so the violation surfaces as the begin
      // promise's rejection — mapped here to the conflict a read would refuse.
      if (isUniqueViolation(error)) {
        return { kind: "conflict", detail: { cause: "ALREADY_REVERSED" } };
      }
      throw error;
    });
  }

  private reverseModerationCreditAdjustmentInTransaction(input: {
    actorId: string;
    adjustmentId: string;
    reason: string;
  }): Promise<CreditAdjustmentResult> {
    return this.sql.begin(async (transaction) => {
      const [original] = await transaction<AdjustmentCoreRow[]>`
        select id, calibration_audit_id, target_account_id, gap_per_pair, pair_count,
               total_amount, reversal_of
        from moderation_credit_adjustments
        where id = ${input.adjustmentId}
        for update
      `;
      if (original === undefined) {
        return { kind: "not_found" };
      }
      // Reversing a reversal would write a re-application; undoing an undo is
      // refused — apply a fresh adjustment from the audit instead.
      if (original.reversal_of !== null) {
        return { kind: "conflict", detail: { cause: "ALREADY_REVERSED" } };
      }
      const [existingReversal] = await transaction<{ id: string }[]>`
        select id from moderation_credit_adjustments where reversal_of = ${original.id} limit 1
      `;
      if (existingReversal !== undefined) {
        return { kind: "conflict", detail: { cause: "ALREADY_REVERSED" } };
      }

      const originalLines = await transaction<LineRow[]>`
        select settlement_id, creditor_id, amount
        from moderation_credit_adjustment_lines
        where adjustment_id = ${original.id}
        order by settlement_id
      `;
      if (originalLines.length === 0) {
        // An applied adjustment always carries lines summing to its positive
        // total; an empty one is corruption this store refuses to mirror.
        throw new Error("An applied adjustment without lines cannot be reversed.");
      }

      const [target] = await transaction<{ id: string; enforcement_state: EnforcementState }[]>`
        select id, enforcement_state from users where id = ${original.target_account_id} for update
      `;
      if (target === undefined) {
        throw new Error("The adjustment's sponsor account no longer exists.");
      }

      // The reversal event is an action record, not a state flip: its cohort
      // columns keep their empty defaults because the reversal's evidence is
      // the original adjustment row and its lines, carried by linkage.
      const [event] = await transaction<{ id: string }[]>`
        insert into moderation_events (
          target_user_id, actor_id, audit_id, prior_state, new_state, reason
        )
        values (
          ${target.id}, ${input.actorId}, ${original.calibration_audit_id},
          ${target.enforcement_state}, ${target.enforcement_state}, ${input.reason}
        )
        returning id
      `;
      if (event === undefined) {
        throw new Error("Moderation event insert returned no row.");
      }

      const [reversal] = await transaction<{ id: string; created_at: string | Date }[]>`
        insert into moderation_credit_adjustments (
          moderation_event_id, calibration_audit_id, target_account_id,
          gap_per_pair, pair_count, total_amount, state, reversal_of, reason
        )
        values (
          ${event.id}, ${original.calibration_audit_id}, ${original.target_account_id},
          ${original.gap_per_pair}, ${original.pair_count}, ${original.total_amount},
          ${"APPLIED"}, ${original.id}, ${input.reason}
        )
        returning id, created_at
      `;
      if (reversal === undefined) {
        throw new Error("Credit adjustment reversal insert returned no row.");
      }

      const lines: CreditAdjustmentLineRecord[] = originalLines.map((line) => ({
        settlementId: line.settlement_id,
        creditorId: line.creditor_id,
        amount: -toSafeInteger(line.amount),
      }));
      for (const line of lines) {
        await transaction`
          insert into moderation_credit_adjustment_lines (adjustment_id, settlement_id, creditor_id, amount)
          values (${reversal.id}, ${line.settlementId}, ${line.creditorId}, ${line.amount})
        `;
      }

      return {
        kind: "ok",
        value: {
          id: reversal.id,
          moderationEventId: event.id,
          calibrationAuditId: original.calibration_audit_id,
          targetAccountId: original.target_account_id,
          gapPerPair: Number(original.gap_per_pair),
          pairCount: toSafeInteger(original.pair_count),
          totalAmount: toSafeInteger(original.total_amount),
          reversalOf: original.id,
          reason: input.reason,
          createdAt: toIsoTimestamp(reversal.created_at),
          lines,
        },
      };
    }) as Promise<CreditAdjustmentResult>;
  }

  /** Lists the account's adjustments — originals and reversals alike — newest first. */
  public async listCreditAdjustments(targetAccountId: string): Promise<CreditAdjustmentRecord[]> {
    const rows = await this.sql<AdjustmentRecordRow[]>`
      select id, moderation_event_id, calibration_audit_id, target_account_id, gap_per_pair,
             pair_count, total_amount, reversal_of, reason, created_at
      from moderation_credit_adjustments
      where target_account_id = ${targetAccountId}
      order by created_at desc, id desc
    `;
    const lineRows = await this.sql<AdjustmentLineRow[]>`
      select lines.adjustment_id, lines.settlement_id, lines.creditor_id, lines.amount
      from moderation_credit_adjustment_lines as lines
      join moderation_credit_adjustments as adjustments on adjustments.id = lines.adjustment_id
      where adjustments.target_account_id = ${targetAccountId}
      order by lines.settlement_id
    `;
    const linesByAdjustment = new Map<string, CreditAdjustmentLineRecord[]>();
    for (const line of lineRows) {
      const lines = linesByAdjustment.get(line.adjustment_id) ?? [];
      lines.push({ settlementId: line.settlement_id, creditorId: line.creditor_id, amount: toSafeInteger(line.amount) });
      linesByAdjustment.set(line.adjustment_id, lines);
    }
    return rows.map((row) => ({
      id: row.id,
      moderationEventId: row.moderation_event_id,
      calibrationAuditId: row.calibration_audit_id,
      targetAccountId: row.target_account_id,
      gapPerPair: Number(row.gap_per_pair),
      pairCount: toSafeInteger(row.pair_count),
      totalAmount: toSafeInteger(row.total_amount),
      reversalOf: row.reversal_of,
      reason: row.reason,
      createdAt: toIsoTimestamp(row.created_at),
      lines: linesByAdjustment.get(row.id) ?? [],
    }));
  }
}

/** The evidence-integrity refusal the shared resolution and evaluation helpers produce. */
type SnapshotEvidenceConflict = { kind: "conflict"; detail: RecalibrationCreditConflict };

function snapshotDrift(description: string): SnapshotEvidenceConflict {
  return { kind: "conflict", detail: { cause: "SNAPSHOT_DRIFT", description } };
}

/** The outsider settlements a snapshot's pairs resolve to, parallel to its pair list. */
type ResolvedStoredPairs = {
  outsiderSettlements: readonly ResolvedOutsiderSettlement[];
};

type ResolvedOutsiderSettlement = { settlementId: string; creditorId: string };

/**
 * Resolves every stored pair to its live row and verifies it unchanged: an
 * outsider pair by the settlement's unique proof fingerprint (same debtor,
 * status SETTLED, unchanged points and contribution identity), a self-work
 * pair by the pull request's proof and the sponsor's calibration row. Any
 * drift refuses the whole resolution — the result the service maps to CONFLICT.
 */
async function resolveStoredPairs(
  sql: SqlClient | TransactionClient,
  targetAccountId: string,
  snapshot: CalibrationCohortSnapshot,
): Promise<{ kind: "ok"; value: ResolvedStoredPairs } | SnapshotEvidenceConflict> {
  for (const pair of snapshot.selfWorkPairs) {
    const drift = await verifySelfWorkPair(sql, targetAccountId, pair);
    if (drift !== null) {
      return snapshotDrift(drift);
    }
  }

  const outsiderSettlements: ResolvedOutsiderSettlement[] = [];
  for (const pair of snapshot.outsiderSettlementPairs) {
    const resolved = await resolveOutsiderSettlement(sql, targetAccountId, pair);
    if (typeof resolved === "string") {
      return snapshotDrift(resolved);
    }
    outsiderSettlements.push(resolved);
  }
  return { kind: "ok", value: { outsiderSettlements } };
}

async function resolveOutsiderSettlement(
  sql: SqlClient | TransactionClient,
  targetAccountId: string,
  pair: CalibrationPair,
): Promise<ResolvedOutsiderSettlement | string> {
  const rows = await sql<OutsiderResolutionRow[]>`
    select
      settlements.id as settlement_id,
      settlements.creditor_id,
      settlements.status::text as status,
      settlements.opening_comparison_points,
      settlements.settled_points,
      registered_repositories.github_repository_id,
      issues.github_issue_id,
      pull_requests.github_pull_request_id,
      pull_requests.merged_at
    from settlements
    join pull_requests on pull_requests.id = settlements.pull_request_id
    join issues on issues.id = settlements.issue_id
    join registered_repositories on registered_repositories.id = issues.repository_id
    where settlements.proof_sha256 = ${pair.proofSha256}
      and settlements.debtor_id = ${targetAccountId}
    limit 2
  `;
  if (rows.length === 0) {
    return `No live settlement carries the stored proof fingerprint ${proofPrefix(pair.proofSha256)}.`;
  }
  if (rows.length > 1) {
    return `The stored proof fingerprint ${proofPrefix(pair.proofSha256)} resolves to more than one settlement.`;
  }
  const row = rows[0]!;
  if (row.status !== "SETTLED") {
    return `The settlement with proof fingerprint ${proofPrefix(pair.proofSha256)} is no longer SETTLED.`;
  }
  const drift = storedPairDrift(
    pair,
    {
      opening_comparison_points: row.opening_comparison_points,
      settled_points: row.settled_points,
      github_repository_id: row.github_repository_id,
      github_issue_id: row.github_issue_id,
      github_pull_request_id: row.github_pull_request_id,
      merged_at: row.merged_at,
    },
    `The settlement with proof fingerprint ${proofPrefix(pair.proofSha256)}`,
  );
  if (drift !== null) {
    return drift;
  }
  return { settlementId: row.settlement_id, creditorId: row.creditor_id };
}

async function verifySelfWorkPair(
  sql: SqlClient | TransactionClient,
  targetAccountId: string,
  pair: CalibrationPair,
): Promise<string | null> {
  const rows = await sql<SelfWorkResolutionRow[]>`
    select
      self_work_calibrations.opening_comparison_points,
      self_work_calibrations.actual_points,
      registered_repositories.github_repository_id,
      issues.github_issue_id,
      pull_requests.github_pull_request_id,
      pull_requests.merged_at
    from self_work_calibrations
    join pull_requests on pull_requests.id = self_work_calibrations.pull_request_id
    join issues on issues.id = self_work_calibrations.issue_id
    join registered_repositories on registered_repositories.id = issues.repository_id
    where pull_requests.proof_sha256 = ${pair.proofSha256}
      and self_work_calibrations.user_id = ${targetAccountId}
    limit 2
  `;
  if (rows.length === 0) {
    return `No live self-work calibration carries the stored proof fingerprint ${proofPrefix(pair.proofSha256)}.`;
  }
  if (rows.length > 1) {
    return `The stored proof fingerprint ${proofPrefix(pair.proofSha256)} resolves to more than one self-work calibration.`;
  }
  return storedPairDrift(
    pair,
    {
      opening_comparison_points: rows[0]!.opening_comparison_points,
      settled_points: rows[0]!.actual_points,
      github_repository_id: rows[0]!.github_repository_id,
      github_issue_id: rows[0]!.github_issue_id,
      github_pull_request_id: rows[0]!.github_pull_request_id,
      merged_at: rows[0]!.merged_at,
    },
    `The self-work calibration with proof fingerprint ${proofPrefix(pair.proofSha256)}`,
  );
}

function storedPairDrift(
  pair: CalibrationPair,
  observed: {
    opening_comparison_points: number | string;
    settled_points: number | string | null;
    github_repository_id: number | string;
    github_issue_id: number | string;
    github_pull_request_id: number | string;
    merged_at: string | Date;
  },
  subject: string,
): string | null {
  if (toSafeInteger(observed.opening_comparison_points) !== pair.offeredDifficulty) {
    return `${subject} no longer carries the stored opening difficulty ${pair.offeredDifficulty}.`;
  }
  if (observed.settled_points === null || toSafeInteger(observed.settled_points) !== pair.settledDifficulty) {
    return `${subject} no longer carries the stored settled difficulty ${pair.settledDifficulty}.`;
  }
  if (
    toSafeInteger(observed.github_repository_id) !== pair.githubRepositoryId ||
    toSafeInteger(observed.github_issue_id) !== pair.githubIssueId ||
    toSafeInteger(observed.github_pull_request_id) !== pair.githubPullRequestId
  ) {
    return `${subject} no longer resolves to the stored contribution.`;
  }
  if (toIsoTimestamp(observed.merged_at) !== pair.mergedAt) {
    return `${subject} no longer carries the stored merge time.`;
  }
  return null;
}

/**
 * Turns a resolved snapshot into the decision figures: the exact cohort sums
 * from the stored pairs, the trigger verdict, and — when actionable — the
 * integer total with its per-settlement line distribution. A zero figure is
 * reported as-is for the preview to show; applying it is refused by the caller.
 */
function evaluateStoredSnapshot(
  targetAccountId: string,
  snapshot: CalibrationCohortSnapshot,
  resolution: ResolvedStoredPairs,
):
  | { kind: "ok"; totals: CalibrationCohortTotals; actionability: CalibrationActionability; figure: AdjustmentTotal | null; lines: readonly CreditAdjustmentLineRecord[] }
  | SnapshotEvidenceConflict {
  const totals = cohortTotalsFrom(snapshot);
  const actionability = describeCalibrationActionability(snapshot.comparison);
  if (
    snapshot.comparison.selfWork.count !== totals.selfCount ||
    snapshot.comparison.outsider.count !== totals.outCount
  ) {
    return snapshotDrift("The stored comparison's cohort counts disagree with the stored pairs.");
  }
  if (!actionability.actionable) {
    return { kind: "ok", totals, actionability, figure: null, lines: [] };
  }

  const compensablePairs = compensableLineInputs(targetAccountId, snapshot, resolution);
  if (compensablePairs === null) {
    return snapshotDrift("Every compensated settlement's creditor is the sponsor; there is nobody to compensate.");
  }

  let figure: AdjustmentTotal;
  let lines: AdjustmentLine[];
  try {
    figure = computeAdjustmentTotal(totals);
    lines = figure.totalAmount === 0 ? [] : distributeAdjustmentLines(figure.totalAmount, compensablePairs);
  } catch (error) {
    if (error instanceof ModerationAdjustmentError) {
      return snapshotDrift(`The stored snapshot admits no compensable figure: ${error.message}`);
    }
    throw error;
  }
  return {
    kind: "ok",
    totals,
    actionability,
    figure,
    lines: lines.map((line) => ({
      settlementId: line.settlementKey,
      creditorId: line.creditorKey,
      amount: line.amount,
    })),
  };
}

/** The exact delta sums and counts, taken from the stored pairs, never from the float means. */
function cohortTotalsFrom(snapshot: CalibrationCohortSnapshot): CalibrationCohortTotals {
  const sum = (pairs: readonly CalibrationPair[]) =>
    pairs.reduce((total, pair) => total + (pair.settledDifficulty - pair.offeredDifficulty), 0);
  return {
    selfSum: sum(snapshot.selfWorkPairs),
    selfCount: snapshot.selfWorkPairs.length,
    outSum: sum(snapshot.outsiderSettlementPairs),
    outCount: snapshot.outsiderSettlementPairs.length,
  };
}

/**
 * One unit per sampled pair, keyed by the creditor and settlement resolved from
 * the live rows. A settlement whose creditor is the sponsor itself is excluded
 * from compensation (it cannot exist today: the settlement check forbids
 * creditor equals debtor, but the exclusion is the plan's named edge); null
 * when that leaves nothing to compensate.
 */
function compensableLineInputs(
  targetAccountId: string,
  snapshot: CalibrationCohortSnapshot,
  resolution: ResolvedStoredPairs,
): AdjustmentLineInput[] | null {
  const lineInputs = snapshot.outsiderSettlementPairs.map((pair, index) => {
    const settlement = resolution.outsiderSettlements[index]!;
    return {
      creditorKey: settlement.creditorId,
      settlementKey: settlement.settlementId,
      weight: 1,
    };
  });
  const compensable = lineInputs.filter((line) => line.creditorKey !== targetAccountId);
  return compensable.length === 0 ? null : compensable;
}

/**
 * Reads the audit's stored snapshot back from its JSONB columns, validating the
 * shape: the pairs must be complete calibration pairs and the comparison a
 * complete one, since the adjustment is computed from exactly this evidence.
 * Null when the stored value is not a snapshot.
 */
function parseStoredSnapshot(audit: {
  cohort_definition: unknown;
  cohort_statistics: unknown;
}): CalibrationCohortSnapshot | null {
  if (
    typeof audit.cohort_definition !== "object" ||
    audit.cohort_definition === null ||
    typeof audit.cohort_statistics !== "object" ||
    audit.cohort_statistics === null
  ) {
    return null;
  }
  const definition = audit.cohort_definition as Record<string, unknown>;
  const comparison = audit.cohort_statistics as Record<string, unknown>;

  if (typeof definition["targetAccountId"] !== "string") {
    return null;
  }
  const repositoryId = definition["repositoryId"];
  if (repositoryId !== null && typeof repositoryId !== "string") {
    return null;
  }
  if (typeof definition["sampleStartedAt"] !== "string" || typeof definition["sampleEndedAt"] !== "string") {
    return null;
  }
  const selfWorkPairs = parseStoredPairs(definition["selfWorkPairs"]);
  const outsiderSettlementPairs = parseStoredPairs(definition["outsiderSettlementPairs"]);
  if (selfWorkPairs === null || outsiderSettlementPairs === null) {
    return null;
  }

  const selfWork = parseStoredSummary(comparison["selfWork"]);
  const outsider = parseStoredSummary(comparison["outsider"]);
  if (selfWork === null || outsider === null) {
    return null;
  }
  const differenceBetweenMeans = comparison["differenceBetweenMeans"];
  if (differenceBetweenMeans !== null && typeof differenceBetweenMeans !== "number") {
    return null;
  }

  return {
    targetAccountId: definition["targetAccountId"],
    repositoryId,
    sampleStartedAt: definition["sampleStartedAt"],
    sampleEndedAt: definition["sampleEndedAt"],
    selfWorkPairs,
    outsiderSettlementPairs,
    comparison: { selfWork, outsider, differenceBetweenMeans },
  };
}

function parseStoredPairs(value: unknown): CalibrationPair[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const pairs: CalibrationPair[] = [];
  const seenProofs = new Set<string>();
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) {
      return null;
    }
    const pair = entry as Record<string, unknown>;
    const proofSha256 = pair["proofSha256"];
    if (
      !isPositiveSafeInteger(pair["githubRepositoryId"]) ||
      !isPositiveSafeInteger(pair["githubIssueId"]) ||
      !isPositiveSafeInteger(pair["githubPullRequestId"]) ||
      !isDifficultyPoints(pair["offeredDifficulty"]) ||
      !isDifficultyPoints(pair["settledDifficulty"]) ||
      typeof proofSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(proofSha256) ||
      typeof pair["mergedAt"] !== "string" ||
      Number.isNaN(Date.parse(pair["mergedAt"]))
    ) {
      return null;
    }
    // A repeated proof inside one cohort list would compensate one settlement
    // twice (or inflate a self cohort it does not belong to), so a snapshot
    // carrying one is malformed evidence, refused before anything computes.
    if (seenProofs.has(proofSha256)) {
      return null;
    }
    seenProofs.add(proofSha256);
    pairs.push({
      githubRepositoryId: pair["githubRepositoryId"],
      githubIssueId: pair["githubIssueId"],
      githubPullRequestId: pair["githubPullRequestId"],
      mergedAt: pair["mergedAt"],
      proofSha256,
      offeredDifficulty: pair["offeredDifficulty"],
      settledDifficulty: pair["settledDifficulty"],
    });
  }
  return pairs;
}

function parseStoredSummary(value: unknown): CalibrationCohortSnapshot["comparison"]["selfWork"] | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const summary = value as Record<string, unknown>;
  if (
    !isNonNegativeSafeInteger(summary["count"]) ||
    typeof summary["meanDelta"] !== "number" ||
    typeof summary["medianDelta"] !== "number"
  ) {
    return null;
  }
  return {
    count: summary["count"],
    meanDelta: summary["meanDelta"],
    medianDelta: summary["medianDelta"],
  };
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isDifficultyPoints(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 10;
}

type SubstantiatedAuditRow = {
  id: string;
  account_id: string;
  repository_id: string | null;
  decided_at: string | Date | null;
  cohort_definition: unknown;
  cohort_statistics: unknown;
};

type AdjustmentCoreRow = {
  id: string;
  calibration_audit_id: string;
  target_account_id: string;
  gap_per_pair: number | string;
  pair_count: number | string;
  total_amount: number | string;
  reversal_of: string | null;
};

type AdjustmentRecordRow = AdjustmentCoreRow & {
  moderation_event_id: string;
  reason: string;
  created_at: string | Date;
};

type LineRow = {
  settlement_id: string;
  creditor_id: string;
  amount: number | string;
};

type AdjustmentLineRow = LineRow & { adjustment_id: string };

type OutsiderResolutionRow = {
  settlement_id: string;
  creditor_id: string;
  status: string;
  opening_comparison_points: number | string;
  settled_points: number | string | null;
  github_repository_id: number | string;
  github_issue_id: number | string;
  github_pull_request_id: number | string;
  merged_at: string | Date;
};

type SelfWorkResolutionRow = {
  opening_comparison_points: number | string;
  actual_points: number | string | null;
  github_repository_id: number | string;
  github_issue_id: number | string;
  github_pull_request_id: number | string;
  merged_at: string | Date;
};

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function proofPrefix(proofSha256: string): string {
  return proofSha256.slice(0, 16);
}

function toSafeInteger(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Database record was invalid.");
  }
  return parsed;
}

function toIsoTimestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Database timestamp was invalid.");
  }
  return date.toISOString();
}

function bySettlementId(left: CreditAdjustmentLineRecord, right: CreditAdjustmentLineRecord): number {
  return left.settlementId.localeCompare(right.settlementId);
}
