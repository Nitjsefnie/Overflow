import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GitLabGateway } from "@/lib/gitlab/client";
import { listGitLabSubjectsPage } from "@/lib/gitlab/subject-listing";
import { SweepBudgetSpent, withSweepRequestBudget } from "@/lib/fold/sweep-request-budget";
import { withSweepPass, type SweepPass } from "@/lib/fold/sweep-pass";

const repository = { owner: "group/subgroup", name: "project" };
const older = "2026-10-25T08:00:00.000Z";
const boundary = "2026-10-26T09:00:00.123000Z";
const later = "2026-10-26T10:00:00.000Z";
const row = (id: number, updated_at = older) => ({ id, iid: id + 1000, updated_at });

function gateway(fetch: typeof globalThis.fetch) {
  return new GitLabGateway({ instanceUrl: "https://gitlab.test", token: randomBytes(24).toString("hex"), fetch });
}

describe("GitLab subject pages", () => {
  it.each(["issue", "pull_request"] as const)("self-sorts %s rows by timestamp and global ID and stages only the strict prefix", async (collection) => {
    let request: Request | undefined;
    const client = gateway(async (input, init) => {
      request = new Request(input, init);
      return Response.json([
        row(10, boundary),
        ...Array.from({ length: 98 }, (_, index) => row(500 - index)),
        row(9, boundary),
      ]);
    });
    const result = await client.listSubjectsPage(repository, { collection, updatedAfter: null });
    expect(result.subjects.map((subject) => subject.id)).toEqual(Array.from({ length: 98 }, (_, index) => 403 + index));
    expect(result.subjects[0]).toEqual({ id: 403, number: 1403, kind: collection, updatedAt: new Date(older) });
    expect(result.nextAnchor).toBe(boundary);
    expect(result.exhausted).toBe(false);
    expect(request?.method).toBe("GET");
    const url = new URL(request!.url);
    expect(url.pathname).toBe(`/api/v4/projects/group%2Fsubgroup%2Fproject/${collection === "issue" ? "issues" : "merge_requests"}`);
    expect(Object.fromEntries(url.searchParams)).toEqual({ state: "all", per_page: "100", order_by: "updated_at", sort: "asc", page: "1" });
  });

  it("re-anchors at the verbatim timestamp so a boundary tie re-arrives whole without skipping or duplicating staged rows", async () => {
    const requests: URL[] = [];
    const rows = [
      ...Array.from({ length: 98 }, (_, index) => row(100 + index)),
      row(300, boundary), row(301, boundary), row(302, boundary),
      ...Array.from({ length: 97 }, (_, index) => row(400 + index, later)),
    ];
    const client = gateway(async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (requests.length > 2) throw new Error("Unexpected request");
      const after = url.searchParams.get("updated_after");
      const filtered = rows.filter((item) => after === null || item.updated_at >= after);
      return Response.json(filtered.slice(0, 100).reverse(), { headers: { "x-next-page": "2" } });
    });
    const first = await client.listSubjectsPage(repository, { collection: "issue", updatedAfter: null });
    expect(first.subjects.map((subject) => subject.id)).toEqual(Array.from({ length: 98 }, (_, index) => 100 + index));
    expect(first.nextAnchor).toBe(boundary);
    const second = await client.listSubjectsPage(repository, { collection: "issue", updatedAfter: first.nextAnchor });
    expect(second.subjects.map((subject) => subject.id)).toEqual([300, 301, 302]);
    expect([...first.subjects, ...second.subjects].map((subject) => subject.id)).toEqual([
      ...Array.from({ length: 98 }, (_, index) => 100 + index), 300, 301, 302,
    ]);
    expect(second.nextAnchor).toBe(later);
    expect(second.exhausted).toBe(false);
    expect(requests.map((url) => url.searchParams.get("page"))).toEqual(["1", "1"]);
    expect(requests.map((url) => url.searchParams.get("updated_after"))).toEqual([null, boundary]);
    expect(requests.every((url) => !url.searchParams.has("updated_before") && !url.searchParams.has("pagination"))).toBe(true);
  });

  it("drains only a full single-timestamp slice by offset pages and keeps its anchor", async () => {
    const requests: URL[] = [];
    const tied = Array.from({ length: 205 }, (_, index) => row(100 + index, boundary));
    const client = gateway(async (input) => {
      const url = new URL(String(input));
      requests.push(url);
      if (requests.length > 4) throw new Error("Unexpected request");
      const before = url.searchParams.get("updated_before");
      const page = Number(url.searchParams.get("page"));
      if (before === null) return Response.json(tied.slice(0, 100).reverse());
      return Response.json(tied.slice((page - 1) * 100, page * 100).reverse());
    });
    const result = await client.listSubjectsPage(repository, { collection: "pull_request", updatedAfter: older });
    expect(result.subjects).toHaveLength(205);
    expect(result.subjects.map((subject) => subject.id)).toEqual(Array.from({ length: 205 }, (_, index) => 100 + index));
    expect(result.subjects[0]).toEqual({ id: 100, number: 1100, kind: "pull_request", updatedAt: new Date(boundary) });
    expect(result.nextAnchor).toBe(boundary);
    expect(result.exhausted).toBe(false);
    expect(requests.map((url) => [url.searchParams.get("updated_after"), url.searchParams.get("updated_before"), url.searchParams.get("page")])).toEqual([
      [older, null, "1"], [boundary, boundary, "1"], [boundary, boundary, "2"], [boundary, boundary, "3"],
    ]);
    expect(requests.every((url) => url.searchParams.get("per_page") === "100" && url.searchParams.get("order_by") === "updated_at"
      && url.searchParams.get("sort") === "asc" && !url.searchParams.has("pagination"))).toBe(true);
  });

  it("reads fresh slice pages without touching the pass cache and holds before sending when the shared budget is spent", async () => {
    let sent = 0;
    let spent = 0;
    let reads = 0;
    let writes = 0;
    const pass = {
      read: async () => { reads++; return { status: 200, headers: {}, body: "[]" }; },
      write: async () => { writes++; },
    } as unknown as SweepPass;
    const client = gateway(async () => { sent++; return Response.json(Array.from({ length: 100 }, (_, index) => row(index + 1, boundary))); });
    await expect(withSweepPass(pass, () => withSweepRequestBudget(async () => ++spent <= 2 ? null : new Date(later), () =>
      client.listSubjectsPage(repository, { collection: "issue", updatedAfter: null }),
    ))).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect({ sent, spent, reads, writes }).toEqual({ sent: 2, spent: 3, reads: 0, writes: 0 });
  });

  it("exports the page surface for a budget-checked request dependency", async () => {
    const result = await listGitLabSubjectsPage({ request: async () => ({ status: 200, headers: new Headers(), body: "[]" }) },
      repository, { collection: "issue", updatedAfter: null });
    expect(result).toEqual({ subjects: [], nextAnchor: null, exhausted: true });
  });

  it.each([undefined, null, "", "invalid", 17])("refuses an unorderable updated_at (%s)", async (updated_at) => {
    const client = gateway(async () => Response.json([{ id: 990, iid: 5, updated_at }]));
    await expect(client.listSubjectsPage(repository, { collection: "issue", updatedAfter: null })).rejects.toThrow(/GitLab.*updated_at/);
  });
});
