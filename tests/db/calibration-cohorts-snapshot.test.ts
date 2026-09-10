import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql, type TransactionSql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { loadCalibrationCohorts, type DashboardSql } from "@/lib/dashboard/queries";

/**
 * Issue 499: loadCalibrationCohorts read the self-work cohort and the outsider
 * settlement cohort as two independent autocommit statements, each at its own
 * READ COMMITTED snapshot. A reconciliation commit landing between them yields
 * a cohort pair that is not one snapshot — the pooled comparison and the
 * per-repository breakdown built on it can describe two different committed
 * instants of the same request.
 *
 * The defect window sits BETWEEN the loader's two statements, and a postgres
 * SELECT cannot be delayed by a writer, so the gate is a test-side sql wrapper:
 * the first statement the loader issues executes immediately, and only then
 * does the gate release a writer on a second, independent connection, whose
 * transaction inserts AND commits a matched pair — one `self_work_calibrations`
 * row for the account and its `settlements` row on the same issue/PR chain.
 * The recorded interaction order proves the commit completed before the second
 * statement was issued, so anything the second statement can see that the
 * first cannot is the tear itself.
 *
 * Consistency is checkable because both rows of the committed pair reference
 * the same issue/PR chain: at one snapshot the pair appears in BOTH cohorts or
 * NEITHER. Under the torn read the pair splits — the outsider selection runs
 * after the commit and sees the settlement, the self-work selection ran before
 * it and does not.
 */
