import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { closeSql, getSql } from "@/lib/db/client";
import { listCreditIssued } from "@/lib/dashboard/ledger-panels";
import type { DashboardSql } from "@/lib/dashboard/queries";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 6_400_000;
const originalDatabaseUrl = process.env.DATABASE_URL;

function nextExternalId(): number {
  return ++externalId;
}

describe("hourly credit issued", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "credit_issued_test", user: "credit_issued_test" });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    execFileSync("pnpm", ["db:migrate"], { env: process.env, stdio: "pipe" });
    sql = getSql();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("groups positive creditor legs by merge hour or adjustment creation hour, newest first", async () => {
    const sponsorId = await insertUser(sql);
    const first = await insertSettlement(sponsorId, 4, "2026-09-01T10:05:00Z");
    await insertSettlement(sponsorId, 2, "2026-09-01T10:59:59Z");
    await insertSettlement(sponsorId, 0, "2026-09-01T11:05:00Z");
    await insertSettlement(sponsorId, 0, "2026-09-01T11:05:00Z", "unsettled");
    const [event] = await sql<{ id: string }[]>`
      insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason)
      values (${sponsorId}, ${first.creditorId}, 'ACTIVE', 'UNDER_AUDIT', 'Audit opened') returning id
    `;
    const [audit] = await sql<{ id: string }[]>`
      insert into calibration_audits (account_id, reporter_id, rationale, sample_started_at, sample_ended_at, settled_sample_size)
      values (${sponsorId}, ${first.creditorId}, 'Review the sample', now() - interval '30 days', now(), 2) returning id
    `;
    const [adjustment] = await sql<{ id: string }[]>`
      insert into moderation_credit_adjustments (
        moderation_event_id, calibration_audit_id, target_account_id,
        gap_per_pair, pair_count, total_amount, state, reason, created_at
      ) values (${event.id}, ${audit.id}, ${sponsorId}, 3, 1, 3, 'APPLIED', 'Compensate work', '2026-09-02T12:13:00Z')
      returning id
    `;
    await sql`
      insert into moderation_credit_adjustment_lines (adjustment_id, settlement_id, creditor_id, amount)
      values (${adjustment.id}, ${first.id}, ${first.creditorId}, 3)
    `;
    const [reversal] = await sql<{ id: string }[]>`
      insert into moderation_credit_adjustments (
        moderation_event_id, calibration_audit_id, target_account_id,
        gap_per_pair, pair_count, total_amount, state, reason, reversal_of, created_at
      ) values (${event.id}, ${audit.id}, ${sponsorId}, 3, 1, 3, 'APPLIED', 'Reverse compensation', ${adjustment.id}, '2026-09-02T14:15:00Z')
      returning id
    `;
    await sql`
      insert into moderation_credit_adjustment_lines (adjustment_id, settlement_id, creditor_id, amount)
      values (${reversal.id}, ${first.id}, ${first.creditorId}, -3)
    `;
    const [dispute] = await sql<{ id: string }[]>`
      insert into closed_pr_dispute_requests (contributor_id, pull_request_id, issue_id, landed_commit_url, request_reason)
      values (${first.creditorId}, ${first.pullRequestId}, ${first.issueId}, 'https://github.com/example/repository/commit/landed', 'Contribution landed elsewhere')
      returning id
    `;
    const [award] = await sql<{ id: string }[]>`
      insert into dispute_credit_adjustments (moderation_event_id, dispute_id, target_account_id, reason, created_at)
      values (${event.id}, ${dispute.id}, ${sponsorId}, 'Award landed work', '2026-09-02T13:17:00Z') returning id
    `;
    await sql`
      insert into dispute_credit_adjustment_lines (adjustment_id, settlement_id, creditor_id, amount)
      values (${award.id}, null, ${first.creditorId}, 5), (${award.id}, ${first.id}, ${first.creditorId}, -4)
    `;

    const buckets = await sql.begin(async (transaction) => {
      await transaction`set local time zone 'Asia/Kathmandu'`;
      return listCreditIssued({ sql: transaction as unknown as DashboardSql });
    });
    expect(buckets).toEqual([
      { bucketStartedAt: "2026-09-02T13:00:00.000Z", issuedTotal: 5 },
      { bucketStartedAt: "2026-09-02T12:00:00.000Z", issuedTotal: 3 },
      { bucketStartedAt: "2026-09-01T10:00:00.000Z", issuedTotal: 6 },
    ]);
  });

  it("caps the result at the 100 most recent hourly buckets", async () => {
    const sponsorId = await insertUser(sql);
    for (let hour = 0; hour < 101; hour += 1) {
      await insertSettlement(sponsorId, 1, new Date(Date.UTC(2027, 0, 1, hour, 37)).toISOString());
    }

    const buckets = await listCreditIssued();
    expect(buckets).toHaveLength(100);
    expect(buckets[0]).toEqual({ bucketStartedAt: "2027-01-05T04:00:00.000Z", issuedTotal: 1 });
    expect(buckets.at(-1)).toEqual({ bucketStartedAt: "2027-01-01T01:00:00.000Z", issuedTotal: 1 });
  });
});

async function insertSettlement(
  sponsorId: string,
  credits: number,
  mergedAt: string,
  kind: "outsider" | "unsettled" = "outsider",
): Promise<{ id: string; creditorId: string; pullRequestId: string; issueId: string }> {
  const creditorId = await insertUser(sql);
  const pullRequest = await insertMergedPullRequest(sql, mergedAt);
  const [settlement] = await sql<{ id: string }[]>`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status, created_at
    ) values (
      ${pullRequest.id}, ${pullRequest.issueId}, ${creditorId}, ${sponsorId},
      5, ${kind === "unsettled" ? null : 8}, ${8 - credits}, ${credits},
      ${`${nextExternalId()}`.padStart(64, "a")}, ${kind === "unsettled" ? "UNSETTLED" : "SETTLED"}, '2026-09-03T08:00:00Z'
    ) returning id
  `;
  return { id: settlement.id, creditorId, pullRequestId: pullRequest.id, issueId: pullRequest.issueId };
}

async function insertMergedPullRequest(client: Sql, mergedAt: string): Promise<{ id: string; issueId: string }> {
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
      ${"MERGED"}, ${mergedAt}
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
