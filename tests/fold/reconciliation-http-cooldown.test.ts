import { createServer, type Server } from "node:http";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { closeSql, getSql } from "@/lib/db/client";
import { GitHubGateway } from "@/lib/github/client";
import { verifiedRepositoryPayload } from "../support/verified-repository";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository } from "@/lib/fold/reconcile";
import { sweepReconciliations } from "@/lib/fold/sweep";
import { processWebhook } from "@/lib/webhooks/processor";
import { encryptToken } from "@/lib/security/token-cipher";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";

const instant = new Date("2030-01-02T03:04:05.678Z");
const token = "fixture-token";
const key = Buffer.alloc(32, 29).toString("base64url");
const pageInfo: { hasNextPage: boolean; endCursor: string | null } = { hasNextPage: false, endCursor: null };
const scheme = {
  openingName: "Size", actualName: "Delivered",
  openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
  actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
};
type Failure = {
  name: string;
  operation: string;
  cursor: string | null;
  status: number;
  body: unknown;
  headers?: Record<string, string>;
  seconds: number | null;
  disconnect?: boolean;
};
const failures: Failure[] = [
  { name: "first-page HTTP 403 secondary limit", operation: "RepositoryIssues", cursor: null,
    status: 403, body: { message: "You have exceeded a secondary rate limit." },
    headers: { "x-ratelimit-remaining": "4219" }, seconds: 3600 },
  { name: "first-page HTTP 200 RATE_LIMIT", operation: "RepositoryIssues", cursor: null,
    status: 200, body: { errors: [{ type: "RATE_LIMIT", message: "API rate limit exceeded." }] },
    headers: { "x-ratelimit-remaining": "0" }, seconds: 3600 },
  { name: "first-page HTTP 200 RATE_LIMITED with retry guidance", operation: "RepositoryIssues", cursor: null,
    status: 200, body: { errors: [{ type: "RATE_LIMITED" }] }, headers: { "retry-after": "120" }, seconds: 120 },
  { name: "closing-continuation HTTP 403 secondary limit", operation: "ClosingPullRequests", cursor: "next",
    status: 403, body: { message: "secondary rate limit" }, seconds: 3600 },
  { name: "closing-continuation HTTP 200 code", operation: "ClosingPullRequests", cursor: "next",
    status: 200, body: { errors: [{ code: "graphql_rate_limit" }] }, headers: { "retry-after": "120" }, seconds: 120 },
  { name: "review-continuation HTTP 403 secondary limit", operation: "PullRequestReviews", cursor: "next",
    status: 403, body: { message: "secondary rate limit" }, headers: { "retry-after": "120" }, seconds: 120 },
  { name: "review-continuation HTTP 200 RATE_LIMIT", operation: "PullRequestReviews", cursor: "next",
    status: 200, body: { errors: [{ type: "RATE_LIMIT" }] }, seconds: 3600 },
  { name: "dismissal-continuation HTTP 403 secondary limit", operation: "PullRequestReviewDismissals", cursor: "next",
    status: 403, body: { message: "secondary rate limit" }, headers: { "retry-after": "120" }, seconds: 120 },
  { name: "dismissal-continuation HTTP 200 RATE_LIMITED", operation: "PullRequestReviewDismissals", cursor: "next",
    status: 200, body: { errors: [{ type: "RATE_LIMITED" }] }, headers: { "retry-after": "120" }, seconds: 120 },
  { name: "ordinary HTTP 403 permission failure", operation: "RepositoryIssues", cursor: null,
    status: 403, body: { message: "Resource not accessible by integration" }, seconds: null },
  { name: "ordinary HTTP 401 authorization failure with limit signals", operation: "RepositoryIssues", cursor: null,
    status: 401, body: { message: "Bad credentials" }, headers: { "retry-after": "60", "x-ratelimit-remaining": "0" }, seconds: null },
  { name: "HTTP 200 schema failure with limit signals", operation: "RepositoryIssues", cursor: null,
    status: 200, body: { errors: [{ type: "GRAPHQL_VALIDATION_FAILED", message: "Unknown RATE_LIMIT field" }] },
    headers: { "retry-after": "60", "x-ratelimit-remaining": "0" }, seconds: null },
  { name: "HTTP 200 permission failure with limit signals", operation: "RepositoryIssues", cursor: null,
    status: 200, body: { errors: [{ type: "FORBIDDEN", message: "secondary rate limit access denied" }] },
    headers: { "retry-after": "60", "x-ratelimit-remaining": "0" }, seconds: null },
  { name: "HTTP 200 authorization failure", operation: "RepositoryIssues", cursor: null,
    status: 200, body: { errors: [{ type: "UNAUTHORIZED" }] }, seconds: null },
  { name: "malformed HTTP 200 JSON with limit signals", operation: "RepositoryIssues", cursor: null,
    status: 200, body: "invalid JSON", headers: { "retry-after": "60" }, seconds: null },
  { name: "socket transport failure", operation: "RepositoryIssues", cursor: null,
    status: 200, body: null, disconnect: true, seconds: null },
];

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 9_600_000;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe("real HTTP failures through reconciliation and PostgreSQL", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "http_cooldown", user: "http_cooldown", password: "http_cooldown" });
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

  it.each(failures)("preserves history and applies only the right cooldown for $name", async (failure) => {
    const fixture = await registeredRepository();
    const calls: Array<{ operation: string; cursor: string | null }> = [];
    const serverErrors: unknown[] = [];
    let changed = false;
    const server = createServer(async (request, response) => {
      try {
        if (request.url === `/repositories/${fixture.githubRepositoryId}`) {
          // Counted like every other request: a cooled-down run must issue no GitHub
          // traffic at all, identity verification included.
          calls.push({ operation: "identity", cursor: null });
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify(verifiedRepositoryPayload(fixture.githubRepositoryId, fixture.ownerName)));
          return;
        }
        if (request.method === "GET") {
          calls.push({ operation: "diff", cursor: null });
          response.end(changed ? "changed diff" : "original diff");
          return;
        }
        const parts: Buffer[] = [];
        for await (const part of request) parts.push(Buffer.from(part));
        const { query, variables } = JSON.parse(Buffer.concat(parts).toString());
        const operation = /query (\w+)/.exec(query)![1]!;
        calls.push({ operation, cursor: variables.cursor });
        if (changed && operation === failure.operation && variables.cursor === failure.cursor) {
          if (failure.disconnect) { response.destroy(); return; }
          response.writeHead(failure.status, { "Content-Type": "application/json", ...failure.headers });
          response.end(typeof failure.body === "string" ? failure.body : JSON.stringify(failure.body));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify(successResponse(fixture, operation, changed, failure)));
      } catch (error) {
        serverErrors.push(error);
        response.statusCode = 500;
        response.end("Unexpected fixture request");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Missing HTTP listener address");
    const store = new PostgresFoldStore(sql, key);
    const github = new GitHubGateway({ accessToken: token, apiUrl: `http://127.0.0.1:${address.port}` });
    const reconcile = (id: string) => reconcileRepository({ store, github, now: () => instant }, id);
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Seed through the same real stack, including immutable user resolution and ledger writes.
      const baseline = await reconcile(fixture.repositoryId);
      expect(baseline).toMatchObject({ skipped: false, adds: 1, changes: 0, removals: 0 });
      expect(await sql`select amount from ledger_entries where account_id in (${fixture.sponsorId}, ${fixture.contributorId}) order by amount`)
        .toEqual([{ amount: -5 }, { amount: 5 }]);
      const history = await materializedHistory();
      const baselineCalls = calls.length;
      changed = true;

      const error = await reconcile(fixture.repositoryId).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(Error);
      expect(await failedRuns(fixture.repositoryId, baseline.runId!)).toEqual([
        { status: "FAILED", error_message: "Reconciliation failed." },
      ]);
      const cooldown = await store.getReconciliationCooldown(fixture.repositoryId);
      console.info("RECONCILIATION_HTTP_COOLDOWN", JSON.stringify({ scenario: failure.name, cooldown }));
      expect(cooldown).toEqual(failure.seconds === null ? null : new Date(instant.getTime() + failure.seconds * 1000));
      expect((error as Error).cause).toMatchObject({ rateLimited: failure.seconds !== null });
      expect(calls.slice(baselineCalls)).toContainEqual({ operation: failure.operation, cursor: failure.cursor });
      expect(await materializedHistory()).toEqual(history);

      const callsAfterFailure = calls.length;
      const delivery = {
        deliveryId: `http-cooldown-${fixture.githubRepositoryId}`, event: "pull_request" as const, action: "closed",
        repositoryGitHubId: fixture.githubRepositoryId, repositoryFullName: fixture.ownerName,
      };
      const webhook = () => processWebhook({ store, reconcileRepository: reconcile }, delivery);
      const sweep = () => sweepReconciliations({
        listActiveRepositoryIds: () => store.listActiveRepositoryIds(),
        getReconciliationCooldown: (id) => store.getReconciliationCooldown(id), reconcile, now: () => instant,
      });
      if (failure.seconds !== null) {
        await expect(webhook()).resolves.toEqual({ status: "PROCESSED" });
        await expect(sweep()).resolves.toEqual({ attempted: 0, reconciled: 0, failed: 0, skipped: 1 });
        expect(calls).toHaveLength(callsAfterFailure);
        expect(await failedRuns(fixture.repositoryId, baseline.runId!)).toEqual([
          { status: "FAILED", error_message: "Reconciliation failed." },
        ]);
      } else {
        await expect(webhook()).rejects.toThrow("Webhook processing failed.");
        await expect(sweep()).resolves.toEqual({ attempted: 1, reconciled: 0, failed: 1, skipped: 0 });
        expect(calls.length).toBeGreaterThan(callsAfterFailure);
        expect(await failedRuns(fixture.repositoryId, baseline.runId!)).toEqual(Array.from({ length: 3 }, () => (
          { status: "FAILED", error_message: "Reconciliation failed." }
        )));
      }
      expect(await materializedHistory()).toEqual(history);
      expect(await store.getReconciliationCooldown(fixture.repositoryId)).toEqual(cooldown);
      expect(serverErrors).toEqual([]);
    } finally {
      errorLog.mockRestore();
      await closeServer(server);
      await sql`update registered_repositories set active = false where id = ${fixture.repositoryId}`;
    }
  });
});

