import { SweepBudgetSpent, withSweepRequestBudget } from "@/lib/fold/sweep-request-budget";
import { describe, expect, it, vi } from "vitest";
import { GitHubGateway } from "@/lib/github/client";
import { memoryPass } from "./reconciliation-walk-fixture";

const reference = { owner: "octo", name: "overflow" };
const at = "2026-10-01T00:00:00Z";
const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });

type Lookup = "found" | "null" | "not-found" | "rate-limited" | "server-error" | "unknown";

function fixture(lookup: Lookup = "found") {
  const pullRequest = { databaseId: 901, number: 7, title: "PR", body: "", url: "https://github.com/octo/overflow/pull/7",
    state: "MERGED", mergedAt: at, mergeCommit: null, commits: { nodes: [] }, author: null,
    repository: { databaseId: 42, nameWithOwner: "octo/overflow" } };
  const issue = { databaseId: 101, number: 1, title: "Issue", body: "", url: "https://github.com/octo/overflow/issues/1",
    state: "CLOSED", stateReason: "COMPLETED", createdAt: at, updatedAt: at, closedAt: at, author: null,
    labels: page([]), assignees: { nodes: [] }, timelineItems: page([]), closedByPullRequestsReferences: page(lookup === "found" ? [pullRequest] : []) };
  const numbers: number[] = [];
  const github = new GitHubGateway({ accessToken: ["test", "token"].join("-"), fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/repos/octo/overflow/issues") return Response.json([
      { id: 101, number: 1, updated_at: at }, { id: 701, number: 7, updated_at: at, pull_request: {} },
    ]);
    if (url.pathname === "/repos/octo/overflow/pulls/7") return new Response("diff 901");
    if (url.pathname !== "/graphql") throw new Error(`Unexpected path ${url.pathname}`);
    const { query, variables } = JSON.parse(String(init?.body));
    const operation = /query (\w+)/.exec(query)![1]!;
    if (operation === "PullRequest") {
      numbers.push(variables.pullRequestNumber);
      if (lookup === "found") return Response.json({ data: { repository: { pullRequest } } });
      if (lookup === "server-error") return new Response("Unavailable", { status: 503 });
      const missing = { type: "NOT_FOUND", message: "Could not resolve to a PullRequest with the number of 7." };
      const errors = lookup === "null" ? [] : lookup === "unknown"
        ? [{ type: "UNPROCESSABLE", message: "Unexpected lookup failure." }]
        : [missing, ...(lookup === "rate-limited" ? [{ type: "RATE_LIMITED", message: "API rate limit exceeded." }] : [])];
      return Response.json({ data: { repository: { pullRequest: null } }, ...(lookup === "null" ? {} : { errors }) });
    }
    if (operation === "RepositoryIssue") return Response.json({ data: { repository: { issue } } });
    if (operation === "IssueTimeline") return Response.json({ data: { repository: { issue: { timelineItems: page([]) } } } });
    if (operation === "PullRequestClosingIssues") return Response.json({ data: { repository: { pullRequest: {
      databaseId: 901, closingIssuesReferences: page([{ databaseId: 101, number: 1, repository: { databaseId: 42 } }]),
    } } } });
    if (operation === "PullRequestReviews") return Response.json({ data: { repository: { pullRequest: { reviews: page([]) } } } });
    if (operation === "PullRequestReviewDismissals") return Response.json({ data: { repository: { pullRequest: { timelineItems: page([]) } } } });
    throw new Error(`Unexpected operation ${operation}`);
  } });
  return { github, numbers };
}

