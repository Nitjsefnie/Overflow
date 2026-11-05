import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { runMigrations } from "../../scripts/migrate";
import type { DashboardSql } from "@/lib/dashboard/queries";
import { closeSql } from "@/lib/db/client";
import { createOwnerProgressReader, createSettledWorkReader, getOwnerProgressStats, getSettledWorkStats } from "@/lib/public-stats";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let nextId = 20_000;
const readAt = new Date("2026-10-27T12:00:00Z");
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;

function read() {
  return createSettledWorkReader({ sql: sql as unknown as DashboardSql, now: () => readAt.getTime() })();
}

describe("public settled work totals against PostgreSQL", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "overflow_public_stats_test", user: "overflow_public_stats_test" });
    container = started.container;
    process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
    await runMigrations();
    sql = postgres(started.databaseUrl);
  });

  beforeEach(async () => {
    await sql`truncate users cascade`;
    await sql`truncate registration_attempt_counts`;
    nextId = 20_000;
  });

  afterAll(async () => {
    await closeSql();
    await sql?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.OVERFLOW_DATABASE_URL;
    else process.env.OVERFLOW_DATABASE_URL = originalDatabaseUrl;
  });

  it("returns zero totals on an empty database", async () => {
    expect(await read()).toEqual({ pullRequests: 0, contributors: 0, points: 0, noRoundPullRequests: 0, meanReviewRounds: null, readAt });
  });

  it("counts all registered repositories, their progress markers, and daily attempts", async () => {
    const readProgress = () => createOwnerProgressReader({ sql: sql as unknown as DashboardSql })();
    expect(await readProgress()).toEqual({
      registrationStarts: 0, repositories: 0, githubRepositories: 0, gitlabRepositories: 0,
      listedIssue: 0, contributorReviewed: 0, listedSecondIssue: 0,
      refusedAttempts: {
        MISSING_CATALOG_LABELS: 0, WEBHOOK_SCOPE_MISSING: 0, NOT_ADMINISTRATOR_OR_APP_NOT_INSTALLED: 0,
        NOT_PUBLIC: 0, ALREADY_REGISTERED: 0, OTHER: 0,
      },
    });

    const sponsor = await insertUser("sponsor");
    const active = await insertRepository(sponsor);
    const unregistered = await insertRepository(sponsor);
    const sanctioned = await insertRepository(sponsor);
    const inactive = await insertRepository(sponsor);
    await insertRepository(sponsor);
    await sql`update registered_repositories set first_listed_issue_id = 101 where id = ${active}`;
    await sql`update registered_repositories set active = false, unregistered_at = now(),
      first_listed_issue_id = 102, contributor_review_received = true where id = ${unregistered}`;
    await sql`update registered_repositories set provider = 'gitlab', active = false, sanction_deactivated_at = now(),
      first_listed_issue_id = 103, contributor_review_received = true, second_issue_listed = true where id = ${sanctioned}`;
    await sql`update registered_repositories set provider = 'gitlab', active = false where id = ${inactive}`;
    await sql`insert into registration_attempt_counts (utc_day, kind, attempts) values
      ('2026-10-01', 'REGISTRATION_START', 5), ('2026-10-02', 'REGISTRATION_START', 7),
      ('2026-10-01', 'MISSING_CATALOG_LABELS', 2), ('2026-10-02', 'MISSING_CATALOG_LABELS', 3),
      ('2026-10-01', 'WEBHOOK_SCOPE_MISSING', 7), ('2026-10-02', 'NOT_ADMINISTRATOR_OR_APP_NOT_INSTALLED', 11),
      ('2026-10-01', 'NOT_PUBLIC', 13), ('2026-10-02', 'ALREADY_REGISTERED', 17), ('2026-10-01', 'OTHER', 19)`;
    const expected = {
      registrationStarts: 12, repositories: 5, githubRepositories: 3, gitlabRepositories: 2,
      listedIssue: 3, contributorReviewed: 2, listedSecondIssue: 1,
      refusedAttempts: {
        MISSING_CATALOG_LABELS: 5, WEBHOOK_SCOPE_MISSING: 7, NOT_ADMINISTRATOR_OR_APP_NOT_INSTALLED: 11,
        NOT_PUBLIC: 13, ALREADY_REGISTERED: 17, OTHER: 19,
      },
    };
    expect(await readProgress()).toEqual(expected);
    expect(await getOwnerProgressStats()).toEqual(expected);
  });

  it("counts distinct settled pull requests and contributors, and sums all their issue rows", async () => {
    const sponsor = await insertUser("sponsor");
    const first = await insertUser("first");
    const second = await insertUser("second");
    const repository = await insertRepository(sponsor);
    const work = await insertWork(repository, first);
    await insertSettlement(work.pullRequest, work.issue, sponsor, first, "SETTLED", 5);
    expect(await read()).toEqual({ pullRequests: 1, contributors: 1, points: 5, noRoundPullRequests: 1, meanReviewRounds: 0, readAt });

    const anotherIssue = await insertIssue(repository);
    await sql`insert into pull_request_issues (pull_request_id, issue_id, repository_id) values (${work.pullRequest}, ${anotherIssue}, ${repository})`;
    await insertSettlement(work.pullRequest, anotherIssue, sponsor, first, "SETTLED", 2);
    const nextWork = await insertWork(repository, first);
    await insertSettlement(nextWork.pullRequest, nextWork.issue, sponsor, first, "SETTLED", 4);
    const otherWork = await insertWork(repository, second);
    await insertSettlement(otherWork.pullRequest, otherWork.issue, sponsor, second, "SETTLED", 8);
    const expected = { pullRequests: 3, contributors: 2, points: 19, noRoundPullRequests: 3, meanReviewRounds: 0, readAt };
    expect(await read()).toEqual(expected);
    const before = Date.now();
    const defaultReading = await getSettledWorkStats();
    expect(defaultReading).toEqual({ ...expected, readAt: expect.any(Date) });
    expect(defaultReading.readAt.getTime()).toBeGreaterThanOrEqual(before);
    expect(defaultReading.readAt.getTime()).toBeLessThanOrEqual(Date.now());

    const unclaimed = await insertWork(repository, null);
    await insertSettlement(unclaimed.pullRequest, unclaimed.issue, sponsor, null, "UNCLAIMED", 9);
    expect(await read()).toEqual(expected);
    const unsettled = await insertWork(repository, second);
    await insertSettlement(unsettled.pullRequest, unsettled.issue, sponsor, second, "UNSETTLED", 0);
    expect(await read()).toEqual(expected);

    const selfWork = await insertWork(repository, sponsor);
    await sql`insert into self_work_calibrations (pull_request_id, issue_id, user_id, opening_comparison_points, actual_points)
      values (${selfWork.pullRequest}, ${selfWork.issue}, ${sponsor}, 4, 7)`;
    expect(await read()).toEqual(expected);
    await expect(insertSettlement(selfWork.pullRequest, selfWork.issue, sponsor, sponsor, "SETTLED", 7))
      .rejects.toThrow(/settlements_check2/);

    const zeroCredit = await insertWork(repository, first);
    await sql`
      insert into settlements (pull_request_id, issue_id, creditor_id, debtor_id, opening_comparison_points,
        settled_points, review_rounds, credits, proof_sha256, status)
      values (${zeroCredit.pullRequest}, ${zeroCredit.issue}, ${first}, ${sponsor}, 4, 2, 2, 0,
        ${(nextId++).toString(16).padStart(64, "0")}, 'SETTLED')`;
    expect(await read()).toEqual({ ...expected, pullRequests: 4, meanReviewRounds: 0.5 });
  });

  it("counts review rounds once per settled pull request, however many issues it settled", async () => {
    const sponsor = await insertUser("sponsor");
    const contributor = await insertUser("contributor");
    const repository = await insertRepository(sponsor);
    const settle = async (issueRounds: number[], status: "SETTLED" | "UNCLAIMED" | "UNSETTLED" = "SETTLED") => {
      const work = await insertWork(repository, status === "UNCLAIMED" ? null : contributor);
      for (const [index, rounds] of issueRounds.entries()) {
        const issue = index === 0 ? work.issue : await insertIssue(repository);
        if (index > 0) await sql`insert into pull_request_issues (pull_request_id, issue_id, repository_id) values (${work.pullRequest}, ${issue}, ${repository})`;
        await insertSettlement(work.pullRequest, issue, sponsor, status === "UNCLAIMED" ? null : contributor, status, 1, rounds);
      }
    };
    // Per pull request the rounds are 0, 0, 0, 3, 1: three without a round, a mean of 4 / 5.
    // Counted per settlement row instead, they read four without a round and a mean of 7 / 7.
    await settle([0]);
    await settle([0]);
    await settle([0, 0]);
    await settle([3, 3]);
    await settle([1]);
    await settle([2], "UNCLAIMED");
    await settle([0], "UNSETTLED");
    expect(await read()).toEqual({
      pullRequests: 5, contributors: 1, points: 7, noRoundPullRequests: 3, meanReviewRounds: expect.closeTo(0.8, 10), readAt,
    });
  });
});

