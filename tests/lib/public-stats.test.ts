import { describe, expect, it, vi } from "vitest";
import type { DashboardSql } from "@/lib/dashboard/queries";
import { createOwnerProgressReader, createSettledWorkReader } from "@/lib/public-stats";

const progressRow = (starts: string) => [{
  repositories: "2", github_repositories: "1", gitlab_repositories: "1", listed_issue: "1",
  contributor_reviewed: "1", listed_second_issue: "1", attempts: { REGISTRATION_START: starts },
}];

describe("owner progress cache", () => {
  it("reuses a reading until the settled-work refresh boundary", async () => {
    let time = 100_000;
    const query = vi.fn().mockResolvedValueOnce(progressRow("2")).mockResolvedValueOnce(progressRow("4"));
    const read = createOwnerProgressReader({ sql: query as unknown as DashboardSql, now: () => time });
    expect((await read()).registrationStarts).toBe(2);
    time += 599_999;
    expect((await read()).registrationStarts).toBe(2);
    expect(query).toHaveBeenCalledTimes(1);
    time += 1;
    expect((await read()).registrationStarts).toBe(4);
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight reading between callers", async () => {
    let resolve!: (rows: ReturnType<typeof progressRow>) => void;
    const pending = new Promise<ReturnType<typeof progressRow>>((done) => { resolve = done; });
    const query = vi.fn().mockReturnValue(pending);
    const read = createOwnerProgressReader({ sql: query as unknown as DashboardSql });
    const first = read();
    const second = read();
    expect(query).toHaveBeenCalledTimes(1);
    resolve(progressRow("8"));
    expect((await Promise.all([first, second])).map((result) => result.registrationStarts)).toEqual([8, 8]);
  });

  it("retries after a failed initial read or refresh", async () => {
    let time = 100_000;
    const query = vi.fn().mockRejectedValueOnce(new Error("unavailable"))
      .mockResolvedValueOnce(progressRow("3")).mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce(progressRow("4"));
    const read = createOwnerProgressReader({ sql: query as unknown as DashboardSql, now: () => time });
    await expect(read()).rejects.toThrow("unavailable");
    expect((await read()).registrationStarts).toBe(3);
    time += 600_000;
    await expect(read()).rejects.toThrow("refresh failed");
    expect((await read()).registrationStarts).toBe(4);
    expect(query).toHaveBeenCalledTimes(4);
  });
});

type SettledRow = { pull_requests: string; contributors: string; points: string; no_round_pull_requests: string; mean_review_rounds: string | null };

