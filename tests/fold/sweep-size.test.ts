import { describe, expect, it } from "vitest";
import {
  PostgresRepositorySizeStore,
  REPOSITORY_SIZE_REMEASURE_MS,
  type RepositorySizeRow,
} from "@/lib/fold/repository-size";
import { sweepReconciliations } from "@/lib/fold/sweep";

/**
 * The sweep's repository size measure (issue 1360): the count read is NOT the
 * list query. At this layer the measure dependency stands in for the forge
 * count read; the request-shape pins (count-only, closed items included) live
 * on the forge client suites that drive the real gateways.
 */

const at = new Date("2030-01-01T00:00:00Z");

function memorySizeStore(rows: Map<string, RepositorySizeRow>): Pick<PostgresRepositorySizeStore, "get" | "store"> {
  return {
    get: async (repositoryId) => rows.get(repositoryId) ?? null,
    store: async (repositoryId, totalCount, measuredAt) => {
      rows.set(repositoryId, { totalCount, measuredAt });
    },
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
      listActiveRepositoryIds: async () => ["stale", "fresh"],
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
      listActiveRepositoryIds: async () => ["new"],
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

  it("fails a null measure softly: the previous size stands and the failure is counted and reported", async () => {
    const rows = new Map<string, RepositorySizeRow>();
    const staleAt = new Date(at.getTime() - 2 * REPOSITORY_SIZE_REMEASURE_MS);
    rows.set("repo", { totalCount: 500, measuredAt: staleAt });
    const reported: string[] = [];
    const summary = await sweepReconciliations({
      listActiveRepositoryIds: async () => ["repo"],
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
      listActiveRepositoryIds: async () => ["repo"],
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
      listActiveRepositoryIds: async () => ["broken"],
      enqueue: async () => undefined,
      now: () => at,
      sizeStore: {
        get: async (repositoryId) => rows.get(repositoryId) ?? null,
        store: async () => { throw new Error("sizes table unavailable"); },
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
      listActiveRepositoryIds: async () => ["repo"],
      enqueue: async (repositoryId) => { enqueued.push(repositoryId); },
      now: () => at,
    });
    expect(enqueued).toEqual(["repo"]);
    expect("measured" in summary).toBe(false);
    expect("measureFailed" in summary).toBe(false);
    expect(summary).toEqual({ attempted: 1, enqueued: 1, failed: 0 });
  });
});
