import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { listAuditCandidates, listModerationRepositories } from "@/lib/dashboard/queries";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 70_000;
const originalDatabaseUrl = process.env.DATABASE_URL;

/** Accounts seeded out of alphabetical order, so a projection that keeps insertion order is visible. */
const seeded = {
  carolId: "",
  aliceId: "",
  bobId: "",
  openAuditId: "",
  activeRepositoryIds: [] as string[],
  inactiveRepositoryId: "",
};

describe("audit targeting against PostgreSQL", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "overflow_audit_targeting_test",
      user: "overflow_audit_targeting_test",
      password: "overflow_audit_targeting_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
    await seedAuditTargetingWorld();
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

  it("projects every account by login with its own pair counts and its open audit", async () => {
    const candidates = await listAuditCandidates();

    expect(candidates).toEqual([
      {
        id: seeded.aliceId,
        githubLogin: "alice",
        enforcementState: "ACTIVE",
        selfWorkPairCount: 0,
        outsiderPairCount: 0,
        openAuditId: null,
      },
      {
        id: seeded.bobId,
        githubLogin: "bob",
        enforcementState: "ACTIVE",
        selfWorkPairCount: 0,
        outsiderPairCount: 0,
        openAuditId: null,
      },
      {
        id: seeded.carolId,
        githubLogin: "carol",
        enforcementState: "ACTIVE",
        selfWorkPairCount: 3,
        outsiderPairCount: 1,
        openAuditId: seeded.openAuditId,
      },
    ]);
  });

  it("reports an open audit's id and nothing for an account whose only audit was dismissed", async () => {
    const auditStates = await sql<{ github_login: string; state: string }[]>`
      select users.github_login, calibration_audits.state::text
      from calibration_audits
      join users on users.id = calibration_audits.account_id
      order by users.github_login
    `;
    expect(auditStates).toEqual([
      { github_login: "alice", state: "DISMISSED" },
      { github_login: "carol", state: "OPEN" },
    ]);

    const candidates = await listAuditCandidates();

    expect(byLogin(candidates, "carol").openAuditId).toBe(seeded.openAuditId);
    expect(byLogin(candidates, "alice").openAuditId).toBeNull();
  });

  it("excludes a self-work row without settled points and one whose pull request has no proof", async () => {
    const [stored] = await sql<{ total: string }[]>`
      select count(*) as total from self_work_calibrations where user_id = ${seeded.carolId}
    `;
    expect(Number(stored.total)).toBe(5);

    const candidates = await listAuditCandidates();

    expect(byLogin(candidates, "carol").selfWorkPairCount).toBe(3);
  });

  it("excludes an unsettled and an unclaimed settlement from the outsider count", async () => {
    const statuses = await sql<{ status: string; creditor_id: string | null }[]>`
      select status::text, creditor_id from settlements where debtor_id = ${seeded.carolId} order by status
    `;
    expect(statuses).toEqual([
      { status: "SETTLED", creditor_id: seeded.bobId },
      { status: "UNCLAIMED", creditor_id: null },
      { status: "UNSETTLED", creditor_id: seeded.bobId },
    ]);

    const candidates = await listAuditCandidates();

    expect(byLogin(candidates, "carol").outsiderPairCount).toBe(1);
  });

  it("cannot count a settlement an account owes itself, because the schema forbids recording one", async () => {
    const { issueId, pullRequestId } = await insertMergedWork({
      repositoryId: seeded.activeRepositoryIds[0]!,
      authorId: seeded.carolId,
      withProof: true,
    });

    await expect(sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, debtor_id, opening_comparison_points,
        settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequestId}, ${issueId}, ${seeded.carolId}, ${seeded.carolId}, 4, 7, 1, 6,
        ${proofFor(nextExternalId())}, ${"SETTLED"}
      )
    `).rejects.toThrow(/settlements_check2/);

    const candidates = await listAuditCandidates();

    expect(byLogin(candidates, "carol").outsiderPairCount).toBe(1);
  });

  it("lists active repositories by owner name and leaves a deactivated one out", async () => {
    const repositories = await listModerationRepositories();

    expect(repositories).toEqual([
      { id: seeded.activeRepositoryIds[0], ownerName: "example/anchor" },
      { id: seeded.activeRepositoryIds[1], ownerName: "example/harbour" },
    ]);
    expect(repositories.map((repository) => repository.id)).not.toContain(seeded.inactiveRepositoryId);
  });
});

function byLogin(candidates: Awaited<ReturnType<typeof listAuditCandidates>>, githubLogin: string) {
  const candidate = candidates.find((row) => row.githubLogin === githubLogin);
  if (candidate === undefined) {
    throw new Error(`No audit candidate was projected for ${githubLogin}.`);
  }
  return candidate;
}

/**
 * Carol is the audit target: three countable self-work pairs against one countable outsider
 * settlement, so a projection that crosses the two counts reports the wrong numbers rather than the
 * same number twice. Alice and Bob have neither, which is what exercises an account with no rows.
 */
async function seedAuditTargetingWorld(): Promise<void> {
  seeded.carolId = await insertUser("carol");
  seeded.bobId = await insertUser("bob");
  seeded.aliceId = await insertUser("alice");

  const harbourId = await insertRepository({ ownerName: "example/harbour", sponsorId: seeded.bobId, active: true });
  const anchorId = await insertRepository({ ownerName: "example/anchor", sponsorId: seeded.bobId, active: true });
  seeded.activeRepositoryIds = [anchorId, harbourId];
  seeded.inactiveRepositoryId = await insertRepository({
    ownerName: "example/retired",
    sponsorId: seeded.bobId,
    active: false,
  });

  for (let index = 0; index < 3; index += 1) {
    await insertSelfWorkCalibration({ repositoryId: harbourId, userId: seeded.carolId, actualPoints: 5, withProof: true });
  }
  await insertSelfWorkCalibration({ repositoryId: harbourId, userId: seeded.carolId, actualPoints: null, withProof: true });
  await insertSelfWorkCalibration({ repositoryId: harbourId, userId: seeded.carolId, actualPoints: 5, withProof: false });

  await insertSettlement({
    repositoryId: harbourId,
    debtorId: seeded.carolId,
    creditorId: seeded.bobId,
    status: "SETTLED",
  });
  await insertSettlement({
    repositoryId: harbourId,
    debtorId: seeded.carolId,
    creditorId: seeded.bobId,
    status: "UNSETTLED",
  });
  await insertSettlement({
    repositoryId: harbourId,
    debtorId: seeded.carolId,
    creditorId: null,
    status: "UNCLAIMED",
  });

  const [openAudit] = await sql<{ id: string }[]>`
    insert into calibration_audits (
      account_id, reporter_id, state, rationale, sample_started_at, sample_ended_at, settled_sample_size
    )
    values (
      ${seeded.carolId}, ${seeded.bobId}, ${"OPEN"}, ${"A moderator opened an account audit."},
      ${"2026-01-01T00:00:00.000Z"}, ${"2026-02-01T00:00:00.000Z"}, 10
    )
    returning id
  `;
  seeded.openAuditId = openAudit.id;

  await sql`
    insert into calibration_audits (
      account_id, reporter_id, state, rationale, decision, sample_started_at, sample_ended_at,
      settled_sample_size, decided_at
    )
    values (
      ${seeded.aliceId}, ${seeded.bobId}, ${"DISMISSED"}, ${"A moderator opened an account audit."},
      ${"The pattern was not sustained."}, ${"2026-01-01T00:00:00.000Z"}, ${"2026-02-01T00:00:00.000Z"}, 10, now()
    )
  `;
}

async function insertUser(githubLogin: string): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${nextExternalId()}, ${githubLogin})
    returning id
  `;
  return user.id;
}

async function insertRepository(input: {
  ownerName: string;
  sponsorId: string;
  active: boolean;
}): Promise<string> {
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, active, difficulty_scheme
    )
    values (
      ${nextExternalId()}, ${input.ownerName}, ${input.sponsorId}, ${"PUBLIC"}, ${nextExternalId()},
      ${input.active}, ${sql.json(difficultyScheme())}
    )
    returning id
  `;
  return repository.id;
}

async function insertMergedWork(input: {
  repositoryId: string;
  authorId: string;
  withProof: boolean;
}): Promise<{ issueId: string; pullRequestId: string }> {
  const githubIssueId = nextExternalId();
  const [issue] = await sql<{ id: string }[]>`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    values (
      ${githubIssueId}, ${input.repositoryId}, ${nextExternalId()}, ${"An account calibration issue"},
      ${"Issue evidence"}, ${`https://github.com/example/overflow/issues/${githubIssueId}`}, ${"CLOSED"},
      ${"size/M"}, 4, 4
    )
    returning id
  `;
  const githubPullRequestId = nextExternalId();
  const [pullRequest] = await sql<{ id: string }[]>`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
      author_id, state, merged_at, proof_sha256
    )
    values (
      ${githubPullRequestId}, ${input.repositoryId}, ${issue.id}, ${nextExternalId()},
      ${`https://github.com/example/overflow/pull/${githubPullRequestId}`}, ${"A merged contribution"},
      ${"Pull request evidence"}, ${input.authorId}, ${"MERGED"}, now(),
      ${input.withProof ? proofFor(githubPullRequestId) : null}
    )
    returning id
  `;
  await sql`
    insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequest.id}, ${issue.id}, ${input.repositoryId})
  `;
  return { issueId: issue.id, pullRequestId: pullRequest.id };
}

async function insertSelfWorkCalibration(input: {
  repositoryId: string;
  userId: string;
  actualPoints: number | null;
  withProof: boolean;
}): Promise<void> {
  const { issueId, pullRequestId } = await insertMergedWork({
    repositoryId: input.repositoryId,
    authorId: input.userId,
    withProof: input.withProof,
  });
  await sql`
    insert into self_work_calibrations (pull_request_id, issue_id, user_id, opening_comparison_points, actual_points)
    values (${pullRequestId}, ${issueId}, ${input.userId}, 4, ${input.actualPoints})
  `;
}

async function insertSettlement(input: {
  repositoryId: string;
  debtorId: string;
  creditorId: string | null;
  status: "SETTLED" | "UNSETTLED" | "UNCLAIMED";
}): Promise<void> {
  const { issueId, pullRequestId } = await insertMergedWork({
    repositoryId: input.repositoryId,
    authorId: input.debtorId,
    withProof: true,
  });
  const settledPoints = input.status === "UNSETTLED" ? null : 7;
  const credits = settledPoints === null ? 0 : Math.max(0, settledPoints - 1);
  await sql`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
    )
    values (
      ${pullRequestId}, ${issueId}, ${input.creditorId},
      ${input.status === "UNCLAIMED" ? "outsider-login" : null}, ${input.debtorId},
      4, ${settledPoints}, 1, ${credits}, ${proofFor(nextExternalId())}, ${input.status}
    )
  `;
}

function difficultyScheme() {
  return {
    openingName: "Scope",
    actualName: "Delivered difficulty",
    openingLabels: [{ label: "size/M", comparisonPoints: 4, reservePoints: 4 }],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}

function proofFor(identifier: number): string {
  return identifier.toString(16).padStart(64, "0");
}

function nextExternalId(): number {
  externalId += 1;
  return externalId;
}
