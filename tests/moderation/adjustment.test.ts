import { describe, expect, it } from "vitest";
import type { CalibrationComparison } from "@/lib/calibration/statistics";
import { MINIMUM_CALIBRATION_SAMPLE_SIZE } from "@/lib/calibration/statistics";
import {
  ModerationAdjustmentError,
  computeAdjustmentTotal,
  describeCalibrationActionability,
  distributeAdjustmentLines,
} from "@/lib/moderation/adjustment";

const comparisonWith = (
  overrides: {
    selfWork?: Partial<CalibrationComparison["selfWork"]>;
    outsider?: Partial<CalibrationComparison["outsider"]>;
    differenceBetweenMeans?: number | null;
  } = {},
): CalibrationComparison => {
  const { selfWork, outsider, differenceBetweenMeans = 4 } = overrides;
  return {
    selfWork: {
      count: MINIMUM_CALIBRATION_SAMPLE_SIZE,
      meanDelta: 5,
      medianDelta: 5,
      ...selfWork,
    },
    outsider: {
      count: MINIMUM_CALIBRATION_SAMPLE_SIZE,
      meanDelta: 1,
      medianDelta: 1,
      ...outsider,
    },
    differenceBetweenMeans,
  };
};

describe("describeCalibrationActionability", () => {
  it("is actionable at exactly the counting floors with a positive gap", () => {
    expect(describeCalibrationActionability(comparisonWith())).toEqual({
      actionable: true,
      reason: "SELF_WORK_UNDERCREDITED_OUTSIDERS",
    });
  });

  it("is not actionable for an empty outsider cohort whose means would read as a perfect gap", () => {
    // The issue-329 substitution: an empty population and a perfectly calibrated
    // one both yield meanDelta 0. A trigger keyed on the means reads selfWork
    // 5 > outsider 0 as a compensable gap; the counting trigger refuses it.
    expect(
      describeCalibrationActionability(
        comparisonWith({
          selfWork: { meanDelta: 5 },
          outsider: { count: 0, meanDelta: 0 },
          differenceBetweenMeans: null,
        }),
      ),
    ).toEqual({
      actionable: false,
      reason: "OUTSIDER_COHORT_BELOW_MINIMUM_SAMPLE_SIZE",
    });
  });

  it("is not actionable one below the outsider counting floor", () => {
    expect(
      describeCalibrationActionability(
        comparisonWith({
          outsider: { count: MINIMUM_CALIBRATION_SAMPLE_SIZE - 1 },
          differenceBetweenMeans: 4,
        }),
      ),
    ).toEqual({
      actionable: false,
      reason: "OUTSIDER_COHORT_BELOW_MINIMUM_SAMPLE_SIZE",
    });
  });

  it("is not actionable one below the self-work counting floor", () => {
    expect(
      describeCalibrationActionability(
        comparisonWith({
          selfWork: { count: MINIMUM_CALIBRATION_SAMPLE_SIZE - 1 },
          differenceBetweenMeans: 4,
        }),
      ),
    ).toEqual({
      actionable: false,
      reason: "SELF_COHORT_BELOW_MINIMUM_SAMPLE_SIZE",
    });
  });

  it("is not actionable on a zero gap", () => {
    expect(
      describeCalibrationActionability(
        comparisonWith({
          selfWork: { meanDelta: 3 },
          outsider: { meanDelta: 3 },
          differenceBetweenMeans: 0,
        }),
      ),
    ).toEqual({ actionable: false, reason: "NO_POSITIVE_CALIBRATION_GAP" });
  });

  it("is not actionable on a negative gap (compensate-only)", () => {
    expect(
      describeCalibrationActionability(
        comparisonWith({
          selfWork: { meanDelta: 2 },
          outsider: { meanDelta: 5 },
          differenceBetweenMeans: -3,
        }),
      ),
    ).toEqual({ actionable: false, reason: "NO_POSITIVE_CALIBRATION_GAP" });
  });

  it("is not actionable when the gap is absent even with both floors met", () => {
    expect(
      describeCalibrationActionability(comparisonWith({ differenceBetweenMeans: null })),
    ).toEqual({ actionable: false, reason: "NO_POSITIVE_CALIBRATION_GAP" });
  });
});

