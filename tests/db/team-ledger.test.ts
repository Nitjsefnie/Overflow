import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { listEligibleIssues } from "@/lib/dashboard/eligible-issues";
import type { DashboardSql } from "@/lib/dashboard/queries";
import { PostgresTeamStore } from "@/lib/teams/store";
import { startPostgresContainer } from "../support/postgres-container";
import {
  balancesOf, creditLimitOf, insertAccount, insertPullRequest, insertSettlement, type FixtureAccount,
} from "../support/team-fixtures";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;
let teamNumber = 0;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "team_ledger", user: "team_ledger" });
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

/** A team led by `lead` with `members` added through the store. */
async function team(lead: FixtureAccount, ...members: FixtureAccount[]): Promise<string> {
  const store = new PostgresTeamStore(sql);
  const created = await store.createTeam(lead.id, `ledger team ${++teamNumber}`);
  if (created.kind !== "ok") throw new Error(`fixture team refused: ${created.kind}`);
  for (const member of members) expect(await store.addTeamMember(lead.id, member.login)).toMatchObject({ kind: "ok" });
  return created.value.id;
}

async function legsOf(settlementId: string) {
  return sql<{ account_id: string; counterparty_id: string; amount: number }[]>`
    select account_id, counterparty_id, amount from ledger_entries where settlement_id = ${settlementId} order by amount
  `;
}

/** How many of `sponsor`'s open issues a third account sees on the board. */
async function boardIssuesOf(sponsor: FixtureAccount): Promise<number> {
  const viewer = await insertAccount(sql);
  return (await listEligibleIssues(viewer.id, { repository: sponsor.ownerName }, { sql: sql as unknown as DashboardSql })).length;
}

describe("a team settlement in the ledger views", () => {
  it("books its creditor leg to the team, not the author, in ledger_entries, balances and account_credit_limits", async () => {
    const [lead, author, sponsor] = [await insertAccount(sql), await insertAccount(sql), await insertAccount(sql)];
    const teamId = await team(lead, author);
    const settlement = await insertSettlement(sql, { author, debtor: sponsor, credits: 6, teamId });

    expect([...await legsOf(settlement.id)]).toEqual([
      { account_id: sponsor.id, counterparty_id: teamId, amount: -6 },
      { account_id: teamId, counterparty_id: sponsor.id, amount: 6 },
    ]);
    expect(await balancesOf(sql, teamId, author.id, sponsor.id)).toEqual([6, 0, -6]);
    expect(await creditLimitOf(sql, teamId)).toEqual({ repaidDebt: 0, creditLimit: 10 });
    expect(await creditLimitOf(sql, author.id)).toBeNull();

    // The same row without a team pays its author, as every settlement did before teams.
    await sql`update settlements set team_id = null where id = ${settlement.id}`;
    expect(await balancesOf(sql, teamId, author.id, sponsor.id)).toEqual([0, 6, -6]);
    expect(await creditLimitOf(sql, author.id)).toEqual({ repaidDebt: 0, creditLimit: 10 });
  });

  it("refuses a team on a settlement that names no creditor", async () => {
    const [lead, sponsor] = [await insertAccount(sql), await insertAccount(sql)];
    const teamId = await team(lead);
    const settlement = await insertSettlement(sql, { author: lead, debtor: sponsor, credits: 4, teamId });
    await expect(sql`update settlements set status = 'UNCLAIMED', creditor_id = null, creditor_github_login = 'someone'
      where id = ${settlement.id}`).rejects.toMatchObject({ constraint_name: "settlements_team_requires_creditor_check" });
    await sql`update settlements set team_id = null, status = 'UNCLAIMED', creditor_id = null, creditor_github_login = 'someone'
      where id = ${settlement.id}`;
  });

  it("keeps a team settlement from repaying its author's debt in the board's credit-limit replay", async () => {
    // The author sponsors two open issues and owes exactly ten: one more repaid point would lift the limit to 11.
    const [lead, author, worker] = [await insertAccount(sql), await insertAccount(sql, 2), await insertAccount(sql)];
    const teamId = await team(lead, author);
    await insertSettlement(sql, { author: worker, debtor: author, credits: 10, mergedAt: "2026-01-01T00:00:00.000Z" });
    const paid = await insertSettlement(sql, { author, debtor: worker, credits: 10, mergedAt: "2026-01-02T00:00:00.000Z", teamId });

    expect(await balancesOf(sql, author.id)).toEqual([-10]);
    expect(await creditLimitOf(sql, author.id)).toEqual({ repaidDebt: 0, creditLimit: 10 });
    expect(await boardIssuesOf(author)).toBe(1);

    await sql`update settlements set team_id = null where id = ${paid.id}`;
    expect(await creditLimitOf(sql, author.id)).toEqual({ repaidDebt: 10, creditLimit: 11 });
    expect(await boardIssuesOf(author)).toBe(2);
  });
});

