import { describe, expect, it } from "vitest";
import { ISSUES_BOARD_MAX_PAGE_SIZE, resolveIssuesBoardPage } from "@/lib/dashboard/eligible-issues";

/**
 * The board page window's bounds, as pure arithmetic: `page` is 1-based and a
 * past-end page reads as an empty page, so the resolved page must never steer
 * the query's SQL offset beyond the largest integer Postgres can receive
 * exactly — `Number.MAX_SAFE_INTEGER` — for any page size the clamp admits.
 * A huge page reading as an upstream outage (alert 1066) is the defect these
 * bounds close.
 */

/** The largest page whose offset `(page - 1) * pageSize` stays a safe integer. */
function largestServablePage(pageSize: number): number {
  return Math.floor(Number.MAX_SAFE_INTEGER / pageSize) + 1;
}

/** The offset the query binds for a resolved window. */
function offsetOf(window: { page: number; pageSize: number }): number {
  return (window.page - 1) * window.pageSize;
}

describe("resolveIssuesBoardPage", () => {
  it("reads an omitted, non-finite, or non-positive page as the first page at the default size", () => {
    expect(resolveIssuesBoardPage(undefined, undefined)).toEqual({ page: 1, pageSize: 200 });
    expect(resolveIssuesBoardPage(Number.NaN, 200)).toEqual({ page: 1, pageSize: 200 });
    expect(resolveIssuesBoardPage(0, 200)).toEqual({ page: 1, pageSize: 200 });
    expect(resolveIssuesBoardPage(-5, 200)).toEqual({ page: 1, pageSize: 200 });
    expect(resolveIssuesBoardPage(2.7, 200)).toEqual({ page: 2, pageSize: 200 });
  });

  it("passes a page whose offset is already a safe integer through unchanged", () => {
    // 1e9 was the issue report's already-working control: page 1000000000
    // answered 200 [] before the bound and must keep doing so.
    expect(resolveIssuesBoardPage(1_000_000_000, 200)).toEqual({ page: 1_000_000_000, pageSize: 200 });
    expect(resolveIssuesBoardPage(45_035_996_273_705, 200)).toEqual({
      page: 45_035_996_273_705,
      pageSize: 200,
    });
    expect(offsetOf(resolveIssuesBoardPage(45_035_996_273_705, 200))).toBe(9_007_199_254_740_800);
  });

  it("clamps a page one past the bound back to the largest servable page", () => {
    expect(resolveIssuesBoardPage(45_035_996_273_706, 200)).toEqual({
      page: 45_035_996_273_705,
      pageSize: 200,
    });
  });

  it.each([1e17, 1e308, Number.MAX_SAFE_INTEGER])(
    "clamps a huge page %s to the largest page whose offset stays a safe integer",
    (page) => {
      const resolved = resolveIssuesBoardPage(page, 200);
      expect(resolved).toEqual({ page: 45_035_996_273_705, pageSize: 200 });
      expect(offsetOf(resolved)).toBe(9_007_199_254_740_800);
    },
  );

  it("keeps the bound inside a safe-integer offset at every page size the clamp serves", () => {
    for (let pageSize = 1; pageSize <= ISSUES_BOARD_MAX_PAGE_SIZE; pageSize += 1) {
      const resolved = resolveIssuesBoardPage(1e308, pageSize);
      expect(resolved.page).toBe(largestServablePage(pageSize));
      expect(Number.isSafeInteger(offsetOf(resolved)), `pageSize ${pageSize}`).toBe(true);
      expect(offsetOf(resolved)).toBeLessThanOrEqual(Number.MAX_SAFE_INTEGER);
    }
  });
});
