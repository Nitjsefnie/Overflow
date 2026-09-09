import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 5_400_000;
const originalDatabaseUrl = process.env.DATABASE_URL;

function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

const adjustmentCreatedAt = "2026-09-02T00:00:00.000Z";
const settlementCreatedAt = "2026-09-01T12:00:00.000Z";
const adjustmentReason = "Recalibration adjustment: the sponsor's settled sample underdelivered its openings.";

describe("moderation credit adjustment ledger legs", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "credit_adjustment_test",
      user: "credit_adjustment_test",
      password: "credit_adjustment_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    // The second run replays every migration against the installed schema, so a
    // migration that is not re-runnable fails here rather than in production.
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

  it("carries an applied adjustment as credit and sponsor ledger legs per line", async () => {
    const fixture = await buildAdjustmentFixture();

    const [adjustment] = await sql<{ id: string }[]>`
      insert into moderation_credit_adjustments (
        moderation_event_id, calibration_audit_id, target_account_id,
        gap_per_pair, pair_count, total_amount, state, reason, created_at
      )
      values (
        ${fixture.moderationEventId}, ${fixture.calibrationAuditId}, ${fixture.sponsorId},
        1.5, 2, 3, ${"APPLIED"}, ${adjustmentReason}, ${adjustmentCreatedAt}
      )
      returning id
    `;
    await sql`
      insert into moderation_credit_adjustment_lines (adjustment_id, settlement_id, creditor_id, amount)
      values
        (${adjustment.id}, ${fixture.settlements[0]!.id}, ${fixture.settlements[0]!.creditorId}, 2),
        (${adjustment.id}, ${fixture.settlements[1]!.id}, ${fixture.settlements[1]!.creditorId}, 1)
    `;

    const legs = await sql<Leg[]>`
      select settlement_id, account_id, counterparty_id, amount, created_at
      from ledger_entries
      where settlement_id = any(${[fixture.settlements[0]!.id, fixture.settlements[1]!.id]}::uuid[])
    `;
    // Compared as multisets rather than in written order: uuid ordering is random
    // per run, so both sides are sorted through the same total-order comparator
    // and neither side's spelling order can decide the assertion.
    const byLeg = (left: Leg, right: Leg) =>
      left.amount - right.amount
        || left.account_id.localeCompare(right.account_id)
        || left.counterparty_id.localeCompare(right.counterparty_id)
        || left.settlement_id.localeCompare(right.settlement_id);
    const expectedLegs: Leg[] = [
      // Each compensated settlement still carries both of its own legs,
      // untouched by 035, at the settlement's own creation moment: the second
      // settlement's is pinned to the exact instant it was inserted with.
      { settlement_id: fixture.settlements[0]!.id, account_id: fixture.sponsorId, counterparty_id: fixture.settlements[0]!.creditorId, amount: -4, created_at: expect.any(Date) },
      { settlement_id: fixture.settlements[1]!.id, account_id: fixture.sponsorId, counterparty_id: fixture.settlements[1]!.creditorId, amount: -2, created_at: new Date(settlementCreatedAt) },
      // The sponsor legs of the applied adjustment, one per line, at the
      // adjustment's creation moment.
      { settlement_id: fixture.settlements[0]!.id, account_id: fixture.sponsorId, counterparty_id: fixture.settlements[0]!.creditorId, amount: -2, created_at: new Date(adjustmentCreatedAt) },
      { settlement_id: fixture.settlements[1]!.id, account_id: fixture.sponsorId, counterparty_id: fixture.settlements[1]!.creditorId, amount: -1, created_at: new Date(adjustmentCreatedAt) },
      // The credit legs of the applied adjustment, one per line.
      { settlement_id: fixture.settlements[1]!.id, account_id: fixture.settlements[1]!.creditorId, counterparty_id: fixture.sponsorId, amount: 1, created_at: new Date(adjustmentCreatedAt) },
      { settlement_id: fixture.settlements[1]!.id, account_id: fixture.settlements[1]!.creditorId, counterparty_id: fixture.sponsorId, amount: 2, created_at: new Date(settlementCreatedAt) },
      { settlement_id: fixture.settlements[0]!.id, account_id: fixture.settlements[0]!.creditorId, counterparty_id: fixture.sponsorId, amount: 2, created_at: new Date(adjustmentCreatedAt) },
      { settlement_id: fixture.settlements[0]!.id, account_id: fixture.settlements[0]!.creditorId, counterparty_id: fixture.sponsorId, amount: 4, created_at: expect.any(Date) },
    ];
    expect(legs.sort(byLeg)).toEqual(expectedLegs.sort(byLeg));
  });

  it("nets account balances back through a reversal's negative lines", async () => {
    const fixture = await buildAdjustmentFixture();
    const accountIds = [fixture.sponsorId, fixture.settlements[0]!.creditorId, fixture.settlements[1]!.creditorId];

    const balancesBefore = await readBalances(accountIds);
    expect(balancesBefore.get(fixture.sponsorId)).toBe(-6);
    expect(balancesBefore.get(fixture.settlements[0]!.creditorId)).toBe(4);
    expect(balancesBefore.get(fixture.settlements[1]!.creditorId)).toBe(2);

    const [adjustment] = await sql<{ id: string }[]>`
      insert into moderation_credit_adjustments (
        moderation_event_id, calibration_audit_id, target_account_id,
        gap_per_pair, pair_count, total_amount, state, reason, created_at
      )
      values (
        ${fixture.moderationEventId}, ${fixture.calibrationAuditId}, ${fixture.sponsorId},
        1.5, 2, 3, ${"APPLIED"}, ${adjustmentReason}, ${adjustmentCreatedAt}
      )
      returning id
    `;
    await sql`
      insert into moderation_credit_adjustment_lines (adjustment_id, settlement_id, creditor_id, amount)
      values
        (${adjustment.id}, ${fixture.settlements[0]!.id}, ${fixture.settlements[0]!.creditorId}, 2),
        (${adjustment.id}, ${fixture.settlements[1]!.id}, ${fixture.settlements[1]!.creditorId}, 1)
    `;

    const balancesApplied = await readBalances(accountIds);
    expect(balancesApplied.get(fixture.sponsorId)).toBe(-9);
    expect(balancesApplied.get(fixture.settlements[0]!.creditorId)).toBe(6);
    expect(balancesApplied.get(fixture.settlements[1]!.creditorId)).toBe(3);

    // The reversal is a second APPLIED row pointing at the original, its lines
    // carrying the negative of the original's per-line amounts. Neither row is
    // ever mutated: the pair of rows cancels in every derived view.
    const [reversal] = await sql<{ id: string }[]>`
      insert into moderation_credit_adjustments (
        moderation_event_id, calibration_audit_id, target_account_id,
        gap_per_pair, pair_count, total_amount, state, reversal_of, reason, created_at
      )
      values (
        ${fixture.moderationEventId}, ${fixture.calibrationAuditId}, ${fixture.sponsorId},
        1.5, 2, 3, ${"APPLIED"}, ${adjustment.id}, ${adjustmentReason}, ${adjustmentCreatedAt}
      )
      returning id
    `;
    await sql`
      insert into moderation_credit_adjustment_lines (adjustment_id, settlement_id, creditor_id, amount)
      values
        (${reversal.id}, ${fixture.settlements[0]!.id}, ${fixture.settlements[0]!.creditorId}, -2),
        (${reversal.id}, ${fixture.settlements[1]!.id}, ${fixture.settlements[1]!.creditorId}, -1)
    `;

    expect(await readBalances(accountIds)).toEqual(balancesBefore);
  });

  it("allows one non-reversal adjustment per audit and one reversal per adjustment", async () => {
    const fixture = await buildAdjustmentFixture();

    const adjustmentId = await insertAdjustment(fixture);
    await insertAdjustmentLines(adjustmentId, fixture);

    // A second applied adjustment for the same audit collides on the partial
    // unique index over non-reversal rows only.
    await expect(sql`
      insert into moderation_credit_adjustments (
        moderation_event_id, calibration_audit_id, target_account_id,
        gap_per_pair, pair_count, total_amount, state, reason, created_at
      )
      values (
        ${fixture.moderationEventId}, ${fixture.calibrationAuditId}, ${fixture.sponsorId},
        1.5, 2, 3, ${"APPLIED"}, ${adjustmentReason}, ${adjustmentCreatedAt}
      )
    `).rejects.toThrow(/one_adjustment_per_audit/);

    // The reversal row for the same audit is the partial index's excluded case,
    // so it is admitted where a second adjustment is not.
    const reversalId = await insertReversal(fixture, adjustmentId);
    await insertAdjustmentLines(reversalId, fixture, -1);

    await expect(sql`
      insert into moderation_credit_adjustments (
        moderation_event_id, calibration_audit_id, target_account_id,
        gap_per_pair, pair_count, total_amount, state, reversal_of, reason, created_at
      )
      values (
        ${fixture.moderationEventId}, ${fixture.calibrationAuditId}, ${fixture.sponsorId},
        1.5, 2, 3, ${"APPLIED"}, ${adjustmentId}, ${adjustmentReason}, ${adjustmentCreatedAt}
      )
    `).rejects.toThrow(/one_reversal_per_adjustment/);
  });
});