describe("the calibration cohort loader reads one database snapshot", () => {
  let container: StartedTestContainer | undefined;
  let sql: Sql;
  /** A second, independent session: the writer whose commit lands mid-load. */
  let otherSession: Sql;
  let externalId = 62_000;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  type CohortChain = { githubIssueId: number; githubPullRequestId: number };

  const seeded: {
    accountId: string;
    creditorId: string;
    /** Committed before the loader runs, so both cohorts must show it in every phase. */
    preexisting: CohortChain;
    /** Committed by the writer between the loader's two statements. */
    midflight: CohortChain & { issueId: string; pullRequestId: string };
  } = {
    accountId: "",
    creditorId: "",
    preexisting: { githubIssueId: 0, githubPullRequestId: 0 },
    midflight: { githubIssueId: 0, githubPullRequestId: 0, issueId: "", pullRequestId: "" },
  };

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "calibration_cohorts_snapshot",
      user: "calibration_cohorts_snapshot",
      password: "calibration_cohorts_snapshot",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    otherSession = postgres(started.databaseUrl, { max: 1 });
    await runMigrations();
    await seedCohortWorld();
  });

  afterAll(async () => {
    await closeSql();
    await otherSession?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("keeps self-work and outsider cohorts on one side of a commit landing between the two selections", async () => {
    const client = gatedCohortClient(sql);
    const cohorts = await loadCalibrationCohorts(seeded.accountId, { sql: client.sql });

    // The gate fired: the writer's commit completed after the first cohort
    // selection returned and before the second was issued. Everything the
    // consistency assertions below observe is downstream of this order.
    expect(client.order).toEqual([
      "statement 1 issued",
      "writer committed",
      "statement 2 issued",
    ]);

    // Vacuous-pass guard: the pair committed before the loader ran is in both
    // cohorts, so the assertions cannot pass on an empty database.
    expect(cohortSees(cohorts.selfWorkRows, seeded.preexisting)).toBe(true);
    expect(cohortSees(cohorts.outsiderRows, seeded.preexisting)).toBe(true);

    // One snapshot: the pair committed between the two selections appears in
    // both cohorts or neither. The torn read splits it — the outsider
    // selection runs after the commit and answers with the settlement, the
    // self-work selection ran before it and answers without.
    const selfWorkSees = cohortSees(cohorts.selfWorkRows, seeded.midflight);
    const outsiderSees = cohortSees(cohorts.outsiderRows, seeded.midflight);
    expect(
      { selfWorkSees, outsiderSees },
      "the two cohorts disagree about a pair committed between the two selections",
    ).toEqual({ selfWorkSees: false, outsiderSees: false });
  });

  /**
   * The loader's sql seam with the defect window gated open.
   *
   * Every statement the loader issues funnels through one counter, whether it
   * reaches the pool directly (the two bare autocommit statements) or through
   * `begin` (a transaction's reads): the first completes, then the gate
   * releases the writer and records its commit, then later statements run.
   * `begin` delegates to the real client so the transaction boundary the
   * production code chooses is the one under test.
   */
  function gatedCohortClient(real: Sql): { sql: DashboardSql; order: string[] } {
    const order: string[] = [];
    let statements = 0;

    const runStatement = async (
      target: <T extends readonly unknown[] = readonly unknown[]>(
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<T>,
      strings: TemplateStringsArray,
      values: unknown[],
    ): Promise<unknown> => {
      statements += 1;
      order.push(`statement ${statements} issued`);
      const result = await target(strings, ...values);
      if (statements === 1) {
        // The writer promise resolves only once its COMMIT has completed, so
        // any statement issued after this await takes a snapshot that the
        // committed pair is visible in (READ COMMITTED) or would be visible
        // in (REPEATABLE READ, which instead holds the earlier snapshot).
        await commitMatchedPair();
        order.push("writer committed");
      }
      return result;
    };

    const transactionHandle = (txSql: TransactionSql): DashboardSql =>
      Object.assign(
        (strings: TemplateStringsArray, ...values: unknown[]) =>
          runStatement(txSql as unknown as Parameters<typeof runStatement>[0], strings, values),
      ) as DashboardSql;

    const client = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) =>
        runStatement(real as unknown as Parameters<typeof runStatement>[0], strings, values),
      {
        begin: (options: string, run: (sql: DashboardSql) => Promise<unknown>): Promise<unknown> =>
          real.begin(options, (txSql) => run(transactionHandle(txSql))),
      },
    );

    return { sql: client as unknown as DashboardSql, order };
  }

  /**
   * The writer: on a second real connection, in ONE transaction, the matched
   * pair for the mid-flight chain — the account's self-work calibration row
   * and its SETTLED settlement row (creditor different, settled_points not
   * null) on the same issue/PR chain. The driver's begin promise includes
   * COMMIT, so awaiting it is the commit-completed signal the gate records.
   */
  async function commitMatchedPair(): Promise<void> {
    await otherSession.begin(async (tx) => {
      await tx`
        insert into self_work_calibrations (pull_request_id, issue_id, user_id, opening_comparison_points, actual_points)
        values (${seeded.midflight.pullRequestId}, ${seeded.midflight.issueId}, ${seeded.accountId}, 4, 6)
      `;
      await tx`
        insert into settlements (
          pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
          opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status, created_at
        )
        values (
          ${seeded.midflight.pullRequestId}, ${seeded.midflight.issueId}, ${seeded.creditorId}, ${null},
          ${seeded.accountId}, 4, 7, 1, 6, ${proofFor(seeded.midflight.githubPullRequestId)},
          ${"SETTLED"}, ${"2026-09-01T00:00:00.000Z"}
        )
      `;
    });
  }

  /** Both cohort selections key their rows off the same issue/PR chain columns. */
  function cohortSees(
    rows: ReadonlyArray<{ github_issue_id: number | string; github_pull_request_id: number | string }>,
    chain: CohortChain,
  ): boolean {
    return rows.some(
      (row) =>
        Number(row.github_issue_id) === chain.githubIssueId &&
        Number(row.github_pull_request_id) === chain.githubPullRequestId,
    );
  }

  /**
   * The account's world: two matched-pair chains on one repository. The
   * pre-existing chain is fully committed before any loader runs; the
   * mid-flight chain's issue and pull request are seeded here so the writer
   * commits only the payload pair.
   */
  async function seedCohortWorld(): Promise<void> {
    seeded.accountId = await insertUser("account");
    seeded.creditorId = await insertUser("creditor");
    const repositoryId = await insertRepository({
      ownerName: "example/cohorts",
      sponsorId: seeded.creditorId,
    });

    const preexisting = await insertMergedWork({ repositoryId, authorId: seeded.accountId });
    await insertSelfWorkCalibration(preexisting, { actualPoints: 6 });
    await insertSettlement(preexisting, { creditorId: seeded.creditorId });
    seeded.preexisting = {
      githubIssueId: preexisting.githubIssueId,
      githubPullRequestId: preexisting.githubPullRequestId,
    };

    seeded.midflight = await insertMergedWork({ repositoryId, authorId: seeded.accountId });
  }

  async function insertUser(githubLogin: string): Promise<string> {
    const [user] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (${nextExternalId()}, ${githubLogin})
      returning id
    `;
    return user.id;
  }

  async function insertRepository(input: { ownerName: string; sponsorId: string }): Promise<string> {
    const [repository] = await sql<{ id: string }[]>`
      insert into registered_repositories (
        github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, active, difficulty_scheme
      )
      values (
        ${nextExternalId()}, ${input.ownerName}, ${input.sponsorId}, ${"PUBLIC"}, ${nextExternalId()},
        ${true}, ${sql.json(difficultyScheme())}
      )
      returning id
    `;
    return repository.id;
  }

  async function insertMergedWork(input: {
    repositoryId: string;
    authorId: string;
  }): Promise<{ issueId: string; pullRequestId: string; githubIssueId: number; githubPullRequestId: number }> {
    const githubIssueId = nextExternalId();
    const [issue] = await sql<{ id: string }[]>`
      insert into issues (
        github_issue_id, repository_id, issue_number, title, body, url, state,
        opening_label, opening_comparison_points, opening_reserve_points
      )
      values (
        ${githubIssueId}, ${input.repositoryId}, ${nextExternalId()}, ${"A calibrated issue"},
        ${"Issue evidence"}, ${`https://github.com/example/cohorts/issues/${githubIssueId}`}, ${"CLOSED"},
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
        ${`https://github.com/example/cohorts/pull/${githubPullRequestId}`}, ${"A merged contribution"},
        ${"Pull request evidence"}, ${input.authorId}, ${"MERGED"}, now(),
        ${proofFor(githubPullRequestId)}
      )
      returning id
    `;
    await sql`
      insert into pull_request_issues (pull_request_id, issue_id, repository_id)
      values (${pullRequest.id}, ${issue.id}, ${input.repositoryId})
    `;
    return {
      issueId: issue.id,
      pullRequestId: pullRequest.id,
      githubIssueId,
      githubPullRequestId,
    };
  }

  async function insertSelfWorkCalibration(
    chain: { issueId: string; pullRequestId: string },
    input: { actualPoints: number },
  ): Promise<void> {
    await sql`
      insert into self_work_calibrations (pull_request_id, issue_id, user_id, opening_comparison_points, actual_points)
      values (${chain.pullRequestId}, ${chain.issueId}, ${seeded.accountId}, 4, ${input.actualPoints})
    `;
  }

  async function insertSettlement(
    chain: { issueId: string; pullRequestId: string; githubPullRequestId: number },
    input: { creditorId: string },
  ): Promise<void> {
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status, created_at
      )
      values (
        ${chain.pullRequestId}, ${chain.issueId}, ${input.creditorId}, ${null}, ${seeded.accountId},
        4, 7, 1, 6, ${proofFor(chain.githubPullRequestId)}, ${"SETTLED"}, ${"2026-09-01T00:00:00.000Z"}
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
});
