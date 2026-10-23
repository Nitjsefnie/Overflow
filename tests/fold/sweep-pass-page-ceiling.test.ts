import { describe, expect, it } from "vitest";
import { DEFAULT_SWEEP_PASS_PAGE_CEILING, readSweepPassPageCeiling } from "@/lib/fold/sweep-pass";

describe("sweep pass page ceiling", () => {
  it("defaults an absent ceiling", () => {
    expect(readSweepPassPageCeiling({})).toBe(DEFAULT_SWEEP_PASS_PAGE_CEILING);
  });
  it.each(["", "oops", "0", "-1", "1.5", "Infinity", " 2", "2 ", String(Number.MAX_SAFE_INTEGER + 1)])(
    "defaults invalid ceiling %s", (value) => {
      expect(readSweepPassPageCeiling({ RECONCILIATION_SWEEP_PAGE_CEILING: value })).toBe(DEFAULT_SWEEP_PASS_PAGE_CEILING);
    },
  );
  it("accepts a positive integer override", () => {
    expect(readSweepPassPageCeiling({ RECONCILIATION_SWEEP_PAGE_CEILING: "17" })).toBe(17);
  });
});
