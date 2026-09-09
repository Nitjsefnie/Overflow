/**
 * The decision surface for a sponsor's self-versus-outsider calibration gap.
 *
 * The trigger is keyed on the cohorts' pair COUNTS and the reported difference
 * between the cohort means — never on `outsider.meanDelta` (or
 * `selfWork.meanDelta`) alone. An empty population and a perfectly calibrated
 * one both yield a mean delta of 0 (the issue-329 substitution), so a
 * mean-keyed trigger would offer a compensation lever for a population that
 * does not exist. The counting floors come first for exactly that reason.
 */
import {
  MINIMUM_CALIBRATION_SAMPLE_SIZE,
  type CalibrationComparison,
} from "@/lib/calibration/statistics";

export class ModerationAdjustmentError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ModerationAdjustmentError";
  }
}

export type CalibrationActionability = {
  actionable: boolean;
  reason:
    | "SELF_COHORT_BELOW_MINIMUM_SAMPLE_SIZE"
    | "OUTSIDER_COHORT_BELOW_MINIMUM_SAMPLE_SIZE"
    | "NO_POSITIVE_CALIBRATION_GAP"
    | "SELF_WORK_UNDERCREDITED_OUTSIDERS";
};

/**
 * The formal trigger, evaluated identically at every decision point (preview,
 * close, reversal precondition): both counting floors, then a positive gap.
 *
 * The floor checks run first, so a population that does not exist can never
 * look calibrated; `differenceBetweenMeans` is null exactly when a cohort is
 * empty, and the floors imply it is non-null.
 */
export function describeCalibrationActionability(
  comparison: CalibrationComparison,
): CalibrationActionability {
  if (comparison.selfWork.count < MINIMUM_CALIBRATION_SAMPLE_SIZE) {
    return { actionable: false, reason: "SELF_COHORT_BELOW_MINIMUM_SAMPLE_SIZE" };
  }
  if (comparison.outsider.count < MINIMUM_CALIBRATION_SAMPLE_SIZE) {
    return { actionable: false, reason: "OUTSIDER_COHORT_BELOW_MINIMUM_SAMPLE_SIZE" };
  }
  if (comparison.differenceBetweenMeans === null || comparison.differenceBetweenMeans <= 0) {
    return { actionable: false, reason: "NO_POSITIVE_CALIBRATION_GAP" };
  }
  return { actionable: true, reason: "SELF_WORK_UNDERCREDITED_OUTSIDERS" };
}

/**
 * The two cohorts' exact delta sums and counts, taken from the sampled pairs
 * themselves — never reconstructed from the summaries' float means. For
 * example 61/7 is a legitimate cohort mean whose product with its count is
 * 60.99999999999999, so a sums-from-means reconstruction cannot represent it.
 */
export type CalibrationCohortTotals = {
  /** Σ(settled − offered) over the sponsor's own-work pairs. */
  selfSum: number;
  selfCount: number;
  /** Σ(settled − offered) over the outsider pairs. */
  outSum: number;
  outCount: number;
};

export type AdjustmentTotal = {
  /** The per-pair gap, one correctly-rounded double from the exact rational. */
  gapPerPair: number;
  /** The compensated population: the outsider cohort's pair count. */
  pairCount: number;
  /** Integer points owed to outsiders, exact-rational rounded half away from zero. */
  totalAmount: number;
};

/**
 * Total adjustment = round(gap × outsider.count) in exact integer arithmetic:
 * totalExact = (selfSum × outCount − outSum × selfCount) / selfCount. Never
 * computes via float means and multiplies — 0.3 − 0.2 as doubles is
 * 0.09999999999999998, which rounds 1.5 exact points down to 1.
 *
 * Refuses (throws) where a mean does not exist (an empty cohort, the null
 * differenceBetweenMeans case) or the gap is non-positive: compensation is
 * the only action, and no precision is risked on the error paths.
 */
