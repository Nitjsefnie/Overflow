import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import type { GitHubIssue } from "@/lib/github/types";
import { encryptToken } from "@/lib/security/token-cipher";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 9_700_000;
const originalDatabaseUrl = process.env.DATABASE_URL;
const tokenEncryptionKey = Buffer.alloc(32, 31).toString("base64url");

describe("reconciliation after the opening account is renamed", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "rename", user: "rename", password: "rename" });
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

  it("reconciles an opened issue again after GitHub renames the account that opened it", async () => {
    const ownerLogin = `reconcile-owner-old-${externalId++}`;
    const renamedOwnerLogin = `reconcile-owner-new-${externalId++}`;
    const { store, repositoryId, sponsorId, githubIssueId } = await registeredRepository(ownerLogin);
    let issue = openedIssue({ githubIssueId, actorLogin: ownerLogin, title: "An opened issue" });
    const github: ReconciliationGateway = {
      listIssues: async () => [issue],
      getPullRequestReviews: async () => [],
      getPullRequestDiff: async () => "",
    };

    await expect(reconcileRepository({ store, github }, repositoryId)).resolves.toMatchObject({ skipped: false });
    await expect(storedIssue(githubIssueId)).resolves.toEqual([{
      title: "An opened issue",
      owner_github_login: ownerLogin,
      opening_source_actor_login: ownerLogin,
      opening_source_event_id: `opening-${githubIssueId}`,
      opening_source_at: new Date("2026-09-01T08:01:00.000Z"),
      opening_label: "M",
      opening_comparison_points: 5,
      opening_reserve_points: 5,
    }]);

    // GitHub renames the account. Every login GitHub reports moves with it, and
    // the stored account row follows, while the labelling event that priced the
    // issue keeps its node id and its timestamp.
    issue = openedIssue({ githubIssueId, actorLogin: renamedOwnerLogin, title: "A renamed owner's opened issue" });
    await sql`update users set github_login = ${renamedOwnerLogin} where id = ${sponsorId}`;

    await expect(reconcileRepository({ store, github }, repositoryId)).resolves.toMatchObject({ skipped: false });
    await expect(sql`
      select status from reconciliation_runs where repository_id = ${repositoryId} order by started_at
    `).resolves.toEqual([{ status: "COMPLETED" }, { status: "COMPLETED" }]);
    await expect(storedIssue(githubIssueId)).resolves.toEqual([{
      title: "A renamed owner's opened issue",
      owner_github_login: renamedOwnerLogin,
      opening_source_actor_login: renamedOwnerLogin,
      opening_source_event_id: `opening-${githubIssueId}`,
      opening_source_at: new Date("2026-09-01T08:01:00.000Z"),
      opening_label: "M",
      opening_comparison_points: 5,
      opening_reserve_points: 5,
    }]);
  });
});

async function storedIssue(githubIssueId: number) {
  return sql`
    select title, owner_github_login, opening_source_actor_login, opening_source_event_id,
           opening_source_at, opening_label, opening_comparison_points, opening_reserve_points
    from issues where github_issue_id = ${githubIssueId}
  `;
}

function openedIssue(input: { githubIssueId: number; actorLogin: string; title: string }): GitHubIssue {
  return {
    id: input.githubIssueId,
    number: 1,
    title: input.title,
    body: "Issue body",
    url: "https://github.com/example/renamed/issues/1",
    state: "OPEN",
    createdAt: "2026-09-01T08:00:00.000Z",
    authorLogin: input.actorLogin,
    labels: ["M"],
    claimAssigneeGitHubLogin: null,
    history: [{
      kind: "LABELED",
      id: `opening-${input.githubIssueId}`,
      actorLogin: input.actorLogin,
      label: "M",
      createdAt: "2026-09-01T08:01:00.000Z",
    }],
    comments: [],
    closingPullRequests: [],
  };
}

async function registeredRepository(ownerLogin: string) {
  const githubRepositoryId = externalId++;
  const [{ id: sponsorId }] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, encrypted_oauth_token)
    values (${externalId++}, ${ownerLogin},
      ${Buffer.from(encryptToken("rename-token", tokenEncryptionKey), "utf8")})
    returning id
  `;
  const difficultyScheme = {
    openingName: "Size",
    actualName: "Delivered",
    openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
  };
  const [{ id: repositoryId }] = await sql<{ id: string }[]>`
    insert into registered_repositories
      (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
    values (${githubRepositoryId}, ${`renamed/repo-${githubRepositoryId}`}, ${sponsorId}, 'PUBLIC',
      ${externalId++}, ${sql.json(difficultyScheme)})
    returning id
  `;
  return {
    store: new PostgresFoldStore(sql, tokenEncryptionKey),
    repositoryId,
    sponsorId,
    githubIssueId: externalId++,
  };
}
