import { describe, expect, it } from "vitest";
import {
  PostgresRepositorySizeStore,
  REPOSITORY_SIZE_REMEASURE_MS,
  type RepositorySizeRow,
} from "@/lib/fold/repository-size";
import { sweepReconciliations } from "@/lib/fold/sweep";

const pairs = (...ids: string[]) => ids.map((id) => ({ repositoryId: id, sponsorId: "sponsor" }));

/**
 * The sweep's repository size measure (issue 1360): the count read is NOT the
 * list query. At this layer the measure dependency stands in for the forge
 * count read; the request-shape pins (count-only, closed items included) live
 * on the forge client suites that drive the real gateways.
 */

const at = new Date("2030-01-01T00:00:00Z");

function memorySizeStore(
  rows: Map<string, RepositorySizeRow>,
  backlogs?: ReadonlyMap<string, number>,
): Pick<PostgresRepositorySizeStore, "get" | "store" | "getSponsorBacklog"> {
  return {
    get: async (repositoryId) => rows.get(repositoryId) ?? null,
    store: async (repositoryId, totalCount, measuredAt) => {
      rows.set(repositoryId, { totalCount, measuredAt });
    },
    getSponsorBacklog: async (sponsorId) => backlogs?.get(sponsorId) ?? null,
  };
}