async function insertUser(login: string): Promise<string> {
  const [row] = await sql<{ id: string }[]>`insert into users (github_user_id, github_login) values (${nextId++}, ${login}) returning id`;
  return row.id;
}

async function insertRepository(sponsor: string): Promise<string> {
  const scheme = {
    openingName: "Scope", actualName: "Delivered difficulty",
    openingLabels: [{ label: "size/M", comparisonPoints: 4, reservePoints: 4 }],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
  };
  const [row] = await sql<{ id: string }[]>`
    insert into registered_repositories (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
    values (${nextId++}, ${`example/private-work-${nextId}`}, ${sponsor}, 'PRIVATE', ${nextId++}, ${sql.json(scheme)}) returning id`;
  return row.id;
}

async function insertIssue(repository: string): Promise<string> {
  const number = nextId++;
  const [row] = await sql<{ id: string }[]>`
    insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state, opening_label, opening_comparison_points, opening_reserve_points)
    values (${number}, ${repository}, ${number}, 'issue', '', ${`https://example.test/issues/${number}`}, 'CLOSED', 'size/M', 4, 4) returning id`;
  return row.id;
}

async function insertWork(repository: string, author: string | null): Promise<{ issue: string; pullRequest: string }> {
  const issue = await insertIssue(repository);
  const number = nextId++;
  const [row] = await sql<{ id: string }[]>`
    insert into pull_requests (github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body, author_id, state, merged_at)
    values (${number}, ${repository}, ${issue}, ${number}, ${`https://example.test/pull/${number}`}, 'pull request', '', ${author}, 'MERGED', now()) returning id`;
  await sql`insert into pull_request_issues (pull_request_id, issue_id, repository_id) values (${row.id}, ${issue}, ${repository})`;
  return { issue, pullRequest: row.id };
}

async function insertSettlement(pullRequest: string, issue: string, sponsor: string, creditor: string | null,
  status: "SETTLED" | "UNCLAIMED" | "UNSETTLED", points: number, reviewRounds = 0): Promise<void> {
  await sql`
    insert into settlements (pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status)
    values (${pullRequest}, ${issue}, ${creditor}, ${creditor === null ? "unclaimed" : null}, ${sponsor},
      4, ${status === "UNSETTLED" ? null : points + reviewRounds}, ${reviewRounds}, ${status === "UNSETTLED" ? 0 : points},
      ${(nextId++).toString(16).padStart(64, "0")}, ${status})`;
}
