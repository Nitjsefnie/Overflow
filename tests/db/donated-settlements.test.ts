import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { listCreditIssued } from "@/lib/dashboard/ledger-panels";
import { listAuditCandidates, loadCalibrationCohorts, type DashboardSql } from "@/lib/dashboard/queries";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";
import { createSettledWorkReader } from "@/lib/public-stats";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 86_000_000;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;
const mergedAt = "2026-09-01T12:00:00.000Z";

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "donated_settlements", user: "donated_settlements" });
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

describe("a donated settlement", () => {
  it("moves no points: no ledger leg, balance, credit limit, public stat or outsider calibration pair", async () => {
    const fixture = await buildFixture();
    const before = await readEveryMover(fixture);

    const settlementId = await insertSettlement(fixture);
    const donated = await readEveryMover(fixture, settlementId);
    expect(donated).toEqual({ ...before, settlementLegs: [] });
    expect(donated.ledgerSum).toBe(0);

    // The same row paid out must reach every reader above, or their silence proves nothing.
    await sql`update settlements set status = 'SETTLED', donation_comment_id = null where id = ${settlementId}`;
    const paid = await readEveryMover(fixture, settlementId);
    expect(paid.settlementLegs).toEqual([
      { account_id: fixture.sponsorId, amount: -6 },
      { account_id: fixture.contributorId, amount: 6 },
    ]);
    expect(paid.ledgerSum).toBe(0);
    expect(paid.balances).toEqual([
      { account_id: fixture.sponsorId, balance: -6 },
      { account_id: fixture.contributorId, balance: 6 },
    ].sort(byAccount));
    expect(paid.creditLimits.map((row) => row.account_id)).toEqual([fixture.sponsorId, fixture.contributorId].sort());
    expect(paid.publicStats).toEqual({
      pullRequests: before.publicStats.pullRequests + 1,
      contributors: before.publicStats.contributors + 1,
      points: before.publicStats.points + 6,
    });
    expect(paid.creditIssued).not.toEqual(before.creditIssued);
    expect(paid.storeOutsiderPairs).toHaveLength(1);
    expect(paid.dashboardOutsiderRows).toHaveLength(1);
    expect(paid.auditOutsiderPairCount).toBe(1);
  });
});

type Fixture = Awaited<ReturnType<typeof buildFixture>>;

/** Every reader that would move, sum or count a settlement's credits, read for this fixture. */
async function readEveryMover(fixture: Fixture, settlementId: string = randomUUID()) {
  const accounts = [fixture.sponsorId, fixture.contributorId];
  const dashboardSql = sql as unknown as DashboardSql;
  const [{ total }] = await sql<{ total: number }[]>`
    select coalesce(sum(amount), 0)::integer as total from ledger_entries
  `;
  const stats = await createSettledWorkReader({ sql: dashboardSql })();
  const cohort = await new PostgresModerationStore(sql).loadCalibrationCohort({
    targetAccountId: fixture.sponsorId, repositoryId: null,
    sampleStartedAt: "2026-08-01T00:00:00.000Z", sampleEndedAt: "2026-10-01T00:00:00.000Z",
  });
  const candidate = (await listAuditCandidates({ sql: dashboardSql })).find((row) => row.id === fixture.sponsorId);
  return {
    settlementLegs: [...await sql<{ account_id: string; amount: number }[]>`
      select account_id, amount from ledger_entries where settlement_id = ${settlementId} order by amount
    `],
    ledgerSum: total,
    balances: [...await sql<{ account_id: string; balance: number }[]>`
      select account_id, balance from balances where account_id = any(${accounts}::uuid[]) order by account_id
    `],
    creditLimits: [...await sql<{ account_id: string }[]>`
      select account_id, repaid_debt, credit_limit from account_credit_limits
      where account_id = any(${accounts}::uuid[]) order by account_id
    `],
    publicStats: { pullRequests: stats.pullRequests, contributors: stats.contributors, points: stats.points },
    creditIssued: await listCreditIssued({ sql: dashboardSql }),
    storeOutsiderPairs: cohort?.outsiderSettlementPairs,
    dashboardOutsiderRows: (await loadCalibrationCohorts(fixture.sponsorId, { sql: dashboardSql })).outsiderRows,
    auditOutsiderPairCount: candidate?.outsiderPairCount,
  };
}

function byAccount(left: { account_id: string }, right: { account_id: string }) {
  return left.account_id < right.account_id ? -1 : 1;
}

async function insertUser() {
  const id = externalId++;
  const [row] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (${id}, ${`donor-${id}`}) returning id
  `;
  return row.id;
}

async function buildFixture() {
  const sponsorId = await insertUser();
  const contributorId = await insertUser();
  const id = externalId++;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
    values (${id}, ${`owner/donated-${id}`}, ${sponsorId}, 'PUBLIC', ${id}, ${sql.json(validDifficultyScheme())}) returning id
  `;
  const [issue] = await sql<{ id: string }[]>`
    insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points)
    values (${id}, ${repository.id}, 1, 'Donated work', '', 'https://example.test/issue', 'CLOSED', 'M', 5, 5)
    returning id
  `;
  const [pullRequest] = await sql<{ id: string }[]>`
    insert into pull_requests (github_pull_request_id, repository_id, issue_id, pull_request_number,
      url, title, body, author_id, state, merged_at)
    values (${id}, ${repository.id}, ${issue.id}, 2, 'https://example.test/pull/2', 'Donation', '',
      ${contributorId}, 'MERGED', ${mergedAt})
    returning id
  `;
  await sql`insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequest.id}, ${issue.id}, ${repository.id})`;
  return { sponsorId, contributorId, repositoryId: repository.id, issueId: issue.id, pullRequestId: pullRequest.id };
}

/** A DONATED settlement worth six credits: seven settled points less one review round. */
async function insertSettlement(fixture: Fixture) {
  const [row] = await sql<{ id: string }[]>`insert into settlements
    (pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id, opening_comparison_points,
      settled_points, review_rounds, credits, proof_sha256, status, donation_comment_id)
    values (${fixture.pullRequestId}, ${fixture.issueId}, ${fixture.contributorId}, 'donor', ${fixture.sponsorId}, 5,
      7, 1, 6, ${randomUUID().replaceAll("-", "").repeat(2)}, 'DONATED', 'donation')
    returning id`;
  return row.id;
}