describe("the sweep's repository size measure", () => {
  it("measures a stale repository once and stores the count without listing issues or pull requests", async () => {
    const rows = new Map<string, RepositorySizeRow>();
    const staleAt = new Date(at.getTime() - 2 * REPOSITORY_SIZE_REMEASURE_MS);
    const freshAt = new Date(at.getTime() - 3_600_000);
    rows.set("stale", { totalCount: 10, measuredAt: staleAt });
    rows.set("fresh", { totalCount: 20, measuredAt: freshAt });
    const measured: string[] = [];
    // 682 issues + 674 pull requests, closed ones included: one count query.
    const count = Object.assign(async () => 1356, {
      listIssues: () => { throw new Error("the sweep listed issues during a count-only measure"); },
      getIssue: () => { throw new Error("the sweep listed issues during a count-only measure"); },
      getPullRequestClosingIssues: () => { throw new Error("the sweep listed pull requests during a count-only measure"); },
      getPullRequestReviews: () => { throw new Error("the sweep listed pull requests during a count-only measure"); },
      getPullRequestDiff: () => { throw new Error("the sweep listed pull requests during a count-only measure"); },
    });
    const summary = await sweepReconciliations({
      listActiveRepositorySponsors: async () => pairs("stale", "fresh"),
      enqueue: async () => undefined,
      now: () => at,
      sizeStore: memorySizeStore(rows),
      measureSize: async (repositoryId) => {
        measured.push(repositoryId);
        return count();
      },
    });
    // The fresh row is skipped; only the stale one is measured, once.
    expect(measured).toEqual(["stale"]);
    expect(rows.get("stale")).toEqual({ totalCount: 1356, measuredAt: at });
    expect(rows.get("fresh")?.totalCount).toBe(20);
    expect(summary).toEqual({ attempted: 2, enqueued: 2, failed: 0, measured: 1, measureFailed: 0 });
  });

  it("measures a repository that has never been measured", async () => {
    const rows = new Map<string, RepositorySizeRow>();
    const measured: string[] = [];
    const summary = await sweepReconciliations({
      listActiveRepositorySponsors: async () => pairs("new"),
      enqueue: async () => undefined,
      now: () => at,
      sizeStore: memorySizeStore(rows),
      measureSize: async (repositoryId) => {
        measured.push(repositoryId);
        return 1356;
      },
    });
    expect(measured).toEqual(["new"]);
    expect(rows.get("new")?.totalCount).toBe(1356);
    expect(summary.measured).toBe(1);
  });

  it("measures at exactly the six-hour boundary and skips one millisecond before it", async () => {
    const rows = new Map<string, RepositorySizeRow>();
    // One millisecond inside the window reads as fresh; the boundary itself is
    // stale, so a window measured once never skips its successor's remeasure.
    rows.set("within", { totalCount: 10, measuredAt: new Date(at.getTime() - (REPOSITORY_SIZE_REMEASURE_MS - 1)) });
    rows.set("boundary", { totalCount: 20, measuredAt: new Date(at.getTime() - REPOSITORY_SIZE_REMEASURE_MS) });
    const measured: string[] = [];
    await sweepReconciliations({
      listActiveRepositorySponsors: async () => pairs("within", "boundary"),
      enqueue: async () => undefined,
      now: () => at,
      sizeStore: memorySizeStore(rows),
      measureSize: async (repositoryId) => {
        measured.push(repositoryId);
        return 1356;
      },
    });
    expect(measured).toEqual(["boundary"]);
    expect(rows.get("within")?.totalCount).toBe(10);
    expect(rows.get("boundary")?.totalCount).toBe(1356);
  });

  it("fails a null measure softly: the previous size stands and the failure is counted and reported", async () => {
    const rows = new Map<string, RepositorySizeRow>();
    const staleAt = new Date(at.getTime() - 2 * REPOSITORY_SIZE_REMEASURE_MS);
    rows.set("repo", { totalCount: 500, measuredAt: staleAt });
    const reported: string[] = [];
    const summary = await sweepReconciliations({
      listActiveRepositorySponsors: async () => pairs("repo"),
      enqueue: async () => undefined,
      now: () => at,
      sizeStore: memorySizeStore(rows),
      measureSize: async () => null,
      onFailure: (repositoryId) => { reported.push(repositoryId); },
    });
    expect(rows.get("repo")).toEqual({ totalCount: 500, measuredAt: staleAt });
    expect(summary.measureFailed).toBe(1);
    expect(summary.measured).toBe(0);
    expect(reported).toEqual(["repo"]);
  });

  it("fails a throwing measure the same way and still rotates", async () => {
    const rows = new Map<string, RepositorySizeRow>();
    const staleAt = new Date(at.getTime() - 2 * REPOSITORY_SIZE_REMEASURE_MS);
    rows.set("repo", { totalCount: 500, measuredAt: staleAt });
    const reported: string[] = [];
    const enqueued: string[] = [];
    const summary = await sweepReconciliations({
      listActiveRepositorySponsors: async () => pairs("repo"),
      enqueue: async (repositoryId) => { enqueued.push(repositoryId); },
      now: () => at,
      sizeStore: memorySizeStore(rows),
      measureSize: async () => { throw new Error("forge unreachable"); },
      onFailure: (repositoryId) => { reported.push(repositoryId); },
    });
    expect(rows.get("repo")?.totalCount).toBe(500);
    expect(summary.measureFailed).toBe(1);
    expect(reported).toEqual(["repo"]);
    // A measure failure costs neither the sweep nor the queue it feeds.
    expect(enqueued).toEqual(["repo"]);
    expect(summary.enqueued).toBe(1);
  });

  it("keeps the whole measure per repository: a store write failure counts and the rest continues", async () => {
    const staleAt = new Date(at.getTime() - 2 * REPOSITORY_SIZE_REMEASURE_MS);
    const rows = new Map<string, RepositorySizeRow>([["broken", { totalCount: 1, measuredAt: staleAt }]]);
    const reported: string[] = [];
    const summary = await sweepReconciliations({
      listActiveRepositorySponsors: async () => pairs("broken"),
      enqueue: async () => undefined,
      now: () => at,
      sizeStore: {
        get: async (repositoryId) => rows.get(repositoryId) ?? null,
        store: async () => { throw new Error("sizes table unavailable"); },
        getSponsorBacklog: async () => null,
      },
      measureSize: async () => 1356,
      onFailure: (repositoryId) => { reported.push(repositoryId); },
    });
    // The failed measure left the previous row in place.
    expect(rows.get("broken")).toEqual({ totalCount: 1, measuredAt: staleAt });
    expect(summary.measureFailed).toBe(1);
    expect(summary.measured).toBe(0);
    expect(reported).toEqual(["broken"]);
  });

  it("is today's sweep when the size dependencies are absent", async () => {
    const enqueued: string[] = [];
    const summary = await sweepReconciliations({
      listActiveRepositorySponsors: async () => pairs("repo"),
      enqueue: async (repositoryId) => { enqueued.push(repositoryId); },
      now: () => at,
    });
    expect(enqueued).toEqual(["repo"]);
    expect("measured" in summary).toBe(false);
    expect("measureFailed" in summary).toBe(false);
    expect(summary).toEqual({ attempted: 1, enqueued: 1, failed: 0 });
  });
});

