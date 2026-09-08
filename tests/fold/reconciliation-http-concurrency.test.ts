import { expect, it, vi } from "vitest";
import { reconcileRepository, type ReconciliationStore } from "@/lib/fold/reconcile";
import type { FoldResult } from "@/lib/fold/repository-fold";
import { GitHubGateway } from "@/lib/github/client";
import { createGitHubGraphqlBudgetStore } from "@/lib/github/rate-limit-budget";
import { createReconciliationBudgetGate } from "@/lib/fold/reconciliation-budget";
import { verifiedRepositoryPayload } from "../support/verified-repository";

const pageInfo = { hasNextPage: false, endCursor: null };

it("latches a mid-pass hold across active PR collectors even after coordination and the reset window end", async () => {
  let now = new Date("2026-09-07T10:00:00Z");
  const resetAt = new Date("2026-09-07T11:00:00Z");
  const budget = createGitHubGraphqlBudgetStore();
  const gates = Array.from({ length: 4 }, signal);
  const started = signal();
  const calls: string[] = [];
  let active = 0;
  let settled = 0;
  let coordinated = false;
  let released = false;
  const materialize = vi.fn(async () => ({ adds: 0, changes: 0, removals: 0 }));
  const github = new GitHubGateway({ accessToken: "fixture-token", owner: "sponsor", budget,
    fetch: async (input, init) => {
      if (String(input).endsWith("/repositories/5001")) {
        return Response.json(verifiedRepositoryPayload(5001, "sponsor/repository"));
      }
      const request = JSON.parse(String(init?.body));
      const operation = /query (\w+)/.exec(request.query)![1]!;
      calls.push(operation);
      if (operation === "RepositoryIssues") {
        return Response.json({ data: { rateLimit: { remaining: 500, resetAt: resetAt.toISOString() },
          repository: { issues: { nodes: Array.from({ length: 9 }, (_, index) => issueNode(index + 1)), pageInfo } },
        } });
      }
      if (operation === "IssueTimeline") {
        return Response.json({ data: { repository: { issue: {
          timelineItems: issueTimeline(request.variables.issueNumber),
        } } } });
      }
      if (operation !== "PullRequestReviews") throw new Error(`Unexpected request: ${operation}`);
      const index = request.variables.pullRequestNumber - 1;
      if (request.variables.cursor === null && index < 4) {
        active++;
        if (active === 4) started.resolve();
        await gates[index].promise;
        active--; settled++;
      }
      return Response.json({ data: {
        rateLimit: { remaining: index === 0 ? 499 : 500, resetAt: resetAt.toISOString() },
        repository: { pullRequest: { reviews: { nodes: [], pageInfo: request.variables.cursor === null
          ? { hasNextPage: true, endCursor: "next" } : pageInfo } } },
      } });
    },
  });
  const store: ReconciliationStore = {
    getReconciliationEvidence: async () => null,
    getDirtyReconciliationSubjects: async () => [],
    withRepositoryReconciliation: async (_id, work) => {
      coordinated = true;
      try { return await work(); } finally { coordinated = false; released = true; }
    },
    getRepository: async () => ({
      id: "repository", githubRepositoryId: 5001, ownerName: "sponsor/repository", active: true,
      registeredAt: "2026-01-01T00:00:00Z",
      sponsor: { id: "sponsor", githubUserId: 1001, githubLogin: "sponsor", enforcementState: "ACTIVE" },
      difficultyScheme: { openingName: "Size", actualName: "Delivered",
        openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
        actualLabels: [{ label: "delivered/6", points: 6 }] },
    }),
    getGitHubAccessToken: async () => "fixture-token", getReconciliationCooldown: async () => null,
    setReconciliationCooldown: async () => {}, findUsersByGitHubUserIds: async () => [],
    hasDerivedRowsBelowFoldRevision: async () => false, beginRun: async () => "run",
    completeRun: async () => {}, failRun: async () => {}, materialize,
    recordVerifiedRepositoryIdentity: async () => {}, markRepositoryUnavailable: async () => {},
  };
  const run = reconcileRepository({ store, github, now: () => now,
    budget: createReconciliationBudgetGate({ store: budget, reserve: 500 }), onBudgetChange: () => {},
  }, "repository");
  // Attach a rejection handler immediately, including for the unguarded RED run.
  const outcome = run.then((value) => ({ value }), (error: unknown) => ({ error }));
  try {
    await Promise.race([started.promise, outcome.then(() => { throw new Error("Ended before concurrent reads"); })]);
    expect(coordinated).toBe(true);
    gates[0].resolve();
    const result = await outcome;
    expect(calls).toEqual(["RepositoryIssues", ...Array(9).fill("IssueTimeline"), ...Array(4).fill("PullRequestReviews")]);
    expect(result).toEqual({ value: expect.objectContaining({ skipped: true, budgetHeldUntil: resetAt }) });
    expect(released).toBe(true);
    expect(active).toBe(3);
    expect(calls).toEqual(["RepositoryIssues", ...Array(9).fill("IssueTimeline"), ...Array(4).fill("PullRequestReviews")]);
    // The same owned gateway remains available outside the held reconciliation,
    // even while the observation is current and its old collectors are active.
    await github.listIssues({ owner: "sponsor", name: "repository" }, {
      timelineCriticalLabels: new Set(["delivered/6"]), timelineWatchedLabels: new Set(["M"]),
    });
    expect(calls[14]).toBe("RepositoryIssues");
    // Detached collectors retain their original hold even if the next fold can be admitted.
    now = resetAt;
    for (const gate of gates) gate.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(4);
    expect(active).toBe(0);
    expect(calls).toHaveLength(15);
    expect(materialize).not.toHaveBeenCalled();
  } finally {
    gates.forEach(({ resolve }) => resolve());
    await outcome;
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
});

it("bounds actual HTTP requests across worker cohorts and both review paginators", async () => {
  const count = 9;
  // One issue page + nine authoritative timelines + nine PRs * five requests.
  // Identity REST precedes the crawl and is excluded from this count.
  const total = 55;
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
      if (operation === "IssueTimeline") {
        return Response.json({ data: { repository: { issue: {
          timelineItems: issueTimeline(request.variables.issueNumber),
        } } } });
      }
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
    getReconciliationEvidence: async () => null,
    getDirtyReconciliationSubjects: async () => [],
    withRepositoryReconciliation: async (_id, work) => work(),
    getRepository: async () => ({
      id: "repository", githubRepositoryId: 5001, ownerName: "sponsor/repository", active: true,
      registeredAt: "2026-01-01T00:00:00.000Z",
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
    hasDerivedRowsBelowFoldRevision: async () => false,
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
    expect(calls.filter(({ operation }) => operation === "IssueTimeline")).toHaveLength(9);
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

function issueTimeline(number: number) {
  return { nodes: [{
    __typename: "LabeledEvent", id: `opening-${number}`, actor: { login: "sponsor" },
    createdAt: "2026-09-01T08:00:00.000Z", label: { name: "M" },
  }], pageInfo };
}

function issueNode(number: number) {
  return {
    databaseId: 100 + number, number, title: `Issue ${number}`, body: "", state: "CLOSED",
    updatedAt: "2026-09-01T12:05:00.000Z",
    url: `https://github.com/sponsor/repository/issues/${number}`, createdAt: "2026-09-01T07:00:00.000Z",
    author: { login: "sponsor" }, labels: { nodes: [{ name: "M" }], pageInfo }, assignees: { nodes: [] },
    timelineItems: issueTimeline(number),
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