/** A moderator adjustment of `target`'s settled work: one line on `settlementId` paying `amount` to `creditor`, booked to `teamId`. */
async function adjustmentLine(
  { settlementId, target, creditor, teamId, amount, createdAt = "2026-01-02T00:00:00.000Z" }:
    { settlementId: string; target: FixtureAccount; creditor: FixtureAccount; teamId: string | null; amount: number; createdAt?: string },
): Promise<void> {
  const [event] = await sql<{ id: string }[]>`
    insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason)
    values (${target.id}, ${creditor.id}, 'ACTIVE', 'UNDER_AUDIT', 'fixture audit') returning id
  `;
  const [audit] = await sql<{ id: string }[]>`
    insert into calibration_audits (account_id, reporter_id, rationale, sample_started_at, sample_ended_at, settled_sample_size, state)
    values (${target.id}, ${creditor.id}, 'fixture sample', '2025-01-01', '2025-02-01', 1, 'SUBSTANTIATED') returning id
  `;
  const [adjustment] = await sql<{ id: string }[]>`
    insert into moderation_credit_adjustments (moderation_event_id, calibration_audit_id, target_account_id,
      gap_per_pair, pair_count, total_amount, reason, created_at)
    values (${event.id}, ${audit.id}, ${target.id}, ${Math.abs(amount)}, 1, ${Math.abs(amount)}, 'fixture adjustment', ${createdAt})
    returning id
  `;
  await sql`insert into moderation_credit_adjustment_lines (adjustment_id, settlement_id, creditor_id, team_id, amount)
    values (${adjustment.id}, ${settlementId}, ${creditor.id}, ${teamId}, ${amount})`;
}

/** A GRANTED dispute whose landing is `settlement`'s pull request, decided at `decidedAt`. */
async function grantDispute(settlement: { issueId: string; pullRequestId: string }, sponsor: FixtureAccount, decidedAt: string) {
  const [contributor, moderator] = [await insertAccount(sql), await insertAccount(sql)];
  const closedPullRequestId = await insertPullRequest(sql, contributor, sponsor.repositoryId, settlement.issueId, "CLOSED", null);
  await sql`
    insert into closed_pr_dispute_requests (contributor_id, pull_request_id, issue_id, landed_pull_request_id, request_reason,
      state, decision, decided_by, decided_reason, decided_at, moderator_figure, awarded_points)
    values (${contributor.id}, ${closedPullRequestId}, ${settlement.issueId}, ${settlement.pullRequestId}, 'My work landed.',
      'DECIDED', 'GRANTED', ${moderator.id}, 'The landing copied it.', ${decidedAt}, 6, 6)
  `;
}