/** Two settled compensable settlements under one sponsor, with the audit and moderation event an adjustment references. */
async function buildAdjustmentFixture(): Promise<{
  sponsorId: string;
  settlements: Array<{ id: string; creditorId: string }>;
  moderationEventId: string;
  calibrationAuditId: string;
}> {
  const sponsorId = await insertUser(sql);
  const moderatorId = await insertUser(sql);
  const reporterId = await insertUser(sql);
  const settlements = [
    await insertSettledSettlement(sql, sponsorId, 4),
    await insertSettledSettlement(sql, sponsorId, 2, settlementCreatedAt),
  ];
  const [moderationEvent] = await sql<{ id: string }[]>`
    insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason, created_at)
    values (${sponsorId}, ${moderatorId}, ${"ACTIVE"}, ${"UNDER_AUDIT"}, ${"Recalibration audit opened."}, now())
    returning id
  `;
  const [audit] = await sql<{ id: string }[]>`
    insert into calibration_audits (
      account_id, reporter_id, rationale, sample_started_at, sample_ended_at, settled_sample_size
    )
    values (
      ${sponsorId}, ${reporterId},
      ${"The sponsor's settled sample warrants evaluation."},
      now() - interval '30 days', now(), 2
    )
    returning id
  `;
  return {
    sponsorId,
    settlements,
    moderationEventId: moderationEvent.id,
    calibrationAuditId: audit.id,
  };
}

