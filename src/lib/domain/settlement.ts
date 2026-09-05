import type { ActualDifficulty } from "@/lib/domain/difficulty-scheme";

export type SettlementInput = {
  creditorId: string | null;
  debtorId: string;
  opening: number;
  settled: number | ActualDifficulty | null;
  reviewIds: string[];
};

export type SettlementDecision =
  | { status: "SELF_WORK"; credits: 0 }
  | { status: "UNSETTLED"; credits: 0 }
  | {
      status: "SETTLED";
      creditorId: string;
      debtorId: string;
      opening: number;
      settled: number;
      reviewRounds: number;
      credits: number;
    };

const minimumPoints = 1;
const maximumPoints = 10;

export function calculateSettlement(input: SettlementInput): SettlementDecision {
  if (!hasText(input.creditorId) || !hasText(input.debtorId)) {
    return { status: "UNSETTLED", credits: 0 };
  }

  if (input.creditorId === input.debtorId) {
    return { status: "SELF_WORK", credits: 0 };
  }

  const settled = resolveActualPoints(input.settled);
  if (!isPointsValue(input.opening) || settled === null) {
    return { status: "UNSETTLED", credits: 0 };
  }

  const reviewRounds = new Set(input.reviewIds).size;
  return {
    status: "SETTLED",
    creditorId: input.creditorId,
    debtorId: input.debtorId,
    opening: input.opening,
    settled,
    reviewRounds,
    credits: creditsForSettledPoints(settled, reviewRounds),
  };
}

/**
 * The one credit rule: settled points less the distinct review rounds, never
 * below zero. Exported so a moderator's correction recomputes credits from the
 * same expression the fold uses instead of storing a figure beside it.
 */
export function creditsForSettledPoints(settledPoints: number, reviewRounds: number): number {
  return Math.max(0, settledPoints - reviewRounds);
}

function resolveActualPoints(settled: SettlementInput["settled"]): number | null {
  if (typeof settled === "number") {
    return isPointsValue(settled) ? settled : null;
  }

  if (settled?.kind === "ok") {
    return isPointsValue(settled.points) ? settled.points : null;
  }

  return null;
}

export function isPointsValue(value: number): boolean {
  return Number.isInteger(value) && value >= minimumPoints && value <= maximumPoints;
}

function hasText(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}
