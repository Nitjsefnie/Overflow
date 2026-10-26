import { describe, expect, it, vi } from "vitest";
import { SweepBudgetSpent } from "@/lib/fold/sweep-request-budget";
import { fixture, instant, pullRequest, subject } from "./reconciliation-walk-fixture";

describe("last-update reconciliation walk", () => {
  it("resumes at the committed anchor without gathering earlier subjects again", async () => {
    const f = fixture([1, 2, 3, 4].map((id) => subject(id)));
    await expect(f.window(3)).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect(f.pass.walkAnchors().subjects).toEqual({ updatedAt: instant(2), key: 2 });
    expect((await f.window(20)).issues.map(({ id }) => id)).toEqual([1, 2, 3, 4]);
    expect(f.listed[1]).toEqual({ since: instant(2).toISOString(), cursor: null });
    expect([...f.counts]).toEqual([[1, 1], [2, 1], [3, 1], [4, 1]]);
    expect(f.pass.read).not.toHaveBeenCalled();
    expect(f.pass.write).not.toHaveBeenCalled();
  });

  it("gathers an unstaged timestamp tie behind the anchor and skips staged repeats across pages", async () => {
    const f = fixture([subject(3, "issue", 1), subject(1, "issue", 1), subject(2, "issue", 1)], 2);
    f.listing.listPage = async ({ cursor }) => f.read(`ties:${cursor}`, () => cursor === null
      ? { subjects: [f.live.get(3)!, f.live.get(1)!], nextCursor: "second" }
      : { subjects: [f.live.get(1)!, f.live.get(2)!], nextCursor: null });
    expect((await f.window(30)).issues.map(({ id }) => id).sort()).toEqual([1, 2, 3]);
    expect([...f.counts].sort()).toEqual([[1, 1], [2, 1], [3, 1]]);
  });

  it("gathers a subject updated during the walk again before returning the document", async () => {
    const f = fixture([subject(1), subject(2)]);
    f.onGather((id) => {
      if (id !== 2) return;
      f.live.get(1)!.updatedAt = instant(10);
      Object.assign(f.issues.get(1)!, { updatedAt: instant(10).toISOString(), title: "Updated during walk" });
    });
    const result = await f.window(20);
    expect(result.issues.find(({ id }) => id === 1)?.title).toBe("Updated during walk");
    expect(f.counts.get(1)).toBe(2);
  });

  it("gathers unstaged ties behind the resume anchor before attempting completion", async () => {
    const f = fixture([subject(3, "issue", 1), subject(1, "issue", 1), subject(2, "issue", 1)]);
    f.listing.listPage = async () => f.read("ties", () => ({ subjects: [f.live.get(3)!, f.live.get(1)!, f.live.get(2)!], nextCursor: null }));
    await expect(f.window(2)).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect(f.pass.walkAnchors().subjects).toEqual({ updatedAt: instant(1), key: 3 });
    await expect(f.window(2)).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect((await f.pass.readStaged()).map(({ subjectKey }) => subjectKey)).toEqual([3, 1]);
    expect(f.counts.get(3)).toBe(1);
    expect(f.counts.get(1)).toBe(1);
  });

  it("gathering a newly closed PR refreshes the issue it closes", async () => {
    const f = fixture([subject(1), subject(2, "pull_request")]);
    f.gateway.getPullRequestClosingIssues = (pr) => f.read(`closing:${pr.id}`, () => {
      f.issues.get(1)!.closingPullRequests = [pullRequest(2)];
      return [{ id: 1, number: 1, repositoryGitHubId: 42 }];
    });
    const result = await f.window(30);
    expect(result.issues[0]?.closingPullRequests).toEqual([{ ...pullRequest(2), reviews: [], rawDiff: "diff 2" }]);
    expect(f.counts.get(1)).toBe(2);
    expect(result.pullRequests).toEqual([{ id: 2, reviews: [], rawDiff: "diff 2" }]);
    expect((await f.pass.readStaged()).find(({ kind }) => kind === "issue")?.payload).toMatchObject({ closingPullRequests: [pullRequest(2)] });
  });

  it("removes a subject deleted after its gather from staging and the fold document", async () => {
    const f = fixture([subject(1), subject(2)]);
    f.onGather((id) => { if (id === 2) f.live.delete(1); });
    const result = await f.window(20);
    expect(result.issues.map(({ id }) => id)).toEqual([2]);
    expect((await f.pass.readStaged()).map(({ subjectKey }) => subjectKey)).toEqual([2]);
    expect(f.pass.deleteStaged).toHaveBeenCalledWith([{ kind: "issue", subjectKey: 1 }]);
  });

  it("returns no fold document and invokes no materialization while held", async () => {
    const f = fixture([subject(1), subject(2)]);
    const materialize = vi.fn();
    let document: unknown;
    const run = async () => { document = await f.window(2); materialize(document); };
    await expect(run()).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect(document).toBeUndefined();
    expect(materialize).not.toHaveBeenCalled();
    expect(f.pass.complete).not.toHaveBeenCalled();
    expect(await f.pass.readStaged()).toHaveLength(1);
  });

  it("completes a repository beyond 1000 subjects over many small budget windows", async () => {
    const f = fixture(Array.from({ length: 1005 }, (_, i) => subject(i + 1)), 50);
    let windows = 0;
    let result;
    for (; windows < 100; windows += 1) {
      try { result = await f.window(50); break; }
      catch (error) { if (!(error instanceof SweepBudgetSpent)) throw error; }
    }
    expect(windows).toBeGreaterThan(10);
    expect(result?.issues).toHaveLength(1005);
    expect([...f.counts.values()]).toEqual(Array(1005).fill(1));
  });

  it("does not advance the anchor over a failed staging transaction", async () => {
    const f = fixture([subject(1), subject(2), subject(3)]);
    const stage = f.pass.stage;
    let failed = false;
    f.pass.stage = async (input) => {
      if (input.subjectKey === 2 && !failed) { failed = true; throw new Error("Staging commit failed"); }
      await stage(input);
    };
    await expect(f.window(20)).rejects.toThrow("Staging commit failed");
    expect(failed).toBe(true);
    expect(f.pass.walkAnchors().subjects).toEqual({ updatedAt: instant(1), key: 1 });
    expect((await f.pass.readStaged()).map(({ subjectKey }) => subjectKey)).toEqual([1]);
    expect((await f.window(20)).issues).toHaveLength(3);
    expect([...f.counts]).toEqual([[1, 1], [2, 2], [3, 1]]);
  });

  it("restarts completion correctly after a hold during the absence sweep", async () => {
    const f = fixture([subject(1), subject(2)]);
    await expect(f.window(3)).rejects.toBeInstanceOf(SweepBudgetSpent);
    f.live.delete(1);
    expect((await f.window(20)).issues.map(({ id }) => id)).toEqual([2]);
    expect((await f.window(20)).issues.map(({ id }) => id)).toEqual([2]);
    expect(f.counts.get(2)).toBe(1);
  });
});