async function insertAdjustment(fixture: Awaited<ReturnType<typeof buildAdjustmentFixture>>): Promise<string> {
  const [adjustment] = await sql<{ id: string }[]>`
    insert into moderation_credit_adjustments (
      moderation_event_id, calibration_audit_id, target_account_id,
      gap_per_pair, pair_count, total_amount, state, reason, created_at
    )
    values (
      ${fixture.moderationEventId}, ${fixture.calibrationAuditId}, ${fixture.sponsorId},
      1.5, 2, 3, ${"APPLIED"}, ${adjustmentReason}, ${adjustmentCreatedAt}
    )
    returning id
  `;
  return adjustment.id;
}

async function insertReversal(
  fixture: Awaited<ReturnType<typeof buildAdjustmentFixture>>,
  reversalOf: string,
): Promise<string> {
  const [reversal] = await sql<{ id: string }[]>`
    insert into moderation_credit_adjustments (
      moderation_event_id, calibration_audit_id, target_account_id,
      gap_per_pair, pair_count, total_amount, state, reversal_of, reason, created_at
    )
    values (
      ${fixture.moderationEventId}, ${fixture.calibrationAuditId}, ${fixture.sponsorId},
      1.5, 2, 3, ${"APPLIED"}, ${reversalOf}, ${adjustmentReason}, ${adjustmentCreatedAt}
    )
    returning id
  `;
  return reversal.id;
}

