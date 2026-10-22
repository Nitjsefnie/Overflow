import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 71_000_000;
const originalDatabaseUrl = process.env.DATABASE_URL;
const adjustmentCreatedAt = "2026-10-01T12:00:00.000Z";

type RequestFields = Record<string, string | number | boolean | null>;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "closed_pr_disputes", user: "closed_pr_disputes" });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("closed PR dispute schema", () => {
  it("allows one OPEN request per PR and a fresh request after a decision", async () => {
    const fixture = await buildFixture();
    const request = await insertRequest(fixture);
    expect(request).toMatchObject({ state: "OPEN", decided_by_sole_moderator: false });
    await expect(insertRequest(fixture)).rejects.toMatchObject({ code: "23505" });
    const [otherPr] = await sql<{ id: string }[]>`
      insert into pull_requests (github_pull_request_id, repository_id, issue_id, pull_request_number,
                                 url, title, body, author_id, state)
      select ${externalId++}, repository_id, issue_id, 100, 'https://example.test/pull/100',
        title, body, author_id, state
      from pull_requests where id = ${fixture.pullRequestId}
      returning id
    `;
    await expect(insertRequest(fixture, { pull_request_id: otherPr.id })).resolves.toMatchObject({
      state: "OPEN", contributor_id: fixture.contributorId, pull_request_id: otherPr.id,
    });
    const [openRequests] = await sql<{ count: number }[]>`
      select count(*)::integer as count from closed_pr_dispute_requests
      where contributor_id = ${fixture.contributorId} and state = 'OPEN'
    `;
    expect(openRequests.count).toBe(2);
    await sql`
      update closed_pr_dispute_requests
      set state = 'DECIDED', decision = 'DENIED', decided_by = ${fixture.contributorId},
        decided_reason = 'Not supported by the evidence.', decided_at = now()
      where id = ${request.id}
    `;
    await expect(insertRequest(fixture)).resolves.toMatchObject({ state: "OPEN" });
  });

  it.each([
    ["blank filing reason", { request_reason: "   " }],
    ["long filing reason", { request_reason: "x".repeat(2001) }],
    ["invalid state", { state: "CANCELLED" }],
    ["invalid decision", { decision: "OTHER" }],
    ["OPEN decision", { decision: "DENIED" }],
    ["OPEN moderator", { decided_by: "fixture" }],
    ["OPEN sole moderator", { decided_by_sole_moderator: true }],
    ["OPEN explanation", { decided_reason: "Premature" }],
    ["OPEN decision timestamp", { decided_at: adjustmentCreatedAt }],
    ["OPEN figure", { moderator_figure: 5 }],
    ["OPEN award", { awarded_points: 0 }],
    ["blank commit evidence", { landed_commit_url: "   " }],
  ] satisfies [string, RequestFields][])("rejects %s", async (_name, fields) => {
    const fixture = await buildFixture();
    const patch: RequestFields = { ...fields };
    if (patch.decided_by === "fixture") patch.decided_by = fixture.contributorId;
    await expect(insertRequest(fixture, patch)).rejects.toMatchObject({ code: "23514" });
  });

  it.each([
    ["missing decision", { decision: null }],
    ["missing moderator", { decided_by: null }],
    ["missing reason", { decided_reason: null }],
    ["missing timestamp", { decided_at: null }],
    ["blank reason", { decided_reason: "   " }],
    ["long reason", { decided_reason: "x".repeat(2001) }],
    ["missing figure", { moderator_figure: null }],
    ["missing award", { awarded_points: null }],
    ["figure below range", { moderator_figure: 0 }],
    ["figure above range", { moderator_figure: 11 }],
    ["negative award", { awarded_points: -1 }],
    ["DENIED figure", { decision: "DENIED", awarded_points: null }],
    ["DENIED award", { decision: "DENIED", moderator_figure: null }],
  ] satisfies [string, RequestFields][])("rejects a decided row with %s", async (_name, fields) => {
    const fixture = await buildFixture();
    await expect(insertRequest(fixture, { ...grantFields(fixture), ...fields }))
      .rejects.toMatchObject({ code: "23514" });
  });

  it.each([1, 10])("accepts a GRANTED figure of %i", async (figure) => {
    const fixture = await buildFixture();
    await expect(insertRequest(fixture, {
      ...grantFields(fixture), moderator_figure: figure, awarded_points: figure,
    })).resolves.toMatchObject({ decision: "GRANTED", moderator_figure: figure, awarded_points: figure });
  });

  it("accepts bounded reasons, either evidence form, and a zero-point grant", async () => {
    const fixture = await buildFixture();
    const row = await insertRequest(fixture, {
      ...grantFields(fixture), request_reason: "x".repeat(2000),
      decided_reason: "x".repeat(2000), awarded_points: 0,
      decided_by_sole_moderator: true,
    });
    expect(row).toMatchObject({ decision: "GRANTED", awarded_points: 0, moderator_figure: 5 });
    await expect(insertRequest(fixture, {
      landed_pull_request_id: fixture.landingId, landed_commit_url: null,
    })).resolves.toMatchObject({ landed_pull_request_id: fixture.landingId });
  });

  it("requires exactly one landed evidence source", async () => {
    const fixture = await buildFixture();
    await expect(insertRequest(fixture, { landed_commit_url: null }))
      .rejects.toMatchObject({ code: "23514" });
    await expect(insertRequest(fixture, { landed_pull_request_id: fixture.landingId }))
      .rejects.toMatchObject({ code: "23514" });
  });

  it.each(["contributor_id", "pull_request_id", "issue_id", "landed_pull_request_id", "decided_by"])(
    "requires an existing %s reference", async (column) => {
      const fixture = await buildFixture();
      const fields: RequestFields = { ...grantFields(fixture), [column]: randomUUID() };
      if (column === "landed_pull_request_id") fields.landed_commit_url = null;
      await expect(insertRequest(fixture, fields)).rejects.toMatchObject({ code: "23503" });
    },
  );

  it("links immutable moderation events without a cascading delete", async () => {
    const fixture = await buildFixture();
    const request = await insertRequest(fixture);
    const eventId = await insertEvent(fixture, request.id as string);
    const [event] = await sql`select dispute_request_id from moderation_events where id = ${eventId}`;
    expect(event.dispute_request_id).toBe(request.id);
    await expect(sql`delete from closed_pr_dispute_requests where id = ${request.id as string}`)
      .rejects.toMatchObject({ code: "23503" });
    await expect(sql`update moderation_events set dispute_request_id = null where id = ${eventId}`)
      .rejects.toThrow(/immutable/);
    await expect(insertEvent(fixture, randomUUID())).rejects.toMatchObject({ code: "23503" });
  });

  it("keeps award and reversal lines on one adjustment, balances both legs, and rejects zero lines", async () => {
    const fixture = await buildFixture();
    const request = await insertRequest(fixture, grantFields(fixture));
    const eventId = await insertEvent(fixture, request.id as string);
    const adjustment = {
      moderation_event_id: eventId, dispute_id: request.id as string,
      target_account_id: fixture.sponsorId, reason: "Closed PR contribution landed elsewhere.",
      created_at: adjustmentCreatedAt,
    };
    const [applied] = await sql`insert into dispute_credit_adjustments ${sql(adjustment)} returning id`;
    await expect(sql`insert into dispute_credit_adjustments ${sql(adjustment)}`)
      .rejects.toMatchObject({ code: "23505" });
    const lines = await sql`
      insert into dispute_credit_adjustment_lines (adjustment_id, settlement_id, creditor_id, amount)
      values (${applied.id}, null, ${fixture.contributorId}, 3),
        (${applied.id}, ${fixture.settlementId}, ${fixture.landingCreditorId}, -6)
      returning id
    `;
    expect(new Set(lines.map((line) => line.id)).size).toBe(2);
    await expect(sql`
      insert into dispute_credit_adjustment_lines (adjustment_id, creditor_id, amount)
      values (${applied.id}, ${fixture.contributorId}, 0)
    `).rejects.toMatchObject({ code: "23514" });

    const legs = await sql`
      select settlement_id, account_id, counterparty_id, amount, created_at from ledger_entries
      where created_at = ${adjustmentCreatedAt}
        and account_id = any(${[fixture.sponsorId, fixture.contributorId, fixture.landingCreditorId]}::uuid[])
      order by amount
    `;
    expect(legs).toEqual([
      { settlement_id: fixture.settlementId, account_id: fixture.landingCreditorId,
        counterparty_id: fixture.sponsorId, amount: -6, created_at: new Date(adjustmentCreatedAt) },
      { settlement_id: null, account_id: fixture.sponsorId,
        counterparty_id: fixture.contributorId, amount: -3, created_at: new Date(adjustmentCreatedAt) },
      { settlement_id: null, account_id: fixture.contributorId,
        counterparty_id: fixture.sponsorId, amount: 3, created_at: new Date(adjustmentCreatedAt) },
      { settlement_id: fixture.settlementId, account_id: fixture.sponsorId,
        counterparty_id: fixture.landingCreditorId, amount: 6, created_at: new Date(adjustmentCreatedAt) },
    ]);
    const balances = await sql`
      select account_id, balance from balances
      where account_id = any(${[fixture.sponsorId, fixture.contributorId, fixture.landingCreditorId]}::uuid[])
    `;
    expect(new Map(balances.map((row) => [row.account_id, row.balance]))).toEqual(new Map([
      [fixture.sponsorId, -3], [fixture.contributorId, 3], [fixture.landingCreditorId, 0],
    ]));
  });
});