describe("a moderator adjustment line in the ledger views", () => {
  it("books its creditor leg to the line's team, and to its creditor when the line carries none", async () => {
    const [lead, author, sponsor] = [await insertAccount(sql), await insertAccount(sql), await insertAccount(sql)];
    const teamId = await team(lead, author);
    const settlement = await insertSettlement(sql, { author, debtor: sponsor, credits: 6, teamId });

    await adjustmentLine({ settlementId: settlement.id, target: sponsor, creditor: author, teamId, amount: 2 });
    expect(await balancesOf(sql, teamId, author.id, sponsor.id)).toEqual([8, 0, -8]);
    expect(await creditLimitOf(sql, author.id)).toBeNull();
    expect((await legsOf(settlement.id)).map((leg) => [leg.account_id, leg.counterparty_id, leg.amount])).toEqual([
      [sponsor.id, teamId, -6], [sponsor.id, teamId, -2], [teamId, sponsor.id, 2], [teamId, sponsor.id, 6],
    ]);

    await adjustmentLine({ settlementId: settlement.id, target: sponsor, creditor: author, teamId: null, amount: -2 });
    expect(await balancesOf(sql, teamId, author.id, sponsor.id)).toEqual([8, -2, -6]);
    expect(await creditLimitOf(sql, author.id)).toEqual({ repaidDebt: 0, creditLimit: 10 });
  });

  it("leaves a team line out of its creditor's repayment in the board's credit-limit replay", async () => {
    // Owes 10, a team line pays 10 to the team, the author's own work then repays 10, and 10 more is owed.
    // Booked to the author instead, the line would clear the debt first and the work would repay nothing.
    const [lead, author, worker] = [await insertAccount(sql), await insertAccount(sql, 2), await insertAccount(sql)];
    const teamId = await team(lead, author);
    await insertSettlement(sql, { author: worker, debtor: author, credits: 10, mergedAt: "2026-01-01T00:00:00.000Z" });
    const teamWork = await insertSettlement(sql, { author, debtor: worker, credits: 1, mergedAt: "2026-01-01T00:00:00.000Z", teamId });
    await adjustmentLine({ settlementId: teamWork.id, target: worker, creditor: author, teamId, amount: 10 });
    await insertSettlement(sql, { author, debtor: worker, credits: 10, mergedAt: "2026-01-03T00:00:00.000Z" });
    await insertSettlement(sql, { author: worker, debtor: author, credits: 10, mergedAt: "2026-01-04T00:00:00.000Z" });

    expect(await balancesOf(sql, author.id, teamId)).toEqual([-10, 11]);
    expect(await creditLimitOf(sql, author.id)).toEqual({ repaidDebt: 10, creditLimit: 11 });
    expect(await boardIssuesOf(author)).toBe(2);
  });
});

describe("a granted dispute's landing reversal in the ledger views", () => {
  it("debits the settlement's team, and its author when the settlement carries no team", async () => {
    const [lead, author, sponsor] = [await insertAccount(sql), await insertAccount(sql), await insertAccount(sql)];
    const teamId = await team(lead, author);
    const settlement = await insertSettlement(sql, { author, debtor: sponsor, credits: 6, teamId });
    await grantDispute(settlement, sponsor, "2026-02-01");

    expect(await balancesOf(sql, teamId, author.id, sponsor.id)).toEqual([0, 0, 0]);
    expect(await creditLimitOf(sql, author.id)).toBeNull();

    await sql`update settlements set team_id = null where id = ${settlement.id}`;
    expect(await balancesOf(sql, teamId, author.id, sponsor.id)).toEqual([0, 0, 0]);
    expect(await creditLimitOf(sql, author.id)).toEqual({ repaidDebt: 0, creditLimit: 10 });
    expect((await legsOf(settlement.id)).filter((leg) => leg.amount === -6).map((leg) => leg.account_id).sort())
      .toEqual([author.id, sponsor.id].sort());
  });

  it("leaves a team settlement's reversal out of its author's repayment in the board's credit-limit replay", async () => {
    // The author owes nothing when their own work lands, then owes 10. Debited to the author instead,
    // the reversal would make that work repay 10 and lift the limit to 11.
    const [lead, author, worker] = [await insertAccount(sql), await insertAccount(sql, 2), await insertAccount(sql)];
    const teamId = await team(lead, author);
    const teamWork = await insertSettlement(sql, { author, debtor: worker, credits: 10, mergedAt: "2026-01-01T00:00:00.000Z", teamId });
    await grantDispute(teamWork, worker, "2026-01-02T00:00:00.000Z");
    await insertSettlement(sql, { author, debtor: worker, credits: 10, mergedAt: "2026-01-03T00:00:00.000Z" });
    await insertSettlement(sql, { author: worker, debtor: author, credits: 10, mergedAt: "2026-01-04T00:00:00.000Z" });
    await insertSettlement(sql, { author: worker, debtor: author, credits: 10, mergedAt: "2026-01-05T00:00:00.000Z" });

    expect(await balancesOf(sql, author.id, teamId)).toEqual([-10, 0]);
    expect(await creditLimitOf(sql, author.id)).toEqual({ repaidDebt: 0, creditLimit: 10 });
    expect(await boardIssuesOf(author)).toBe(1);
  });
});

