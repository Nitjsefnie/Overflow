import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  assessGraphqlBudget,
  createGitHubGraphqlBudgetStore,
  DEFAULT_GRAPHQL_BUDGET_RESERVE,
  gitHubGraphqlBudget,
  readGraphqlBudgetPayload,
  readGraphqlBudgetReserve,
  type GitHubGraphqlBudgetReading,
} from "@/lib/github/rate-limit-budget";
import { GitHubGraphqlClient } from "@/lib/github/graphql";
import { GitHubGateway } from "@/lib/github/client";
import { createReconciliationBudgetGate } from "@/lib/fold/reconciliation-budget";

const reset = new Date("2026-09-07T11:00:00.000Z");
const observed = new Date("2026-09-07T10:00:00.000Z");
const rateLimit = { cost: 1, limit: 5000, remaining: 42, resetAt: reset.toISOString() };
const reading: GitHubGraphqlBudgetReading = {
  cost: 1, limit: 5000, remaining: 42, resetAt: reset, observedAt: observed,
};

describe("readGraphqlBudgetPayload", () => {
  it("keeps a well-formed payload", () => {
    expect(
      readGraphqlBudgetPayload(
        { cost: 1, limit: 5000, remaining: 4999, resetAt: reset.toISOString() },
        observed,
      ),
    ).toEqual({ cost: 1, limit: 5000, remaining: 4999, resetAt: reset, observedAt: observed });
  });

  it.each([
    ["null", null],
    ["a missing resetAt", { cost: 1, limit: 5000, remaining: 4999 }],
    ["an unparseable resetAt", { remaining: 1, resetAt: "not a date" }],
    ["a non-numeric remaining", { remaining: "1", resetAt: reset.toISOString() }],
    ["a negative remaining", { remaining: -1, resetAt: reset.toISOString() }],
    ["a missing remaining", { resetAt: reset.toISOString() }],
    ["NaN remaining", { remaining: NaN, resetAt: reset.toISOString() }],
    ["infinite remaining", { remaining: Infinity, resetAt: reset.toISOString() }],
    ["fractional remaining", { remaining: 1.5, resetAt: reset.toISOString() }],
    ["a non-string resetAt", { remaining: 1, resetAt: reset }],
    ["an empty resetAt", { remaining: 1, resetAt: "" }],
    ["an array with valid budget fields", Object.assign([], rateLimit)],
    ["a scalar", 1],
    ["undefined", undefined],
  ])("refuses %s", (_name, payload) => {
    expect(readGraphqlBudgetPayload(payload, observed)).toBeNull();
  });

  it.each([
    "September 7, 2099 11:00:00 GMT",
    "2099-09-07",
    "2099-09-07 11:00:00Z",
    "2099-09-07T11:00:00",
    "2099-09-07T11:00:00Z\n",
  ])("refuses non-ISO reset instant %j", (resetAt) => {
    expect(readGraphqlBudgetPayload({ ...rateLimit, resetAt }, observed)).toBeNull();
  });

  it.each([
    "2026-09-07T11:00:00Z",
    "2026-09-07T11:00:00.000Z",
    "2026-09-07T11:00:00.000000Z",
    "2026-09-07T13:00:00+02:00",
  ])("accepts ISO reset instant %j", (resetAt) => {
    expect(readGraphqlBudgetPayload({ ...rateLimit, resetAt }, observed)).toEqual(reading);
  });

  it.each(["remaining", "resetAt", "limit", "cost"])("contains a throwing %s getter", (field) => {
    const payload = Object.defineProperty({ ...rateLimit }, field, {
      get() { throw new Error("untrusted getter"); },
    });
    expect(readGraphqlBudgetPayload(payload, observed)).toBeNull();
  });

  it("contains a revoked proxy", () => {
    const { proxy, revoke } = Proxy.revocable({ ...rateLimit }, {});
    revoke();
    expect(readGraphqlBudgetPayload(proxy, observed)).toBeNull();
  });

  it.each([undefined, null, "5000", NaN, Infinity, -Infinity])(
    "normalizes invalid optional numbers %s to null",
    (value) => {
      expect(readGraphqlBudgetPayload({ ...rateLimit, remaining: 0, limit: value, cost: value }, observed))
        .toEqual({ ...reading, remaining: 0, limit: null, cost: null });
    },
  );

  it("keeps finite optional numbers without imposing integer or sign constraints", () => {
    expect(readGraphqlBudgetPayload({ ...rateLimit, limit: -1, cost: 0.5 }, observed))
      .toEqual({ ...reading, limit: -1, cost: 0.5 });
  });
});

