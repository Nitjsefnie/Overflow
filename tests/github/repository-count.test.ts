import { describe, expect, it } from "vitest";
import { GitHubGateway } from "@/lib/github/client";

/**
 * The sweep's size measure rides one count-only GraphQL read: the two
 * connections' totalCounts, never a page of nodes, so closed issues and pull
 * requests are counted by the same read that counts open ones.
 */

function gatewayWith(repository: unknown, capture?: (query: string) => void): GitHubGateway {
  return new GitHubGateway({
    accessToken: "test-access-token",
    fetch: async (_input, init) => {
      const payload = JSON.parse(String(init?.body)) as { query: string };
      capture?.(payload.query);
      return Response.json({ data: { repository } });
    },
  });
}

describe("the GitHub repository history count", () => {
  it("sums both connections' totals, closed items included", async () => {
    const gateway = gatewayWith({ issues: { totalCount: 682 }, pullRequests: { totalCount: 674 } });
    await expect(gateway.getRepositoryHistoryCount({ owner: "octo", name: "overflow" })).resolves.toBe(1356);
  });

  it("reads one count query shaped like neither list query", async () => {
    let query: string | undefined;
    const gateway = gatewayWith({ issues: { totalCount: 1 }, pullRequests: { totalCount: 2 } }, (captured) => { query = captured; });
    await gateway.getRepositoryHistoryCount({ owner: "octo", name: "overflow" });
    expect(query).toMatch(/issues\s*\{\s*totalCount\s*\}/);
    expect(query).toMatch(/pullRequests\s*\{\s*totalCount\s*\}/);
    // A count query lists nothing: no page of nodes, no page size, no states.
    expect(query).not.toMatch(/\bnodes\b/);
    expect(query).not.toMatch(/\bfirst\s*:/);
    expect(query).not.toMatch(/\bstates\s*:/);
  });

  it.each([
    ["a repository GitHub cannot resolve", null],
    ["a missing issues connection", { pullRequests: { totalCount: 1 } }],
    ["a non-integer total", { issues: { totalCount: "many" }, pullRequests: { totalCount: 1 } }],
    ["a negative total", { issues: { totalCount: -1 }, pullRequests: { totalCount: 1 } }],
  ])("answers null for %s", async (_name, repository) => {
    const gateway = gatewayWith(repository);
    await expect(gateway.getRepositoryHistoryCount({ owner: "octo", name: "overflow" })).resolves.toBeNull();
  });
});
