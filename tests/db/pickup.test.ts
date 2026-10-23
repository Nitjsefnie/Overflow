import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { closeSql, getSql } from "@/lib/db/client";
import { listPickup } from "@/lib/dashboard/ledger-panels";
import type { DashboardSql } from "@/lib/dashboard/queries";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 6_500_000;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;

describe("pickup stock", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "pickup_test", user: "pickup_test" });
    container = started.container;
    process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
    execFileSync("pnpm", ["db:migrate"], { env: process.env, stdio: "pipe" });
    sql = getSql();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.OVERFLOW_DATABASE_URL;
    else process.env.OVERFLOW_DATABASE_URL = originalDatabaseUrl;
  });

  it("reads posted prices for open outside assignments and unassigned issues, excluding sponsor assignments and closed issues", async () => {
    expect(await listPickup()).toEqual({
      outsideAssignedPostedPrice: 0, unassignedPostedPrice: 0,
      outsideAssignedIssueCount: 0, unassignedIssueCount: 0,
    });

    const first = await insertRepository();
    const second = await insertRepository();
    await insertIssue(first.id, 6, first.login, second.githubUserId);
    await insertIssue(first.id, 7, null, null);
    await insertIssue(first.id, 10, "renamed-sponsor", first.githubUserId);
    await insertIssue(first.id, 3, "pending-identity", null);
    await insertIssue(first.id, 2, null, second.githubUserId);
    await insertIssue(second.id, 5, first.login, first.githubUserId);
    await insertIssue(second.id, 8, second.login, second.githubUserId);
    await insertIssue(first.id, 10, "outside", second.githubUserId, "CLOSED");
    await insertIssue(first.id, 9, null, null, "CLOSED");
    await insertIssue(first.id, 8, first.login, first.githubUserId, "CLOSED");

    const pickup = await sql.begin(async (transaction) => {
      await transaction`set transaction read only`;
      return listPickup({ sql: transaction as unknown as DashboardSql });
    });
    expect(pickup).toEqual({
      outsideAssignedPostedPrice: 14, unassignedPostedPrice: 9,
      outsideAssignedIssueCount: 3, unassignedIssueCount: 2,
    });
  });
});

async function insertRepository(): Promise<{ id: string; githubUserId: number; login: string }> {
  const githubUserId = ++externalId;
  const login = `sponsor-${githubUserId}`;
  const [sponsor] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (${githubUserId}, ${login}) returning id
  `;
  const githubRepositoryId = ++externalId;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    ) values (
      ${githubRepositoryId}, ${`${login}/repository`}, ${sponsor.id}, 'PUBLIC',
      ${++externalId}, ${sql.json(validDifficultyScheme())}::jsonb
    ) returning id
  `;
  return { id: repository.id, githubUserId, login };
}

async function insertIssue(
  repositoryId: string, postedPrice: number, assigneeLogin: string | null,
  assigneeId: number | null, state: "OPEN" | "CLOSED" = "OPEN",
): Promise<void> {
  const githubIssueId = ++externalId;
  await sql`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points,
      claim_assignee_github_login, claim_assignee_github_user_id
    ) values (
      ${githubIssueId}, ${repositoryId}, ${++externalId}, 'Pickup fixture', 'Issue evidence',
      ${`https://github.com/example/repository/issues/${githubIssueId}`}, ${state},
      'size/M', 1, ${postedPrice}, ${assigneeLogin}, ${assigneeId}
    )
  `;
}
