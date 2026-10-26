import { describe, expect, it } from "vitest";
import type { WalkListingDriver } from "@/lib/fold/reconciliation-walk";
import { SweepBudgetSpent } from "@/lib/fold/sweep-request-budget";
import { fixture, instant, subject } from "./reconciliation-walk-fixture";

type Options = Parameters<Extract<WalkListingDriver, { kind: "timestamp" }>["listPage"]>[0];
function gitlab(f: ReturnType<typeof fixture>, pageSize = 100) {
  const calls: Options[] = [];
  const listing: WalkListingDriver = { kind: "timestamp", listPage: (options) => f.read(`gl:${JSON.stringify(options)}`, () => {
    calls.push(options);
    const available = [...f.live.values()].filter((row) => row.kind === options.collection
      && (options.updatedAfter === null || +row.updatedAt >= Date.parse(options.updatedAfter))
      && (options.updatedBefore === undefined || +row.updatedAt <= Date.parse(options.updatedBefore)))
      .sort((a, b) => +a.updatedAt - +b.updatedAt || a.id - b.id);
    const start = ((options.page ?? 1) - 1) * pageSize;
    const subjects = available.slice(start, start + pageSize);
    return { subjects, nextAnchor: subjects.at(-1)?.updatedAt.toISOString() ?? null, exhausted: subjects.length < pageSize };
  }) };
  return { listing, calls };
}

describe("timestamp reconciliation listing driver", () => {
  it("visits the first re-anchored page when timestamps advance between pages", async () => {
    const f = fixture(Array.from({ length: 250 }, (_, i) => subject(i + 1)));
    const gl = gitlab(f);
    const result = await f.window(2000, gl.listing);
    expect(result.issues).toHaveLength(250);
    expect([...f.counts.keys()].sort((a, b) => a - b)).toEqual(Array.from({ length: 250 }, (_, i) => i + 1));
    expect([...f.counts.values()]).toEqual(Array(250).fill(1));
  });

  it("drains a timestamp slice over multiple pages before continuing past the tie", async () => {
    const f = fixture([subject(1), ...Array.from({ length: 205 }, (_, i) => subject(i + 2, "issue", 2)), subject(207, "issue", 3)]);
    const gl = gitlab(f);
    const result = await f.window(1000, gl.listing);
    expect(result.issues).toHaveLength(207);
    expect([...f.counts.values()]).toEqual(Array(207).fill(1));
    expect(gl.calls).toContainEqual({ collection: "issue", updatedAfter: instant(2).toISOString(), updatedBefore: instant(2).toISOString(), page: 3 });
    expect(gl.calls).toContainEqual({ collection: "issue", updatedAfter: instant(2).toISOString(), page: 3 });
    expect(gl.calls).toContainEqual({ collection: "pull_request", updatedAfter: null });
    expect(f.pass.walkAnchors().issue?.key).toBe(207);
    expect(f.pass.walkAnchors().subjects).toBeUndefined();
  });

  it("resumes each collection independently and keeps unstaged rows behind a tie anchor", async () => {
    const f = fixture([subject(1), subject(2, "issue", 1), subject(3, "pull_request", 1)]);
    const gl = gitlab(f, 2);
    await expect(f.window(2, gl.listing)).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect(f.pass.walkAnchors().issue).toEqual({ updatedAt: instant(1), key: 1 });
    expect(f.pass.walkAnchors().pull_request).toBeUndefined();
    const result = await f.window(100, gl.listing);
    expect(result.issues.map(({ id }) => id)).toEqual([1, 2]);
    expect([...f.counts]).toEqual([[1, 1], [2, 1]]);
    expect(f.pass.walkAnchors().pull_request?.key).toBe(3);
    expect(gl.calls[1]).toEqual({ collection: "issue", updatedAfter: instant(1).toISOString() });
  });

  it("stages the strict prefix before moving the timestamp bound", async () => {
    const f = fixture([subject(1), subject(2), subject(3)]);
    const gl = gitlab(f, 2);
    const original = f.pass.stage;
    f.pass.stage = async (row) => { if (row.subjectKey === 1) throw new Error("Prefix not committed"); await original(row); };
    await expect(f.window(20, gl.listing)).rejects.toThrow("Prefix not committed");
    expect(gl.calls).toEqual([{ collection: "issue", updatedAfter: null }]);
    expect(f.pass.walkAnchors()).toEqual({});
  });

  it("retains the raw timestamp spelling for the slice and post-slice bounds", async () => {
    const f = fixture([subject(1), subject(2)]);
    const raw = "2026-10-01T00:00:02.000123+00:00";
    const calls: Options[] = [];
    const listing: WalkListingDriver = { kind: "timestamp", listPage: (options) => f.read(`raw:${JSON.stringify(options)}`, () => {
      calls.push(options);
      if (options.collection === "pull_request" || options.page === 2) return { subjects: [], nextAnchor: null, exhausted: true };
      if (options.updatedBefore !== undefined) return { subjects: [subject(2)], nextAnchor: raw, exhausted: true };
      return { subjects: [subject(1), subject(2)], nextAnchor: raw, exhausted: false };
    }) };
    expect((await f.window(40, listing)).issues).toHaveLength(2);
    expect(calls).toContainEqual({ collection: "issue", updatedAfter: raw, updatedBefore: raw, page: 1 });
    expect(calls).toContainEqual({ collection: "issue", updatedAfter: raw, page: 2 });
  });

  it("bounds a timestamp slice whose full pages never end", async () => {
    const f = fixture([subject(1)]);
    let reads = 0;
    const listing: WalkListingDriver = { kind: "timestamp", listPage: async () => {
      reads += 1;
      if (reads > 2100) throw new Error("Fake forge refused an unbounded slice");
      return { subjects: [subject(1)], nextAnchor: instant(1).toISOString(), exhausted: false };
    } };
    await expect(f.window(10000, listing)).rejects.toThrow(/collection-walk bound/);
    expect(reads).toBeGreaterThan(1);
    expect(reads).toBeLessThan(2100);
  });

  it("keeps an issue and a PR with the same numeric id as separate staged subjects", async () => {
    const f = fixture([subject(7)]);
    f.repository.disputePullRequests = [{ id: 7, number: 7 }];
    const listing: WalkListingDriver = { kind: "timestamp", listPage: (options) => f.read(`collision:${options.collection}`, () => ({
      subjects: [subject(7, options.collection)], nextAnchor: instant(7).toISOString(), exhausted: true,
    })) };
    const result = await f.window(30, listing);
    expect(result.issues.map(({ id }) => id)).toEqual([7]);
    expect(result.pullRequests.map(({ id }) => id)).toEqual([7]);
    expect((await f.pass.readStaged()).map(({ kind, subjectKey }) => [kind, subjectKey])).toEqual([["issue", 7], ["pull_request", 7]]);
  });
});