describe("the GitHub walk adapter", () => {
  it.each(["null", "not-found"] as const)("skips a %s PR lookup and discards the pass snapshot's true PR identity", async (lookup) => {
    const { github, numbers } = fixture(lookup);
    const pass = memoryPass();
    pass.dirtySubjects.push({ kind: "ISSUE", id: 701, number: 7, generation: 1 },
      { kind: "PULL_REQUEST", id: 902, number: 8, generation: 2 },
      { kind: "PULL_REQUEST", id: 901, number: 7, generation: 3 });
    const onDiscard = vi.fn(async () => {});
    const result = await github.walkReconciliation(reference, {
      pass, repository: { githubRepositoryId: 42, disputePullRequests: [] }, onDiscard,
    });
    expect(result.status).toBe("completed");
    expect(result.issues.map(({ id }) => id)).toEqual([101]);
    expect(result.pullRequests).toEqual([]);
    expect(onDiscard).toHaveBeenCalledExactlyOnceWith({ kind: "pull_request", subject: { id: 901, number: 7 }, reason: "NOT_FOUND" });
    expect((await pass.readStaged()).map(({ kind, subjectKey }) => ({ kind, subjectKey }))).toEqual([{ kind: "issue", subjectKey: 101 }]);
    expect(numbers).toEqual([7]);
    expect(pass.complete).not.toHaveBeenCalled();
  });

  it("skips an absent PR with no matching dirty snapshot without inventing an identity", async () => {
    const { github } = fixture("not-found");
    const onDiscard = vi.fn(async () => {});
    await expect(github.walkReconciliation(reference, {
      pass: memoryPass(), repository: { githubRepositoryId: 42, disputePullRequests: [] }, onDiscard,
    })).resolves.toMatchObject({ status: "completed", pullRequests: [] });
    expect(onDiscard).not.toHaveBeenCalled();
  });

  it.each([
    ["rate-limited", 200, true], ["server-error", 503, false], ["unknown", 200, false],
  ] as const)("propagates a %s PR lookup without discarding the subject", async (lookup, status, rateLimited) => {
    const { github } = fixture(lookup);
    const pass = memoryPass();
    pass.dirtySubjects.push({ kind: "PULL_REQUEST", id: 901, number: 7, generation: 3 });
    const onDiscard = vi.fn(async () => {});
    await expect(github.walkReconciliation(reference, {
      pass, repository: { githubRepositoryId: 42, disputePullRequests: [] }, onDiscard,
    })).rejects.toMatchObject({ status, rateLimited });
    expect(onDiscard).not.toHaveBeenCalled();
    expect((await pass.readStaged()).map(({ subjectKey }) => subjectKey)).toEqual([101]);
  });

  it("propagates a budget hold at PR normalization without discarding the subject", async () => {
    const { github } = fixture();
    const pass = memoryPass();
    pass.dirtySubjects.push({ kind: "PULL_REQUEST", id: 901, number: 7, generation: 3 });
    const onDiscard = vi.fn(async () => {});
    const heldUntil = new Date(at);
    let spent = 0;
    await expect(withSweepRequestBudget(async () => spent++ < 3 ? null : heldUntil,
      () => github.walkReconciliation(reference, {
        pass, repository: { githubRepositoryId: 42, disputePullRequests: [] }, onDiscard,
      }))).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect(onDiscard).not.toHaveBeenCalled();
    expect((await pass.readStaged()).map(({ subjectKey }) => subjectKey)).toEqual([101]);
  });

  it("resumes with true IDs after a budget hold without resolving already staged PR numbers again", async () => {
    const { github, numbers } = fixture();
    const pass = memoryPass();
    const input = { pass, repository: { githubRepositoryId: 42, disputePullRequests: [{ id: 901, number: 7 }] } };
    let spent = 0;
    await expect(withSweepRequestBudget(async () => spent++ < 10 ? null : new Date(at),
      () => github.walkReconciliation(reference, input))).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect((await pass.readStaged()).filter(({ kind }) => kind === "pull_request").map(({ subjectKey }) => subjectKey)).toEqual([901]);
    const result = await github.walkReconciliation(reference, input);
    expect(result.pullRequests).toEqual([{ id: 901, reviews: [], rawDiff: "diff 901" }]);
    expect(numbers).toEqual([7]);
  });

  it("stages and joins REST issue id 701, PR number 7 as true PR databaseId 901", async () => {
    const { github, numbers } = fixture();
    const pass = memoryPass();
    expect(typeof github.walkReconciliation).toBe("function");
    const result = await github.walkReconciliation(reference, {
      pass, repository: { githubRepositoryId: 42, disputePullRequests: [{ id: 901, number: 7 }] },
    });
    expect(result.status).toBe("completed");
    expect(result.pullRequests).toEqual([{ id: 901, reviews: [], rawDiff: "diff 901" }]);
    expect(result.issues[0]?.closingPullRequests[0]).toMatchObject({ id: 901, rawDiff: "diff 901" });
    const staged = await pass.readStaged();
    expect(staged.filter(({ kind }) => kind === "pull_request").map(({ subjectKey }) => subjectKey)).toEqual([901]);
    expect(numbers).toContain(7);
    await expect(github.getPullRequestClosingIssues(reference, { id: 701, number: 7 })).rejects.toThrow("identity did not match");
  });
});
