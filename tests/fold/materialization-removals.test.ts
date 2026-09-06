import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import type { GitHubIssue, GitHubPullRequest } from "@/lib/github/types";
import { encryptToken } from "@/lib/security/token-cipher";
import { verifiedRepositoryAt } from "../support/verified-repository";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;
const tokenEncryptionKey = Buffer.alloc(32, 29).toString("base64url");

const abandonedIssueGitHubId = 9_100_001;
const reopenedIssueGitHubId = 9_100_002;
const withdrawnPullRequestGitHubId = 9_100_003;
const survivingIssueGitHubId = 9_100_004;

type ChangeRow = {
  entity_kind: string;
  change_kind: string;
  pull_request_id: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
};

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "overflow_removal_fold_test",
    user: "overflow_removal_fold_test",
    password: "overflow_removal_fold_test",
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

describe("a reconciliation that deletes materialized rows says so", () => {
  it("counts and records an issue that left the fold", async () => {
    const { repositoryId, store, ownerName } = await registerRepository({
      githubRepositoryId: 9_200_001,
      ownerName: "example/abandoned-issue",
      githubWebhookId: 9_200_002,
      sponsorLogin: "removal-sponsor-one",
      sponsorGitHubUserId: 9_300_001,
    });
    let issues: GitHubIssue[] = [openIssue({ id: abandonedIssueGitHubId, number: 1, ownerName, ownerLogin: "removal-sponsor-one" })];
    const github = gateway(ownerName, () => issues);

    const first = await reconcile(store, github, repositoryId);
    expect(first.removals).toBe(0);
    await expect(materializedIssueIds(repositoryId)).resolves.toEqual([abandonedIssueGitHubId]);

    // The issue is gone from GitHub's answer, so the fold no longer contains it
    // and materialization deletes the row it left behind.
    issues = [];
    const second = await reconcile(store, github, repositoryId);

    await expect(materializedIssueIds(repositoryId)).resolves.toEqual([]);
    const removals = await removalChanges(second.runId);
    expect(removals).toEqual([
      {
        entity_kind: "ISSUE",
        change_kind: "REMOVE",
        pull_request_id: null,
        before_state: {
          githubIssueId: abandonedIssueGitHubId,
          openingLabel: "M",
          openingComparisonPoints: 5,
          openingReservePoints: 5,
        },
        after_state: null,
      },
    ]);
    expect(second.removals).toBe(removals.length);
    expect(second.removed).toBe(removals.length);
  });

  it("counts and records a pull request that left the fold", async () => {
    const sponsorLogin = "removal-sponsor-two";
    const contributorLogin = "removal-contributor-two";
    const contributorGitHubUserId = 9_300_003;
    await insertUser(contributorLogin, contributorGitHubUserId);
    const { repositoryId, store, ownerName } = await registerRepository({
      githubRepositoryId: 9_200_003,
      ownerName: "example/withdrawn-pull-request",
      githubWebhookId: 9_200_004,
      sponsorLogin,
      sponsorGitHubUserId: 9_300_002,
    });
    const closingPullRequest = mergedPullRequest({
      id: withdrawnPullRequestGitHubId,
      number: 11,
      ownerName,
      githubRepositoryId: 9_200_003,
      authorLogin: contributorLogin,
      authorGitHubUserId: contributorGitHubUserId,
    });
    let issues: GitHubIssue[] = [{
      ...openIssue({ id: reopenedIssueGitHubId, number: 2, ownerName, ownerLogin: sponsorLogin }),
      state: "CLOSED",
      claimAssigneeGitHubLogin: contributorLogin,
      closingPullRequests: [closingPullRequest],
    }];
    const github = gateway(ownerName, () => issues);

    await reconcile(store, github, repositoryId);
    await expect(materializedPullRequestIds(repositoryId)).resolves.toEqual([withdrawnPullRequestGitHubId]);

    // The issue is open again and closes nothing, so the pull request leaves the
    // fold while the issue stays.
    issues = [{ ...issues[0], state: "OPEN", closingPullRequests: [] }];
    const second = await reconcile(store, github, repositoryId);

    await expect(materializedPullRequestIds(repositoryId)).resolves.toEqual([]);
    await expect(materializedIssueIds(repositoryId)).resolves.toEqual([reopenedIssueGitHubId]);
    const removals = await removalChanges(second.runId);
    expect(removals.filter((change) => change.entity_kind === "PULL_REQUEST")).toEqual([
      {
        entity_kind: "PULL_REQUEST",
        change_kind: "REMOVE",
        // Migration 004 nulls this reference when the row it names is deleted,
        // so the removed pull request is only legible in before_state.
        pull_request_id: null,
        before_state: { githubPullRequestId: withdrawnPullRequestGitHubId },
        after_state: null,
      },
    ]);
    expect(second.removals).toBe(removals.length);
    expect(second.removed).toBe(removals.length);
  });

  it("records no removal for a reconciliation that removes nothing", async () => {
    const { repositoryId, store, ownerName } = await registerRepository({
      githubRepositoryId: 9_200_005,
      ownerName: "example/unchanged-fold",
      githubWebhookId: 9_200_006,
      sponsorLogin: "removal-sponsor-three",
      sponsorGitHubUserId: 9_300_004,
    });
    const issues = [openIssue({ id: survivingIssueGitHubId, number: 3, ownerName, ownerLogin: "removal-sponsor-three" })];
    const github = gateway(ownerName, () => issues);

    await reconcile(store, github, repositoryId);
    const second = await reconcile(store, github, repositoryId);

    await expect(materializedIssueIds(repositoryId)).resolves.toEqual([survivingIssueGitHubId]);
    await expect(removalChanges(second.runId)).resolves.toEqual([]);
    expect(second.removals).toBe(0);
    expect(second.removed).toBe(0);
  });
});

