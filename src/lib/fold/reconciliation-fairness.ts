import type { GraphqlFoldCost } from "@/lib/github/graphql-cost";
import type { GitHubGraphqlBudgetAssessment } from "@/lib/github/rate-limit-budget";

export type ReconciliationUsage = { debt: number; measuredAt: Date; ratePerSecond: number };
export type ReconciliationFairnessAssessment = {
  state: "ADMITTED" | "HELD";
  holdUntil: Date | null;
  usage: ReconciliationUsage;
};
export type ReconciliationCostCharge = GraphqlFoldCost & { sponsorId: string; completedAt: Date };

function finiteNonnegative(value: number): boolean {
  return Number.isFinite(value) && value >= 0;
}

function finiteDate(value: Date): boolean {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function validUsage(usage: ReconciliationUsage): boolean {
  return finiteNonnegative(usage.debt) && finiteNonnegative(usage.ratePerSecond) && finiteDate(usage.measuredAt);
}

export function decayReconciliationUsage(usage: ReconciliationUsage, now: Date): ReconciliationUsage {
  const nowMs = finiteDate(now) ? now.getTime() : null;
  const measuredMs = finiteDate(usage.measuredAt) ? usage.measuredAt.getTime() : nowMs ?? 0;
  const effectiveMs = Math.max(nowMs ?? measuredMs, measuredMs);
  const elapsedSeconds = (effectiveMs - measuredMs) / 1000;
  const valid = validUsage(usage);
  return {
    debt: valid ? Math.max(0, usage.debt - usage.ratePerSecond * elapsedSeconds)
      : finiteNonnegative(usage.debt) ? usage.debt : 0,
    measuredAt: new Date(effectiveMs),
    ratePerSecond: valid ? usage.ratePerSecond : 0,
  };
}

export function assessReconciliationFairness(input: {
  usage: ReconciliationUsage | null;
  budget: GitHubGraphqlBudgetAssessment;
  activeRepositoryCount: number;
  now: Date;
}): ReconciliationFairnessAssessment {
  const usage = input.usage === null
    ? { debt: 0, measuredAt: new Date(finiteDate(input.now) ? input.now.getTime() : 0), ratePerSecond: 0 }
    : decayReconciliationUsage(input.usage, input.now);
  const unallocated: ReconciliationFairnessAssessment = {
    state: "ADMITTED", holdUntil: null, usage: { ...usage, ratePerSecond: 0 },
  };
  const { reading, reserve, state } = input.budget;
  if (!finiteDate(input.now) || (input.usage !== null && !validUsage(input.usage))
    || state !== "AVAILABLE" || reading === null || !finiteDate(reading.resetAt) || !finiteDate(reading.observedAt)
    || reading.resetAt.getTime() <= input.now.getTime()
    || !finiteNonnegative(reading.remaining) || !finiteNonnegative(reserve)
    || !Number.isSafeInteger(input.activeRepositoryCount) || input.activeRepositoryCount < 1) {
    return unallocated;
  }

  // Settle the old interval before replacing its allocation. Peer debt never
  // participates; only this sponsor's number of active registrations does.
  const secondsUntilReset = (reading.resetAt.getTime() - input.now.getTime()) / 1000;
  const rate = Math.max(0, reading.remaining - reserve) / secondsUntilReset / input.activeRepositoryCount;
  const allowance = 30 * rate;
  if (!finiteNonnegative(rate) || !finiteNonnegative(allowance)) return unallocated;
  const allocated = { ...usage, ratePerSecond: rate };
  if (usage.debt <= allowance) return { state: "ADMITTED", holdUntil: null, usage: allocated };

  // A future stored timestamp pauses decay. Include that pause in the recheck
  // without ever moving the persisted timestamp backwards.
  const delay = rate > 0
    ? Math.max(5000, Math.min(30000, Math.ceil(
      Math.max(0, usage.measuredAt.getTime() - input.now.getTime()) + 1000 * (usage.debt - allowance) / rate,
    )))
    : 30000;
  const holdUntil = new Date(input.now.getTime() + delay);
  if (!finiteDate(holdUntil)) return unallocated;
  return { state: "HELD", holdUntil, usage: allocated };
}
