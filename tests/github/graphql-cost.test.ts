import { describe, expect, it } from "vitest";
import { GitHubGraphqlClient, collectCursorPages } from "@/lib/github/graphql";
import { createGitHubGraphqlBudgetStore } from "@/lib/github/rate-limit-budget";
import { recordGraphqlResponseCost, withGraphqlFoldCost } from "@/lib/github/graphql-cost";

describe("fold GraphQL cost", () => {
  it("sums pages and concurrent responses even when the budget observer drops readings", async () => {
    const budget = createGitHubGraphqlBudgetStore();
    const client = new GitHubGraphqlClient({ accessToken: "test-token", owner: "sponsor-1", budget,
      fetch: async (_url, init) => {
        const { variables } = JSON.parse(String(init?.body)) as { variables: { cost: number } };
        return Response.json({ data: { rateLimit: { cost: variables.cost, remaining: 4000,
          limit: 5000, resetAt: "2099-01-01T01:00:00Z" } } });
      },
    });
    const result = await withGraphqlFoldCost(async (readCost) => {
      await collectCursorPages(async (cursor) => {
        await client.query("query cost", { cost: cursor === null ? 2 : 3 });
        return { nodes: [cursor], pageInfo: { hasNextPage: cursor === null, endCursor: "second" } };
      });
      await Promise.all([client.query("query cost", { cost: 5 }), client.query("query cost", { cost: 7 })]);
      expect(readCost()).toEqual({ observedCost: 17, observedResponses: 4, unmeasuredResponses: 0 });
      return "folded";
    });
    expect(result).toEqual({ value: "folded", cost: { observedCost: 17, observedResponses: 4, unmeasuredResponses: 0 } });
    expect(budget.read("sponsor-1")?.cost).toBe(2);
  });

  it("isolates simultaneous and nested folds and excludes unscoped requests", async () => {
    recordGraphqlResponseCost({ cost: 999 });
    const [one, two] = await Promise.all([
      withGraphqlFoldCost(async () => { recordGraphqlResponseCost({ cost: 2 }); await Promise.resolve(); recordGraphqlResponseCost({ cost: 3 }); }),
      withGraphqlFoldCost(async () => { recordGraphqlResponseCost({ cost: 11 }); }),
    ]);
    expect([one.cost.observedCost, two.cost.observedCost]).toEqual([5, 11]);
    const outer = await withGraphqlFoldCost(async () => {
      recordGraphqlResponseCost({ cost: 1 });
      const inner = await withGraphqlFoldCost(async () => recordGraphqlResponseCost({ cost: 10 }));
      expect(inner.cost.observedCost).toBe(10);
    });
    expect(outer.cost.observedCost).toBe(1);
  });

  it("binds each reader to its own fold while a nested fold is active", async () => {
    const outer = await withGraphqlFoldCost(async (readOuter) => {
      recordGraphqlResponseCost({ cost: 1 });
      const inner = await withGraphqlFoldCost(async (readInner) => {
        recordGraphqlResponseCost({ cost: 10 });
        await Promise.resolve();
        expect([readOuter().observedCost, readInner().observedCost]).toEqual([1, 10]);
      });
      recordGraphqlResponseCost({ cost: 2 });
      expect(readOuter()).toEqual({ observedCost: 3, observedResponses: 2, unmeasuredResponses: 0 });
      expect(inner.cost).toEqual({ observedCost: 10, observedResponses: 1, unmeasuredResponses: 0 });
    });
    expect(outer.cost).toEqual({ observedCost: 3, observedResponses: 2, unmeasuredResponses: 0 });
  });

  it("distinguishes unknown costs, observed zero, and partially measured totals", async () => {
    const unknown = await withGraphqlFoldCost(async () => {
      for (const cost of [undefined, null, -1, 1.5, NaN, Infinity, "3"]) recordGraphqlResponseCost({ cost });
      recordGraphqlResponseCost({ get cost() { throw new Error("observer input"); } });
    });
    expect(unknown.cost).toEqual({ observedCost: null, observedResponses: 0, unmeasuredResponses: 8 });
    const partial = await withGraphqlFoldCost(async () => { recordGraphqlResponseCost({ cost: 0 }); recordGraphqlResponseCost({}); });
    expect(partial.cost).toEqual({ observedCost: 0, observedResponses: 1, unmeasuredResponses: 1 });
  });

  it("retains the safe observed sum when another response would overflow", async () => {
    const result = await withGraphqlFoldCost(async () => {
      recordGraphqlResponseCost({ cost: Number.MAX_SAFE_INTEGER });
      recordGraphqlResponseCost({ cost: 1 });
    });
    expect(result.cost).toEqual({ observedCost: Number.MAX_SAFE_INTEGER, observedResponses: 1, unmeasuredResponses: 1 });
  });

  it("counts malformed shapes and unsafe costs as unmeasured", async () => {
    const { proxy, revoke } = Proxy.revocable({ cost: 3 }, {});
    revoke();
    const result = await withGraphqlFoldCost(async () => {
      for (const rateLimit of [undefined, null, 3, "3", Object.assign([], { cost: 3 }), proxy,
        { cost: Number.MAX_SAFE_INTEGER + 1 }]) recordGraphqlResponseCost(rateLimit);
    });
    expect(result.cost).toEqual({ observedCost: null, observedResponses: 0, unmeasuredResponses: 7 });
  });

  it("returns independent snapshots without exposing mutable collection state", async () => {
    const result = await withGraphqlFoldCost(async (readCost) => {
      const empty = readCost();
      recordGraphqlResponseCost({ cost: 2 });
      expect(empty).toEqual({ observedCost: null, observedResponses: 0, unmeasuredResponses: 0 });
      const first = readCost();
      first.observedCost = 999;
      first.observedResponses = 999;
      first.unmeasuredResponses = 999;
      recordGraphqlResponseCost({ cost: 3 });
      expect(readCost()).toEqual({ observedCost: 5, observedResponses: 2, unmeasuredResponses: 0 });
    });
    expect(result.cost).toEqual({ observedCost: 5, observedResponses: 2, unmeasuredResponses: 0 });
  });

  it("preserves a successful null data response and marks its cost unmeasured", async () => {
    const client = new GitHubGraphqlClient({ accessToken: "test-token",
      fetch: async () => Response.json({ data: null }),
    });
    const result = await withGraphqlFoldCost(async () => client.query("query cost", {}));
    expect(result).toEqual({ value: null, cost: { observedCost: null, observedResponses: 0, unmeasuredResponses: 1 } });
  });

  it.each(["sponsor-1", "sponsor-2"])("collects cost for %s when observation throws", async (owner) => {
    const client = new GitHubGraphqlClient({ accessToken: "test-token", owner,
      budget: { ...createGitHubGraphqlBudgetStore(), record() { throw new Error("observer failed"); } },
      fetch: async () => Response.json({ data: { rateLimit: { cost: 7, remaining: 4000,
        resetAt: "2099-01-01T01:00:00Z" } } }),
    });
    const result = await withGraphqlFoldCost(async () => client.query("query cost", {}));
    expect(result.cost).toEqual({ observedCost: 7, observedResponses: 1, unmeasuredResponses: 0 });
  });

  it.each(["sponsor-1", "sponsor-2"])("collects cost for %s when observation rejects asynchronously", async (owner) => {
    const client = new GitHubGraphqlClient({ accessToken: "test-token", owner,
      budget: { ...createGitHubGraphqlBudgetStore(), async record() {
        await Promise.resolve();
        throw new Error("async observer failed");
      } },
      fetch: async () => Response.json({ data: { rateLimit: { cost: 7, remaining: 4000,
        resetAt: "2099-01-01T01:00:00Z" } } }),
    });
    const result = await withGraphqlFoldCost(async () => client.query("query cost", {}));
    await Promise.resolve();
    expect(result.cost).toEqual({ observedCost: 7, observedResponses: 1, unmeasuredResponses: 0 });
  });

  it.each(["sponsor-1", "sponsor-2"])("isolates concurrent real clients owned by sponsor-1 and %s", async (secondOwner) => {
    const budget = createGitHubGraphqlBudgetStore();
    const run = (owner: string, cost: number) => withGraphqlFoldCost(async () => {
      const client = new GitHubGraphqlClient({ accessToken: "test-token", owner, budget,
        fetch: async () => Response.json({ data: { rateLimit: { cost, remaining: 4000,
          limit: 5000, resetAt: "2099-01-01T01:00:00Z" } } }),
      });
      await client.query("query cost", {});
    });
    const [one, two] = await Promise.all([run("sponsor-1", 5), run(secondOwner, 11)]);
    expect([one.cost.observedCost, two.cost.observedCost]).toEqual([5, 11]);
  });

  it.each([
    [500, { data: { rateLimit: { cost: 7 } } }],
    [200, { data: { rateLimit: { cost: 7 } }, errors: [{ type: "RATE_LIMIT" }] }],
  ])("rejects a failed fold without publishing a charge for HTTP %i", async (status, payload) => {
    const client = new GitHubGraphqlClient({ accessToken: "test-token",
      fetch: async () => Response.json(payload, { status }),
    });
    await expect(withGraphqlFoldCost(async () => client.query("query cost", {}))).rejects.toBeInstanceOf(Error);
  });
});
