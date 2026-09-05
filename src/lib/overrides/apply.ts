import { creditsForSettledPoints, isPointsValue } from "@/lib/domain/settlement";
import type { FoldSettlement, SelfWorkCalibration } from "@/lib/fold/repository-fold";

/**
 * Rewrites a folded settlement with the settled points a moderator granted.
 *
 * The override lives beside the fold rather than inside it: the fold reads
 * immutable GitHub history and must keep producing the same answer from it, so
 * a correction is applied to the fold's result at materialization time. Credits
 * are recomputed from the settled points and the review rounds the fold already
 * counted, never carried over from the granted decision, so a stored figure can
 * never disagree with the rule.
 *
 * A correction can only supply the settled points. It cannot invent a creditor:
 * where the fold found no author account and no author login, or where the
 * author is the debtor, the settlement is returned untouched.
 */
export function applyGrantedSettlementOverride(
  settlement: FoldSettlement,
  settledPoints: number,
): FoldSettlement {
  if (!isPointsValue(settledPoints)) {
    return settlement;
  }

  const credits = creditsForSettledPoints(settledPoints, settlement.reviewRounds);
  if (settlement.creditorId === null) {
    if (settlement.creditorGitHubLogin === null || settlement.creditorGitHubLogin.trim().length === 0) {
      return settlement;
    }
    return { ...settlement, settledPoints, credits, status: "UNCLAIMED" };
  }

  if (settlement.creditorId === settlement.debtorId) {
    return settlement;
  }

  return { ...settlement, settledPoints, credits, status: "SETTLED" };
}

/**
 * Rewrites a folded self-work calibration with the actual points a moderator
 * granted.
 *
 * Self-work earns no credits, so a correction here only restates how difficult
 * the delivered work turned out to be — the figure the calibration compares
 * against the opening estimate. It is applied beside the fold for the same
 * reason a settlement correction is: materialization rewrites calibration rows
 * from immutable GitHub history on every run, so a correction written into the
 * row would not survive the next reconciliation.
 *
 * The evidence fields stay exactly as the fold left them. The fold looked for an
 * actual-difficulty label and the rationale comment that authorizes it and found
 * neither, and a moderator's grant is a points decision, not a claim about what
 * GitHub recorded — so no label, label event, actor or timestamp is invented
 * here.
 */
export function applyGrantedSelfWorkCalibrationOverride(
  calibration: SelfWorkCalibration,
  actualPoints: number,
): SelfWorkCalibration {
  if (!isPointsValue(actualPoints)) {
    return calibration;
  }

  return { ...calibration, actualPoints };
}
