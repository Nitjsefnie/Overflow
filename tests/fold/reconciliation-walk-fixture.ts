import { vi } from "vitest";
import type { WalkSubject } from "@/lib/forge/subject-listing";
import type { SweepPass } from "@/lib/fold/sweep-pass";
import { checkpointSweepRequest, withSweepPass } from "@/lib/fold/sweep-pass";
import { checkSweepRequestBudget, withSweepRequestBudget } from "@/lib/fold/sweep-request-budget";
import { walkReconciliation, type ReconciliationWalkInput, type WalkGateway, type WalkListingDriver } from "@/lib/fold/reconciliation-walk";
import type { GitHubIssue, GitHubPullRequest, GitHubSubject } from "@/lib/github/types";

export const instant = (key: number) => new Date(Date.UTC(2026, 9, 1, 0, 0, key));
export const subject = (id: number, kind: WalkSubject["kind"] = "issue", time = id): WalkSubject => ({ id, number: id, kind, updatedAt: instant(time) });
export function issue(id: number): GitHubIssue {
  return {
    id, number: id, title: `Issue ${id}`, body: "opening", url: `https://example.com/issues/${id}`, state: "OPEN", stateReason: null,
    createdAt: instant(0).toISOString(), updatedAt: instant(id).toISOString(), closedAt: null, authorLogin: null, authorGitHubUserId: null,
    labels: [], claimAssigneeGitHubLogin: null, claimAssigneeGitHubUserId: null, history: [], comments: [], closingPullRequests: [],
  };
}
export function pullRequest(id: number, repositoryGitHubId = 42): GitHubPullRequest {
  return { id, number: id, title: "Closing PR", body: "", url: `https://example.com/pulls/${id}`, state: "MERGED",
    mergedAt: instant(20).toISOString(), mergeCommitOid: null, finalCommitAt: null, authorLogin: null, authorGitHubUserId: null,
    repositoryGitHubId, repositoryNameWithOwner: "owner/repo" };
}

export function memoryPass() {
  const anchors: Record<string, { updatedAt: Date; key: number }> = {};
  const rows = new Map<string, Awaited<ReturnType<SweepPass["readStaged"]>>[number]>();
  const pass: SweepPass = {
    id: "pass", scanStartedAt: instant(0), dirtySubjects: [],
    read: vi.fn(async () => { throw new Error("Page cache read"); }),
    write: vi.fn(async () => { throw new Error("Page cache write"); }),
    walkAnchors: () => structuredClone(anchors),
    stage: vi.fn(async ({ anchor, kind, subjectKey, updatedAt, payload }) => {
      rows.set(`${kind}:${subjectKey}`, { kind, subjectKey, updatedAt, payload: structuredClone(payload) });
      const old = anchors[anchor];
      if (old === undefined || updatedAt > old.updatedAt || (+updatedAt === +old.updatedAt && subjectKey > old.key)) {
        anchors[anchor] = { updatedAt, key: subjectKey };
      }
    }),
    readStaged: async () => structuredClone([...rows.values()]),
    deleteStaged: vi.fn(async (keys) => { for (const { kind, subjectKey } of keys) rows.delete(`${kind}:${subjectKey}`); }),
    complete: vi.fn(async () => { rows.clear(); }),
  };
  return pass;
}

export function fixture(subjects: WalkSubject[], pageSize = 100) {
  const pass = memoryPass();
  const live = new Map(subjects.map((row) => [row.id, structuredClone(row)]));
  const issues = new Map(subjects.filter((row) => row.kind === "issue").map((row) => [row.id, { ...issue(row.id), updatedAt: row.updatedAt.toISOString() }]));
  const pullRequests = new Map(subjects.filter((row) => row.kind === "pull_request").map((row) => [row.id, { ...pullRequest(row.id), number: row.number }]));
  const lookups: Array<GitHubSubject & { kind: WalkSubject["kind"] }> = [];
  const counts = new Map<number, number>();
  const listed: Array<{ since?: string; cursor: string | null }> = [];
  const requests: string[] = [];
  const discarded: Parameters<NonNullable<ReconciliationWalkInput["onDiscard"]>>[0][] = [];
  let afterGather: (id: number) => void = () => {};
  const read = async <T>(key: string, work: () => T) => checkpointSweepRequest(key, async () => {
    await checkSweepRequestBudget();
    requests.push(key);
    return structuredClone(work());
  });
  const listing: WalkListingDriver = { kind: "cursor", listPage: async (options) => read(`list:${JSON.stringify(options)}`, () => {
    listed.push(options);
    const available = [...live.values()].filter((row) => options.since === undefined || +row.updatedAt >= Date.parse(options.since))
      .sort((a, b) => +a.updatedAt - +b.updatedAt || a.id - b.id);
    const start = Number(options.cursor ?? 0);
    return { subjects: available.slice(start, start + pageSize), nextCursor: start + pageSize < available.length ? String(start + pageSize) : null };
  }) };
  const gateway: WalkGateway = {
    gatherIssue: async ({ id, number }) => read(`issue:${id}`, () => {
      lookups.push({ kind: "issue", id, number });
      counts.set(id, (counts.get(id) ?? 0) + 1);
      const result = structuredClone(issues.get(id) ?? null);
      afterGather(id);
      return result;
    }),
    getPullRequest: async ({ id, number }) => read(`pull_request:${id}`, () => {
      lookups.push({ kind: "pull_request", id, number });
      return pullRequests.get(id) ?? null;
    }),
    getPullRequestClosingIssues: async ({ id }) => read(`closing:${id}`, () => []),
    getPullRequestReviews: async ({ id }) => read(`reviews:${id}`, () => []),
    getPullRequestDiff: async ({ id }) => read(`diff:${id}`, () => `diff ${id}`),
  };
  const repository = { githubRepositoryId: 42, disputePullRequests: [] as Array<{ id: number; number: number }> };
  const window = async (budget: number, driver: WalkListingDriver = listing) => {
    let spent = 0;
    return withSweepPass(pass, () => withSweepRequestBudget(async () => spent++ < budget ? null : instant(10000),
      () => walkReconciliation({ pass, listing: driver, gateway, repository, onDiscard: async (entry) => { discarded.push(entry); } })));
  };
  return { pass, live, issues, pullRequests, lookups, counts, listed, listing, gateway, repository, requests, discarded, window,
    onGather: (callback: (id: number) => void) => { afterGather = callback; }, read };
}
