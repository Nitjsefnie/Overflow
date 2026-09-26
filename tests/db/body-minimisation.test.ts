import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import type { GitHubIssue, GitHubPullRequest } from "@/lib/github/types";
import { credentialBinding, encryptToken } from "@/lib/security/token-cipher";
import { verifiedRepositoryAt } from "../support/verified-repository";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;
const tokenEncryptionKey = Buffer.alloc(32, 29).toString("base64url");

const openIssueGitHubId = 9_810_001;
const closedIssueGitHubId = 9_810_002;
const closingPullRequestGitHubId = 9_810_003;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "body_minimisation_test",
    user: "body_minimisation_test",
    password: "body_minimisation_test",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe("materialized body text is not persisted", () => {
  it("leaves the issues and pull requests body columns nullable", async () => {
    const columns = await sql<{ table_name: string; is_nullable: string }[]>`
      select table_name, is_nullable from information_schema.columns
      where table_name in ('issues', 'pull_requests') and column_name = 'body'
      order by table_name
    `;
    expect(columns).toEqual([
      { table_name: "issues", is_nullable: "YES" },
      { table_name: "pull_requests", is_nullable: "YES" },
    ]);
  });

  it("materializes null bodies when the evidence carried body text", async () => {
    const { repositoryId, store } = await registerRepository({
      githubRepositoryId: 9_820_001,
      ownerName: "example/body-minimisation",
      githubWebhookId: 9_820_002,
      sponsorLogin: "body-sponsor-one",
      sponsorGitHubUserId: 9_830_001,
    });
    const closingPullRequest = mergedPullRequest({
      id: closingPullRequestGitHubId,
      number: 11,
      ownerName: "example/body-minimisation",
      githubRepositoryId: 9_820_001,
    });
    const issues: GitHubIssue[] = [
      openIssue({ id: openIssueGitHubId, number: 1, ownerLogin: "body-sponsor-one" }),
      {
        ...openIssue({ id: closedIssueGitHubId, number: 2, ownerLogin: "body-sponsor-one" }),
        state: "CLOSED",
        stateReason: "COMPLETED",
        closedAt: "2026-09-01T12:01:00.000Z",
        claimAssigneeGitHubLogin: "body-contributor-one",
        closingPullRequests: [closingPullRequest],
      },
    ];

    await reconcile(store, gateway("example/body-minimisation", () => issues), repositoryId);

    // The evidence carried body text for both kinds — the gateway fixtures
    // above set it — and the materialized rows still hold none of it, while
    // every raw field that is still read keeps flowing.
    await expect(sql<{ title: string; body: string | null }[]>`
      select title, body from issues where repository_id = ${repositoryId} order by issue_number
    `).resolves.toEqual([
      { title: "An issue kept without its body 1", body: null },
      { title: "An issue kept without its body 2", body: null },
    ]);
    await expect(sql<{ title: string; body: string | null }[]>`
      select title, body from pull_requests where repository_id = ${repositoryId} order by pull_request_number
    `).resolves.toEqual([{ title: "A merged pull request 11", body: null }]);
  });

  it("keeps a stored body untouched when the fold re-materializes the row", async () => {
    const { repositoryId, store } = await registerRepository({
      githubRepositoryId: 9_820_003,
      ownerName: "example/body-minimisation-two",
      githubWebhookId: 9_820_004,
      sponsorLogin: "body-sponsor-two",
      sponsorGitHubUserId: 9_830_002,
    });
    const issues: GitHubIssue[] = [openIssue({ id: openIssueGitHubId + 10, number: 1, ownerLogin: "body-sponsor-two" })];
    await reconcile(store, gateway("example/body-minimisation-two", () => issues), repositoryId);

    // A value that predates the minimisation (the migration leaves existing
    // rows alone) survives a re-fold: the fold no longer writes the column in
    // either the insert or the on-conflict update.
    await sql`update issues set body = 'legacy body text' where repository_id = ${repositoryId}`;
    await reconcile(store, gateway("example/body-minimisation-two", () => issues), repositoryId);

    await expect(sql<{ body: string | null }[]>`
      select body from issues where repository_id = ${repositoryId}
    `).resolves.toEqual([{ body: "legacy body text" }]);
  });
});