function grantFields(fixture: { contributorId: string }): RequestFields {
  return {
    state: "DECIDED", decision: "GRANTED", decided_by: fixture.contributorId,
    decided_reason: "The contribution landed elsewhere.", decided_at: adjustmentCreatedAt,
    moderator_figure: 5, awarded_points: 3,
  };
}

async function buildFixture() {
  const { repositoryId } = await materializeRepositoryFixture(sql);
  const [landing] = await sql`
    select settlements.id, settlements.pull_request_id, settlements.issue_id,
      settlements.creditor_id, settlements.debtor_id
    from settlements join issues on issues.id = settlements.issue_id
    where issues.repository_id = ${repositoryId}
  `;
  const [contributor] = await sql`
    insert into users (github_user_id, github_login)
    values (${externalId++}, ${`disputer-${randomUUID()}`}) returning id
  `;
  const [closedPr] = await sql`
    insert into pull_requests (github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body, author_id, state)
    values (${externalId++}, ${repositoryId}, ${landing.issue_id}, 99, 'https://example.test/pull/99',
      'Closed contribution', '', ${contributor.id}, 'CLOSED') returning id
  `;
  return {
    contributorId: contributor.id as string, pullRequestId: closedPr.id as string,
    issueId: landing.issue_id as string, landingId: landing.pull_request_id as string,
    settlementId: landing.id as string, sponsorId: landing.debtor_id as string,
    landingCreditorId: landing.creditor_id as string,
  };
}

async function insertRequest(fixture: Awaited<ReturnType<typeof buildFixture>>, fields: RequestFields = {}) {
  const row = {
    contributor_id: fixture.contributorId, pull_request_id: fixture.pullRequestId,
    issue_id: fixture.issueId, request_reason: "My contribution landed elsewhere.",
    landed_commit_url: "https://example.test/commit/landed", ...fields,
  };
  const [request] = await sql`insert into closed_pr_dispute_requests ${sql(row)} returning *`;
  return request;
}

async function insertEvent(fixture: { contributorId: string }, disputeId: string) {
  const [event] = await sql`
    insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason, dispute_request_id)
    values (${fixture.contributorId}, ${fixture.contributorId}, 'ACTIVE', 'ACTIVE', 'Dispute filed.', ${disputeId})
    returning id
  `;
  return event.id as string;
}