async function insertAdjustmentLines(
  adjustmentId: string,
  fixture: Awaited<ReturnType<typeof buildAdjustmentFixture>>,
  amountSign: 1 | -1 = 1,
): Promise<void> {
  await sql`
    insert into moderation_credit_adjustment_lines (adjustment_id, settlement_id, creditor_id, amount)
    values
      (${adjustmentId}, ${fixture.settlements[0]!.id}, ${fixture.settlements[0]!.creditorId}, ${amountSign * 2}),
      (${adjustmentId}, ${fixture.settlements[1]!.id}, ${fixture.settlements[1]!.creditorId}, ${amountSign * 1})
  `;
}

type Leg = {
  settlement_id: string;
  account_id: string;
  counterparty_id: string;
  amount: number;
  created_at: Date;
};

/** Reads the given accounts' balances as a map, so assertions never depend on uuid ordering. */
async function readBalances(accountIds: string[]): Promise<Map<string, number>> {
  const rows = await sql<{ account_id: string; balance: number }[]>`
    select account_id, balance from balances
    where account_id = any(${accountIds}::uuid[])
  `;
  return new Map(rows.map((row) => [row.account_id, row.balance]));
}

async function insertSettledSettlement(
  client: Sql,
  sponsorId: string,
  credits: number,
  createdAt?: string,
): Promise<{ id: string; creditorId: string }> {
  const creditorId = await insertUser(client);
  const pullRequest = await insertMergedPullRequest(client);
  const [settlement] = await client<{ id: string }[]>`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status, created_at
    )
    values (
      ${pullRequest.id}, ${pullRequest.issueId}, ${creditorId}, ${sponsorId},
      5, 6, ${6 - credits}, ${credits}, ${`${nextExternalId()}`.padStart(64, "a")}, ${"SETTLED"},
      ${createdAt ?? sql`now()`}
    )
    returning id
  `;
  return { id: settlement.id, creditorId };
}

async function insertMergedPullRequest(client: Sql): Promise<{ id: string; issueId: string }> {
  const issue = await insertIssue(client);
  const contributorId = await insertUser(client);
  const githubPullRequestId = nextExternalId();
  const [pullRequest] = await client<{ id: string }[]>`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
      author_id, state, merged_at
    )
    values (
      ${githubPullRequestId}, ${issue.repositoryId}, ${issue.id}, ${nextExternalId()},
      ${`https://github.com/example/repository/pull/${githubPullRequestId}`},
      ${"A merged contribution"}, ${"Pull request evidence"}, ${contributorId},
      ${"MERGED"}, now()
    )
    returning id
  `;
  await client`
    insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequest.id}, ${issue.id}, ${issue.repositoryId})
  `;
  return { id: pullRequest.id, issueId: issue.id };
}

async function insertIssue(client: Sql): Promise<{ id: string; repositoryId: string }> {
  const sponsorId = await insertUser(client);
  const repositoryId = await insertRepository(client, sponsorId);
  const githubIssueId = nextExternalId();
  const [issue] = await client<{ id: string }[]>`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    values (
      ${githubIssueId}, ${repositoryId}, ${nextExternalId()}, ${"An eligible issue"},
      ${"Issue evidence"}, ${`https://github.com/example/repository/issues/${githubIssueId}`},
      ${"OPEN"}, ${"size/M"}, 5, 5
    )
    returning id
  `;
  return { id: issue.id, repositoryId };
}

async function insertRepository(client: Sql, sponsorId: string): Promise<string> {
  const githubRepositoryId = nextExternalId();
  const [repository] = await client<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    )
    values (
      ${githubRepositoryId}, ${`owner-${githubRepositoryId}/repository-${githubRepositoryId}`},
      ${sponsorId}, ${"PUBLIC"}, ${nextExternalId()}, ${client.json(validDifficultyScheme())}::jsonb
    )
    returning id
  `;
  return repository.id;
}

async function insertUser(client: Sql): Promise<string> {
  const githubUserId = nextExternalId();
  const [user] = await client<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${`member-${githubUserId}`})
    returning id
  `;
  return user.id;
}
