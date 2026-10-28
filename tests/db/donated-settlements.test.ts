import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { createSettlementsGetHandler } from "@/app/api/settlements/route";
import { createSettlementProofGetHandler } from "@/app/api/settlements/[id]/route";
import { exportAccount } from "@/lib/accounts/export";
import { closeSql, getSql } from "@/lib/db/client";
import { listEligibleIssues } from "@/lib/dashboard/eligible-issues";
import { listCreditIssued } from "@/lib/dashboard/ledger-panels";
import {
  getDashboard, getSettlementProof, listAuditCandidates, listSettlementHistory, loadCalibrationCohorts, type DashboardSql,
} from "@/lib/dashboard/queries";
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
    expect(paid.creditLimits).toEqual([
      { account_id: fixture.sponsorId, repaid_debt: 0, credit_limit: 10 },
      { account_id: fixture.contributorId, repaid_debt: 0, credit_limit: 10 },
    ].sort(byAccount));
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

  it("stays out of the board's own credit-limit replay", async () => {
    // The donor sponsors open work and owes ten, so a ten-credit repayment would lift their limit to eleven.
    const donorId = await insertUser();
    const owed = await buildFixture({ sponsorId: donorId, mergedAt: "2026-08-01T12:00:00.000Z" });
    await insertSettlement(owed, { creditorId: owed.contributorId, debtorId: donorId, points: 10, rounds: 0, status: "SETTLED" });
    await insertOpenIssue(owed.repositoryId, 3);
    await insertOpenIssue(owed.repositoryId, 4);
    const donated = await buildFixture({ contributorId: donorId });
    const settlementId = await insertSettlement(donated, { points: 10, rounds: 0 });
    const viewerId = await insertUser();
    const donorIssuesOnBoard = async () => (await listEligibleIssues(viewerId, {}, { sql: sql as unknown as DashboardSql }))
      .filter((issue) => issue.repositoryName === `owner/donated-${owed.githubId}`).length;

    // Exhausted at -10 against a limit of 10: only the one repayment issue stays on the board.
    expect(await donorIssuesOnBoard()).toBe(1);

    await sql`update settlements set status = 'SETTLED', donation_comment_id = null where id = ${settlementId}`;
    expect(await donorIssuesOnBoard()).toBe(2);
    expect(await sql`select credit_limit::integer from account_credit_limits where account_id = ${donorId}`)
      .toEqual([{ credit_limit: 11 }]);
  });

  it("R4 clause 2: settles with the work recorded and visible to the donor and the sponsor", async () => {
    const fixture = await buildFixture();
    const settlementId = await insertSettlement(fixture);

    for (const accountId of [fixture.contributorId, fixture.sponsorId]) {
      const history = await (await createSettlementsGetHandler({ ...memberRoute(accountId), listSettlementHistory })(
        new Request("https://overflow.example/api/settlements"),
      )).json();
      expect(history).toEqual([expect.objectContaining({
        id: settlementId, status: "DONATED", credits: 6, reviewRounds: 1, balanceEffect: 0,
      })]);

      const proof = await createSettlementProofGetHandler({
        ...memberRoute(accountId), getSettlementProof,
        createCorrectionsService: async () => ({ listRequestsForSettlement: async () => [] }),
      })(new Request(`https://overflow.example/api/settlements/${settlementId}`), { params: Promise.resolve({ id: settlementId }) });
      expect(proof.status).toBe(200);
      expect((await proof.json()).settlement).toMatchObject({
        id: settlementId, status: "DONATED", settledPoints: 7, reviewRounds: 1, credits: 6, balanceEffect: 0,
      });
    }
  });

  it("R4 clause 4: the donor sees which claims were donations", async () => {
    const donated = await buildFixture({ mergedAt: "2026-09-02T12:00:00.000Z" });
    const donatedId = await insertSettlement(donated);
    const paid = await buildFixture({ contributorId: donated.contributorId });
    const paidId = await insertSettlement(paid, { status: "SETTLED" });

    const history = await listSettlementHistory(donated.contributorId);
    expect(history.map(({ id, status }) => ({ id, status })).sort(byId)).toEqual([
      { id: donatedId, status: "DONATED" },
      { id: paidId, status: "SETTLED" },
    ].sort(byId));
    const recent = (await getDashboard(donated.contributorId)).recentSettlements;
    expect(recent.map(({ id, status, credits }) => ({ id, status, credits })).sort(byId)).toEqual([
      { id: donatedId, status: "DONATED", credits: 6 },
      { id: paidId, status: "SETTLED", credits: 6 },
    ].sort(byId));
    const [{ github_user_id: githubUserId }] = await sql<{ github_user_id: string }[]>`
      select github_user_id from users where id = ${donated.contributorId}
    `;
    const exported = await exportAccount(sql, Number(githubUserId));
    expect(exported!.settlements.asCreditor.map((row) => ({ id: row.id as string, donation_comment_id: row.donation_comment_id }))
      .sort(byId)).toEqual([{ id: donatedId, donation_comment_id: "donation" }, { id: paidId, donation_comment_id: null }].sort(byId));
  });
});

/** The member gate's dependencies, signed in as the given account. */
function memberRoute(accountId: string) {
  return {
    getSession: async () => ({ user: { id: accountId, role: "MEMBER" as const } }),
    findAccountByTokenHash: async () => null,
    getCurrentRole: async () => "MEMBER" as const,
  };
}

function byId(left: { id: string }, right: { id: string }) {
  return left.id < right.id ? -1 : 1;
}

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
    creditLimits: [...await sql<{ account_id: string; repaid_debt: number; credit_limit: number }[]>`
      select account_id, repaid_debt::integer, credit_limit::integer from account_credit_limits
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

async function buildFixture(
  { sponsorId, contributorId, mergedAt: merged = mergedAt }: { sponsorId?: string; contributorId?: string; mergedAt?: string } = {},
) {
  sponsorId ??= await insertUser();
  contributorId ??= await insertUser();
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
      ${contributorId}, 'MERGED', ${merged})
    returning id
  `;
  await sql`insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequest.id}, ${issue.id}, ${repository.id})`;
  return { sponsorId, contributorId, githubId: id, repositoryId: repository.id, issueId: issue.id, pullRequestId: pullRequest.id };
}

async function insertOpenIssue(repositoryId: string, issueNumber: number) {
  const id = externalId++;
  await sql`insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points)
    values (${id}, ${repositoryId}, ${issueNumber}, 'Open work', '', ${`https://example.test/issue/${id}`}, 'OPEN', 'M', 5, 5)`;
}

/** By default a DONATED settlement worth six credits: seven settled points less one review round. */
async function insertSettlement(
  fixture: Fixture,
  { creditorId = fixture.contributorId, debtorId = fixture.sponsorId, points = 7, rounds = 1, status = "DONATED" }:
    { creditorId?: string; debtorId?: string; points?: number; rounds?: number; status?: "DONATED" | "SETTLED" } = {},
) {
  const [row] = await sql<{ id: string }[]>`insert into settlements
    (pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id, opening_comparison_points,
      settled_points, review_rounds, credits, proof_sha256, status, donation_comment_id)
    values (${fixture.pullRequestId}, ${fixture.issueId}, ${creditorId}, 'donor', ${debtorId}, 5,
      ${points}, ${rounds}, ${points - rounds}, ${randomUUID().replaceAll("-", "").repeat(2)}, ${status},
      ${status === "DONATED" ? "donation" : null})
    returning id`;
  return row.id;
}