describe("computeAdjustmentTotal", () => {
  it("computes an exact whole-point total", () => {
    expect(computeAdjustmentTotal({ selfSum: 50, selfCount: 10, outSum: 10, outCount: 10 })).toEqual({
      gapPerPair: 4,
      pairCount: 10,
      totalAmount: 40,
    });
  });

  it("rounds half away from zero where the float-mean route rounds wrong at the floors", () => {
    // Exact gap 3/10 − 3/15 = 1/10, exact total 1.5 → 2. The float route
    // (0.3 − 0.2 = 0.09999999999999998, × 15) gives 1.4999999999999998 → 1.
    expect(computeAdjustmentTotal({ selfSum: 3, selfCount: 10, outSum: 3, outCount: 15 })).toEqual({
      gapPerPair: 0.1,
      pairCount: 15,
      totalAmount: 2,
    });
  });

  it("rounds half away from zero on a sub-floor cohort where the float route loses a whole point", () => {
    // Exact gap 1/2 − 2/5 = 1/10, exact total 0.5 → 1. The float route
    // (0.09999999999999998 × 5 = 0.49…) gives 0.
    expect(computeAdjustmentTotal({ selfSum: 1, selfCount: 2, outSum: 2, outCount: 5 })).toEqual({
      gapPerPair: 0.1,
      pairCount: 5,
      totalAmount: 1,
    });
  });

  it("reports gapPerPair from exact sums even where a mean does not round-trip with its count", () => {
    // 61/7 is a mean whose product with its count is 60.99999999999999, so a
    // sums-from-means reconstruction cannot even represent this cohort; the
    // exact total is (61×21 − 63×7)/7 = 120.
    const result = computeAdjustmentTotal({ selfSum: 61, selfCount: 7, outSum: 63, outCount: 21 });
    expect(result.totalAmount).toBe(120);
    expect(result.pairCount).toBe(21);
    expect(result.gapPerPair).toBe(40 / 7);
  });

  it("refuses a zero gap", () => {
    expect(() =>
      computeAdjustmentTotal({ selfSum: 30, selfCount: 10, outSum: 30, outCount: 10 }),
    ).toThrow(ModerationAdjustmentError);
  });

  it("refuses a negative gap (compensate-only)", () => {
    expect(() =>
      computeAdjustmentTotal({ selfSum: 10, selfCount: 10, outSum: 50, outCount: 10 }),
    ).toThrow(ModerationAdjustmentError);
  });

  it("refuses an empty cohort, where a mean does not exist", () => {
    expect(() => computeAdjustmentTotal({ selfSum: 0, selfCount: 0, outSum: 5, outCount: 10 })).toThrow(
      ModerationAdjustmentError,
    );
    expect(() => computeAdjustmentTotal({ selfSum: 5, selfCount: 10, outSum: 0, outCount: 0 })).toThrow(
      ModerationAdjustmentError,
    );
  });

  it("refuses non-integer or out-of-range cohort totals", () => {
    expect(() => computeAdjustmentTotal({ selfSum: 5.5, selfCount: 10, outSum: 5, outCount: 10 })).toThrow(
      ModerationAdjustmentError,
    );
    expect(() =>
      computeAdjustmentTotal({ selfSum: Number.MAX_SAFE_INTEGER, selfCount: 10, outSum: 0, outCount: 10 }),
    ).toThrow(ModerationAdjustmentError);
  });
});

