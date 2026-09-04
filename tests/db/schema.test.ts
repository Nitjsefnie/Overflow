import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { GenericContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql, withTransaction } from "@/lib/db/client";

let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;
let sql: Sql;
let externalId = 1_000_000;
const originalDatabaseUrl = process.env.DATABASE_URL;
type QueryableSql = Sql | TransactionSql;

describe("initial PostgreSQL materialization", () => {
  beforeAll(async () => {
    container = await new GenericContainer("postgres:17-alpine")
      .withEnvironment({
        POSTGRES_DB: "overflow_test",
        POSTGRES_PASSWORD: "overflow_test",
        POSTGRES_USER: "overflow_test",
      })
      .withExposedPorts(5432)
      .start();
    process.env.DATABASE_URL = `postgresql://overflow_test:overflow_test@${container.getHost()}:${container.getMappedPort(5432)}/overflow_test`;
    sql = getSql();
    await runMigrations();
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

  it("creates every required relational table and derived view", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public'
    `;

    for (const table of [
      "users",
      "registered_repositories",
      "issues",
      "pull_requests",
      "review_rounds",
      "settlements",
      "self_work_calibrations",
      "unwritable_closures",
      "webhook_deliveries",
      "reconciliation_runs",
      "reconciliation_changes",
      "calibration_audits",
      "moderation_events",
    ]) {
      expect(rows.some((row) => row.table_name === table)).toBe(true);
    }

    const views = await sql<{ table_name: string }[]>`
      select table_name from information_schema.views where table_schema = 'public'
    `;
    expect(views.map((view) => view.table_name)).toEqual(
      expect.arrayContaining(["ledger_entries", "balances", "calibration_statistics"]),
    );
  });

  it("records each numbered migration only once", async () => {
    const [result] = await sql<{ count: number }[]>`
      select count(*)::integer as count from schema_migrations where name = ${"001_initial.sql"}
    `;

    expect(result.count).toBe(1);
  });

  it("rejects out-of-range opening and actual difficulty points", async () => {
    await expect(insertIssue(sql, { comparisonPoints: 11 })).rejects.toThrow();
    await expect(insertPullRequest(sql, { actualPoints: 0 })).rejects.toThrow();
  });

  it("rejects duplicate GitHub user and repository identifiers", async () => {
    const githubUserId = nextExternalId();
    await insertUser(sql, githubUserId);
    await expect(insertUser(sql, githubUserId)).rejects.toThrow();

    const sponsorId = await insertUser(sql);
    const githubRepositoryId = nextExternalId();
    await insertRepository(sql, sponsorId, githubRepositoryId);
    await expect(insertRepository(sql, sponsorId, githubRepositoryId)).rejects.toThrow();
  });

  it("rejects updates to an issue's original opening rating", async () => {
    const issue = await insertIssue(sql);

    await expect(updateOriginalOpeningDifficulty(sql, issue.id)).rejects.toThrow();
  });

  it("rejects duplicate settlement proof fingerprints", async () => {
    const proofFingerprint = "a".repeat(64);
    await insertSettledRecord(proofFingerprint);

    await expect(insertSettledRecord(proofFingerprint)).rejects.toThrow();
  });

  it("derives zero-sum ledger entries and account balances from settlements", async () => {
    const settlement = await insertSettledRecord("b".repeat(64));

    expect(await sumLedgerEntries(sql)).toBe(0);

    const balances = await sql<{ account_id: string; balance: number }[]>`
      select account_id, balance from balances
      where account_id in (${settlement.creditorId}, ${settlement.debtorId})
      order by account_id
    `;
    expect(balances).toEqual([
      { account_id: settlement.creditorId, balance: 4 },
      { account_id: settlement.debtorId, balance: -4 },
    ].sort((left, right) => left.account_id.localeCompare(right.account_id)));
  });

  it("rejects direct writes to every derived view", async () => {
    await expect(sql`insert into ledger_entries default values`).rejects.toThrow();
    await expect(sql`insert into balances default values`).rejects.toThrow();
    await expect(sql`insert into calibration_statistics default values`).rejects.toThrow();
  });
});

function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

async function insertUser(client: QueryableSql, githubUserId = nextExternalId()): Promise<string> {
  const [user] = await client<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${`member-${githubUserId}`})
    returning id
  `;
  return user.id;
}

async function insertRepository(
  client: QueryableSql,
  sponsorId: string,
  githubRepositoryId = nextExternalId(),
): Promise<string> {
  const [repository] = await client<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id,
      owner_name,
      sponsor_id,
      visibility,
      github_webhook_id
    )
    values (
      ${githubRepositoryId},
      ${`owner-${githubRepositoryId}/repository-${githubRepositoryId}`},
      ${sponsorId},
      ${"PUBLIC"},
      ${nextExternalId()}
    )
    returning id
  `;
  return repository.id;
}

async function insertIssue(
  client: QueryableSql,
  options: { comparisonPoints?: number; reservePoints?: number } = {},
): Promise<{ id: string; sponsorId: string; repositoryId: string }> {
  const sponsorId = await insertUser(client);
  const repositoryId = await insertRepository(client, sponsorId);
  const githubIssueId = nextExternalId();
  const [issue] = await client<{ id: string }[]>`
    insert into issues (
      github_issue_id,
      repository_id,
      issue_number,
      title,
      body,
      url,
      state,
      opening_label,
      opening_comparison_points,
      opening_reserve_points
    )
    values (
      ${githubIssueId},
      ${repositoryId},
      ${nextExternalId()},
      ${"An eligible issue"},
      ${"Issue evidence"},
      ${`https://github.com/example/repository/issues/${githubIssueId}`},
      ${"OPEN"},
      ${"size/M"},
      ${options.comparisonPoints ?? 5},
      ${options.reservePoints ?? 5}
    )
    returning id
  `;
  return { id: issue.id, sponsorId, repositoryId };
}

async function insertPullRequest(
  client: QueryableSql,
  options: { actualPoints?: number } = {},
): Promise<{ id: string; issueId: string; sponsorId: string }> {
  const issue = await insertIssue(client);
  const contributorId = await insertUser(client);
  const githubPullRequestId = nextExternalId();
  const [pullRequest] = await client<{ id: string }[]>`
    insert into pull_requests (
      github_pull_request_id,
      repository_id,
      issue_id,
      pull_request_number,
      url,
      title,
      body,
      author_id,
      actual_label,
      actual_points,
      state,
      merged_at
    )
    values (
      ${githubPullRequestId},
      ${issue.repositoryId},
      ${issue.id},
      ${nextExternalId()},
      ${`https://github.com/example/repository/pull/${githubPullRequestId}`},
      ${"A merged contribution"},
      ${"Pull request evidence"},
      ${contributorId},
      ${"delivered/6"},
      ${options.actualPoints ?? 6},
      ${"MERGED"},
      now()
    )
    returning id
  `;
  return { id: pullRequest.id, issueId: issue.id, sponsorId: issue.sponsorId };
}

async function insertSettledRecord(proofFingerprint: string): Promise<{
  creditorId: string;
  debtorId: string;
}> {
  return withTransaction(async (transactionSql) => {
    const pullRequest = await insertPullRequest(transactionSql);
    const creditorId = await insertUser(transactionSql);
    const [settlement] = await transactionSql<{ creditor_id: string; debtor_id: string }[]>`
      insert into settlements (
        pull_request_id,
        issue_id,
        creditor_id,
        debtor_id,
        opening_comparison_points,
        settled_points,
        review_rounds,
        credits,
        proof_sha256,
        status
      )
      values (
        ${pullRequest.id},
        ${pullRequest.issueId},
        ${creditorId},
        ${pullRequest.sponsorId},
        5,
        6,
        2,
        4,
        ${proofFingerprint},
        ${"SETTLED"}
      )
      returning creditor_id, debtor_id
    `;
    return { creditorId: settlement.creditor_id, debtorId: settlement.debtor_id };
  });
}

async function updateOriginalOpeningDifficulty(client: Sql, issueId: string): Promise<void> {
  await client`
    update issues
    set opening_comparison_points = 6
    where id = ${issueId}
  `;
}

async function sumLedgerEntries(client: Sql): Promise<number> {
  const [result] = await client<{ total: number }[]>`
    select coalesce(sum(amount), 0)::integer as total from ledger_entries
  `;
  return result.total;
}
