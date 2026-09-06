import { expect, it, vi } from "vitest";
import { reconcileRepository, type ReconciliationStore } from "@/lib/fold/reconcile";
import type { FoldResult } from "@/lib/fold/repository-fold";
import { GitHubGateway } from "@/lib/github/client";
import { verifiedRepositoryPayload } from "../support/verified-repository";

const pageInfo = { hasNextPage: false, endCursor: null };

it("bounds actual HTTP requests across worker cohorts and both review paginators", async () => {
  const count = 9;
  // One issue page, two review pages, two dismissal pages and a diff per PR.
  const total = 46;
  const gates = Array.from({ length: total }, signal);
  const starts = Array.from({ length: total }, signal);
  const calls: Array<{ operation: string; number: number | null; cursor: string | null }> = [];
  let active = 0;
  let peak = 0;
  const materialize = vi.fn().mockResolvedValue({ adds: count, changes: 0, removals: 0 });
  const github = new GitHubGateway({
    accessToken: "fixture-token",
    fetch: async (input, init) => {
      // Identity verification precedes the crawl and is not one of the bounded calls.
      if (String(input).endsWith("/repositories/5001")) {
        return Response.json(verifiedRepositoryPayload(5001, "sponsor/repository"));
      }
      const request = String(input).endsWith("/graphql") ? JSON.parse(String(init?.body)) : null;
      const operation = request === null ? "diff" : /query (\w+)/.exec(request.query)![1]!;
      const number = request === null
        ? Number(/\/pulls\/(\d+)$/.exec(String(input))![1])
        : request.variables.pullRequestNumber ?? null;
      const cursor = request?.variables.cursor ?? null;
      const index = calls.length;
      calls.push({ operation, number, cursor });
      active++;
      peak = Math.max(peak, active);
      starts[index].resolve();
      await gates[index].promise;
      active--;

      if (operation === "RepositoryIssues") {
        return Response.json({ data: { repository: { issues: {
          nodes: Array.from({ length: count }, (_, index) => issueNode(index + 1)), pageInfo,
        } } } });
      }
      if (operation === "diff") return new Response(`diff ${number}`);
      expect(cursor).toBeOneOf([null, "next"]);
      const nextPage = cursor === null ? { hasNextPage: true, endCursor: "next" } : pageInfo;
      if (operation === "PullRequestReviews") {
        return Response.json({ data: { repository: { pullRequest: { reviews: {
          nodes: cursor === null ? [] : [{
            databaseId: 300 + number!, state: "DISMISSED", submittedAt: "2026-09-01T09:00:00.000Z",
          }], pageInfo: nextPage,
        } } } } });
      }
      if (operation === "PullRequestReviewDismissals") {
        return Response.json({ data: { repository: { pullRequest: { timelineItems: {
          nodes: cursor === null ? [] : [{
            __typename: "ReviewDismissedEvent", review: { databaseId: 300 + number! },
            createdAt: "2026-09-01T13:00:00.000Z", previousReviewState: "CHANGES_REQUESTED",
          }], pageInfo: nextPage,
        } } } } });
      }
      throw new Error(`Unexpected request: ${operation}`);
    },
  });
  const store: ReconciliationStore = {
    withRepositoryReconciliation: async (_id, work) => work(),
    getRepository: async () => ({
      id: "repository", githubRepositoryId: 5001, ownerName: "sponsor/repository", active: true,
      sponsor: { id: "sponsor", githubUserId: 1001, githubLogin: "sponsor", enforcementState: "ACTIVE" },
      difficultyScheme: {
        openingName: "Size", actualName: "Delivered",
        openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
        actualLabels: [{ label: "delivered/6", points: 6 }],
      },
    }),
    getGitHubAccessToken: async () => "fixture-token",
    getReconciliationCooldown: async () => null,
    setReconciliationCooldown: async () => {},
    findUsersByGitHubUserIds: async () => [{
      id: "contributor", githubUserId: 2001, githubLogin: "contributor", enforcementState: "ACTIVE",
    }],
    beginRun: async () => "run", completeRun: async () => {}, failRun: async () => {}, materialize,
    recordVerifiedRepositoryIdentity: async () => {},
    markRepositoryUnavailable: async () => {},
  };
  const run = reconcileRepository({ store, github }, "repository");
  try {
    for (let index = 0; index < total; index++) {
      await Promise.race([
        starts[index].promise,
        run.then(() => { throw new Error(`Reconciliation ended before request ${index}`); }),
      ]);
      gates[index].resolve();
    }
    await run;
    console.info("RECONCILIATION_HTTP_HIGH_WATER", JSON.stringify({ requests: calls.length, peak, active }));
    expect(peak).toBeLessThanOrEqual(4);
    expect(active).toBe(0);
    expect(calls).toHaveLength(total);
    expect(calls.filter(({ operation }) => operation === "RepositoryIssues")).toHaveLength(1);
    for (let number = 1; number <= count; number++) {
      expect(calls.filter((call) => call.number === number)).toEqual(expect.arrayContaining([
        { operation: "PullRequestReviews", number, cursor: null },
        { operation: "PullRequestReviews", number, cursor: "next" },
        { operation: "PullRequestReviewDismissals", number, cursor: null },
        { operation: "PullRequestReviewDismissals", number, cursor: "next" },
        { operation: "diff", number, cursor: null },
      ]));
    }
    const fold = materialize.mock.calls[0]![0].fold as FoldResult;
    expect(fold.pullRequests).toHaveLength(count);
    expect(fold.pullRequests.map(({ reviewRounds }) => reviewRounds)).toEqual(
      Array.from({ length: count }, (_, index) => [{
        githubReviewId: 301 + index, submittedAt: "2026-09-01T09:00:00.000Z",
      }]),
    );
  } finally {
    gates.forEach(({ resolve }) => resolve());
    await Promise.allSettled([run]);
  }
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function issueNode(number: number) {
  return {
    databaseId: 100 + number, number, title: `Issue ${number}`, body: "", state: "CLOSED",
    url: `https://github.com/sponsor/repository/issues/${number}`, createdAt: "2026-09-01T07:00:00.000Z",
    author: { login: "sponsor" }, labels: { nodes: [{ name: "M" }], pageInfo }, assignees: { nodes: [] },
    timelineItems: { nodes: [{
      __typename: "LabeledEvent", id: `opening-${number}`, actor: { login: "sponsor" },
      createdAt: "2026-09-01T08:00:00.000Z", label: { name: "M" },
    }], pageInfo },
    closedByPullRequestsReferences: { nodes: [{
      databaseId: 200 + number, number, title: `PR ${number}`, body: "", state: "MERGED",
      url: `https://github.com/sponsor/repository/pull/${number}`, mergedAt: "2026-09-01T12:00:00.000Z",
      mergeCommit: { oid: number.toString(16).padStart(40, "0") },
      commits: { nodes: [{ commit: { committedDate: "2026-09-01T10:00:00.000Z" } }] },
      author: { login: "contributor", databaseId: 2001 },
      repository: { databaseId: 5001, nameWithOwner: "sponsor/repository" },
    }], pageInfo },
  };
}
