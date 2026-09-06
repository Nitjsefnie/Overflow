import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { verifiedRepositoryAt } from "../support/verified-repository";
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

  // The issue author and the account that priced the issue are different
  // accounts here, which is the ordinary production shape: an opening label only
  // counts from the repository sponsor, while anyone may open the issue. Sharing
  // one login between them would make `owner_github_login` and
  // `opening_source_actor_login` indistinguishable, and a store that wrote either
  // column from the other's value would still look correct.
  it("moves only the author's display login when GitHub renames the account that opened the issue", async () => {
    const raterLogin = `reconcile-rater-${externalId++}`;
    const authorLogin = `reconcile-author-old-${externalId++}`;
    const renamedAuthorLogin = `reconcile-author-new-${externalId++}`;
    const { store, repositoryId, githubIssueId, ownerName } = await registeredRepository(raterLogin);
    let issue = openedIssue({ githubIssueId, authorLogin, raterLogin, title: "An opened issue" });
    const github: ReconciliationGateway = {
      listIssues: async () => [issue],
      getPullRequestReviews: async () => [],
      getPullRequestDiff: async () => "",
      getRepositoryById: verifiedRepositoryAt(ownerName),
    };

    await expect(reconcileRepository({ store, github }, repositoryId)).resolves.toMatchObject({ skipped: false });
    await expect(storedIssue(githubIssueId)).resolves.toEqual([
      openedIssueRow({ githubIssueId, title: "An opened issue", ownerLogin: authorLogin, actorLogin: raterLogin }),
    ]);

    // GitHub renames the author's account. The login GitHub reports for the
    // issue's author moves with it, the labelling event keeps its actor, its node
    // id and its timestamp, and so does the actor login displayed beside it.
    issue = openedIssue({
      githubIssueId,
      authorLogin: renamedAuthorLogin,
      raterLogin,
      title: "A renamed author's opened issue",
    });

    await expect(reconcileRepository({ store, github }, repositoryId)).resolves.toMatchObject({ skipped: false });
    await expect(sql`
      select status from reconciliation_runs where repository_id = ${repositoryId} order by started_at
    `).resolves.toEqual([{ status: "COMPLETED" }, { status: "COMPLETED" }]);
    await expect(storedIssue(githubIssueId)).resolves.toEqual([
      openedIssueRow({
        githubIssueId,
        title: "A renamed author's opened issue",
        ownerLogin: renamedAuthorLogin,
        actorLogin: raterLogin,
      }),
    ]);
  });

  it("moves only the opening actor's display login when GitHub renames the account that priced the issue", async () => {
    const raterLogin = `reconcile-rater-old-${externalId++}`;
    const renamedRaterLogin = `reconcile-rater-new-${externalId++}`;
    const authorLogin = `reconcile-author-${externalId++}`;
    const { store, repositoryId, sponsorId, githubIssueId, ownerName } = await registeredRepository(raterLogin);
    let issue = openedIssue({ githubIssueId, authorLogin, raterLogin, title: "An opened issue" });
    const github: ReconciliationGateway = {
      listIssues: async () => [issue],
      getPullRequestReviews: async () => [],
      getPullRequestDiff: async () => "",
      getRepositoryById: verifiedRepositoryAt(ownerName),
    };

    await expect(reconcileRepository({ store, github }, repositoryId)).resolves.toMatchObject({ skipped: false });
    await expect(storedIssue(githubIssueId)).resolves.toEqual([
      openedIssueRow({ githubIssueId, title: "An opened issue", ownerLogin: authorLogin, actorLogin: raterLogin }),
    ]);

    // GitHub renames the sponsor's account, so the labelling event reports the
    // new login against the same unchanged event. The stored account row follows,
    // the actor's display text follows, and the author's login does not move.
    issue = openedIssue({
      githubIssueId,
      authorLogin,
      raterLogin: renamedRaterLogin,
      title: "A renamed rater's opened issue",
    });
    await sql`update users set github_login = ${renamedRaterLogin} where id = ${sponsorId}`;

    await expect(reconcileRepository({ store, github }, repositoryId)).resolves.toMatchObject({ skipped: false });
    await expect(sql`
      select status from reconciliation_runs where repository_id = ${repositoryId} order by started_at
    `).resolves.toEqual([{ status: "COMPLETED" }, { status: "COMPLETED" }]);
    await expect(storedIssue(githubIssueId)).resolves.toEqual([
      openedIssueRow({
        githubIssueId,
        title: "A renamed rater's opened issue",
        ownerLogin: authorLogin,
        actorLogin: renamedRaterLogin,
      }),
    ]);
  });
});

async function storedIssue(githubIssueId: number) {
  return sql`
    select title, owner_github_login, opening_source_actor_login, opening_source_event_id,
           opening_source_at, opening_label, opening_comparison_points, opening_reserve_points
    from issues where github_issue_id = ${githubIssueId}
  `;
}

function openedIssue(
  input: { githubIssueId: number; authorLogin: string; raterLogin: string; title: string },
): GitHubIssue {
  return {
    id: input.githubIssueId,
    number: 1,
    title: input.title,
    body: "Issue body",
    url: "https://github.com/example/renamed/issues/1",
    state: "OPEN",
    createdAt: "2026-09-01T08:00:00.000Z",
    closedAt: null,
    authorLogin: input.authorLogin,
    labels: ["M"],
    claimAssigneeGitHubLogin: null,
    history: [{
      kind: "LABELED",
      id: `opening-${input.githubIssueId}`,
      actorLogin: input.raterLogin,
      label: "M",
      createdAt: "2026-09-01T08:01:00.000Z",
    }],
    comments: [],
    closingPullRequests: [],
  };
}

function openedIssueRow(
  input: { githubIssueId: number; title: string; ownerLogin: string; actorLogin: string },
) {
  return {
    title: input.title,
    owner_github_login: input.ownerLogin,
    opening_source_actor_login: input.actorLogin,
    opening_source_event_id: `opening-${input.githubIssueId}`,
    opening_source_at: new Date("2026-09-01T08:01:00.000Z"),
    opening_label: "M",
    opening_comparison_points: 5,
    opening_reserve_points: 5,
  };
}

async function registeredRepository(ownerLogin: string) {
  const githubRepositoryId = externalId++;
  const ownerName = `renamed/repo-${githubRepositoryId}`;
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
    values (${githubRepositoryId}, ${ownerName}, ${sponsorId}, 'PUBLIC',
      ${externalId++}, ${sql.json(difficultyScheme)})
    returning id
  `;
  return {
    store: new PostgresFoldStore(sql, tokenEncryptionKey),
    repositoryId,
    sponsorId,
    githubIssueId: externalId++,
    ownerName,
  };
}