describe("a team distribution in the ledger views", () => {
  it("moves the points from the team to the member as two ledger legs", async () => {
    const [lead, member, sponsor] = [await insertAccount(sql), await insertAccount(sql), await insertAccount(sql)];
    const teamId = await team(lead, member);
    await insertSettlement(sql, { author: lead, debtor: sponsor, credits: 7, teamId });
    const distributed = await new PostgresTeamStore(sql).distributeTeamPoints(lead.id, member.id, 3);
    expect(distributed).toMatchObject({ kind: "ok", value: { teamId, memberId: member.id, points: 3 } });
    if (distributed.kind !== "ok") return;

    const legs = await sql<{ settlement_id: string | null; account_id: string; counterparty_id: string; amount: number; created_at: Date }[]>`
      select settlement_id, account_id, counterparty_id, amount, created_at from ledger_entries
      where account_id = any(${[teamId, member.id]}::uuid[]) and settlement_id is null order by amount
    `;
    const createdAt = new Date(distributed.value.createdAt);
    expect([...legs]).toEqual([
      { settlement_id: null, account_id: teamId, counterparty_id: member.id, amount: -3, created_at: createdAt },
      { settlement_id: null, account_id: member.id, counterparty_id: teamId, amount: 3, created_at: createdAt },
    ]);
    expect(await balancesOf(sql, teamId, member.id, lead.id, sponsor.id)).toEqual([4, 3, 0, -7]);
  });

  it("replays as a non-work event in account_credit_limits and the board's copy of it", async () => {
    // Owes 10, receives a 10-point distribution, earns 10 by work, owes 20 more: the work repaid nothing.
    const [lead, member, worker] = [await insertAccount(sql), await insertAccount(sql, 2), await insertAccount(sql)];
    const teamId = await team(lead, member);
    await insertSettlement(sql, { author: lead, debtor: worker, credits: 10, mergedAt: "2026-01-01T00:00:00.000Z", teamId });
    await insertSettlement(sql, { author: worker, debtor: member, credits: 10, mergedAt: "2026-01-01T00:00:00.000Z" });
    await sql`insert into team_distributions (team_id, member_id, points, created_at)
      values (${teamId}, ${member.id}, 10, '2026-01-02T00:00:00.000Z')`;
    await insertSettlement(sql, { author: member, debtor: worker, credits: 10, mergedAt: "2026-01-03T00:00:00.000Z" });
    await insertSettlement(sql, { author: worker, debtor: member, credits: 10, mergedAt: "2026-01-04T00:00:00.000Z" });
    await insertSettlement(sql, { author: worker, debtor: member, credits: 10, mergedAt: "2026-01-05T00:00:00.000Z" });

    expect(await balancesOf(sql, member.id, teamId)).toEqual([-10, 0]);
    expect(await creditLimitOf(sql, member.id)).toEqual({ repaidDebt: 0, creditLimit: 10 });
    expect(await creditLimitOf(sql, teamId)).toEqual({ repaidDebt: 0, creditLimit: 10 });
    expect(await boardIssuesOf(member)).toBe(1);
  });
});

