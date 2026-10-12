import { describe, expect, it } from "vitest";
import { applyTighten, collectViolations, parseBudget } from "../../scripts/check-perf-budget.ts";

describe("SQL statement budgets", () => {
  it("accepts equal, deterministic measurements for the whole declared set", () => {
    expect(collectViolations({ board: [2, 2], fold: [20, 20] }, { board: 2, fold: 20 })).toEqual([]);
  });

  it("names the workload, budget and measured count when SQL work grows", () => {
    expect(collectViolations({ board: [3, 3] }, { board: 2 })).toEqual([
      expect.objectContaining({ kind: "over", workload: "board", detail: expect.stringMatching(/budget 2.*measured 3/) }),
    ]);
  });

  it("fails a shrink until the budget is tightened", () => {
    expect(collectViolations({ board: [1, 1] }, { board: 2 })).toEqual([
      expect.objectContaining({ kind: "shrunk", workload: "board" }),
    ]);
  });

  it("refuses a missing declared workload even if every remaining count is equal", () => {
    expect(collectViolations({ board: [2, 2] }, { board: 2, fold: 20 })).toEqual([
      expect.objectContaining({ kind: "missing", workload: "fold" }),
    ]);
  });

  it("refuses an unbudgeted measurement", () => {
    expect(collectViolations({ board: [2, 2], fold: [20, 20] }, { board: 2 })).toEqual([
      expect.objectContaining({ kind: "unexpected", workload: "fold" }),
    ]);
  });

  it("reports unequal repeats as nondeterminism even when both fit the budget", () => {
    expect(collectViolations({ board: [1, 2] }, { board: 2 })).toEqual([
      expect.objectContaining({ kind: "nondeterministic", workload: "board", detail: expect.stringContaining("1, 2") }),
    ]);
  });

  it.each([[[]], [[2]], [[2, 2, 2]], [[-1, -1]], [[1.5, 1.5]], [[NaN, NaN]], [[0, 0]]])(
    "refuses incomplete or invalid statement counts %j", (samples) => {
      expect(collectViolations({ board: samples }, { board: 2 })).toEqual([
        expect.objectContaining({ kind: "invalid", workload: "board" }),
      ]);
    },
  );

  it("tightens only shrunken counts, preserving the original document", () => {
    const budget = { board: 2, fold: 20 };
    expect(applyTighten({ board: [1, 1], fold: [20, 20] }, budget)).toEqual({
      doc: { board: 1, fold: 20 }, changes: ["lowered board: 2 -> 1"],
    });
    expect(budget).toEqual({ board: 2, fold: 20 });
  });

  it.each([
    [{ board: [3, 3] }, /over/],
    [{}, /missing/],
    [{ board: [2, 2], fold: [20, 20] }, /unexpected/],
    [{ board: [1, 2] }, /nondeterministic/],
  ] as const)("refuses tighten without rewriting an invalid run %j", (measurements, reason) => {
    expect(() => applyTighten(measurements, { board: 2 })).toThrow(reason);
  });

  it("reads a flat positive integer budget map", () => {
    expect(parseBudget({ board: 2, fold: 20 })).toEqual({ board: 2, fold: 20 });
  });

  it.each([null, [], {}, { board: 0 }, { board: -1 }, { board: 1.5 }, { board: "2" }, { board: Infinity }, { board: Number.MAX_SAFE_INTEGER + 1 }])(
    "refuses a malformed budget %j", (value) => {
      expect(() => parseBudget(value)).toThrow(/budget.*positive.*integer/);
    },
  );
});