describe("GitHubGraphqlBudgetStore", () => {
  it("starts empty and keeps the lowest reading within the same reset window", () => {
    const budget = createGitHubGraphqlBudgetStore();
    expect(budget.read()).toBeNull();
    budget.record(reading);
    expect(budget.read()).toEqual(reading);
    const newer = { ...reading, remaining: 10, observedAt: new Date("2026-09-07T10:01:00.000Z") };
    budget.record(newer);
    budget.record(reading);
    budget.record({ ...newer, remaining: 20 });
    expect(budget.read()).toEqual(newer);
  });

  it("reports the first verdict and each change, but not repeats", () => {
    const budget = createGitHubGraphqlBudgetStore();
    expect(budget.readState()).toBe("UNKNOWN");
    expect(budget.noteState("UNKNOWN")).toBe(true);
    expect(budget.noteState("UNKNOWN")).toBe(false);
    expect(budget.noteState("AVAILABLE")).toBe(true);
    expect(budget.readState()).toBe("AVAILABLE");
    expect(budget.noteState("AVAILABLE")).toBe(false);
    expect(budget.noteState("BELOW_RESERVE")).toBe(true);
    expect(budget.readState()).toBe("BELOW_RESERVE");
    expect(budget.noteState("UNKNOWN")).toBe(true);
    expect(budget.readState()).toBe("UNKNOWN");
  });

  it("shares the symbol-backed store across separately loaded modules", async () => {
    const budget = gitHubGraphqlBudget();
    expect(Reflect.get(globalThis, Symbol.for("overflow.github.graphql-budget"))).toBe(budget);
    vi.resetModules();
    const otherBundle = await import("@/lib/github/rate-limit-budget");
    expect(otherBundle.gitHubGraphqlBudget()).toBe(budget);
  });

  it.each([
    ["zero", 0],
    ["false", false],
    ["a string", "occupied by a non-store"],
    ["an empty object", {}],
    ["a partial store", { record() {} }],
    ["a throwing method getter", Object.defineProperty({}, "record", {
      get() { throw new Error("unreadable store"); },
    })],
    ["a non-callable read", { ...createGitHubGraphqlBudgetStore(), read: 0 }],
    ["a non-callable noteState", { ...createGitHubGraphqlBudgetStore(), noteState: false }],
    ["a non-callable readState", { ...createGitHubGraphqlBudgetStore(), readState: null }],
    ["null", null],
    ["undefined", undefined],
  ])("replaces %s with a usable store shared across modules", async (_name, value) => {
    const key = Symbol.for("overflow.github.graphql-budget");
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    Reflect.set(globalThis, key, value);
    try {
      const first = gitHubGraphqlBudget();
      first.record(reading);
      expect(first.noteState("BELOW_RESERVE")).toBe(true);
      vi.resetModules();
      const otherBundle = await import("@/lib/github/rate-limit-budget");
      expect(otherBundle.gitHubGraphqlBudget).not.toBe(gitHubGraphqlBudget);
      const second = otherBundle.gitHubGraphqlBudget();
      expect(second).toBe(first);
      expect(second.read()).toEqual(reading);
      expect(second.readState()).toBe("BELOW_RESERVE");
    } finally {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it("preserves a valid store supplied by another module", async () => {
    const key = Symbol.for("overflow.github.graphql-budget");
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    vi.resetModules();
    const otherBundle = await import("@/lib/github/rate-limit-budget");
    const existing = otherBundle.createGitHubGraphqlBudgetStore();
    existing.record(reading);
    existing.noteState("BELOW_RESERVE");
    Reflect.set(globalThis, key, existing);
    try {
      const budget = gitHubGraphqlBudget();
      expect(budget).toBe(existing);
      expect(budget.read()).toEqual(reading);
      expect(budget.readState()).toBe("BELOW_RESERVE");
      budget.noteState("AVAILABLE");
      expect(otherBundle.gitHubGraphqlBudget().readState()).toBe("AVAILABLE");
    } finally {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  });
});

describe("assessGraphqlBudget", () => {
  it("has no verdict about an absent reading", () => {
    expect(assessGraphqlBudget(null, { reserve: 500, now: observed }))
      .toEqual({ state: "UNKNOWN", reading: null, reserve: 500 });
  });

  it.each([
    ["2026-09-07T10:59:59.999Z", "BELOW_RESERVE"],
    ["2026-09-07T11:00:00.000Z", "UNKNOWN"],
    ["2026-09-07T11:00:00.001Z", "UNKNOWN"],
  ])("assesses the reset boundary at %s", (now, state) => {
    expect(assessGraphqlBudget(reading, { reserve: 500, now: new Date(now) }))
      .toEqual({ state, reading, reserve: 500 });
  });

  it.each([
    [499, 500, "BELOW_RESERVE"],
    [500, 500, "AVAILABLE"],
    [501, 500, "AVAILABLE"],
    [0, 0, "AVAILABLE"],
  ])("assesses %i remaining against reserve %i", (remaining, reserve, state) => {
    const current = { ...reading, remaining };
    expect(assessGraphqlBudget(current, { reserve, now: observed }))
      .toEqual({ state, reading: current, reserve });
  });
});

describe("readGraphqlBudgetReserve", () => {
  it("uses the default when unset", () => {
    expect(readGraphqlBudgetReserve({} as NodeJS.ProcessEnv)).toBe(500);
    expect(readGraphqlBudgetReserve({} as NodeJS.ProcessEnv)).toBe(DEFAULT_GRAPHQL_BUDGET_RESERVE);
  });

  it.each([
    ["0", 0], ["250", 250], ["-1", 500], ["1.5", 500], ["many", 500],
    ["", 500], ["   ", 500], ["Infinity", 500], ["NaN", 500],
  ])("reads %s as %i", (value, expected) => {
    expect(readGraphqlBudgetReserve({ NODE_ENV: "test", GITHUB_GRAPHQL_BUDGET_RESERVE: value })).toBe(expected);
  });
});

describe("GitHubGraphqlClient budget recording", () => {
  it.each([
    { name: "a delayed higher balance in the same window", early: 499, late: 501,
      earlyReset: "2026-09-07T11:00:00Z", lateReset: "2026-09-07T11:00:00Z",
      laterNow: "2026-09-07T10:01:00Z", expected: 499, state: "BELOW_RESERVE" },
    { name: "a lower balance received in the same millisecond", early: 500, late: 499,
      earlyReset: "2026-09-07T11:00:00Z", lateReset: "2026-09-07T11:00:00Z",
      laterNow: "2026-09-07T10:00:00Z", expected: 499, state: "BELOW_RESERVE" },
    { name: "a delayed expired window", early: 499, late: 1,
      earlyReset: "2026-09-07T11:00:00Z", lateReset: "2026-09-07T10:00:00Z",
      laterNow: "2026-09-07T10:01:00Z", expected: 499, state: "BELOW_RESERVE" },
    { name: "a replenished newer window", early: 499, late: 4900,
      earlyReset: "2026-09-07T11:00:00Z", lateReset: "2026-09-07T12:00:00Z",
      laterNow: "2026-09-07T11:00:00Z", expected: 4900, state: "AVAILABLE" },
  ])("merges $name through the transport and admission gate", async (scenario) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
    try {
      const budget = createGitHubGraphqlBudgetStore();
      const gate = createReconciliationBudgetGate({ store: budget, reserve: 500 });
      const delayed = Promise.withResolvers<Response>();
      const early = Promise.withResolvers<Response>();
      const responses = [delayed.promise, early.promise];
      const client = new GitHubGraphqlClient({
        accessToken: "test-token", budget, fetch: () => responses.shift()!,
      });
      const delayedQuery = client.query("query { rateLimit { remaining resetAt } }", {});
      const earlyQuery = client.query("query { rateLimit { remaining resetAt } }", {});
      early.resolve(Response.json({ data: { rateLimit: {
        ...rateLimit, remaining: scenario.early, resetAt: scenario.earlyReset,
      } } }));
      await earlyQuery;
      expect(gate.check(new Date("2026-09-07T10:00:00Z"))).toMatchObject({
        state: scenario.early === 500 ? "AVAILABLE" : "BELOW_RESERVE",
        reading: { remaining: scenario.early, resetAt: new Date(scenario.earlyReset) },
      });

      vi.setSystemTime(new Date(scenario.laterNow));
      delayed.resolve(Response.json({ data: { rateLimit: {
        ...rateLimit, remaining: scenario.late, resetAt: scenario.lateReset,
      } } }));
      await delayedQuery;
      expect(gate.check(new Date(scenario.laterNow))).toMatchObject({
        state: scenario.state,
        reading: { remaining: scenario.expected,
          resetAt: new Date(scenario.state === "AVAILABLE" ? scenario.lateReset : scenario.earlyReset) },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("records a successful reading and returns the data unchanged", async () => {
    const budget = createGitHubGraphqlBudgetStore();
    const data = { repository: null, rateLimit };
    const client = new GitHubGraphqlClient({
      accessToken: "test-token", budget, fetch: async () => Response.json({ data }),
    });

    expect(await client.query("query { repository { id } }", {})).toEqual(data);
    expect(budget.read()).toEqual({ ...reading, observedAt: expect.any(Date) });
  });

  it.each([
    { repository: null },
    { repository: null, rateLimit: { remaining: 42 } },
    null,
  ])("does not invent a reading from data %j", async (data) => {
    const budget = createGitHubGraphqlBudgetStore();
    const client = new GitHubGraphqlClient({
      accessToken: "test-token", budget, fetch: async () => Response.json({ data }),
    });

    expect(await client.query("query { repository { id } }", {})).toEqual(data);
    expect(budget.read()).toBeNull();
  });

  it("returns the data even when recording fails", async () => {
    const data = { repository: null, rateLimit };
    const record = vi.fn(() => { throw new Error("recorder failed"); });
    const client = new GitHubGraphqlClient({
      accessToken: "test-token",
      budget: { ...createGitHubGraphqlBudgetStore(), record },
      fetch: async () => Response.json({ data }),
    });

    await expect(client.query("query { repository { id } }", {})).resolves.toEqual(data);
    expect(record).toHaveBeenCalledExactlyOnceWith({ ...reading, observedAt: expect.any(Date) });
  });

  it.each(["reject", "pending"])("contains async recorder %s without delaying the query or crashing Node", (mode) => {
    // A separate Node process has no Vitest rejection listener. Its exit status
    // catches unhandled rejections, and a pending recorder catches accidental await.
    const child = spawnSync(process.execPath, [
      "--experimental-transform-types",
      "--unhandled-rejections=strict",
      "--import", "./scripts/register-path-aliases.ts",
      "--input-type=module",
      "--eval", `
        import { GitHubGraphqlClient } from './src/lib/github/graphql.ts';
        import { createGitHubGraphqlBudgetStore } from './src/lib/github/rate-limit-budget.ts';
        const data = ${JSON.stringify({ repository: null, rateLimit })};
        let calls = 0;
        const budget = {
          ...createGitHubGraphqlBudgetStore(),
          async record() {
            calls++;
            await Promise.resolve();
            if (${JSON.stringify(mode)} === 'reject') throw new Error('async recorder rejected');
            return new Promise(() => {});
          },
        };
        const client = new GitHubGraphqlClient({
          accessToken: 'test-token', budget,
          fetch: async () => Response.json({ data }),
        });
        const result = await client.query('query { rateLimit { remaining resetAt } }', {});
        process.stdout.write(JSON.stringify({ result, calls }));
        await new Promise(resolve => setImmediate(resolve));
      `,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 });

    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ result: { repository: null, rateLimit }, calls: 1 });
  });

  it.each([
    [500, { data: { repository: null, rateLimit } }],
    [200, { data: { repository: null, rateLimit }, errors: [{ type: "RATE_LIMIT" }] }],
  ])("does not record a failed request with HTTP %i", async (status, payload) => {
    const budget = createGitHubGraphqlBudgetStore();
    const client = new GitHubGraphqlClient({
      accessToken: "test-token", budget, fetch: async () => Response.json(payload, { status }),
    });

    await expect(client.query("query { repository { id } }", {})).rejects.toBeInstanceOf(Error);
    expect(budget.read()).toBeNull();
  });

  it("uses the global store when none is injected", async () => {
    const key = Symbol.for("overflow.github.graphql-budget");
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    const budget = createGitHubGraphqlBudgetStore();
    Reflect.set(globalThis, key, budget);
    try {
      const client = new GitHubGraphqlClient({
        accessToken: "test-token", fetch: async () => Response.json({ data: { rateLimit } }),
      });
      await client.query("query { rateLimit { remaining resetAt } }", {});
      expect(budget.read()?.remaining).toBe(42);
    } finally {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it("constructs and queries through a broken default observer, then observes after recovery", async () => {
    const key = Symbol.for("overflow.github.graphql-budget");
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    const fault = vi.fn(() => { throw new Error("shared store cannot be assigned"); });
    Object.defineProperty(globalThis, key, { configurable: true, get: () => undefined, set: fault });
    const data = { repository: null, rateLimit };
    const request = vi.fn(async () => Response.json({ data }));
    try {
      const client = new GitHubGraphqlClient({ accessToken: "test-token", fetch: request });
      expect(fault).not.toHaveBeenCalled();
      await expect(client.query("query { rateLimit { remaining resetAt } }", {})).resolves.toEqual(data);
      expect(request).toHaveBeenCalledTimes(1);
      expect(fault).toHaveBeenCalledTimes(1);

      Reflect.deleteProperty(globalThis, key);
      await expect(client.query("query { rateLimit { remaining resetAt } }", {})).resolves.toEqual(data);
      expect(request).toHaveBeenCalledTimes(2);
      expect(gitHubGraphqlBudget().read()).toMatchObject({ remaining: 42, resetAt: reset });
    } finally {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it("records through the gateway's injected store and requests the full budget first", async () => {
    const budget = createGitHubGraphqlBudgetStore();
    const queries: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-token", budget,
      fetch: async (_input, init) => {
        queries.push(JSON.parse(String(init?.body)).query);
        return Response.json({ data: {
          rateLimit,
          repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
        } });
      },
    });

    expect(await gateway.listIssues({ owner: "octo", name: "overflow" })).toEqual([]);
    expect(budget.read()?.remaining).toBe(42);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toMatch(/query RepositoryIssues\([^)]*\)\s*\{\s*rateLimit\s*\{\s*cost\s+limit\s+remaining\s+resetAt\s*\}/);
  });

  it("requests the full budget first in all six gateway operations", async () => {
    const queries = new Map<string, string>();
    const page = { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
    const repository = { owner: "octo", name: "overflow" };
    const responses: Record<string, unknown> = {
      RepositoryIssues: { repository: { issues: {
        ...page,
        nodes: [{
          databaseId: 101, number: 1, title: "Issue", body: "", url: "https://github.com/octo/overflow/issues/1",
          state: "OPEN", createdAt: observed.toISOString(), closedAt: null, author: null,
          labels: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "next-labels" } },
          assignees: { nodes: [] }, closedByPullRequestsReferences: page,
        }],
      } } },
      ClosingPullRequests: { repository: { issue: { closedByPullRequestsReferences: page } } },
      IssueLabels: { repository: { issue: { labels: page } } },
      IssueTimeline: { repository: { issue: { timelineItems: page } } },
      PullRequestReviews: { repository: { pullRequest: { reviews: page } } },
      PullRequestReviewDismissals: { repository: { pullRequest: { timelineItems: page } } },
    };
    const gateway = new GitHubGateway({
      accessToken: "test-token", budget: createGitHubGraphqlBudgetStore(),
      fetch: async (_input, init) => {
        const { query } = JSON.parse(String(init?.body)) as { query: string };
        const operation = /query\s+(\w+)/.exec(query)?.[1];
        if (operation === undefined || !(operation in responses)) throw new Error(`Unexpected operation: ${operation}`);
        queries.set(operation, query);
        return Response.json({ data: responses[operation] });
      },
    });

    await gateway.listIssues(repository);
    await gateway.getIssueClosingPullRequests(repository, 1);
    await gateway.getPullRequestReviews(repository, 2);

    const operations = [
      "RepositoryIssues", "ClosingPullRequests", "IssueLabels", "IssueTimeline",
      "PullRequestReviews", "PullRequestReviewDismissals",
    ];
    expect([...queries.keys()].sort()).toEqual([...operations].sort());
    for (const operation of operations) {
      expect(queries.get(operation), `${operation} must request the full budget as its first selection`)
        .toMatch(new RegExp(`query\\s+${operation}\\([^)]*\\)\\s*\\{\\s*rateLimit\\s*\\{\\s*cost\\s+limit\\s+remaining\\s+resetAt\\s*\\}`));
    }
  });
});
