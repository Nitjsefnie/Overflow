import type { EnforcementState } from "@/lib/db/types";

export type SubstantiatedEnforcementState = Extract<
  EnforcementState,
  "WARNED" | "RECALIBRATING" | "BANNED"
>;

export class ModerationTransitionError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "ModerationTransitionError";
  }
}

export function deriveSubstantiatedState(
  confirmedPatternCount: number,
): SubstantiatedEnforcementState {
  if (!Number.isSafeInteger(confirmedPatternCount) || confirmedPatternCount <= 0) {
    throw new ModerationTransitionError("Confirmed-pattern count must be a positive integer.");
  }

  if (confirmedPatternCount === 1) {
    return "WARNED";
  }
  if (confirmedPatternCount === 2) {
    return "RECALIBRATING";
  }
  return "BANNED";
}

export function normalizeRecalibrationPlan(value: unknown): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ModerationTransitionError("A nonblank recalibration plan is required.");
  }
  return value.trim();
}
