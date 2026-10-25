import { describe, expect, it } from "vitest";
import { DEFAULT_DIFF_ONLY_BACKLOG, readDiffOnlyBacklogThreshold } from "@/lib/fold/repository-size";

describe("the diff-only backlog threshold", () => {
  it("defaults an absent threshold", () => {
    expect(readDiffOnlyBacklogThreshold({})).toBe(DEFAULT_DIFF_ONLY_BACKLOG);
  });
  it.each(["", "oops", "0", "-1", "1.5", "Infinity", " 2", "2 ", String(Number.MAX_SAFE_INTEGER + 1)])(
    "defaults invalid threshold %s",
    (value) => {
      expect(readDiffOnlyBacklogThreshold({ RECONCILIATION_DIFF_ONLY_BACKLOG: value })).toBe(DEFAULT_DIFF_ONLY_BACKLOG);
    },
  );
  it("accepts a positive integer override", () => {
    expect(readDiffOnlyBacklogThreshold({ RECONCILIATION_DIFF_ONLY_BACKLOG: "250" })).toBe(250);
  });
});
