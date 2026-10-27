import { describe, expect, it, vi } from "vitest";
import type { DashboardSql } from "@/lib/dashboard/queries";
import { createSettledWorkReader } from "@/lib/public-stats";

describe("settled work cache", () => {
  it("reuses a reading until the ten-minute boundary, then reads again", async () => {
    let time = Date.parse("2026-10-27T12:00:00Z");
    const query = vi.fn()
      .mockResolvedValueOnce([{ pull_requests: "3", contributors: "2", points: "12" }])
      .mockResolvedValueOnce([{ pull_requests: "4", contributors: "3", points: "16" }]);
    const read = createSettledWorkReader({ sql: query as unknown as DashboardSql, now: () => time });

    expect(await read()).toEqual({ pullRequests: 3, contributors: 2, points: 12, readAt: new Date(time) });
    time += 599_999;
    expect(await read()).toEqual({ pullRequests: 3, contributors: 2, points: 12, readAt: new Date(time - 599_999) });
    expect(query).toHaveBeenCalledTimes(1);
    time += 1;
    expect(await read()).toEqual({ pullRequests: 4, contributors: 3, points: 16, readAt: new Date(time) });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight refresh among concurrent callers", async () => {
    let time = 100_000;
    let resolve!: (rows: { pull_requests: string; contributors: string; points: string }[]) => void;
    const pending = new Promise<{ pull_requests: string; contributors: string; points: string }[]>((done) => { resolve = done; });
    const query = vi.fn()
      .mockResolvedValueOnce([{ pull_requests: "1", contributors: "1", points: "3" }])
      .mockReturnValue(pending);
    const read = createSettledWorkReader({ sql: query as unknown as DashboardSql, now: () => time });
    await read();
    time += 600_000;
    const first = read();
    const second = read();
    await Promise.resolve();
    expect(query).toHaveBeenCalledTimes(2);
    resolve([{ pull_requests: "7", contributors: "5", points: "11" }]);
    expect(await Promise.all([first, second])).toEqual([
      { pullRequests: 7, contributors: 5, points: 11, readAt: new Date(700_000) },
      { pullRequests: 7, contributors: 5, points: 11, readAt: new Date(700_000) },
    ]);
  });

  it("propagates a failure and retries on the next call", async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce([{ pull_requests: "2", contributors: "1", points: "9" }]);
    const read = createSettledWorkReader({ sql: query as unknown as DashboardSql, now: () => 200_000 });

    await expect(read()).rejects.toThrow("database unavailable");
    expect(await read()).toEqual({ pullRequests: 2, contributors: 1, points: 9, readAt: new Date(200_000) });
    expect(query).toHaveBeenCalledTimes(2);

    let time = 200_000;
    const refreshQuery = vi.fn()
      .mockResolvedValueOnce([{ pull_requests: "1", contributors: "1", points: "3" }])
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce([{ pull_requests: "2", contributors: "1", points: "9" }]);
    const refresh = createSettledWorkReader({ sql: refreshQuery as unknown as DashboardSql, now: () => time });
    await refresh();
    time += 600_000;
    await expect(refresh()).rejects.toThrow("refresh failed");
    expect(await refresh()).toEqual({ pullRequests: 2, contributors: 1, points: 9, readAt: new Date(time) });
    expect(refreshQuery).toHaveBeenCalledTimes(3);
  });
});