describe("settled work cache", () => {
  it("reuses a reading until the ten-minute boundary, then reads again", async () => {
    let time = Date.parse("2026-10-27T12:00:00Z");
    const query = vi.fn()
      .mockResolvedValueOnce([{ pull_requests: "3", contributors: "2", points: "12", no_round_pull_requests: "1", mean_review_rounds: "0.5" }])
      .mockResolvedValueOnce([{ pull_requests: "4", contributors: "3", points: "16", no_round_pull_requests: "1", mean_review_rounds: "0.5" }]);
    const read = createSettledWorkReader({ sql: query as unknown as DashboardSql, now: () => time });

    expect(await read()).toEqual({ pullRequests: 3, contributors: 2, points: 12, noRoundPullRequests: 1, meanReviewRounds: 0.5, readAt: new Date(time) });
    time += 599_999;
    expect(await read()).toEqual({ pullRequests: 3, contributors: 2, points: 12, noRoundPullRequests: 1, meanReviewRounds: 0.5, readAt: new Date(time - 599_999) });
    expect(query).toHaveBeenCalledTimes(1);
    time += 1;
    expect(await read()).toEqual({ pullRequests: 4, contributors: 3, points: 16, noRoundPullRequests: 1, meanReviewRounds: 0.5, readAt: new Date(time) });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it("shares an in-flight refresh among concurrent callers", async () => {
    let time = 100_000;
    let resolve!: (rows: SettledRow[]) => void;
    const pending = new Promise<SettledRow[]>((done) => { resolve = done; });
    const query = vi.fn()
      .mockResolvedValueOnce([{ pull_requests: "1", contributors: "1", points: "3", no_round_pull_requests: "1", mean_review_rounds: "0.5" }])
      .mockReturnValue(pending);
    const read = createSettledWorkReader({ sql: query as unknown as DashboardSql, now: () => time });
    await read();
    time += 600_000;
    const first = read();
    const second = read();
    await Promise.resolve();
    expect(query).toHaveBeenCalledTimes(2);
    resolve([{ pull_requests: "7", contributors: "5", points: "11", no_round_pull_requests: "1", mean_review_rounds: "0.5" }]);
    expect(await Promise.all([first, second])).toEqual([
      { pullRequests: 7, contributors: 5, points: 11, noRoundPullRequests: 1, meanReviewRounds: 0.5, readAt: new Date(700_000) },
      { pullRequests: 7, contributors: 5, points: 11, noRoundPullRequests: 1, meanReviewRounds: 0.5, readAt: new Date(700_000) },
    ]);
  });

  it("propagates a failure and retries on the next call", async () => {
    const query = vi.fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce([{ pull_requests: "2", contributors: "1", points: "9", no_round_pull_requests: "1", mean_review_rounds: "0.5" }]);
    const read = createSettledWorkReader({ sql: query as unknown as DashboardSql, now: () => 200_000 });

    await expect(read()).rejects.toThrow("database unavailable");
    expect(await read()).toEqual({ pullRequests: 2, contributors: 1, points: 9, noRoundPullRequests: 1, meanReviewRounds: 0.5, readAt: new Date(200_000) });
    expect(query).toHaveBeenCalledTimes(2);

    let time = 200_000;
    const refreshQuery = vi.fn()
      .mockResolvedValueOnce([{ pull_requests: "1", contributors: "1", points: "3", no_round_pull_requests: "1", mean_review_rounds: "0.5" }])
      .mockRejectedValueOnce(new Error("refresh failed"))
      .mockResolvedValueOnce([{ pull_requests: "2", contributors: "1", points: "9", no_round_pull_requests: "1", mean_review_rounds: "0.5" }]);
    const refresh = createSettledWorkReader({ sql: refreshQuery as unknown as DashboardSql, now: () => time });
    await refresh();
    time += 600_000;
    await expect(refresh()).rejects.toThrow("refresh failed");
    expect(await refresh()).toEqual({ pullRequests: 2, contributors: 1, points: 9, noRoundPullRequests: 1, meanReviewRounds: 0.5, readAt: new Date(time) });
    expect(refreshQuery).toHaveBeenCalledTimes(3);
  });

  it("reads the no-round count and the per-pull-request mean, and no mean without a settled pull request", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce([{ pull_requests: "7", contributors: "3", points: "20", no_round_pull_requests: "5", mean_review_rounds: "0.42857142857142857143" }])
      .mockResolvedValueOnce([{ pull_requests: "0", contributors: "0", points: "0", no_round_pull_requests: "0", mean_review_rounds: null }]);
    let time = 100_000;
    const read = createSettledWorkReader({ sql: query as unknown as DashboardSql, now: () => time });
    expect(await read()).toEqual({
      pullRequests: 7, contributors: 3, points: 20, noRoundPullRequests: 5, meanReviewRounds: expect.closeTo(3 / 7, 10), readAt: new Date(time),
    });
    time += 600_000;
    expect(await read()).toEqual({ pullRequests: 0, contributors: 0, points: 0, noRoundPullRequests: 0, meanReviewRounds: null, readAt: new Date(time) });
  });

  it("refuses a mean that is neither a number nor absent", async () => {
    const query = vi.fn().mockResolvedValue([{ pull_requests: "1", contributors: "1", points: "2", no_round_pull_requests: "0", mean_review_rounds: "not a mean" }]);
    await expect(createSettledWorkReader({ sql: query as unknown as DashboardSql })()).rejects.toThrow("Mean review rounds was not a number.");
  });
});
