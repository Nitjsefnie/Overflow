import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitHubGateway } from "@/lib/github/client";
import { listOpenIssueIds, listSubjectPage } from "@/lib/github/subject-listing";
import { SweepBudgetSpent, withSweepRequestBudget } from "@/lib/fold/sweep-request-budget";
import { withGraphqlFoldCost } from "@/lib/github/graphql-cost";

const repository = { owner: "octo", name: "overflow" };
const firstTime = "2026-10-25T08:00:00.000Z";
const secondTime = "2026-10-26T09:00:00.000Z";

function gateway(fetch: typeof globalThis.fetch) {
  return new GitHubGateway({ accessToken: randomBytes(24).toString("hex"), fetch });
}

describe("GitHub subject pages", () => {
  it("requests every state in ascending update order and maps stable IDs, numbers, kinds and dates", async () => {
    let request: Request | undefined;
    const client = gateway(async (input, init) => {
      request = new Request(input, init);
      return Response.json([{ id: 701, number: 12, updated_at: firstTime }, { id: 405, number: 19, updated_at: secondTime, pull_request: {} }]);
    });
    expect(await listSubjectPage(client, repository, { cursor: null })).toEqual({
      subjects: [{ id: 701, number: 12, kind: "issue", updatedAt: new Date(firstTime) }, { id: 405, number: 19, kind: "pull_request", updatedAt: new Date(secondTime) }],
      nextCursor: null,
    });
    expect(request?.method).toBe("GET");
    expect(request?.url).toBe("https://api.github.com/repos/octo/overflow/issues?state=all&sort=updated&direction=asc&per_page=100");
  });

  it("classifies a pull request by key presence even when the key's value is null", async () => {
    const client = gateway(async () => Response.json([{ id: 901, number: 5, updated_at: firstTime, pull_request: null }]));
    expect((await listSubjectPage(client, repository, { cursor: null })).subjects[0]?.kind).toBe("pull_request");
  });

  it("follows next Links across three pages, preserving after and classic page cursors", async () => {
    const requests: string[] = [];
    const base = "https://api.github.com/repos/octo/overflow/issues";
    const client = gateway(async (input) => {
      const url = new URL(String(input));
      requests.push(url.search);
      if (requests.length === 1) return Response.json([
        { id: 801, number: 6, updated_at: firstTime },
      ], { headers: { link: `<${base}?after=opaque%2Bcursor&per_page=100>; rel="next", <${base}?page=3>; rel="last"` } });
      if (requests.length === 2) return Response.json([
        { id: 802, number: 7, updated_at: firstTime },
      ], { headers: { link: `<${base}?page=1>; rel="prev", <${base}?page=3&per_page=100>; rel="next"` } });
      if (requests.length === 3) return Response.json([
        { id: 803, number: 8, updated_at: secondTime },
      ], { headers: { link: `<${base}?page=2>; rel="prev", <${base}?page=1>; rel="first"` } });
      throw new Error("Unexpected extra page");
    });
    const first = await listSubjectPage(client, repository, { cursor: null });
    expect(requests).toHaveLength(1);
    expect(first.nextCursor).not.toBeNull();
    const second = await listSubjectPage(client, repository, { cursor: first.nextCursor });
    expect(second.nextCursor).not.toBeNull();
    const third = await listSubjectPage(client, repository, { cursor: second.nextCursor });
    expect([...first.subjects, ...second.subjects, ...third.subjects].map((subject) => subject.id)).toEqual([801, 802, 803]);
    expect(third.nextCursor).toBeNull();
    expect(requests).toEqual(["?state=all&sort=updated&direction=asc&per_page=100", "?after=opaque%2Bcursor&per_page=100", "?page=3&per_page=100"]);
  });

  it("adds since only when given and encodes repository segments", async () => {
    const urls: URL[] = [];
    const client = gateway(async (input) => { urls.push(new URL(String(input))); return Response.json([]); });
    await listSubjectPage(client, { owner: "space owner", name: "a/b" }, { cursor: null });
    await listSubjectPage(client, repository, { cursor: null, since: secondTime });
    expect(urls[0]?.pathname).toBe("/repos/space%20owner/a%2Fb/issues");
    expect(urls.map((url) => url.searchParams.get("since"))).toEqual([null, secondTime]);
  });

  it("exhausts when a Link relation only starts with next", async () => {
    const client = gateway(async () => Response.json([], { headers: { link: '<https://api.github.com/repos/octo/overflow/issues?page=2>; rel="next-sibling"' } }));
    expect((await listSubjectPage(client, repository, { cursor: null })).nextCursor).toBeNull();
  });

  it.each([undefined, null, "", "not-a-timestamp"])("refuses an unorderable updated_at (%s)", async (updated_at) => {
    const client = gateway(async () => Response.json([{ id: 901, number: 5, updated_at }]));
    await expect(listSubjectPage(client, repository, { cursor: null })).rejects.toThrow(/GitHub.*updated_at/);
  });

  it("spends the sweep budget once per request and holds before sending when it is spent", async () => {
    let sent = 0, spent = 0;
    const client = gateway(async () => Response.json([{ id: ++sent, number: 6, updated_at: firstTime }]));
    const resetAt = new Date(secondTime);
    await withSweepRequestBudget(async () => ++spent <= 2 ? null : resetAt, async () => {
      expect((await listSubjectPage(client, repository, { cursor: null })).subjects[0]?.id).toBe(1);
      expect((await listSubjectPage(client, repository, { cursor: null })).subjects[0]?.id).toBe(2);
      await expect(listSubjectPage(client, repository, { cursor: "?page=2" })).rejects.toBeInstanceOf(SweepBudgetSpent);
    });
    expect({ sent, spent }).toEqual({ sent: 2, spent: 3 });
  });
});

