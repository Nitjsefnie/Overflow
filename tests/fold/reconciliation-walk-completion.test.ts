import { describe, expect, it } from "vitest";
import { SweepBudgetSpent } from "@/lib/fold/sweep-request-budget";
import { GitHubApiError, GitHubGraphqlInvalidResponseError, GitHubGraphqlRequestError } from "@/lib/github/errors";
import { GitHubResponseTooLargeError } from "@/lib/github/response-text";
import { GitLabApiError } from "@/lib/gitlab/api-error";
import { fixture, instant, pullRequest, subject } from "./reconciliation-walk-fixture";

describe("reconciliation walk completion", () => {
  it("refreshes reviews and diff again after a hold halfway through completion", async () => {
    const f = fixture([subject(1)]);
    f.issues.get(1)!.closingPullRequests = [pullRequest(9)];
    await expect(f.window(4)).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect(f.requests).toEqual([expect.stringContaining("list:"), "issue:1", expect.stringContaining("list:"), "reviews:9"]);
    f.gateway.getPullRequestReviews = (pr) => f.read(`reviews:${pr.id}`, () => [{ id: 19, state: "APPROVED", submittedAt: instant(40).toISOString(), dismissal: null }]);
    f.gateway.getPullRequestDiff = (pr) => f.read(`diff:${pr.id}`, () => "fresh diff after hold");
    const result = await f.window(20);
    expect(result.issues[0]?.closingPullRequests[0]).toMatchObject({ reviews: [{ id: 19, state: "APPROVED" }], rawDiff: "fresh diff after hold" });
    expect(result.pullRequests).toEqual([{ id: 9, reviews: [{ id: 19, state: "APPROVED", submittedAt: instant(40).toISOString(), dismissal: null }], rawDiff: "fresh diff after hold" }]);
    expect(f.counts.get(1)).toBe(1);
    expect(f.requests.filter((key) => key === "reviews:9")).toHaveLength(2);
    expect(f.pass.complete).not.toHaveBeenCalled();
  });

  it("refreshes only eligible local references and disputes, deduplicating their evidence", async () => {
    const f = fixture([subject(1), subject(2, "pull_request")]);
    f.issues.get(1)!.closingPullRequests = [pullRequest(9), pullRequest(10, 43), { ...pullRequest(11), state: "OPEN" },
      { ...pullRequest(12), mergedAt: null }, { ...pullRequest(13), state: "CLOSED", mergedAt: null }];
    f.repository.disputePullRequests = [{ id: 9, number: 9 }, { id: 14, number: 14 }];
    const result = await f.window(40);
    expect(result.pullRequests.map(({ id }) => id)).toEqual([9, 13, 14]);
    expect(f.requests.filter((key) => /^(reviews|diff):/.test(key))).toEqual(["reviews:2", "diff:2", "reviews:9", "diff:9", "reviews:13", "diff:13", "reviews:14", "diff:14"]);
    expect(result.missingDisputePrIds).toEqual(new Set());
  });

  it("refreshes an old closing issue when a PR removes its closing reference", async () => {
    const f = fixture([subject(1), subject(2, "pull_request")]);
    f.issues.get(1)!.closingPullRequests = [pullRequest(2)];
    f.gateway.getPullRequestClosingIssues = (pr) => f.read(`closing:${pr.id}`, () => { f.issues.get(1)!.closingPullRequests = []; return []; });
    const result = await f.window(30);
    expect(result.issues[0]?.closingPullRequests).toEqual([]);
    expect(f.counts.get(1)).toBe(2);
    expect(result.pullRequests).toEqual([]);
  });

  it("keeps related-issue refreshes from advancing a listing stream past ungathered subjects", async () => {
    const f = fixture([subject(1, "pull_request"), subject(2), subject(3)]);
    f.gateway.getPullRequestClosingIssues = (pr) => f.read(`closing:${pr.id}`, () => [{ id: 3, number: 3, repositoryGitHubId: 42 }]);
    await expect(f.window(5)).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect(f.pass.walkAnchors().subjects).toEqual({ updatedAt: instant(1), key: 1 });
    const result = await f.window(40);
    expect(result.issues.map(({ id }) => id).sort()).toEqual([2, 3]);
    expect(f.counts.get(2)).toBe(1);
  });

  it.each([
    ["GitHub missing", () => new GitHubApiError(404), "NOT_FOUND", true],
    ["GitLab missing", () => new GitLabApiError(404), "NOT_FOUND", true],
    ["GraphQL missing repository", () => new GitHubGraphqlRequestError("GitHub GraphQL request failed. NOT_FOUND: Could not resolve to a Repository named owner/repo", false, null, 200), "NOT_FOUND", true],
    ["diff too large", () => new GitHubApiError(406), "DIFF_TOO_LARGE", false],
    ["response too large", () => new GitHubResponseTooLargeError(12), "RESPONSE_TOO_LARGE", false],
  ] as const)("discards only the %s dispute failure", async (_name, failure, reason, missing) => {
    const f = fixture([subject(1)]);
    f.repository.disputePullRequests = [{ id: 9, number: 9 }];
    f.gateway.getPullRequestDiff = (pr) => f.read(`diff:${pr.id}`, () => { throw failure(); });
    const result = await f.window(20);
    expect(result.issues).toHaveLength(1);
    expect(result.pullRequests).toEqual([]);
    expect(result.missingDisputePrIds).toEqual(new Set(missing ? [9] : []));
    expect(f.discarded).toEqual([{ kind: "pull_request", subject: { id: 9, number: 9 }, reason }]);
  });

  it.each([
    ["GitHub missing", () => new GitHubApiError(404), "NOT_FOUND"],
    ["GitLab missing", () => new GitLabApiError(404), "NOT_FOUND"],
    ["GraphQL missing", () => new Error("Could not resolve to an Issue with number 1"), "NOT_FOUND"],
    ["oversized", () => new GitHubResponseTooLargeError(12), "RESPONSE_TOO_LARGE"],
    ["unreadable own field", () => new GitHubGraphqlInvalidResponseError("Unreadable issue", "labels.nodes"), "UNREADABLE_FIELD"],
  ] as const)("stages a discarded %s issue so later subjects can progress", async (_name, failure, reason) => {
    const f = fixture([subject(1), subject(2)]);
    const gather = f.gateway.gatherIssue;
    f.gateway.gatherIssue = (row) => row.id === 1 ? f.read("issue:1", () => { throw failure(); }) : gather(row);
    const result = await f.window(20);
    expect(result.issues.map(({ id }) => id)).toEqual([2]);
    expect(f.pass.walkAnchors().subjects?.key).toBe(2);
    expect(f.discarded).toEqual([{ kind: "issue", subject: expect.objectContaining({ id: 1 }), reason }]);
  });

  it.each([401, 403, 429, 500])("keeps HTTP %s on the whole-run failure path", async (status) => {
    const f = fixture([subject(1)]);
    f.repository.disputePullRequests = [{ id: 9, number: 9 }];
    const failure = new GitHubApiError(status);
    f.gateway.getPullRequestReviews = async () => { throw failure; };
    await expect(f.window(20)).rejects.toBe(failure);
    expect(f.discarded).toEqual([]);
  });

  it("keeps unreadable-issue markers in staging for the caller's retention policy", async () => {
    const f = fixture([subject(1), subject(2)]);
    f.issues.get(1)!.openingEvidenceUnreadable = true;
    f.issues.get(2)!.closingPullRequestsUnreadable = true;
    const result = await f.window(20);
    expect(result.issues[0]?.openingEvidenceUnreadable).toBe(true);
    expect(result.issues[1]?.closingPullRequestsUnreadable).toBe(true);
    expect(f.discarded.map(({ reason }) => reason)).toEqual(["UNREADABLE_FIELD", "UNREADABLE_FIELD"]);
  });
});
