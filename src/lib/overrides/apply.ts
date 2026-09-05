import { creditsForSettledPoints, isPointsValue } from "@/lib/domain/settlement";
import type { FoldSettlement } from "@/lib/fold/repository-fold";

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
