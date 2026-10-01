import { describe, expect, it } from "vitest";
import { GitLabApiError, isUnclassifiedGitLabFailure } from "@/lib/gitlab/api-error";

// Issue 892: the labels route's GitLab arm logs exactly the failures no arm
// of its classification explains. This file pins the REAL predicate's set —
// the route defines it (401/403 → 403 FORBIDDEN, 404 → 404 NOT_FOUND, 429 →
// 429 RATE_LIMITED), so anything else is unclassified and worth recording:
// a plain Error (the collection-walk bound's rank), every transport rank
// (status 0), and every status GitLab answered with that the route has no arm
// for, a 500 among them.
describe("isUnclassifiedGitLabFailure", () => {
  it("reads a plain Error as unclassified — the collection-walk bound's rank", () => {
    expect(isUnclassifiedGitLabFailure(new Error("repository labels: walked past the ceiling"))).toBe(true);
  });

  // The instanceof disjunct's distinguishing corner: the route's arms all
  // read `error instanceof GitLabApiError && status`, so a foreign,
  // non-GitLabApiError value carrying an in-set status matched no arm at all
  // — it is unclassified even though its status is one the route answers for.
  it("reads a non-GitLabApiError carrying an in-set status as unclassified", () => {
    expect(isUnclassifiedGitLabFailure({ status: 401 })).toBe(true);
  });

  it.each([0, 500, 503])("reads GitLabApiError status %i as unclassified", (status) => {
    expect(isUnclassifiedGitLabFailure(new GitLabApiError(status))).toBe(true);
  });

  it.each([401, 403, 404, 429])("reads GitLabApiError status %i as classified", (status) => {
    expect(isUnclassifiedGitLabFailure(new GitLabApiError(status))).toBe(false);
  });
});
