import { describe, expect, it } from "vitest";
import { countReviewRoundsAsOf } from "@/lib/fold/repository-fold";
import type { GitHubPullRequestReview } from "@/lib/github/types";

const cutoff = Date.parse("2026-10-01T12:00:00.000Z");
const before = "2026-10-01T11:59:59.999Z";

describe("countReviewRoundsAsOf", () => {
  it("counts distinct changes-requested rounds before the cutoff, sorted by ID", () => {
    expect(countReviewRoundsAsOf([
      review(3), review(1), review(3), review(2, "APPROVED"), review(4, "COMMENTED"), review(5, "PENDING"),
    ], cutoff)).toEqual([
      { githubReviewId: 1, submittedAt: before }, { githubReviewId: 3, submittedAt: before },
    ]);
  });

  it("excludes submissions at or after the cutoff and missing or invalid timestamps", () => {
    expect(countReviewRoundsAsOf([
      review(1), { ...review(2), submittedAt: "2026-10-01T12:00:00.000Z" },
      { ...review(3), submittedAt: "2026-10-01T12:00:00.001Z" },
      { ...review(4), submittedAt: null }, { ...review(5), submittedAt: "invalid" },
    ], cutoff)).toEqual([{ githubReviewId: 1, submittedAt: before }]);
  });

  it("withdraws pre-cutoff dismissals while preserving rounds dismissed at or after the cutoff", () => {
    expect(countReviewRoundsAsOf([
      { ...review(1, "DISMISSED"), dismissal: { at: before, previousState: "CHANGES_REQUESTED" } },
      { ...review(2, "DISMISSED"), dismissal: { at: "2026-10-01T12:00:00.000Z", previousState: "CHANGES_REQUESTED" } },
      { ...review(3, "DISMISSED"), dismissal: { at: "2026-10-01T12:00:00.001Z", previousState: "CHANGES_REQUESTED" } },
      { ...review(4), dismissal: { at: before, previousState: "CHANGES_REQUESTED" } },
    ], cutoff)).toEqual([
      { githubReviewId: 2, submittedAt: before }, { githubReviewId: 3, submittedAt: before },
    ]);
  });

  it("preserves dismissal state handling for missing or unreadable dismissal evidence", () => {
    expect(countReviewRoundsAsOf([
      review(1, "DISMISSED"),
      { ...review(2, "DISMISSED"), dismissal: { at: before, previousState: null } },
      { ...review(3, "DISMISSED"), dismissal: { at: "invalid", previousState: "CHANGES_REQUESTED" } },
    ], cutoff)).toEqual([{ githubReviewId: 3, submittedAt: before }]);
  });
});

function review(id: number, state: GitHubPullRequestReview["state"] = "CHANGES_REQUESTED"): GitHubPullRequestReview {
  return { id, state, submittedAt: before, dismissal: null };
}
