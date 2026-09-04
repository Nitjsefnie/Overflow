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
  if (input.creditorId !== null && input.creditorId === input.debtorId) {
    return { status: "SELF_WORK", credits: 0 };
  }

  const settled = resolveActualPoints(input.settled);
  if (
    !hasText(input.creditorId) ||
    !hasText(input.debtorId) ||
    !isPointsValue(input.opening) ||
    settled === null
  ) {
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
    credits: Math.max(0, settled - reviewRounds),
  };
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

function isPointsValue(value: number): boolean {
  return Number.isInteger(value) && value >= minimumPoints && value <= maximumPoints;
}

function hasText(value: string | null): value is string {
  return value !== null && value.trim().length > 0;
}