async function registeredRepository() {
  const githubRepositoryId = externalId;
  externalId += 1000;
  const sponsorLogin = `sponsor-${githubRepositoryId}`;
  const contributorLogin = `contributor-${githubRepositoryId}`;
  const contributorGitHubId = githubRepositoryId + 2;
  const ownerName = `${sponsorLogin}/repository`;
  const [{ id: sponsorId }] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, encrypted_oauth_token)
    values (${githubRepositoryId + 1}, ${sponsorLogin}, ${Buffer.from(encryptToken(token, key), "utf8")}) returning id
  `;
  const [{ id: contributorId }] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (${contributorGitHubId}, ${contributorLogin}) returning id
  `;
  const [{ id: repositoryId }] = await sql<{ id: string }[]>`
    insert into registered_repositories (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
    values (${githubRepositoryId}, ${ownerName}, ${sponsorId}, 'PUBLIC', ${githubRepositoryId}, ${sql.json(scheme)}) returning id
  `;
  return { repositoryId, githubRepositoryId, ownerName, sponsorId, contributorId, sponsorLogin, contributorLogin, contributorGitHubId };
}

type RepositoryFixture = Awaited<ReturnType<typeof registeredRepository>>;

function issueNode(fixture: RepositoryFixture, number: number, changed: boolean) {
  const id = fixture.githubRepositoryId + 10 + number;
  const actualLabel = changed ? "delivered/7" : "delivered/6";
  return {
    databaseId: id, number, title: changed ? "Changed issue" : "Original issue", body: "", state: "CLOSED",
    url: `https://github.com/${fixture.ownerName}/issues/${number}`, createdAt: "2026-09-01T07:00:00.000Z",
    author: { login: fixture.sponsorLogin }, assignees: { nodes: [] },
    labels: { nodes: [{ name: "M" }, { name: actualLabel }], pageInfo },
    timelineItems: { nodes: [
      { __typename: "LabeledEvent", id: `opening-${id}`, actor: { login: fixture.sponsorLogin },
        createdAt: "2026-09-01T08:00:00.000Z", label: { name: "M" } },
      { __typename: "LabeledEvent", id: `actual-${id}`, actor: { login: fixture.sponsorLogin },
        createdAt: "2026-09-01T11:00:00.000Z", label: { name: actualLabel } },
      { __typename: "IssueComment", id: `comment-${id}`, databaseId: id + 300,
        author: { login: fixture.sponsorLogin }, body: `Settled as ${actualLabel}.`,
        createdAt: "2026-09-01T11:30:00.000Z", lastEditedAt: null },
    ], pageInfo },
    closedByPullRequestsReferences: { nodes: number === 1 ? [{
      databaseId: id + 100, number: 11, title: "PR", body: "", state: "MERGED",
      url: `https://github.com/${fixture.ownerName}/pull/11`, mergedAt: "2026-09-01T12:00:00.000Z" as string | null,
      mergeCommit: { oid: id.toString(16).padStart(40, "0") } as { oid: string } | null,
      commits: { nodes: [{ commit: { committedDate: "2026-09-01T10:00:00.000Z" } }] },
      author: { login: fixture.contributorLogin, databaseId: fixture.contributorGitHubId },
      repository: { nameWithOwner: fixture.ownerName },
    }] : [], pageInfo },
  };
}