async function reconcile(
  store: PostgresFoldStore,
  github: ReconciliationGateway,
  repositoryId: string,
): Promise<void> {
  const summary = await reconcileRepository({ store, github }, repositoryId, { rederive: true });
  if (summary.skipped) {
    throw new Error("Expected the reconciliation to run.");
  }
}

async function registerRepository(input: {
  githubRepositoryId: number;
  ownerName: string;
  githubWebhookId: number;
  sponsorLogin: string;
  sponsorGitHubUserId: number;
}): Promise<{ repositoryId: string; store: PostgresFoldStore }> {
  const sponsorId = await insertUser(input.sponsorLogin, input.sponsorGitHubUserId);
  await sql`
    update users
    set encrypted_oauth_token = ${Buffer.from(encryptToken("body-token", tokenEncryptionKey, credentialBinding.userOAuthToken(input.sponsorGitHubUserId)), "utf8")}
    where id = ${sponsorId}
  `;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    )
    values (
      ${input.githubRepositoryId}, ${input.ownerName}, ${sponsorId}, ${"PUBLIC"}, ${input.githubWebhookId},
      ${sql.json(difficultyScheme())}::jsonb
    )
    returning id
  `;
  return {
    repositoryId: repository.id,
    store: new PostgresFoldStore(sql, tokenEncryptionKey),
  };
}

async function insertUser(githubLogin: string, githubUserId: number): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${githubLogin})
    returning id
  `;
  return user.id;
}

function difficultyScheme() {
  return {
    openingName: "Scope",
    actualName: "Delivered difficulty",
    openingLabels: [
      { label: "S", comparisonPoints: 2, reservePoints: 2 },
      { label: "M", comparisonPoints: 5, reservePoints: 5 },
      { label: "L", comparisonPoints: 8, reservePoints: 8 },
    ],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}

function gateway(ownerName: string, issuesNow: () => readonly GitHubIssue[]): ReconciliationGateway {
  return {
    getIssue: async () => null,
    getPullRequestClosingIssues: async () => [],
    getRepositoryById: verifiedRepositoryAt(ownerName),
    listIssues: async () => issuesNow().map((issue) => ({ ...issue })),
    getPullRequestReviews: async () => [],
    getPullRequestDiff: async (_repository, pullRequestNumber) => `body-minimisation diff ${pullRequestNumber}`,
  };
}

function openIssue(input: { id: number; number: number; ownerLogin: string }): GitHubIssue {
  return {
    id: input.id,
    number: input.number,
    title: `An issue kept without its body ${input.number}`,
    updatedAt: "2026-09-01T12:05:00.000Z",
    body: `Issue ${input.number} body the store must not keep`,
    url: `https://github.com/example/body-minimisation/issues/${input.number}`,
    state: "OPEN",
    stateReason: null,
    createdAt: "2026-09-01T08:00:00.000Z",
    closedAt: null,
    authorLogin: input.ownerLogin,
    authorGitHubUserId: null,
    labels: ["M"],
    claimAssigneeGitHubLogin: null,
    claimAssigneeGitHubUserId: null,
    history: [
      {
        kind: "LABELED",
        id: `opening-${input.id}`,
        actorLogin: input.ownerLogin,
        actorGitHubUserId: null,
        label: "M",
        createdAt: "2026-09-01T08:01:00.000Z",
      },
    ],
    comments: [],
    closingPullRequests: [],
  };
}

function mergedPullRequest(input: {
  id: number;
  number: number;
  ownerName: string;
  githubRepositoryId: number;
}): GitHubPullRequest {
  return {
    id: input.id,
    number: input.number,
    title: `A merged pull request ${input.number}`,
    body: "Pull request body the store must not keep",
    url: `https://github.com/example/body-minimisation/pull/${input.number}`,
    state: "MERGED",
    mergedAt: "2026-09-01T12:00:00.000Z",
    mergeCommitOid: "c".repeat(40),
    finalCommitAt: "2026-09-01T10:00:00.000Z",
    authorLogin: "body-contributor-one",
    authorGitHubUserId: null,
    repositoryGitHubId: input.githubRepositoryId,
    repositoryNameWithOwner: input.ownerName,
  };
}
