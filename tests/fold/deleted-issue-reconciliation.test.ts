import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { listEligibleIssues } from "@/lib/dashboard/eligible-issues";
import type { DashboardSql } from "@/lib/dashboard/queries";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { RECONCILIATION_FULL_REPAIR_MS } from "@/lib/fold/full-repair-interval";
import { unlistedOpenIssues } from "@/lib/fold/unlisted-open-issues";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import { GitHubGateway } from "@/lib/github/client";
import { GitHubGraphqlInvalidResponseError } from "@/lib/github/errors";
import { GitHubResponseTooLargeError, MAX_SUCCESS_BODY_BYTES } from "@/lib/github/response-text";
import type { GitHubIssue } from "@/lib/github/types";
import { credentialBinding, encryptToken } from "@/lib/security/token-cipher";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
let container: StartedTestContainer;
let externalId = 7_700_000;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;
const encryptionKey = Buffer.alloc(32, 37).toString("base64url");

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "deleted_issue", user: "deleted_issue" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});
afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.OVERFLOW_DATABASE_URL;
  else process.env.OVERFLOW_DATABASE_URL = originalDatabaseUrl;
});

async function quietly<T>(run: () => Promise<T>) {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  try { return await run(); } finally { errors.mockRestore(); }
}

describe("an issue the forge no longer has", () => {
  const notFound = async () => { throw new Error("GitHub GraphQL request failed. NOT_FOUND: Could not resolve to an Issue with the number of 7."); };

  it.each([["answered as not found", notFound], ["answered as null", async () => null]])("leaves the board once the interval allows a listing when %s, and the exception moves on", async (_name, answer) => {
    const f = await fixture();
    await f.fold();
    expect(await f.board()).toEqual([f.cheapest.number]);

    f.forget(f.cheapest, answer);
    expect(await quietly(() => f.fold("WEBHOOK"))).toMatchObject({ skipped: false, removed: 0 });
    expect(await f.board()).toEqual([f.cheapest.number]);
    expect(await quietly(() => f.fold("WEBHOOK", RECONCILIATION_FULL_REPAIR_MS))).toMatchObject({ skipped: false, removed: 1 });

    expect(f.scans.at(-1)).toBeDefined();
    expect(await f.board()).toEqual([f.next.number]);
    expect((await f.store.getReconciliationEvidence(f.id))?.issues.map(({ id }) => id)).not.toContain(f.cheapest.id);
  });

  it("reads an issue only once unlisted, and keeps one the forge still returns", async () => {
    const f = await fixture();
    await f.fold();
    await f.fold("WEBHOOK");
    expect(f.issueReads).toEqual([]);
    f.unlist(f.cheapest);

    expect(await f.fold("WEBHOOK", RECONCILIATION_FULL_REPAIR_MS)).toMatchObject({ skipped: false, removed: 0 });
    expect(await f.board()).toEqual([f.cheapest.number]);
    expect(f.issueReads).toEqual([f.cheapest.number]);
  });

  it.each([["too large", new GitHubResponseTooLargeError(MAX_SUCCESS_BODY_BYTES)],
    ["unreadable on its own labels", new GitHubGraphqlInvalidResponseError("GitHub returned an unreadable labels connection.", "labels.nodes")],
  ])("keeps an unlisted issue whose read is discarded as %s, a reason other than not found", async (_name, error) => {
    const f = await fixture();
    await f.fold();
    f.forget(f.cheapest, async () => { throw error; });
    expect(await quietly(() => f.fold("WEBHOOK", RECONCILIATION_FULL_REPAIR_MS))).toMatchObject({ skipped: false, removed: 0 });
    expect(f.issueReads).toEqual([f.cheapest.number]);
    expect(await f.board()).toEqual([f.cheapest.number]);
  });

  it("asks for no open listing when no cached issue is open", async () => {
    const listOpenIssueIds = vi.fn(async () => []);
    const cached = new Map([[1, { id: 1, number: 1, state: "CLOSED" as const }]]);
    expect(await unlistedOpenIssues({ listOpenIssueIds }, { owner: "octo", name: "repo" }, cached)).toEqual([]);
    expect(listOpenIssueIds).not.toHaveBeenCalled();
  });

  it("fails the run and keeps the issue when its read fails transiently, and the next fold lists again", async () => {
    const f = await fixture();
    await f.fold();
    f.forget(f.cheapest, async () => { throw new Error("GitHub issue read broke."); });
    await expect(quietly(() => f.fold("WEBHOOK", RECONCILIATION_FULL_REPAIR_MS))).rejects.toThrow("Unable to reconcile repository.");
    await expect(quietly(() => f.fold("WEBHOOK"))).rejects.toThrow("Unable to reconcile repository.");
    expect(await f.board()).toEqual([f.cheapest.number]);
  });

  it("lists the open issues at most once per interval of incremental folds, a full pass counting as one", async () => {
    const f = await fixture();
    await f.fold();
    for (const elapsed of [120_000, 120_000, RECONCILIATION_FULL_REPAIR_MS - 240_001, 1, 120_000, RECONCILIATION_FULL_REPAIR_MS - 120_000]) await f.fold("WEBHOOK", elapsed);
    expect(f.listings).toEqual([1, 2].map((intervals) => new Date(Date.parse("2026-09-08T10:02:00Z") + intervals * RECONCILIATION_FULL_REPAIR_MS)));
  });

  it("lists on the next fold when the stored listing time is absent, as on a row an earlier release wrote", async () => {
    const f = await fixture();
    await f.fold();
    await sql`update repository_reconciliation_evidence set last_open_listing_at = null where repository_id = ${f.id}`;
    for (const reason of ["WEBHOOK", "WEBHOOK"] as const) await f.fold(reason);
    expect(f.listings).toEqual([new Date("2026-09-08T10:04:00Z")]);
  });

  it("charges every page of the open listing to the fold's recorded cost", async () => {
    const f = await fixture();
    await f.fold();
    const pages = [[f.cheapest], [f.next]];
    const forge = new GitHubGateway({ accessToken: "test-token", fetch: async () => Response.json(pages.shift()!.map(({ id, number, updatedAt }) => ({ id, number, updated_at: updatedAt })),
      { headers: pages.length > 0 ? { link: '<https://api.github.com/repos/octo/repo/issues?page=2>; rel="next"' } : {} }) });
    f.github.listOpenIssueIds = (reference) => forge.listOpenIssueIds(reference);
    const { runId } = await f.fold("WEBHOOK", RECONCILIATION_FULL_REPAIR_MS);
    expect(await sql`select graphql_cost, graphql_observed_responses, graphql_unmeasured_responses from reconciliation_runs where id = ${runId}`)
      .toEqual([{ graphql_cost: null, graphql_observed_responses: 0, graphql_unmeasured_responses: 2 }]);
    expect(pages).toEqual([]);
  });
});