function successResponse(fixture: RepositoryFixture, operation: string, changed: boolean, failure: Failure) {
  const continuation = changed && operation === failure.operation ? { hasNextPage: true, endCursor: "next" } : pageInfo;
  if (operation === "RepositoryIssues") {
    const issue = issueNode(fixture, 1, changed);
    if (changed && failure.operation === "ClosingPullRequests") {
      const pullRequest = issue.closedByPullRequestsReferences.nodes[0]!;
      issue.closedByPullRequestsReferences = {
        nodes: [pullRequest, ...Array.from({ length: 19 }, (_, index) => ({
          ...pullRequest, databaseId: pullRequest.databaseId + index + 1, number: 12 + index,
          state: "CLOSED", mergedAt: null, mergeCommit: null,
        }))], pageInfo: { hasNextPage: true, endCursor: "next" },
      };
    }
    return { data: { repository: { issues: { nodes: changed ? [issue, issueNode(fixture, 2, true)] : [issue], pageInfo } } } };
  }
  const reviewId = fixture.githubRepositoryId + 200;
  if (operation === "PullRequestReviews") {
    return { data: { repository: { pullRequest: { reviews: {
      nodes: [{ databaseId: reviewId, state: "DISMISSED", submittedAt: "2026-09-01T09:00:00.000Z" }], pageInfo: continuation,
    } } } } };
  }
  if (operation === "PullRequestReviewDismissals") {
    return { data: { repository: { pullRequest: { timelineItems: {
      nodes: [{ __typename: "ReviewDismissedEvent", review: { databaseId: reviewId },
        createdAt: "2026-09-01T13:00:00.000Z", previousReviewState: "CHANGES_REQUESTED" }], pageInfo: continuation,
    } } } } };
  }
  throw new Error(`Unexpected GraphQL operation: ${operation}`);
}

async function failedRuns(repositoryId: string, baselineRunId: string) {
  return sql`select status, error_message from reconciliation_runs where repository_id = ${repositoryId} and id <> ${baselineRunId} order by started_at, id`;
}

async function materializedHistory() {
  // This suite owns the database; compare every materialized row, including IDs,
  // timestamps, evidence links, change history and the derived ledger/balances.
  return Promise.all([
    sql`select * from issues order by id`,
    sql`select * from pull_requests order by id`,
    sql`select * from pull_request_issues order by pull_request_id, issue_id`,
    sql`select * from review_rounds order by id`,
    sql`select * from settlements order by id`,
    sql`select * from self_work_calibrations order by id`,
    sql`select * from unwritable_closures order by id`,
    sql`select * from reconciliation_changes order by id`,
    sql`select * from ledger_entries order by settlement_id, account_id`,
    sql`select * from balances order by account_id`,
  ]);
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeIdleConnections();
  });
}