async function reconcile(
  store: PostgresFoldStore,
  github: ReconciliationGateway,
  repositoryId: string,
): Promise<{ runId: string; removals: number; removed: number }> {
  const summary = await reconcileRepository({ store, github }, repositoryId);
  if (summary.skipped) {
    throw new Error("Expected the reconciliation to run.");
  }
  return { runId: summary.runId, removals: summary.removals, removed: summary.removed };
}

async function removalChanges(runId: string): Promise<ChangeRow[]> {
  return sql<ChangeRow[]>`
    select entity_kind, change_kind, pull_request_id, before_state, after_state
    from reconciliation_changes
    where reconciliation_run_id = ${runId} and change_kind = ${"REMOVE"}
    order by entity_kind asc
  `;
}

async function materializedIssueIds(repositoryId: string): Promise<number[]> {
  const rows = await sql<{ github_issue_id: number | string }[]>`
    select github_issue_id from issues where repository_id = ${repositoryId} order by github_issue_id asc
  `;
  return rows.map((row) => Number(row.github_issue_id));
}

async function materializedPullRequestIds(repositoryId: string): Promise<number[]> {
  const rows = await sql<{ github_pull_request_id: number | string }[]>`
    select github_pull_request_id from pull_requests
    where repository_id = ${repositoryId} order by github_pull_request_id asc
  `;
  return rows.map((row) => Number(row.github_pull_request_id));
}

async function registerRepository(input: {
  githubRepositoryId: number;
  ownerName: string;
  githubWebhookId: number;
  sponsorLogin: string;
  sponsorGitHubUserId: number;
}): Promise<{ repositoryId: string; store: PostgresFoldStore; ownerName: string }> {
  const sponsorId = await insertUser(input.sponsorLogin, input.sponsorGitHubUserId);
  await sql`
    update users
    set encrypted_oauth_token = ${Buffer.from(encryptToken("removal-token", tokenEncryptionKey), "utf8")}
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
    ownerName: input.ownerName,
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
    getRepositoryById: verifiedRepositoryAt(ownerName),
    listIssues: async () => issuesNow().map((issue) => ({ ...issue })),
    getPullRequestReviews: async () => [],
    getPullRequestDiff: async (_repository, pullRequestNumber) => `removal diff ${pullRequestNumber}`,
  };
}

function openIssue(input: { id: number; number: number; ownerName: string; ownerLogin: string }): GitHubIssue {
  return {
    id: input.id,
    number: input.number,
    title: `An issue whose materialization can be removed ${input.number}`,
    body: "Issue evidence",
    url: `https://github.com/${input.ownerName}/issues/${input.number}`,
    state: "OPEN",
    createdAt: "2026-09-01T08:00:00.000Z",
    closedAt: null,
    authorLogin: input.ownerLogin,
    authorGitHubUserId: null,
    labels: ["M"],
    claimAssigneeGitHubLogin: null,
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
  authorLogin: string;
  authorGitHubUserId: number;
}): GitHubPullRequest {
  return {
    id: input.id,
    number: input.number,
    title: `A merged pull request ${input.number}`,
    body: "Pull request evidence",
    url: `https://github.com/${input.ownerName}/pull/${input.number}`,
    state: "MERGED",
    mergedAt: "2026-09-01T12:00:00.000Z",
    mergeCommitOid: input.id.toString(16).padStart(40, "0"),
    finalCommitAt: "2026-09-01T10:00:00.000Z",
    authorLogin: input.authorLogin,
    authorGitHubUserId: input.authorGitHubUserId,
    repositoryGitHubId: input.githubRepositoryId,
    repositoryNameWithOwner: input.ownerName,
  };
}