describe("the sweep's diff-only rotation filter", () => {
  /**
   * Item 4 of the diff-only reconciliation plan: a sponsor whose stored backlog
   * is strictly over the diff-only threshold gets NO sweep slot — its
   * repositories leave the rotation so a queued webhook job keeps its reason
   * instead of being upgraded to a full sweep. An under-threshold sponsor
   * rotates exactly as before.
   */
  it("offers a sponsor over the backlog threshold no slot and still rotates an under-threshold sponsor", async () => {
    const offered: string[] = [];
    const slots: Array<{ sponsorId: string; repositoryIds: readonly string[] }> = [];
    const summary = await sweepReconciliations({
      listActiveRepositorySponsors: async () => [
        { repositoryId: "d1", sponsorId: "sponsor-over" },
        { repositoryId: "d2", sponsorId: "sponsor-over" },
        { repositoryId: "u1", sponsorId: "sponsor-under" },
      ],
      round: { enqueueNext: async (sponsorId, ids, _now, _limit, enqueue) => {
        slots.push({ sponsorId, repositoryIds: ids });
        await enqueue(ids[0]!);
        return ids[0]!;
      } },
      enqueue: async (id) => { offered.push(id); },
      now: () => at,
      sizeStore: memorySizeStore(new Map(), new Map([["sponsor-over", 1356], ["sponsor-under", 500]])),
    });
    // The over-threshold sponsor's whole group is filtered, so its round is
    // never touched: the tick spends no slot on a repository it must not queue.
    expect(slots).toEqual([{ sponsorId: "sponsor-under", repositoryIds: ["u1"] }]);
    expect(offered).toEqual(["u1"]);
    expect(summary).toEqual({ attempted: 1, enqueued: 1, failed: 0 });
  });

  it("keeps a sponsor at exactly the threshold in the rotation, since only a greater backlog is diff-only", async () => {
    const slots: string[] = [];
    await sweepReconciliations({
      listActiveRepositorySponsors: async () => [{ repositoryId: "r", sponsorId: "sponsor-at" }],
      round: { enqueueNext: async (sponsorId, _ids, _now, _limit, enqueue) => {
        slots.push(sponsorId);
        await enqueue("r");
        return "r";
      } },
      enqueue: async () => undefined,
      now: () => at,
      sizeStore: memorySizeStore(new Map(), new Map([["sponsor-at", 1000]])),
    });
    expect(slots).toEqual(["sponsor-at"]);
  });

  it("resolves the documented OVERFLOW_-prefixed threshold variable through the production sweep", async () => {
    const originalPrefixed = process.env.OVERFLOW_RECONCILIATION_DIFF_ONLY_BACKLOG;
    const originalUnprefixed = process.env.RECONCILIATION_DIFF_ONLY_BACKLOG;
    process.env.OVERFLOW_RECONCILIATION_DIFF_ONLY_BACKLOG = "5";
    delete process.env.RECONCILIATION_DIFF_ONLY_BACKLOG;
    try {
      const offered: string[] = [];
      await sweepReconciliations({
        listActiveRepositorySponsors: async () => [{ repositoryId: "r", sponsorId: "sponsor-over" }],
        round: { enqueueNext: async (_sponsorId, _ids, _now, _limit, enqueue) => {
          await enqueue("r");
          return "r";
        } },
        enqueue: async (id) => { offered.push(id); },
        now: () => at,
        sizeStore: memorySizeStore(new Map(), new Map([["sponsor-over", 6]])),
      });
      // The prefixed knob is the documented one: a backlog of 6 is over a
      // threshold of 5, so the sponsor is filtered from the rotation.
      expect(offered).toEqual([]);
    } finally {
      if (originalPrefixed === undefined) delete process.env.OVERFLOW_RECONCILIATION_DIFF_ONLY_BACKLOG; else process.env.OVERFLOW_RECONCILIATION_DIFF_ONLY_BACKLOG = originalPrefixed;
      if (originalUnprefixed === undefined) delete process.env.RECONCILIATION_DIFF_ONLY_BACKLOG; else process.env.RECONCILIATION_DIFF_ONLY_BACKLOG = originalUnprefixed;
    }
  });

  it("filters the unpaced sweep too, so both sweep shapes skip a diff-only sponsor", async () => {
    const enqueued: string[] = [];
    await sweepReconciliations({
      listActiveRepositorySponsors: async () => [
        { repositoryId: "d", sponsorId: "sponsor-over" },
        { repositoryId: "u", sponsorId: "sponsor-under" },
      ],
      enqueue: async (id) => { enqueued.push(id); },
      now: () => at,
      sizeStore: memorySizeStore(new Map(), new Map([["sponsor-over", 1356], ["sponsor-under", 500]])),
    });
    expect(enqueued).toEqual(["u"]);
  });

  it("still measures every repository, including an excluded sponsor's, so the decision reads fresh sizes", async () => {
    const rows = new Map<string, RepositorySizeRow>();
    const measured: string[] = [];
    await sweepReconciliations({
      listActiveRepositorySponsors: async () => [
        { repositoryId: "d", sponsorId: "sponsor-over" },
        { repositoryId: "u", sponsorId: "sponsor-under" },
      ],
      enqueue: async () => undefined,
      now: () => at,
      sizeStore: memorySizeStore(rows, new Map([["sponsor-over", 1356], ["sponsor-under", 500]])),
      measureSize: async (repositoryId) => {
        measured.push(repositoryId);
        return 1356;
      },
    });
    // An unmeasured backlog reads as zero, so skipping the excluded sponsor's
    // measure would silently return it to the rotation.
    expect(measured).toEqual(["d", "u"]);
  });
});