describe("distributeAdjustmentLines", () => {
  it("returns an explicit empty result for a zero total", () => {
    expect(distributeAdjustmentLines(0, [{ creditorKey: "a", settlementKey: "a-1", weight: 1 }])).toEqual([]);
  });

  it("allocates by creditor weight with largest remainder and splits within a creditor by settlement", () => {
    // Stage 1: weights a=2, b=3, c=5, total 7 → shares 1.4 / 2.1 / 3.5, bases
    // 1 / 2 / 3, remainder numerators 4 / 1 / 5; the single remainder unit goes
    // to c. Stage 2 splits each creditor's amount across its own settlements by
    // weight (largest remainder, settlementKey ascending on ties); zero splits
    // carry no line.
    const lines = distributeAdjustmentLines(7, [
      { creditorKey: "a", settlementKey: "a-1", weight: 1 },
      { creditorKey: "a", settlementKey: "a-2", weight: 1 },
      { creditorKey: "b", settlementKey: "b-1", weight: 1 },
      { creditorKey: "b", settlementKey: "b-2", weight: 1 },
      { creditorKey: "b", settlementKey: "b-3", weight: 1 },
      { creditorKey: "c", settlementKey: "c-1", weight: 1 },
      { creditorKey: "c", settlementKey: "c-2", weight: 1 },
      { creditorKey: "c", settlementKey: "c-3", weight: 1 },
      { creditorKey: "c", settlementKey: "c-4", weight: 1 },
      { creditorKey: "c", settlementKey: "c-5", weight: 1 },
    ]);
    expect(lines).toEqual([
      { creditorKey: "a", settlementKey: "a-1", amount: 1 },
      { creditorKey: "b", settlementKey: "b-1", amount: 1 },
      { creditorKey: "b", settlementKey: "b-2", amount: 1 },
      { creditorKey: "c", settlementKey: "c-1", amount: 1 },
      { creditorKey: "c", settlementKey: "c-2", amount: 1 },
      { creditorKey: "c", settlementKey: "c-3", amount: 1 },
      { creditorKey: "c", settlementKey: "c-4", amount: 1 },
    ]);
  });

  it("hands remainder ties to the ascending creditor key", () => {
    expect(
      distributeAdjustmentLines(1, [
        { creditorKey: "b", settlementKey: "b-1", weight: 1 },
        { creditorKey: "a", settlementKey: "a-1", weight: 1 },
      ]),
    ).toEqual([{ creditorKey: "a", settlementKey: "a-1", amount: 1 }]);
  });

  it("splits a creditor's amount by its pairs' weights", () => {
    expect(
      distributeAdjustmentLines(3, [
        { creditorKey: "a", settlementKey: "a-1", weight: 2 },
        { creditorKey: "a", settlementKey: "a-2", weight: 1 },
      ]),
    ).toEqual([
      { creditorKey: "a", settlementKey: "a-1", amount: 2 },
      { creditorKey: "a", settlementKey: "a-2", amount: 1 },
    ]);
  });

  it("gives one pair the whole total", () => {
    expect(distributeAdjustmentLines(9, [{ creditorKey: "a", settlementKey: "a-1", weight: 1 }])).toEqual([
      { creditorKey: "a", settlementKey: "a-1", amount: 9 },
    ]);
  });

  it("always sums exactly to the total across many shapes", () => {
    for (const totalAmount of [1, 2, 3, 5, 8, 13]) {
      for (const shape of [
        [{ creditorKey: "a", settlementKey: "a-1", weight: 7 }],
        [
          { creditorKey: "a", settlementKey: "a-1", weight: 3 },
          { creditorKey: "b", settlementKey: "b-1", weight: 3 },
          { creditorKey: "b", settlementKey: "b-2", weight: 3 },
        ],
        [
          { creditorKey: "a", settlementKey: "a-1", weight: 1 },
          { creditorKey: "a", settlementKey: "a-2", weight: 1 },
          { creditorKey: "a", settlementKey: "a-3", weight: 1 },
          { creditorKey: "b", settlementKey: "b-1", weight: 1 },
          { creditorKey: "b", settlementKey: "b-2", weight: 1 },
          { creditorKey: "b", settlementKey: "b-3", weight: 1 },
        ],
      ]) {
        const lines = distributeAdjustmentLines(totalAmount, shape);
        const sum = lines.reduce((total, line) => total + line.amount, 0);
        expect(sum).toBe(totalAmount);
        for (const line of lines) {
          expect(Number.isInteger(line.amount)).toBe(true);
          expect(line.amount).toBeGreaterThan(0);
        }
      }
    }
  });

  it("refuses a positive total with no pairs to compensate", () => {
    expect(() => distributeAdjustmentLines(5, [])).toThrow(ModerationAdjustmentError);
  });

  it("refuses a negative or non-integer total", () => {
    expect(() =>
      distributeAdjustmentLines(-1, [{ creditorKey: "a", settlementKey: "a-1", weight: 1 }]),
    ).toThrow(ModerationAdjustmentError);
    expect(() =>
      distributeAdjustmentLines(2.5, [{ creditorKey: "a", settlementKey: "a-1", weight: 1 }]),
    ).toThrow(ModerationAdjustmentError);
  });

  it("refuses duplicate settlement keys", () => {
    expect(() =>
      distributeAdjustmentLines(5, [
        { creditorKey: "a", settlementKey: "a-1", weight: 1 },
        { creditorKey: "a", settlementKey: "a-1", weight: 1 },
      ]),
    ).toThrow(ModerationAdjustmentError);
  });

  it("refuses non-positive or non-integer weights and blank keys", () => {
    expect(() =>
      distributeAdjustmentLines(5, [{ creditorKey: "a", settlementKey: "a-1", weight: 0 }]),
    ).toThrow(ModerationAdjustmentError);
    expect(() =>
      distributeAdjustmentLines(5, [{ creditorKey: "a", settlementKey: "a-1", weight: 1.5 }]),
    ).toThrow(ModerationAdjustmentError);
    expect(() =>
      distributeAdjustmentLines(5, [{ creditorKey: "  ", settlementKey: "a-1", weight: 1 }]),
    ).toThrow(ModerationAdjustmentError);
    expect(() =>
      distributeAdjustmentLines(5, [{ creditorKey: "a", settlementKey: "", weight: 1 }]),
    ).toThrow(ModerationAdjustmentError);
  });
});