export function computeAdjustmentTotal(totals: CalibrationCohortTotals): AdjustmentTotal {
  assertSafeInteger(totals.selfSum, "Self-work delta sum");
  assertSafeInteger(totals.selfCount, "Self-work pair count");
  assertSafeInteger(totals.outSum, "Outsider delta sum");
  assertSafeInteger(totals.outCount, "Outsider pair count");

  if (totals.selfCount <= 0 || totals.outCount <= 0) {
    throw new ModerationAdjustmentError(
      "A cohort mean does not exist for an empty cohort; there is no gap to compensate.",
    );
  }

  const selfWeighted = totals.selfSum * totals.outCount;
  const outWeighted = totals.outSum * totals.selfCount;
  if (!Number.isSafeInteger(selfWeighted) || !Number.isSafeInteger(outWeighted)) {
    throw new ModerationAdjustmentError(
      "Cohort sums and counts must stay within the safe integer range for exact arithmetic.",
    );
  }

  const numerator = selfWeighted - outWeighted;
  assertSafeInteger(numerator, "The calibration gap");
  if (numerator <= 0) {
    throw new ModerationAdjustmentError(
      "A credit adjustment requires a positive calibration gap; non-positive gaps take no action.",
    );
  }

  const denominator = totals.selfCount;
  const remainder = numerator % denominator;
  const quotient = (numerator - remainder) / denominator;
  const totalAmount = 2 * remainder >= denominator ? quotient + 1 : quotient;

  return {
    gapPerPair: numerator / (totals.selfCount * totals.outCount),
    pairCount: totals.outCount,
    totalAmount,
  };
}

export type AdjustmentLineInput = {
  /** Stable creditor identifier; creditors with equal keys share one allocation. */
  creditorKey: string;
  /** Unique settlement identifier — one line per settlement, never duplicated. */
  settlementKey: string;
  /**
   * The pair's share weight. A creditor's weight is the sum over its pairs, so
   * with one unit per sampled pair it is the creditor's sampled-pair count.
   */
  weight: number;
};

export type AdjustmentLine = {
  creditorKey: string;
  settlementKey: string;
  amount: number;
};

/**
 * Largest-remainder distribution of the integer total across creditors, then
 * within each creditor across its settlements.
 *
 * Stage 1 — per creditor, weight = the sum of its pairs' weights (the
 * creditor's sampled-pair count when each pair carries one unit): base =
 * floor(share × total), the remaining units are handed out one each in
 * descending remainder order, ties broken by creditor key ascending.
 *
 * Stage 2 — a creditor's integer amount is split across its own pairs by the
 * same largest-remainder rule, ties broken by settlement key ascending.
 *
 * Lines are emitted ordered by creditor key then settlement key, they sum
 * exactly to totalAmount, and splits that land on zero carry no line. A zero
 * total yields an explicit empty result.
 */
export function distributeAdjustmentLines(
  totalAmount: number,
  pairs: readonly AdjustmentLineInput[],
): AdjustmentLine[] {
  if (!Number.isSafeInteger(totalAmount) || totalAmount < 0) {
    throw new ModerationAdjustmentError("Adjustment total must be a non-negative integer.");
  }
  if (totalAmount === 0) {
    return [];
  }
  if (pairs.length === 0) {
    throw new ModerationAdjustmentError(
      "A positive adjustment total requires at least one sampled pair to compensate.",
    );
  }

  const groups = groupPairsByCreditor(pairs);

  // Stage 1: exact integer largest remainder over creditors.
  let weightTotal = 0;
  for (const group of groups.values()) {
    weightTotal += group.totalWeight;
    if (!Number.isSafeInteger(weightTotal)) {
      throw new ModerationAdjustmentError(
        "Creditor weights must stay within the safe integer range for exact arithmetic.",
      );
    }
  }

  const creditorAmounts = new Map<string, number>();
  const remainderOrder: { creditorKey: string; remainder: number }[] = [];
  let allocated = 0;
  for (const [creditorKey, group] of groups) {
    const weighted = totalAmount * group.totalWeight;
    if (!Number.isSafeInteger(weighted)) {
      throw new ModerationAdjustmentError(
        "Creditor weights must stay within the safe integer range for exact arithmetic.",
      );
    }
    const base = (weighted - (weighted % weightTotal)) / weightTotal;
    creditorAmounts.set(creditorKey, base);
    allocated += base;
    remainderOrder.push({ creditorKey, remainder: weighted % weightTotal });
  }

  let remainderUnits = totalAmount - allocated;
  remainderOrder.sort(
    (left, right) =>
      right.remainder - left.remainder || compareStrings(left.creditorKey, right.creditorKey),
  );
  for (const entry of remainderOrder) {
    if (remainderUnits === 0) break;
    creditorAmounts.set(entry.creditorKey, creditorAmounts.get(entry.creditorKey)! + 1);
    remainderUnits -= 1;
  }

  const lines: AdjustmentLine[] = [];
  for (const creditorKey of [...groups.keys()].sort(compareStrings)) {
    const amount = creditorAmounts.get(creditorKey)!;
    if (amount === 0) {
      continue;
    }
    lines.push(...splitCreditorAmount(creditorKey, groups.get(creditorKey)!, amount));
  }
  return lines;
}

