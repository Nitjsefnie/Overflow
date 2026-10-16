import { describe, expect, it, vi } from "vitest";
import type { ReconciliationGateway } from "@/lib/fold/reconcile";
import { withTransientRequestRetry, transientRetryDelayMs } from "@/lib/fold/reconciliation-retry";
import { GitHubApiError, GitHubGraphqlRequestError, isTransientGitHubRequestError } from "@/lib/github/errors";
import { GraphqlBudgetHeld } from "@/lib/github/graphql-request-budget";
import { GitHubResponseTooLargeError } from "@/lib/github/response-text";
import { GitLabApiError } from "@/lib/gitlab/api-error";

describe("isTransientGitHubRequestError", () => {
  it.each<[string, unknown, boolean]>([
    ["HTTP 500", new GitHubApiError(500), true],
    ["HTTP 503 without rate-limit evidence", new GitHubApiError(503, false), true],
    ["REST timeout", new Error("GitHub request timed out."), true],
    ["GraphQL timeout", new GitHubGraphqlRequestError("GitHub request timed out."), true],
    ["REST network wrapper", new Error("GitHub request failed: /repositories/1", { cause: new Error("connection reset") }), true],
    ["GraphQL network wrapper", new GitHubGraphqlRequestError("GitHub GraphQL request failed. connection reset"), true],
    ...[401, 403, 404, 406, 422, 429].map((status): [string, unknown, boolean] => [
      `HTTP ${status} without rate-limit evidence`, new GitHubApiError(status, false), false,
    ]),
    ["REST rate limit", new GitHubApiError(403, true, 60), false],
    ["rate limit outranks server status", new GitHubApiError(503, true, 60), false],
    ["GraphQL payload error", new GitHubGraphqlRequestError("GitHub GraphQL request failed. NOT_FOUND: Could not resolve to a PullRequest with the number of 11.", false, null, 200), false],
    ["GraphQL rate limit", new GitHubGraphqlRequestError("GitHub request timed out.", true, 60), false],
    ["untyped GraphQL-like message", new Error("GitHub GraphQL request failed. connection reset"), false],
    ["oversized response", new GitHubResponseTooLargeError(1024), false],
    ["GraphQL budget hold", new GraphqlBudgetHeld(new Date("2030-01-01T00:00:00Z")), false],
    ["GitLab server error", new GitLabApiError(503), false],
    ["unrelated error", new Error("boom"), false],
    ["null", null, false],
    ["undefined", undefined, false],
  ])("classifies %s", (_label, error, expected) => {
    expect(isTransientGitHubRequestError(error)).toBe(expected);
  });
});

describe("withTransientRequestRetry", () => {
  it("returns a first-attempt result without waiting", async () => {
    const delays: number[] = [];
    const gateway = retryGateway();
    const wrapped = withTransientRequestRetry(gateway, { delay: async (ms) => { delays.push(ms); } });

    expect(await wrapped.getPullRequestDiff(reference, 11)).toBe("diff 11");
    expect(delays).toEqual([]);
  });

  it("returns the result after one transient failure and a 250ms wait", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const gateway = retryGateway();
    gateway.getPullRequestDiff = async () => {
      attempts += 1;
      if (attempts === 1) throw new GitHubApiError(503);
      return "recovered diff";
    };

    const wrapped = withTransientRequestRetry(gateway, { delay: async (ms) => { delays.push(ms); } });
    expect(await wrapped.getPullRequestDiff(reference, 11)).toBe("recovered diff");
    expect(attempts).toBe(2);
    expect(delays).toEqual([250]);
  });

  it("waits for the default 250ms backoff before retrying", async () => {
    vi.useFakeTimers();
    try {
      let attempts = 0;
      let completed = false;
      const gateway = retryGateway();
      gateway.getPullRequestDiff = async () => {
        attempts += 1;
        if (attempts === 1) throw new GitHubApiError(503);
        return "recovered diff";
      };
      const result = withTransientRequestRetry(gateway).getPullRequestDiff(reference, 11).then((value) => {
        completed = true;
        return value;
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toBe(1);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(249);
      expect(attempts).toBe(1);
      expect(completed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(completed).toBe(true);
      await expect(result).resolves.toBe("recovered diff");
      expect(attempts).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws the last failure after three attempts and only two waits", async () => {
    const delays: number[] = [];
    const failures = [new GitHubApiError(500), new GitHubApiError(502), new GitHubApiError(503)];
    let attempts = 0;
    const gateway = retryGateway();
    gateway.getPullRequestDiff = async () => { throw failures[attempts++]; };
    const wrapped = withTransientRequestRetry(gateway, { delay: async (ms) => { delays.push(ms); } });

    await expect(wrapped.getPullRequestDiff(reference, 11)).rejects.toBe(failures[2]);
    expect(attempts).toBe(3);
    expect(delays).toEqual([250, 500]);
  });

  it.each([
    ["getRepositoryById", [1]],
    ["listIssues", [reference, { since: "2030-01-01T00:00:00Z" }]],
    ["getIssue", [reference, { id: 101, number: 1 }]],
    ["getPullRequestClosingIssues", [reference, { id: 201, number: 11 }]],
    ["getPullRequestReviews", [reference, 11]],
    ["getPullRequestDiff", [reference, 11]],
  ] as const)("retries %s independently and preserves its arguments and receiver", async (method, args) => {
    const delays: number[] = [];
    const gateway = retryGateway();
    const calls: unknown[][] = [];
    const expectedResult = await Reflect.apply(gateway[method], gateway, [...args]);
    Reflect.set(gateway, method, async function (this: ReconciliationGateway, ...received: unknown[]) {
      expect(this).toBe(gateway);
      calls.push(received);
      if (calls.length % 2 === 1) throw new Error("GitHub request timed out.");
      return expectedResult;
    });
    const wrapped = withTransientRequestRetry(gateway, { delay: async (ms) => { delays.push(ms); } });

    for (let call = 0; call < 2; call++) {
      expect(await Reflect.apply(wrapped[method], wrapped, [...args])).toBe(expectedResult);
    }
    expect(calls).toEqual([args, args, args, args]);
    expect(delays).toEqual([250, 250]);
  });

  it("rethrows a non-transient failure immediately without waiting", async () => {
    const delays: number[] = [];
    let attempts = 0;
    const failure = new GitHubApiError(401);
    const gateway = retryGateway();
    gateway.listIssues = async () => { attempts += 1; throw failure; };
    const wrapped = withTransientRequestRetry(gateway, { delay: async (ms) => { delays.push(ms); } });

    await expect(wrapped.listIssues(reference)).rejects.toBe(failure);
    expect(attempts).toBe(1);
    expect(delays).toEqual([]);
  });
});

describe("transientRetryDelayMs", () => {
  it.each([[1, 250], [2, 500], [3, 1000]])("backs off after failed attempt %s", (attempt, expected) => {
    expect(transientRetryDelayMs(attempt)).toBe(expected);
  });
});

const reference = { owner: "octo", name: "example" };

function retryGateway(): ReconciliationGateway {
  return {
    getRepositoryById: async () => null,
    listIssues: async () => [],
    getIssue: async () => null,
    getPullRequestClosingIssues: async () => [],
    getPullRequestReviews: async () => [],
    getPullRequestDiff: async (_repository, number) => `diff ${number}`,
  };
}
