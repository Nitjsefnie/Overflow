import { describe, expect, it } from "vitest";
import { SweepBudgetSpent } from "@/lib/fold/sweep-request-budget";
import { StagedPassDataUnreadable } from "@/lib/fold/sweep-pass";
import { GitHubApiError, GitHubGraphqlInvalidResponseError, GitHubGraphqlRequestError } from "@/lib/github/errors";
import { GitHubResponseTooLargeError } from "@/lib/github/response-text";
import { GitLabApiError } from "@/lib/gitlab/api-error";
import { fixture, instant, pullRequest, subject } from "./reconciliation-walk-fixture";

describe("reconciliation walk completion", () => {
  it("retains a live staged issue when an update shifts absence pages", async () => {
    const f = fixture(Array.from({ length: 102 }, (_, i) => subject(i + 1)));
    for (const fact of f.issues.values()) await f.pass.stage({ anchor: "subjects", kind: "issue", subjectKey: fact.id, updatedAt: new Date(fact.updatedAt), payload: fact });
    f.issues.get(101)!.title = "Fresh witness for the omitted issue";
    const listPage = f.listing.listPage;
    f.listing.listPage = async (options) => {
      if (options.since === undefined && options.cursor === "100") { f.live.get(1)!.updatedAt = instant(200); f.issues.get(1)!.updatedAt = instant(200).toISOString(); }
      return listPage(options);
    };
    const result = await f.window(300);
    expect(f.live.has(101)).toBe(true);
    expect(result.issues.map(({ id }) => id).sort((a, b) => a - b)).toEqual(Array.from({ length: 102 }, (_, i) => i + 1));
    expect(result.issues.find(({ id }) => id === 101)?.title).toBe("Fresh witness for the omitted issue");
    expect(f.lookups).toContainEqual({ kind: "issue", id: 101, number: 101 });
    expect((await f.pass.readStaged()).find(({ subjectKey }) => subjectKey === 101)?.payload).toMatchObject({ title: "Fresh witness for the omitted issue" });
    expect(f.pass.deleteStaged).not.toHaveBeenCalledWith([{ kind: "issue", subjectKey: 101 }]);
  });

  it("resumes the absence listing after every held run's record", async () => {
    const f = fixture(Array.from({ length: 6 }, (_, i) => subject(i + 1)), 1);
    for (const fact of f.issues.values()) await f.pass.stage({ anchor: "subjects", kind: "issue", subjectKey: fact.id, updatedAt: new Date(fact.updatedAt), payload: fact });
    // Each budget of 3 spends the walk page and two absence pages; resuming after both records needs the walk page and four.
    for (const budget of [3, 3]) await expect(f.window(budget)).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect((await f.window(5)).issues).toHaveLength(6);
    for (const record of [{}, [{ ...f.live.get(1), anchor: "subjects" }]]) { await f.pass.write("absence-listing:2", record); await expect(f.window(5)).rejects.toBeInstanceOf(StagedPassDataUnreadable); }
  });

  it.each(["null", "404"] as const)("carries omitted subjects' lookups across holds, deleting only those confirmed %s absent", async (answer) => {
    const f = fixture([...Array.from({ length: 20 }, (_, i) => subject(i + 1)), subject(502, "pull_request")]), gather = f.gateway.gatherIssue;
    for (const fact of f.issues.values()) await f.pass.stage({ anchor: "subjects", kind: "issue", subjectKey: fact.id, updatedAt: new Date(fact.updatedAt), payload: fact });
    await f.pass.stage({ anchor: "subjects", kind: "pull_request", subjectKey: 502, updatedAt: instant(502), payload: { subject: { id: 502, number: 502 }, evidence: { reviews: [], rawDiff: "old evidence" } } });
    for (let id = 11; id <= 20; id++) { f.live.delete(id); if (id <= 15) f.issues.delete(id); }
    f.live.delete(502); f.pullRequests.delete(502);
    if (answer === "404") f.gateway.gatherIssue = (row) => f.issues.has(row.id) ? gather(row) : f.read(`issue:${row.id}`, () => { throw new GitHubApiError(404); });
    if (answer === "404") f.gateway.getPullRequest = (row) => f.read(`pull_request:${row.id}`, () => { throw new GitLabApiError(404); });
    // Each budget of 6 spends the walk page and an absence page before four of the eleven lookups.
    for (const held of [1, 2]) await expect(f.window(6), `hold ${held}`).rejects.toBeInstanceOf(SweepBudgetSpent);
    const kept = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 16, 17, 18, 19, 20];
    expect([(await f.window(6)).issues.map(({ id }) => id), (await f.pass.readStaged()).map(({ subjectKey }) => subjectKey)]).toEqual([kept, kept]);
    expect(f.requests.filter((key) => /^(issue|pull_request):/.test(key))).toEqual([...Array.from({ length: 10 }, (_, i) => `issue:${i + 11}`), "pull_request:502"]);
  });

  it.each(["issue", "pull_request"] as const)("retains an omitted %s and rejects completion on a transient lookup failure", async (kind) => {
    const f = fixture([subject(1), subject(2), subject(502, "pull_request")]);
    for (const fact of f.issues.values()) await f.pass.stage({ anchor: "subjects", kind: "issue", subjectKey: fact.id, updatedAt: new Date(fact.updatedAt), payload: fact });
    await f.pass.stage({ anchor: "subjects", kind: "pull_request", subjectKey: 502, updatedAt: instant(502), payload: { subject: { id: 502, number: 502 }, evidence: { reviews: [], rawDiff: "old evidence" } } });
    const [id, failure] = kind === "issue" ? [1, new GitHubApiError(503)] : [502, new GitLabApiError(503)];
    f.live.delete(id);
    if (kind === "issue") f.gateway.gatherIssue = (row) => f.read(`issue:${row.id}`, () => { throw failure; });
    else f.gateway.getPullRequest = (row) => f.read(`pull_request:${row.id}`, () => { throw failure; });
    const before = await f.pass.readStaged();
    let document: unknown;
    await expect((async () => { document = await f.window(20); })()).rejects.toBe(failure);
    expect(document).toBeUndefined();
    expect(await f.pass.readStaged()).toEqual(before);
    expect(f.requests).toContain(`${kind}:${id}`);
    expect(f.pass.deleteStaged).not.toHaveBeenCalled();
  });

  it("uses a PR lookup and its stored number to repair an omitted live PR", async () => {
    const pr = { ...subject(502, "pull_request"), number: 7 }, f = fixture([subject(1), pr]);
    await expect(f.window(5)).rejects.toBeInstanceOf(SweepBudgetSpent);
    f.live.delete(pr.id);
    f.gateway.getPullRequestDiff = (row) => f.read(`diff:${row.id}`, () => "Refreshed after omission");
    expect((await f.window(30)).issues.map(({ id }) => id)).toEqual([1]);
    expect(f.lookups.filter(({ kind }) => kind === "pull_request")).toEqual([{ kind: "pull_request", id: 502, number: 7 }]);
    expect(f.lookups.filter(({ kind, id }) => kind === "issue" && id === 502)).toEqual([]);
    expect((await f.pass.readStaged()).find(({ kind }) => kind === "pull_request")?.payload).toMatchObject({ evidence: { rawDiff: "Refreshed after omission" } });
    expect(f.pass.deleteStaged).not.toHaveBeenCalledWith([{ kind: "pull_request", subjectKey: pr.id }]);
  });

  it("resumes a mid-refresh hold without rereading completed PRs", async () => {
    const f = fixture([subject(1)]);
    f.issues.get(1)!.closingPullRequests = [pullRequest(8), pullRequest(9)];
    await expect(f.window(6)).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect(f.requests).toEqual([expect.stringContaining("list:"), "issue:1", expect.stringContaining("list:"), "reviews:8", "diff:8", "reviews:9"]);
    expect(f.pass.walkAnchors().refresh).toEqual({ updatedAt: f.pass.scanStartedAt, key: 8 });
    f.gateway.getPullRequestReviews = (pr) => f.read(`reviews:${pr.id}`, () => [{ id: 19, state: "APPROVED", submittedAt: instant(40).toISOString(), dismissal: null }]);
    f.gateway.getPullRequestDiff = (pr) => f.read(`diff:${pr.id}`, () => "fresh diff after hold");
    const result = await f.window(20);
    expect(result.issues[0]?.closingPullRequests[0]).toMatchObject({ id: 8, reviews: [], rawDiff: "diff 8" });
    expect(result.issues[0]?.closingPullRequests[1]).toMatchObject({ id: 9, reviews: [{ id: 19, state: "APPROVED" }], rawDiff: "fresh diff after hold" });
    expect(result.pullRequests).toEqual([{ id: 8, reviews: [], rawDiff: "diff 8" }, { id: 9, reviews: [{ id: 19, state: "APPROVED", submittedAt: instant(40).toISOString(), dismissal: null }], rawDiff: "fresh diff after hold" }]);
    expect(f.counts.get(1)).toBe(1);
    expect(["reviews:8", "diff:8", "reviews:9", "diff:9"].map((read) => f.requests.filter((key) => key === read).length)).toEqual([1, 1, 2, 1]);
    expect(f.pass.complete).not.toHaveBeenCalled();
  });

  it("returns the uninterrupted document after resuming a committed PR refresh", async () => {
    const setup = () => { const f = fixture([subject(1)]); f.issues.get(1)!.closingPullRequests = [pullRequest(8), pullRequest(9), pullRequest(10)]; return f; };
    const f = setup();
    await expect(f.window(5)).rejects.toBeInstanceOf(SweepBudgetSpent);
    const result = await f.window(20);
    expect(result).toEqual(await setup().window(20));
    for (const id of [8, 9, 10]) for (const read of ["reviews", "diff"]) expect(f.requests.filter((key) => key === `${read}:${id}`)).toHaveLength(1);
  });

  it("completes a large repository's PR refresh across three tiny budget windows", async () => {
    const setup = async () => {
      const f = fixture(Array.from({ length: 1005 }, (_, i) => subject(i + 1)));
      f.issues.get(1)!.closingPullRequests = Array.from({ length: 6 }, (_, i) => pullRequest(2001 + i));
      // Start at completion with the main walk's real staging shape and anchor.
      for (const issue of f.issues.values()) await f.pass.stage({ anchor: "subjects", kind: "issue", subjectKey: issue.id, updatedAt: new Date(issue.updatedAt), payload: issue });
      return f;
    };
    // 12 requests list the walk page and all 11 absence pages, then 2 resume both listings before 5 refreshes.
    const f = await setup();
    await expect(f.window(12)).rejects.toBeInstanceOf(SweepBudgetSpent);
    await expect(f.window(12)).rejects.toBeInstanceOf(SweepBudgetSpent);
    const result = await f.window(12);
    expect(result).toEqual(await (await setup()).window(100));
    expect(result.issues).toHaveLength(1005);
    for (let id = 2001; id <= 2006; id += 1) for (const read of ["reviews", "diff"]) expect(f.requests.filter((key) => key === `${read}:${id}`)).toHaveLength(1);
    expect(f.pass.walkAnchors().refresh).toEqual({ updatedAt: f.pass.scanStartedAt, key: 2006 });
  });

  it("retains a missing-dispute refresh outcome across a later hold", async () => {
    const f = fixture([subject(1)]);
    f.issues.get(1)!.closingPullRequests = [pullRequest(10)];
    f.repository.disputePullRequests = [{ id: 9, number: 9 }];
    f.gateway.getPullRequestDiff = (pr) => f.read(`diff:${pr.id}`, () => { if (pr.id === 9) throw new GitHubApiError(404); return "surviving PR"; });
    await expect(f.window(5)).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect(f.pass.walkAnchors().refresh?.key).toBe(9);
    const result = await f.window(20);
    expect(result.missingDisputePrIds).toEqual(new Set([9]));
    expect(result.pullRequests.map(({ id }) => id)).toEqual([10]);
    expect(f.requests.filter((key) => key === "diff:9")).toHaveLength(1);
    expect(f.discarded).toHaveLength(1);
  });

  it("advances refresh progress only after the refreshed PR staging commits", async () => {
    const f = fixture([subject(1)]);
    f.issues.get(1)!.closingPullRequests = [pullRequest(8), pullRequest(9)];
    const stage = f.pass.stage;
    let failed = false;
    f.pass.stage = async (row) => { if (row.anchor === "refresh" && row.subjectKey === 9 && !failed) { failed = true; throw new Error("Refresh staging failed"); }
      return stage(row); };
    await expect(f.window(20)).rejects.toThrow("Refresh staging failed");
    expect(failed).toBe(true);
    expect(f.pass.walkAnchors().refresh?.key).toBe(8);
    expect((await f.window(20)).pullRequests).toHaveLength(2);
    expect(["diff:8", "diff:9"].map((read) => f.requests.filter((key) => key === read).length)).toEqual([1, 2]);
  });

  it("refreshes a newly referenced PR behind the saved refresh anchor", async () => {
    const f = fixture([subject(1)]);
    f.issues.get(1)!.closingPullRequests = [pullRequest(9), pullRequest(10)];
    await expect(f.window(5)).rejects.toBeInstanceOf(SweepBudgetSpent);
    f.live.get(1)!.updatedAt = instant(20);
    Object.assign(f.issues.get(1)!, { updatedAt: instant(20).toISOString(), closingPullRequests: [pullRequest(8), pullRequest(9), pullRequest(10)] });
    const result = await f.window(20);
    expect(result.pullRequests.map(({ id }) => id)).toEqual([8, 9, 10]);
    expect(["diff:8", "diff:9"].map((read) => f.requests.filter((key) => key === read).length)).toEqual([1, 1]);
  });

  it("looks up a refreshed listed PR the listing omits once the record that listed it is lost", async () => {
    const f = fixture([subject(1), subject(2, "pull_request"), subject(3, "pull_request")]);
    f.issues.get(1)!.closingPullRequests = [pullRequest(2), pullRequest(3)]; f.repository.disputePullRequests = [{ id: 2, number: 2 }];
    await expect(f.window(13)).rejects.toBeInstanceOf(SweepBudgetSpent);
    // A page ceiling can drop the absence record; PR 2's refreshed row still says listed.
    await f.pass.write("absence-listing:0", []);
    f.live.delete(2); f.pullRequests.delete(2);
    f.gateway.getPullRequestReviews = (pr) => f.read(`reviews:${pr.id}`, () => { if (pr.id === 2) throw new GitHubApiError(404); return []; });
    const result = await f.window(20);
    expect([result.pullRequests.map(({ id }) => id), result.missingDisputePrIds]).toEqual([[3], new Set([2])]);
    expect(f.requests.filter((key) => /^(pull_request|reviews):2$/.test(key))).toEqual(["reviews:2", "reviews:2", "pull_request:2", "reviews:2"]);
  });

  it("restores a definitive missing result when a refreshed reference becomes disputed", async () => {
    const f = fixture([subject(1)]);
    f.issues.get(1)!.closingPullRequests = [pullRequest(9), pullRequest(10)];
    f.gateway.getPullRequestDiff = (pr) => f.read(`diff:${pr.id}`, () => { if (pr.id === 9) throw new GitHubApiError(404); return "surviving PR"; });
    await expect(f.window(5)).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect(f.discarded[0]?.reason).toBe("NOT_FOUND");
    f.repository.disputePullRequests = [{ id: 9, number: 9 }];
    const result = await f.window(20);
    expect(result.missingDisputePrIds).toEqual(new Set([9]));
    expect(result.pullRequests.map(({ id }) => id)).toEqual([10]);
    expect(f.requests.filter((key) => key === "diff:9")).toHaveLength(1);
  });

  it("refreshes only eligible local references and disputes, deduplicating their evidence", async () => {
    const f = fixture([subject(1), subject(2, "pull_request")]);
    f.issues.get(1)!.closingPullRequests = [pullRequest(9), pullRequest(10, 43), { ...pullRequest(11), state: "OPEN" },
      { ...pullRequest(12), mergedAt: null }, { ...pullRequest(13), state: "CLOSED", mergedAt: null }];
    f.repository.disputePullRequests = [{ id: 9, number: 9 }, { id: 14, number: 14 }];
    const result = await f.window(40);
    expect(result.pullRequests.map(({ id }) => id)).toEqual([9, 13, 14]);
    expect(f.requests.filter((key) => /^(reviews|diff):/.test(key))).toEqual(["reviews:2", "diff:2", "reviews:9", "diff:9", "reviews:13", "diff:13", "reviews:14", "diff:14"]);
    expect(result.missingDisputePrIds).toEqual(new Set());
  });

  it("refreshes an old closing issue when a PR removes its closing reference", async () => {
    const f = fixture([subject(1), subject(2, "pull_request")]);
    f.issues.get(1)!.closingPullRequests = [pullRequest(2)];
    f.gateway.getPullRequestClosingIssues = (pr) => f.read(`closing:${pr.id}`, () => { f.issues.get(1)!.closingPullRequests = []; return []; });
    const result = await f.window(30);
    expect(result.issues[0]?.closingPullRequests).toEqual([]);
    expect(f.counts.get(1)).toBe(2);
    expect(result.pullRequests).toEqual([]);
  });

  it("keeps related-issue refreshes from advancing a listing stream past ungathered subjects", async () => {
    const f = fixture([subject(1, "pull_request"), subject(2), subject(3)]);
    f.gateway.getPullRequestClosingIssues = (pr) => f.read(`closing:${pr.id}`, () => [{ id: 3, number: 3, repositoryGitHubId: 42 }]);
    await expect(f.window(5)).rejects.toBeInstanceOf(SweepBudgetSpent);
    expect(f.pass.walkAnchors().subjects).toEqual({ updatedAt: instant(1), key: 1 });
    const result = await f.window(40);
    expect(result.issues.map(({ id }) => id).sort()).toEqual([2, 3]);
    expect(f.counts.get(2)).toBe(1);
  });

  it.each([
    ["GitHub missing", () => new GitHubApiError(404), "NOT_FOUND", true],
    ["GitLab missing", () => new GitLabApiError(404), "NOT_FOUND", true],
    ["GraphQL missing repository", () => new GitHubGraphqlRequestError("GitHub GraphQL request failed. NOT_FOUND: Could not resolve to a Repository named owner/repo", false, null, 200), "NOT_FOUND", true],
    ["diff too large", () => new GitHubApiError(406), "DIFF_TOO_LARGE", false],
    ["response too large", () => new GitHubResponseTooLargeError(12), "RESPONSE_TOO_LARGE", false],
  ] as const)("discards only the %s dispute failure", async (_name, failure, reason, missing) => {
    const f = fixture([subject(1)]);
    f.repository.disputePullRequests = [{ id: 9, number: 9 }];
    f.gateway.getPullRequestDiff = (pr) => f.read(`diff:${pr.id}`, () => { throw failure(); });
    const result = await f.window(20);
    expect(result.issues).toHaveLength(1);
    expect(result.pullRequests).toEqual([]);
    expect(result.missingDisputePrIds).toEqual(new Set(missing ? [9] : []));
    expect(f.discarded).toEqual([{ kind: "pull_request", subject: { id: 9, number: 9 }, reason }]);
  });

  it.each([
    ["GitHub missing", () => new GitHubApiError(404), "NOT_FOUND"],
    ["GitLab missing", () => new GitLabApiError(404), "NOT_FOUND"],
    ["GraphQL missing", () => new Error("Could not resolve to an Issue with number 1"), "NOT_FOUND"],
    ["oversized", () => new GitHubResponseTooLargeError(12), "RESPONSE_TOO_LARGE"],
    ["unreadable own field", () => new GitHubGraphqlInvalidResponseError("Unreadable issue", "labels.nodes"), "UNREADABLE_FIELD"],
  ] as const)("stages a discarded %s issue so later subjects can progress", async (_name, failure, reason) => {
    const f = fixture([subject(1), subject(2)]);
    const gather = f.gateway.gatherIssue;
    f.gateway.gatherIssue = (row) => row.id === 1 ? f.read("issue:1", () => { throw failure(); }) : gather(row);
    const result = await f.window(20);
    expect(result.issues.map(({ id }) => id)).toEqual([2]);
    expect(f.pass.walkAnchors().subjects?.key).toBe(2);
    expect(f.discarded).toEqual([{ kind: "issue", subject: expect.objectContaining({ id: 1 }), reason,
      ...(failure() instanceof GitHubGraphqlInvalidResponseError && { fieldPath: "labels.nodes" }) }]);
  });

  it.each([401, 403, 429, 500])("keeps HTTP %s on the whole-run failure path", async (status) => {
    const f = fixture([subject(1)]);
    f.repository.disputePullRequests = [{ id: 9, number: 9 }];
    const failure = new GitHubApiError(status);
    f.gateway.getPullRequestReviews = async () => { throw failure; };
    await expect(f.window(20)).rejects.toBe(failure);
    expect(f.discarded).toEqual([]);
  });

  it("keeps unreadable-issue markers in staging for the caller's retention policy", async () => {
    const f = fixture([subject(1), subject(2)]);
    f.issues.get(1)!.openingEvidenceUnreadable = true; f.issues.get(2)!.closingPullRequestsUnreadable = true;
    const result = await f.window(20);
    expect([result.issues[0]?.openingEvidenceUnreadable, result.issues[1]?.closingPullRequestsUnreadable]).toEqual([true, true]);
    expect(f.discarded.map(({ reason }) => reason)).toEqual(["UNREADABLE_FIELD", "UNREADABLE_FIELD"]);
  });

  it.each([
    ["closingIssuesReferences.nodes", false], ["closingIssuesReferences.nodes.repository", false],
    ["closingIssuesReferences.nodes", true], ["closingIssuesReferences.nodes.repository", true],
  ] as const)("discards only one PR's closing read when its %s is unreadable (disputed: %s), still staging its evidence", async (fieldPath, disputed) => {
      const f = fixture([subject(1), subject(2, "pull_request"), subject(3), subject(4, "pull_request")]);
      if (disputed) f.repository.disputePullRequests = [{ id: 2, number: 2 }];
      f.issues.get(1)!.closingPullRequests = [pullRequest(2)]; f.issues.get(3)!.closingPullRequests = [pullRequest(4)];
      f.gateway.getPullRequestClosingIssues = (pr) => f.read(`closing:${pr.id}`, () => {
        if (pr.id === 2) throw new GitHubGraphqlInvalidResponseError("Unreadable closing read", fieldPath); return [{ id: 3, number: 3, repositoryGitHubId: 42 }]; });
      const result = await f.window(40);
      expect(f.discarded).toEqual([{ kind: "pull_request", subject: expect.objectContaining({ id: 2 }), reason: "UNREADABLE_FIELD", fieldPath }]);
      // The issue already naming the unreadable PR is still refreshed, as is the healthy PR's.
      expect([f.counts.get(1), f.counts.get(3)]).toEqual([2, 2]);
      expect((await f.pass.readStaged()).find(({ kind, subjectKey }) => kind === "pull_request" && subjectKey === 2)?.payload)
        .toMatchObject({ subject: { id: 2, number: 2 }, evidence: { reviews: [], rawDiff: "diff 2" } });
      expect(result.issues.map(({ id }) => id)).toEqual([1, 3]);
      expect(result.pullRequests).toEqual([{ id: 2, reviews: [], rawDiff: "diff 2" }, { id: 4, reviews: [], rawDiff: "diff 4" }]);
      expect(result.missingDisputePrIds).toEqual(new Set());
    });

  // A disputed PR's unreadable evidence is not definitive absence: it stays out of the missing-dispute set.
  it.each([["reviews.nodes", false], ["timelineItems.nodes", false], ["reviews.nodes", true], ["timelineItems.nodes", true]] as const)(
    "omits only one PR's evidence when its %s is unreadable (disputed: %s)", async (fieldPath, disputed) => {
    const f = fixture([subject(1)]);
    if (disputed) f.repository.disputePullRequests = [{ id: 8, number: 8 }];
    f.issues.get(1)!.closingPullRequests = [pullRequest(8), pullRequest(9)];
    f.gateway.getPullRequestReviews = (pr) => f.read(`reviews:${pr.id}`, () => { if (pr.id === 8) throw new GitHubGraphqlInvalidResponseError("Unreadable evidence read", fieldPath); return []; });
    const result = await f.window(20);
    expect(f.discarded).toEqual([{ kind: "pull_request", subject: expect.objectContaining({ id: 8 }), reason: "UNREADABLE_FIELD", fieldPath }]);
    expect(result.pullRequests).toEqual([{ id: 9, reviews: [], rawDiff: "diff 9" }]);
    expect(result.missingDisputePrIds).toEqual(new Set());
    expect(result.issues[0]?.closingPullRequests.map(({ id, rawDiff }) => [id, rawDiff])).toEqual([[8, ""], [9, "diff 9"]]);
  });

  // Classification keys on the read: a field path another read owns (or no
  // pull request read owns) keeps whole-run semantics on this one.
  it.each([
    ["closing", "assignees.nodes"], ["closing", "reviews.nodes"], ["closing", "timelineItems.nodes"],
    ["evidence", "assignees.nodes"], ["evidence", "closingIssuesReferences.nodes"], ["evidence", "closingIssuesReferences.nodes.repository"],
    ["issue", "reviews.nodes"], ["issue", "closingIssuesReferences.nodes"], ["issue", "closingIssuesReferences.nodes.repository"],
  ] as const)("keeps a %s read's unrelated %s rejection on the whole-run failure path", async (read, fieldPath) => {
    const f = fixture([subject(1), subject(2, "pull_request")]);
    const failure = new GitHubGraphqlInvalidResponseError("Unrelated field", fieldPath);
    if (read === "closing") f.gateway.getPullRequestClosingIssues = async () => { throw failure; };
    else if (read === "evidence") f.gateway.getPullRequestReviews = async () => { throw failure; };
    else f.gateway.gatherIssue = async () => { throw failure; };
    await expect(f.window(20)).rejects.toBe(failure);
    expect(f.discarded).toEqual([]);
  });
});
