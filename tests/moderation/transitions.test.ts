import { describe, expect, it } from "vitest";
import {
  ModerationTransitionError,
  deriveSubstantiatedState,
  normalizeRecalibrationPlan,
} from "@/lib/moderation/transitions";

describe("account moderation transitions", () => {
  it.each([
    [1, "WARNED"],
    [2, "RECALIBRATING"],
    [3, "BANNED"],
    [8, "BANNED"],
  ] as const)("derives %s confirmed patterns as %s", (confirmedPatternCount, expectedState) => {
    expect(deriveSubstantiatedState(confirmedPatternCount)).toBe(expectedState);
  });

  it.each([0, -1, 1.5, Number.POSITIVE_INFINITY])(
    "rejects a non-positive or non-integer confirmed-pattern count (%s)",
    (confirmedPatternCount) => {
      expect(() => deriveSubstantiatedState(confirmedPatternCount)).toThrow(ModerationTransitionError);
    },
  );

  it("requires a nonblank moderator-recorded recalibration plan", () => {
    expect(normalizeRecalibrationPlan("  compare opening labels with merged work weekly  ")).toBe(
      "compare opening labels with merged work weekly",
    );
    expect(() => normalizeRecalibrationPlan(" \n\t ")).toThrow(ModerationTransitionError);
  });
});