async function fixture() {
  const [sponsorGitHubId, viewerGitHubId, githubRepositoryId] = [externalId++, externalId++, externalId++];
  const [sponsor] = await sql`insert into users (github_user_id, github_login, encrypted_oauth_token)
    values (${sponsorGitHubId}, ${`sponsor-${sponsorGitHubId}`}, ${Buffer.from(encryptToken("test-token", encryptionKey, credentialBinding.userOAuthToken(sponsorGitHubId)), "utf8")}) returning id, github_login`;
  const [viewer] = await sql`insert into users (github_user_id, github_login) values (${viewerGitHubId}, ${`viewer-${viewerGitHubId}`}) returning id`;
  const [repository] = await sql`insert into registered_repositories
    (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme, created_at)
    values (${githubRepositoryId}, ${`octo/repo-${githubRepositoryId}`}, ${sponsor.id}, 'PUBLIC', ${externalId++},
      ${sql.json(validDifficultyScheme())}, '2026-01-01T00:00:00Z') returning id`;
  await sql`insert into repository_reconciliation_sizes (repository_id, total_count, measured_at) values (${repository.id}, 5000, now())`;
  await indebt(String(sponsor.id), String(viewer.id));

  const issue = (number: number): GitHubIssue => {
    const id = externalId++;
    return { id, number, title: `Issue ${number}`, body: "body", url: `https://github.com/octo/repo/issues/${number}`,
      state: "OPEN", stateReason: null, createdAt: `2026-09-01T07:00:0${number}Z`, updatedAt: "2026-09-01T12:00:00Z",
      closedAt: null, authorLogin: sponsor.github_login, authorGitHubUserId: sponsorGitHubId, labels: ["M"],
      claimAssigneeGitHubLogin: null, claimAssigneeGitHubUserId: null,
      history: [{ kind: "LABELED", id: `opening-${id}`, actorLogin: sponsor.github_login,
        actorGitHubUserId: sponsorGitHubId, createdAt: "2026-09-01T08:00:00Z", label: "M" }],
      comments: [], closingPullRequests: [] };
  };
  const cheapest = issue(1), next = issue(2);
  let upstream = [cheapest, next];
  const unlisted = new Set<number>(), answers = new Map<number, () => Promise<GitHubIssue | null>>();
  const scans: Array<string | undefined> = [], issueReads: number[] = [], listings: Date[] = [];
  const store = new PostgresFoldStore(sql, encryptionKey);
  let clock = new Date("2026-09-08T10:00:00Z");

  const github: ReconciliationGateway = {
    getRepositoryById: async () => ({ id: githubRepositoryId, owner: "octo", name: `repo-${githubRepositoryId}`,
      fullName: `octo/repo-${githubRepositoryId}`, visibility: "PUBLIC", url: "https://github.com/octo/repo", canAdminister: true, ownerType: "USER" }),
    listIssues: async (_reference, options) => {
      scans.push(options?.since);
      return structuredClone(upstream.filter((row) => options?.since === undefined || Date.parse(row.updatedAt) >= Date.parse(options.since)));
    },
    listOpenIssueIds: async () => (listings.push(clock), upstream).filter((row) => row.state === "OPEN" && !unlisted.has(row.id)).map(({ id }) => id),
    getIssue: async (_reference, subject) => {
      issueReads.push(subject.number);
      const answer = answers.get(subject.id);
      return answer ? answer() : structuredClone(upstream.find(({ id }) => id === subject.id) ?? null);
    },
    getPullRequestClosingIssues: async () => [], getPullRequestReviews: async () => [], getPullRequestDiff: async () => "diff",
  };

  return {
    id: String(repository.id), store, github, cheapest, next, scans, issueReads, listings,
    fold(reason?: "WEBHOOK", elapsed = 120_000) {
      clock = new Date(clock.getTime() + elapsed);
      return reconcileRepository({ store, github, now: () => clock, onBudgetChange: () => {} }, String(repository.id), { reason });
    },
    forget(gone: GitHubIssue, answer: () => Promise<GitHubIssue | null>) {
      upstream = upstream.filter(({ id }) => id !== gone.id);
      answers.set(gone.id, answer);
    },
    unlist(row: GitHubIssue) { unlisted.add(row.id); },
    async board() {
      const rows = await listEligibleIssues(String(viewer.id), {}, { sql: sql as unknown as DashboardSql });
      return rows.filter((row) => row.repositoryName === `octo/repo-${githubRepositoryId}`).map((row) => row.issueNumber);
    },
  };
}

async function indebt(debtorId: string, creditorId: string) {
  const id = externalId++;
  const [repository] = await sql`insert into registered_repositories
    (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
    values (${id}, ${`octo/debt-${id}`}, ${debtorId}, 'PUBLIC', ${id}, ${sql.json(validDifficultyScheme())}) returning id`;
  const [issue] = await sql`insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points)
    values (${id}, ${repository.id}, 1, 'Settled work', '', 'https://example.test/issue', 'CLOSED', 'M', 5, 5) returning id`;
  const [pullRequest] = await sql`insert into pull_requests (github_pull_request_id, repository_id, issue_id,
      pull_request_number, url, title, body, author_id, state, merged_at)
    values (${id}, ${repository.id}, ${issue.id}, 2, 'https://example.test/pull/2', 'Work', '', ${creditorId}, 'MERGED',
      '2026-09-01T12:00:00Z') returning id`;
  await sql`insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequest.id}, ${issue.id}, ${repository.id})`;
  await sql`insert into settlements (pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status)
    values (${pullRequest.id}, ${issue.id}, ${creditorId}, 'creditor', ${debtorId}, 5, 10, 0, 10, ${"a".repeat(64)}, 'SETTLED')`;
}
