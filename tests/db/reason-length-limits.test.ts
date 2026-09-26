import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 5_900_000;
const originalDatabaseUrl = process.env.DATABASE_URL;

const maxReason = "x".repeat(2000);
const overReason = `${maxReason}!`;

function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

/** The check violation a value past the cap must produce, by constraint name. */
function overTheCap(constraintName: string): object {
  return { code: "23514", constraint_name: constraintName };
}

describe("reason length limits (migration 049)", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "reason_length_test",
      user: "reason_length_test",
      password: "reason_length_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
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

  it("caps settlement_override_requests.reason at 2000 characters", async () => {
    const requesterId = await insertUser(sql);

    await expect(sql`
      insert into settlement_override_requests (issue_id, requester_id, reason)
      values (${await insertIssue(sql)}, ${requesterId}, ${overReason})
    `).rejects.toMatchObject(overTheCap("settlement_override_requests_reason_length_check"));

    await sql`
      insert into settlement_override_requests (issue_id, requester_id, reason)
      values (${await insertIssue(sql)}, ${requesterId}, ${maxReason})
    `;
  });

  it("caps settlement_override_requests.decision_reason at 2000 characters", async () => {
    const deciderId = await insertUser(sql);

    const rejected = await insertOpenRequest();
    await expect(sql`
      update settlement_override_requests
      set state = ${"GRANTED"}, settled_points = 1, decided_by_id = ${deciderId},
          decision_reason = ${overReason}, decided_at = now()
      where id = ${rejected}
    `).rejects.toMatchObject(overTheCap("settlement_override_requests_decision_reason_length_check"));

    const accepted = await insertOpenRequest();
    await sql`
      update settlement_override_requests
      set state = ${"GRANTED"}, settled_points = 1, decided_by_id = ${deciderId},
          decision_reason = ${maxReason}, decided_at = now()
      where id = ${accepted}
    `;
  });

  it("caps calibration_audits.rationale at 2000 characters", async () => {
    await expect(insertAudit(overReason)).rejects.toMatchObject(
      overTheCap("calibration_audits_rationale_length_check"),
    );
    // The accepted row also proves decision stays nullable beside a rationale.
    await insertAudit(maxReason);
  });

  it("caps calibration_audits.decision at 2000 characters", async () => {
    const rejectedAudit = await insertAudit("A rationale under the cap.");
    await expect(sql`
      update calibration_audits set decision = ${overReason} where id = ${rejectedAudit}
    `).rejects.toMatchObject(overTheCap("calibration_audits_decision_length_check"));

    const acceptedAudit = await insertAudit("Another rationale under the cap.");
    await sql`
      update calibration_audits set decision = ${maxReason} where id = ${acceptedAudit}
    `;
  });

  it("caps moderation_events.reason at 2000 characters", async () => {
    await expect(insertEvent(overReason)).rejects.toMatchObject(
      overTheCap("moderation_events_reason_length_check"),
    );
    await insertEvent(maxReason);
  });

  it("caps moderation_events.recalibration_plan at 2000 characters and keeps null allowed", async () => {
    await expect(sql`
      insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason, recalibration_plan)
      values (${await insertUser(sql)}, ${await insertUser(sql)}, ${"RECALIBRATING"}, ${"ACTIVE"}, ${"Closed."}, ${overReason})
    `).rejects.toMatchObject(overTheCap("moderation_events_recalibration_plan_length_check"));

    await sql`
      insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason, recalibration_plan)
      values (${await insertUser(sql)}, ${await insertUser(sql)}, ${"RECALIBRATING"}, ${"ACTIVE"}, ${"Closed."}, ${maxReason})
    `;

    // The recalibration plan is optional: an event without one stays writable.
    await sql`
      insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason)
      values (${await insertUser(sql)}, ${await insertUser(sql)}, ${"ACTIVE"}, ${"WARNED"}, ${"Warned."})
    `;
  });

  it("caps moderation_credit_adjustments.reason at 2000 characters", async () => {
    const fixture = await insertAdjustmentReferences();

    await expect(sql`
      insert into moderation_credit_adjustments (
        moderation_event_id, calibration_audit_id, target_account_id,
        gap_per_pair, pair_count, total_amount, state, reason
      )
      values (
        ${fixture.eventId}, ${fixture.auditId}, ${fixture.sponsorId},
        1, 2, 3, ${"APPLIED"}, ${overReason}
      )
    `).rejects.toMatchObject(overTheCap("moderation_credit_adjustments_reason_length_check"));

    await sql`
      insert into moderation_credit_adjustments (
        moderation_event_id, calibration_audit_id, target_account_id,
        gap_per_pair, pair_count, total_amount, state, reason
      )
      values (
        ${fixture.eventId}, ${fixture.auditId}, ${fixture.sponsorId},
        1, 2, 3, ${"APPLIED"}, ${maxReason}
      )
    `;
  });
});

/** One open request row on its own issue, with `reason` already at the cap's short side. */
async function insertOpenRequest(): Promise<string> {
  const [request] = await sql<{ id: string }[]>`
    insert into settlement_override_requests (issue_id, requester_id, reason)
    values (${await insertIssue(sql)}, ${await insertUser(sql)}, ${"The settlement miscounted the review rounds."})
    returning id
  `;
  return request.id;
}

async function insertAudit(rationale: string): Promise<string> {
  const [audit] = await sql<{ id: string }[]>`
    insert into calibration_audits (
      account_id, reporter_id, rationale, sample_started_at, sample_ended_at, settled_sample_size
    )
    values (
      ${await insertUser(sql)}, ${await insertUser(sql)}, ${rationale},
      now() - interval '30 days', now(), 2
    )
    returning id
  `;
  return audit.id;
}

async function insertEvent(reason: string): Promise<string> {
  const [event] = await sql<{ id: string }[]>`
    insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason)
    values (${await insertUser(sql)}, ${await insertUser(sql)}, ${"ACTIVE"}, ${"UNDER_AUDIT"}, ${reason})
    returning id
  `;
  return event.id;
}

/** The moderation event, audit and target account an adjustment row references. */
async function insertAdjustmentReferences(): Promise<{
  eventId: string;
  auditId: string;
  sponsorId: string;
}> {
  const sponsorId = await insertUser(sql);
  const [event] = await sql<{ id: string }[]>`
    insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason)
    values (${sponsorId}, ${await insertUser(sql)}, ${"ACTIVE"}, ${"UNDER_AUDIT"}, ${"Recalibration audit opened."})
    returning id
  `;
  const [audit] = await sql<{ id: string }[]>`
    insert into calibration_audits (
      account_id, reporter_id, rationale, sample_started_at, sample_ended_at, settled_sample_size
    )
    values (
      ${sponsorId}, ${await insertUser(sql)},
      ${"The sponsor's settled sample warrants evaluation."},
      now() - interval '30 days', now(), 2
    )
    returning id
  `;
  return { eventId: event.id, auditId: audit.id, sponsorId };
}

async function insertIssue(client: Sql): Promise<string> {
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
  return issue.id;
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
