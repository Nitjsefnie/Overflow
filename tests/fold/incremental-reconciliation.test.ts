import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import * as repositoryFold from "@/lib/fold/repository-fold";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import { reconcileRepositoryAsSponsor } from "@/lib/fold/reconcile-as-sponsor";
import type { GitHubIssue, GitHubIssueReference, GitHubPullRequest, GitHubPullRequestReview, GitHubSubject } from "@/lib/github/types";
import { encryptToken } from "@/lib/security/token-cipher";
import { GitHubGateway } from "@/lib/github/client";
import { recordGraphqlResponseCost } from "@/lib/github/graphql-cost";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
let container: StartedTestContainer;
let externalId = 9_800_000;
const originalDatabaseUrl = process.env.DATABASE_URL;
const encryptionKey = Buffer.alloc(32, 31).toString("base64url");
const start = new Date("2026-09-08T10:00:00Z");

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "incremental", user: "incremental", password: "incremental" });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});
afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("incremental reconciliation", () => {
  it("charges quiet retained history only for current observations", async () => {
    const f = await fixture();
    f.issues[0]!.updatedAt = "2026-09-08T09:58:00Z";
    f.measuredIssueCost = 1;
    f.measuredReviewCost = 5;
    const full = await f.run();
    expect(full.skipped).toBe(false);
    f.clock = new Date("2026-09-08T10:04:00Z");
    const quiet = await f.run();
    expect(quiet.skipped).toBe(false);
    expect(f.reviewReads).toEqual([11, 12]);
    f.issues[0]!.updatedAt = "2026-09-08T10:05:00Z";
    f.clock = new Date("2026-09-08T10:06:00Z");
    const active = await f.run();
    expect(active.skipped).toBe(false);
    const costs = [];
    for (const result of [full, quiet, active]) {
      if (result.skipped) throw new Error("Expected a completed test fold.");
      const [row] = await sql<{ cost: number }[]>`select graphql_cost::int as cost
        from reconciliation_runs where id = ${result.runId}`;
      costs.push(row!.cost);
    }
    expect(costs).toEqual([11, 1, 6]);
  });

  it("charges one current scan for a larger retained history and only refreshed reviews after a dirty event", async () => {
    const f = await fixture();
    f.issues[0]!.updatedAt = "2026-09-08T09:58:00Z";
    const template = f.issues[0]!;
    for (let index = 0; index < 20; index++) {
      const issue = structuredClone(template);
      issue.id = externalId++;
      issue.number = 100 + index;
      issue.closingPullRequests[0]!.id = externalId++;
      issue.closingPullRequests[0]!.number = 200 + index;
      f.issues.push(issue);
    }
    f.measuredIssueCost = 1;
    f.measuredReviewCost = 5;
    const full = await f.run();
    f.clock = new Date("2026-09-08T10:04:00Z");
    const quiet = await f.run();
    expect((await f.store.getReconciliationEvidence(f.id))?.issues).toHaveLength(23);
    expect(f.reviewReads).toHaveLength(22);
    await f.dirty("ISSUE", f.issues[0]!);
    f.clock = new Date("2026-09-08T10:06:00Z");
    const dirty = await f.run();
    expect(f.issueReads).toEqual([1]);
    expect(f.reviewReads).toHaveLength(23);
    expect(f.reviewReads.at(-1)).toBe(11);
    const costs = [];
    for (const result of [full, quiet, dirty]) {
      if (result.skipped) throw new Error("Expected a completed test fold.");
      const [row] = await sql<{ cost: number }[]>`select graphql_cost::int as cost
        from reconciliation_runs where id = ${result.runId}`;
      costs.push(row!.cost);
    }
    expect(costs).toEqual([111, 1, 6]);
  });

  // Mutants: DROP_MIDPASS_INVALIDATION, ISSUE_WATERMARK_GATES_DIRTY_FETCH.
  it("retains a mid-pass invalidation and repairs its issue through the sponsor gateway on the next quiet pass", async () => {
    const f = await fixture();
    f.issues[0]!.updatedAt = "2026-09-01T00:00:00Z";
    await f.run();
    f.clock = new Date("2026-09-08T10:03:00Z");
    f.afterList = async () => {
      f.issues[0]!.title = "arrived after scan";
      await f.dirty("ISSUE", f.issues[0]!);
      f.clock = new Date("2026-09-08T10:04:00Z");
      f.afterList = async () => {};
    };
    await f.run();
    expect((await f.store.getReconciliationEvidence(f.id))?.checkpoint).toEqual(new Date("2026-09-08T10:03:00Z"));
    expect(await f.store.getDirtyReconciliationSubjects(f.id)).toHaveLength(1);
    expect((await derived(f.id)).issues[0]?.title).toBe("Issue 1");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-08T10:05:00Z"));
    try { await f.runAsSponsor(); } finally { vi.useRealTimers(); }
    expect(f.issueReads).toEqual([1]);
    expect((await derived(f.id)).issues[0]?.title).toBe("arrived after scan");
    expect(await f.store.getDirtyReconciliationSubjects(f.id)).toEqual([]);
  });

  // Mutants: MAX_UPDATED_AT_REHYDRATES_FOREVER, REFETCH_ALL_PR_EVIDENCE,
  // FULL_AFTER_RESTART, CACHE_ONLY_PRICED_ISSUES, FOLD_DELTA_ONLY, DROP_UNCHANGED_PR_DIFF.
  it("bootstraps, refreshes the overlap, then performs quiet passes across a store restart", async () => {
    const f = await fixture();
    await f.run();
    expect(f.scans).toEqual([undefined]);
    expect((await f.store.getReconciliationEvidence(f.id))?.issues).toHaveLength(3);
    const initial = await derived(f.id);
    expect(initial.issues).toHaveLength(2);
    expect(initial.pullRequests).toHaveLength(2);
    f.clock = new Date("2026-09-08T10:02:00Z");
    await f.run();
    f.clock = new Date("2026-09-08T10:04:00Z");
    await f.run();
    f.store = new PostgresFoldStore(sql, encryptionKey);
    f.clock = new Date("2026-09-08T10:05:00Z");
    await f.run();
    expect(f.scans).toEqual([undefined, "2026-09-08T09:59:00.000Z", "2026-09-08T10:01:00.000Z", "2026-09-08T10:03:00.000Z"]);
    expect(f.reviewReads).toEqual([11, 12, 11]);
    expect(f.diffReads).toEqual([11, 12, 11]);
    expect(f.issueReads).toEqual([]);
    expect(await derived(f.id)).toEqual(initial);
    expect(await f.store.getReconciliationEvidence(f.id)).toMatchObject({ version: 4, checkpoint: f.clock, lastFullPassAt: start });
  });

  // Mutants: FOLD_DELTA_ONLY, EQUAL_TIMESTAMP_MEANS_UNCHANGED, CACHE_ONLY_PRICED_ISSUES.
  it("replaces changed evidence at an equal update timestamp while retaining unchanged and unpriced issues", async () => {
    const f = await fixture();
    await f.run();
    f.issues[0] = { ...f.issues[0]!, body: "edited body", comments: [], title: "edited title" };
    f.clock = new Date("2026-09-08T10:02:00Z");
    await f.run();
    const cache = await f.store.getReconciliationEvidence(f.id);
    expect(cache?.issues.map(({ number, body }) => ({ number, body }))).toEqual([
      { number: 1, body: "edited body" }, { number: 2, body: "body" }, { number: 3, body: "body" },
    ]);
    expect((await derived(f.id)).issues.map(({ title }) => title)).toEqual(["edited title", "Issue 2"]);
  });

  // Mutants: FREEZE_LOCAL_USERS, CACHE_ONLY_PRICED_ISSUES.
  it("uses fresh local accounts and repository labels while folding retained upstream evidence", async () => {
    const f = await fixture();
    await f.run();
    expect((await derived(f.id)).pullRequests[0]?.author_id).toBeNull();
    const [user] = await sql`insert into users (github_user_id, github_login) values (${f.contributorGitHubId}, 'new-account') returning id`;
    const scheme = validDifficultyScheme();
    scheme.openingLabels.push({ label: "future", comparisonPoints: 4, reservePoints: 4 });
    await sql`update registered_repositories set difficulty_scheme = ${sql.json(scheme)} where id = ${f.id}`;
    f.clock = new Date("2026-09-08T10:03:00Z");
    await f.run();
    f.clock = new Date("2026-09-08T10:05:00Z");
    await f.run();
    const rows = await derived(f.id);
    expect(rows.pullRequests.every(({ author_id }) => author_id === user.id)).toBe(true);
    expect(rows.issues.map(({ title }) => title)).toEqual(["Issue 1", "Issue 2", "Issue 3"]);
  });

  // Mutants: NEW_REFERENCES_ONLY, OLD_REFERENCES_ONLY, ISSUE_WATERMARK_GATES_DIRTY_FETCH,
  // IGNORE_MERGED_PR_REVIEW, FOREIGN_NUMBER_COLLISION.
  it("refreshes old and new PR-referenced issues below the checkpoint and preserves foreign-number boundaries", async () => {
    const f = await fixture();
    f.issues[0]!.updatedAt = "2026-09-01T00:00:00Z";
    await f.run();
    const changedPr = f.issues[0]!.closingPullRequests[0]!;
    f.issues[0] = { ...f.issues[0]!, title: "old reference removed", closingPullRequests: [] };
    f.issues[1] = { ...f.issues[1]!, title: "new reference added", closingPullRequests: [changedPr] };
    f.references = [
      { id: f.issues[1]!.id, number: 2, repositoryGitHubId: f.githubRepositoryId },
      { id: 999, number: 1, repositoryGitHubId: f.githubRepositoryId + 1 },
    ];
    f.reviews = [{ id: 401, state: "DISMISSED", submittedAt: "2026-09-01T09:00:00Z",
      dismissal: { at: "2026-09-01T13:00:00Z", previousState: "CHANGES_REQUESTED" } }];
    await f.dirty("PULL_REQUEST", changedPr);
    f.clock = new Date("2026-09-08T10:03:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(f.clock);
    try { await f.runAsSponsor(); } finally { vi.useRealTimers(); }
    expect(f.issueReads).toEqual([1, 2]);
    expect(f.reverseReads).toEqual([11]);
    const cache = await f.store.getReconciliationEvidence(f.id);
    expect(cache?.issues.slice(0, 2).map(({ title }) => title)).toEqual(["old reference removed", "new reference added"]);
    expect(cache?.pullRequests.find(({ id }) => id === changedPr.id)?.reviews).toEqual(f.reviews);
    expect(await f.store.getDirtyReconciliationSubjects(f.id)).toEqual([]);
  });

  // Mutants: DROP_UNCHANGED_PR_DIFF, IGNORE_MERGED_PR_REVIEW,
  // SHARED_PR_EVIDENCE_FIRST_ISSUE_ONLY (the deduplicated PR row alone cannot detect this).
  it("applies shared PR evidence refreshed through one changed issue to every retained reference", async () => {
    const f = await fixture();
    f.issues[1]!.closingPullRequests = f.issues[0]!.closingPullRequests;
    await f.run();
    f.diff = "replacement diff";
    f.reviews = [{ id: 501, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T09:00:00Z", dismissal: null }];
    f.clock = new Date("2026-09-08T10:02:00Z");
    // Observe the real fold boundary without replacing its implementation or materialization.
    const fold = vi.spyOn(repositoryFold, "foldRepository");
    try {
      await f.run();
      expect(fold).toHaveBeenCalledOnce();
      const issueInputs = fold.mock.calls[0]![0].issues.filter(({ number }) => number === 1 || number === 2);
      expect(issueInputs.map(({ number, closingPullRequests }) => ({
        number,
        closingPullRequests: closingPullRequests.map(({ number, reviews, rawDiff }) => ({ number, reviews, rawDiff })),
      }))).toEqual([
        { number: 1, closingPullRequests: [{ number: 11, rawDiff: "replacement diff", reviews: [{
          id: 501, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T09:00:00Z", dismissal: null,
        }] }] },
        { number: 2, closingPullRequests: [{ number: 11, rawDiff: "replacement diff", reviews: [{
          id: 501, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T09:00:00Z", dismissal: null,
        }] }] },
      ]);
    } finally {
      fold.mockRestore();
    }
    expect(f.diffReads).toEqual([11, 11]);
    const [pr] = await sql`select pr.proof_sha256, (select count(*)::int from review_rounds r where r.pull_request_id = pr.id) as reviews
      from pull_requests pr where pr.repository_id = ${f.id}`;
    expect(pr).toEqual({
      proof_sha256: "bb4a70592c7e8e3fcb5637474e8dde68f44f0affc057373c8113bdb820d551b3",
      reviews: 1,
    });
    expect((await f.store.getReconciliationEvidence(f.id))?.pullRequests).toMatchObject([{ rawDiff: "replacement diff", reviews: [{ id: 501 }] }]);
  });

  // Mutants: IGNORE_REDERIVE, NEVER_REPAIR_MISSED_WEBHOOK, KEEP_FULL_PASS_ABSENT_ISSUE.
  it.each(["rederive", "six hours", "incompatible cache"])("performs full repair for %s and removes absent issues only then", async (reason) => {
    const f = await fixture();
    await f.run();
    f.issues = [f.issues[0]!];
    f.clock = new Date("2026-09-08T10:02:00Z");
    await f.run();
    expect((await f.store.getReconciliationEvidence(f.id))?.issues).toHaveLength(3);
    if (reason === "six hours") f.clock = new Date("2026-09-08T16:00:00Z");
    if (reason === "incompatible cache") await sql`update repository_reconciliation_evidence set format_version = 2 where repository_id = ${f.id}`;
    await f.run({ rederive: reason === "rederive" });
    expect(f.scans.at(-1)).toBeUndefined();
    expect((await f.store.getReconciliationEvidence(f.id))?.issues).toHaveLength(1);
    expect((await derived(f.id)).issues).toHaveLength(1);
    expect((await f.store.getReconciliationEvidence(f.id))?.lastFullPassAt).toEqual(f.clock);
  });

  // Mutants: ADVANCE_FULL_AGE_ON_FAILURE, WATERMARK_BEFORE_MATERIALIZE,
  // CACHE_OUTSIDE_TRANSACTION, DROP_MIDPASS_INVALIDATION.
  it.each(["issue page two", "PR evidence", "materialization", "cooldown"])("keeps synchronization state unchanged after %s failure", async (failure) => {
    const f = await fixture();
    f.measuredIssueCost = 1;
    f.measuredReviewCost = 5;
    await f.run();
    const usageBefore = await sql`select * from repository_reconciliation_usage where repository_id = ${f.id}`;
    await f.dirty("ISSUE", f.issues[0]!);
    const before = await f.store.getReconciliationEvidence(f.id);
    const dirty = await f.store.getDirtyReconciliationSubjects(f.id);
    const rows = await derived(f.id);
    f.clock = new Date("2026-09-08T16:00:00Z");
    f.issues[0]!.title = "must roll back";
    f.failure = failure;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let table: string | undefined;
    if (failure === "materialization" || failure === "cooldown") {
      table = failure === "materialization" ? "issues" : "registered_repositories";
      const column = failure === "materialization" ? "title" : "reconciliation_not_before";
      await sql`create function reject_incremental_test_write() returns trigger language plpgsql as $$
        begin raise exception 'injected incremental failure'; end $$`;
      await sql`create trigger reject_incremental_test_write before update of ${sql(column)} on ${sql(table)}
        for each row execute function reject_incremental_test_write()`;
    }
    try {
      await expect(f.run()).rejects.toThrow("Unable to reconcile repository.");
    } finally {
      errors.mockRestore();
      if (table !== undefined) {
        await sql`drop trigger reject_incremental_test_write on ${sql(table)}`;
        await sql`drop function reject_incremental_test_write()`;
      }
    }
    expect(await f.store.getReconciliationEvidence(f.id)).toEqual(before);
    expect(await f.store.getDirtyReconciliationSubjects(f.id)).toEqual(dirty);
    expect(await derived(f.id)).toEqual(rows);
    if (failure === "issue page two") expect(f.failedPageCursors).toEqual([null, "page-two"]);
    expect(await sql`select status from reconciliation_runs where repository_id = ${f.id} order by started_at`)
      .toEqual([{ status: "COMPLETED" }, { status: "FAILED" }]);
    expect(await sql`select graphql_cost, graphql_cost_sponsor_id, graphql_observed_responses, graphql_unmeasured_responses
      from reconciliation_runs where repository_id = ${f.id} and status = 'FAILED'`)
      .toEqual([{ graphql_cost: null, graphql_cost_sponsor_id: null, graphql_observed_responses: null, graphql_unmeasured_responses: null }]);
    expect(await sql`select * from repository_reconciliation_usage where repository_id = ${f.id}`).toEqual(usageBefore);
  });
});

async function fixture() {
  const sponsorGitHubId = externalId++;
  const contributorGitHubId = externalId++;
  const githubRepositoryId = externalId++;
  const [sponsor] = await sql`insert into users (github_user_id, github_login, encrypted_oauth_token)
    values (${sponsorGitHubId}, ${`sponsor-${sponsorGitHubId}`}, ${Buffer.from(encryptToken("test-token", encryptionKey), "utf8")}) returning id, github_login`;
  const [repository] = await sql`insert into registered_repositories
    (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme, created_at)
    values (${githubRepositoryId}, ${`octo/repo-${githubRepositoryId}`}, ${sponsor.id}, 'PUBLIC', ${externalId++},
      ${sql.json(validDifficultyScheme())}, '2026-01-01T00:00:00Z') returning id`;
  const issues = [1, 2, 3].map((number): GitHubIssue => {
    const id = externalId++;
    const label = number === 3 ? "future" : "M";
    const pr: GitHubPullRequest = { id: externalId++, number: number + 10, title: `PR ${number}`, body: "body",
      url: "https://github.com/octo/repo/pull/11", state: "MERGED", mergedAt: "2026-09-01T12:00:00Z",
      mergeCommitOid: id.toString(16).padStart(40, "0"), finalCommitAt: "2026-09-01T10:00:00Z",
      authorLogin: "contributor", authorGitHubUserId: contributorGitHubId,
      repositoryGitHubId: githubRepositoryId, repositoryNameWithOwner: `octo/repo-${githubRepositoryId}` };
    return { id, number, title: `Issue ${number}`, body: "body", url: "https://github.com/octo/repo/issues/1",
      state: number === 3 ? "OPEN" : "CLOSED", createdAt: "2026-09-01T07:00:00Z",
      updatedAt: number === 1 ? "2026-09-08T09:59:30Z" : "2026-09-01T12:00:00Z",
      closedAt: number === 3 ? null : "2026-09-01T12:00:00Z", authorLogin: sponsor.github_login,
      authorGitHubUserId: sponsorGitHubId, labels: [label], claimAssigneeGitHubLogin: null,
      history: [{ kind: "LABELED", id: `opening-${id}`, actorLogin: sponsor.github_login,
        actorGitHubUserId: sponsorGitHubId, createdAt: "2026-09-01T08:00:00Z", label }],
      comments: [], closingPullRequests: number === 3 ? [] : [pr] };
  });
  const f = { id: String(repository.id), githubRepositoryId, contributorGitHubId, issues,
    store: new PostgresFoldStore(sql, encryptionKey), clock: start, failure: "", diff: "initial diff",
    reviews: [] as GitHubPullRequestReview[], references: [] as GitHubIssueReference[],
    scans: [] as Array<string | undefined>, issueReads: [] as number[], reverseReads: [] as number[],
    reviewReads: [] as number[], diffReads: [] as number[],
    failedPageCursors: [] as Array<string | null>,
    measuredIssueCost: null as number | null,
    measuredReviewCost: null as number | null,
    afterList: async () => {},
    async dirty(kind: "ISSUE" | "PULL_REQUEST", subject: GitHubSubject) {
      await f.store.enqueueWebhookReconciliation(f.id, { deliveryId: `event-${f.id}`, event: kind === "ISSUE" ? "issues" : "pull_request_review",
        action: kind === "ISSUE" ? "edited" : "dismissed", repositoryGitHubId: githubRepositoryId,
        repositoryFullName: `octo/repo-${githubRepositoryId}`, subject: { kind, id: subject.id, number: subject.number } });
    },
    run: (options?: { rederive?: boolean }) => reconcileRepository({ store: f.store, github, now: () => f.clock, onBudgetChange: () => {} }, f.id, options),
    runAsSponsor: () => reconcileRepositoryAsSponsor(f.store, f.id, () => github),
  };
  const github: ReconciliationGateway = {
    getRepositoryById: async () => ({ id: githubRepositoryId, owner: "octo", name: `repo-${githubRepositoryId}`,
      fullName: `octo/repo-${githubRepositoryId}`, visibility: "PUBLIC", url: "https://github.com/octo/repo", canAdminister: true, ownerType: "USER" }),
    listIssues: async (reference, options) => {
      f.scans.push(options?.since);
      if (f.failure === "issue page two") {
        const paginated = new GitHubGateway({ accessToken: "test-token", fetch: async (_input, init) => {
          const { variables } = JSON.parse(String(init?.body));
          f.failedPageCursors.push(variables.cursor);
          if (variables.cursor !== null) throw new Error("second issue page failed");
          const issue = f.issues[0]!;
          const pageInfo = { hasNextPage: false, endCursor: null };
          return Response.json({ data: { repository: { issues: {
            nodes: [{ ...issue, databaseId: issue.id, author: { login: issue.authorLogin, databaseId: issue.authorGitHubUserId },
              labels: { nodes: issue.labels.map((name) => ({ name })), pageInfo }, assignees: { nodes: [] },
              timelineItems: { nodes: [], pageInfo }, closedByPullRequestsReferences: { nodes: [], pageInfo } }],
            pageInfo: { hasNextPage: true, endCursor: "page-two" },
          } } } });
        } });
        return paginated.listIssues(reference, options);
      }
      const issues = structuredClone(f.issues.filter((issue) => options?.since === undefined || Date.parse(issue.updatedAt) >= Date.parse(options.since)));
      await f.afterList();
      if (f.measuredIssueCost !== null) recordGraphqlResponseCost({ cost: f.measuredIssueCost });
      return issues;
    },
    getIssue: async (_reference, subject) => {
      f.issueReads.push(subject.number);
      return structuredClone(f.issues.find(({ id }) => id === subject.id) ?? null);
    },
    getPullRequestClosingIssues: async (_reference, subject) => { f.reverseReads.push(subject.number); return structuredClone(f.references); },
    getPullRequestReviews: async (_reference, number) => {
      f.reviewReads.push(number);
      if (f.failure === "PR evidence") throw new Error("PR evidence failed");
      if (f.measuredReviewCost !== null) recordGraphqlResponseCost({ cost: f.measuredReviewCost });
      return structuredClone(f.reviews);
    },
    getPullRequestDiff: async (_reference, number) => { f.diffReads.push(number); return f.diff; },
  };
  return f;
}

async function derived(repositoryId: string) {
  const issues = await sql`select github_issue_id, title, body from issues where repository_id = ${repositoryId} order by issue_number`;
  const pullRequests = await sql`select github_pull_request_id, proof_sha256, author_id from pull_requests where repository_id = ${repositoryId} order by pull_request_number`;
  return { issues, pullRequests };
}