function groupPairsByCreditor(
  pairs: readonly AdjustmentLineInput[],
): Map<string, { totalWeight: number; pairs: AdjustmentLineInput[] }> {
  const groups = new Map<string, { totalWeight: number; pairs: AdjustmentLineInput[] }>();
  const settlementKeys = new Set<string>();
  for (const pair of pairs) {
    if (typeof pair.creditorKey !== "string" || pair.creditorKey.trim().length === 0) {
      throw new ModerationAdjustmentError("Creditor keys must be nonblank strings.");
    }
    if (typeof pair.settlementKey !== "string" || pair.settlementKey.trim().length === 0) {
      throw new ModerationAdjustmentError("Settlement keys must be nonblank strings.");
    }
    if (!Number.isSafeInteger(pair.weight) || pair.weight < 1) {
      throw new ModerationAdjustmentError("Pair weights must be positive integers.");
    }
    if (settlementKeys.has(pair.settlementKey)) {
      throw new ModerationAdjustmentError(
        `Settlement key ${pair.settlementKey} appears more than once; a settlement is compensated at most once.`,
      );
    }
    settlementKeys.add(pair.settlementKey);

    let group = groups.get(pair.creditorKey);
    if (!group) {
      group = { totalWeight: 0, pairs: [] };
      groups.set(pair.creditorKey, group);
    }
    group.totalWeight += pair.weight;
    if (!Number.isSafeInteger(group.totalWeight)) {
      throw new ModerationAdjustmentError(
        "Creditor weights must stay within the safe integer range for exact arithmetic.",
      );
    }
    group.pairs.push(pair);
  }
  return groups;
}

function splitCreditorAmount(
  creditorKey: string,
  group: { totalWeight: number; pairs: AdjustmentLineInput[] },
  amount: number,
): AdjustmentLine[] {
  const splits = group.pairs.map((pair) => {
    const weighted = amount * pair.weight;
    if (!Number.isSafeInteger(weighted)) {
      throw new ModerationAdjustmentError(
        "Creditor weights must stay within the safe integer range for exact arithmetic.",
      );
    }
    return {
      settlementKey: pair.settlementKey,
      base: (weighted - (weighted % group.totalWeight)) / group.totalWeight,
      remainder: weighted % group.totalWeight,
    };
  });

  let units = amount - splits.reduce((total, split) => total + split.base, 0);
  splits.sort(
    (left, right) =>
      right.remainder - left.remainder || compareStrings(left.settlementKey, right.settlementKey),
  );
  for (const split of splits) {
    if (units === 0) break;
    split.base += 1;
    units -= 1;
  }

  return splits
    .filter((split) => split.base > 0)
    .sort((left, right) => compareStrings(left.settlementKey, right.settlementKey))
    .map((split) => ({ creditorKey, settlementKey: split.settlementKey, amount: split.base }));
}

function assertSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new ModerationAdjustmentError(`${label} must be a safe integer.`);
  }
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