describe("GitHub open issue IDs", () => {
  const base = "https://api.github.com/repos/octo/overflow/issues";
  it("collects every page of open issues, leaves pull requests out and counts each page as an unmeasured response", async () => {
    const requests: string[] = [];
    const client = gateway(async (input) => {
      requests.push(String(input));
      if (requests.length === 1) return Response.json([
        { id: 11, number: 1, updated_at: firstTime }, { id: 12, number: 2, updated_at: firstTime, pull_request: {} },
      ], { headers: { link: `<${base}?state=open&page=2>; rel="next"` } });
      return Response.json([{ id: 13, number: 3, updated_at: secondTime }]);
    });
    expect(await withGraphqlFoldCost(() => client.listOpenIssueIds(repository))).toEqual({ value: [11, 13], cost: { observedCost: null, observedResponses: 0, unmeasuredResponses: 2 } });
    expect(requests).toEqual([`${base}?state=open&sort=updated&direction=asc&per_page=100`, `${base}?state=open&page=2`]);
  });

  it("counts a page as soon as it arrives, before its body is read", async () => {
    const client = gateway(async () => Response.json([{ id: 11, number: 1, updated_at: "not-a-timestamp" }]));
    const { value, cost } = await withGraphqlFoldCost(() => listOpenIssueIds(client, repository).catch(String));
    expect([value, cost.unmeasuredResponses]).toEqual([expect.stringMatching(/updated_at/), 1]);
  });

  it("fails on a repeated cursor", async () => {
    const client = gateway(async () => Response.json([], { headers: { link: `<${base}?page=2>; rel="next"` } }));
    await expect(listOpenIssueIds(client, repository)).rejects.toThrow("Open issue listing repeated a cursor.");
  });

  it("fails when a later page fails, so a partial list is never returned", async () => {
    let calls = 0;
    const client = gateway(async () => ++calls === 1
      ? Response.json([{ id: 11, number: 1, updated_at: firstTime }], { headers: { link: `<${base}?page=2>; rel="next"` } })
      : new Response("{}", { status: 502 }));
    await expect(client.listOpenIssueIds(repository)).rejects.toMatchObject({ status: 502 });
  });
});
