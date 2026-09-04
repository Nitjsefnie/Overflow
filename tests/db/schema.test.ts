import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql, withTransaction } from "@/lib/db/client";
import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";
import { claimGitHubIdentity } from "@/lib/fold/postgres-store";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { foldRepository, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";

let container: Awaited<ReturnType<GenericContainer["start"]>> | undefined;
let sql: Sql;
let externalId = 1_000_000;
const originalDatabaseUrl = process.env.DATABASE_URL;
type QueryableSql = Sql | TransactionSql;

describe("initial PostgreSQL materialization", () => {
  beforeAll(async () => {
    container = await new GenericContainer("postgres:17-alpine")
      .withEnvironment({
        POSTGRES_DB: "overflow_test",
        POSTGRES_PASSWORD: "overflow_test",
        POSTGRES_USER: "overflow_test",
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forSuccessfulCommand("psql -U overflow_test -d overflow_test -c 'select 1' >/dev/null 2>&1"))
      .start();
    process.env.DATABASE_URL = `postgresql://overflow_test:overflow_test@${container.getHost()}:${container.getMappedPort(5432)}/overflow_test`;
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

  it("creates every required relational table and derived view", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public'
    `;

    for (const table of [
      "users",
      "registered_repositories",
      "issues",
      "pull_requests",
      "review_rounds",
      "settlements",
      "self_work_calibrations",
      "unwritable_closures",
      "webhook_deliveries",
      "reconciliation_runs",
      "reconciliation_changes",
      "calibration_audits",
      "moderation_events",
    ]) {
      expect(rows.some((row) => row.table_name === table)).toBe(true);
    }

    const views = await sql<{ table_name: string }[]>`
      select table_name from information_schema.views where table_schema = 'public'
    `;
    expect(views.map((view) => view.table_name)).toEqual(
      expect.arrayContaining(["ledger_entries", "balances", "calibration_statistics"]),
    );
  });

  it("records each numbered migration only once", async () => {
    const [result] = await sql<{ count: number }[]>`
      select count(*)::integer as count from schema_migrations where name = ${"001_initial.sql"}
    `;

    expect(result.count).toBe(1);
  });

  it("rejects out-of-range opening and actual difficulty points", async () => {
    await expect(insertIssue(sql, { comparisonPoints: 11 })).rejects.toThrow();
    await expect(insertPullRequest(sql, { actualPoints: 0 })).rejects.toThrow();
  });

  it("rejects duplicate GitHub user and repository identifiers", async () => {
    const githubUserId = nextExternalId();
    await insertUser(sql, githubUserId);
    await expect(insertUser(sql, githubUserId)).rejects.toThrow();

    const sponsorId = await insertUser(sql);
    const githubRepositoryId = nextExternalId();
    await insertRepository(sql, sponsorId, githubRepositoryId);
    await expect(insertRepository(sql, sponsorId, githubRepositoryId)).rejects.toThrow();
  });

  it("requires every repository to persist a complete explicit difficulty scheme", async () => {
    const sponsorId = await insertUser(sql);
    const validScheme = validDifficultyScheme();

    await expect(
      insertRepositoryWithDifficultyScheme(sql, sponsorId, validScheme),
    ).resolves.toEqual(expect.any(String));

    const incompleteActualCatalog = validDifficultyScheme();
    incompleteActualCatalog.actualLabels.pop();
    const emptyOpeningCatalog = validDifficultyScheme();
    emptyOpeningCatalog.openingLabels = [];
    const duplicateAndMissingActualPoints = validDifficultyScheme();
    duplicateAndMissingActualPoints.actualLabels[9] = { label: "delivered/10", points: 9 };
    const outOfRangeOpeningPoints = validDifficultyScheme();
    outOfRangeOpeningPoints.openingLabels[0] = {
      ...outOfRangeOpeningPoints.openingLabels[0],
      comparisonPoints: 11,
    };
    const wrongPointType = validDifficultyScheme() as unknown as {
      actualLabels: Array<{ label: string; points: unknown }>;
    };
    wrongPointType.actualLabels[0] = { label: "delivered/1", points: "1" };
    const overlappingCatalogs = validDifficultyScheme();
    overlappingCatalogs.actualLabels[0] = { label: "S", points: 1 };
    const blankDisplayName = validDifficultyScheme();
    blankDisplayName.actualName = " ";

    for (const scheme of [
      null,
      {},
      emptyOpeningCatalog,
      incompleteActualCatalog,
      duplicateAndMissingActualPoints,
      outOfRangeOpeningPoints,
      wrongPointType,
      overlappingCatalogs,
      blankDisplayName,
    ]) {
      await expect(insertRepositoryWithDifficultyScheme(sql, sponsorId, scheme)).rejects.toThrow();
    }
  });

  it("rejects updates to an issue's original opening rating", async () => {
    const issue = await insertIssue(sql);

    await expect(updateOriginalOpeningDifficulty(sql, issue.id)).rejects.toThrow();
  });

  it("rejects a pull request whose issue belongs to another repository", async () => {
    const issue = await insertIssue(sql);
    const foreignRepository = await insertRepository(sql, await insertUser(sql));
    const githubPullRequestId = nextExternalId();

    await expect(sql`
      insert into pull_requests (
        github_pull_request_id,
        repository_id,
        issue_id,
        pull_request_number,
        url,
        title,
        body,
        actual_label,
        actual_points,
        state,
        merged_at
      )
      values (
        ${githubPullRequestId},
        ${foreignRepository},
        ${issue.id},
        ${nextExternalId()},
        ${`https://github.com/example/repository/pull/${githubPullRequestId}`},
        ${"A mismatched contribution"},
        ${"Pull request evidence"},
        ${"delivered/6"},
        6,
        ${"MERGED"},
        now()
      )
    `).rejects.toThrow();
  });

  it("rejects a settlement whose issue does not match its pull request", async () => {
    const pullRequest = await insertPullRequest(sql);
    const unrelatedIssue = await insertIssue(sql);
    const creditorId = await insertUser(sql);

    await expect(sql`
      insert into settlements (
        pull_request_id,
        issue_id,
        creditor_id,
        debtor_id,
        opening_comparison_points,
        settled_points,
        review_rounds,
        credits,
        proof_sha256,
        status
      )
      values (
        ${pullRequest.id},
        ${unrelatedIssue.id},
        ${creditorId},
        ${pullRequest.sponsorId},
        5,
        6,
        2,
        4,
        ${"c".repeat(64)},
        ${"SETTLED"}
      )
    `).rejects.toThrow();
  });

  it("allows one merged PR to settle each of several issues with its one raw-diff proof", async () => {
    const pullRequest = await insertPullRequest(sql);
    const secondIssueId = await insertSiblingIssue(sql, pullRequest.issueId);
    const contributorId = await insertUser(sql);
    const proofFingerprint = "a".repeat(64);

    await sql`
      insert into pull_request_issues (pull_request_id, issue_id)
      values (${pullRequest.id}, ${secondIssueId})
    `;
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values
        (${pullRequest.id}, ${pullRequest.issueId}, ${contributorId}, ${pullRequest.sponsorId}, 5, 6, 2, 4, ${proofFingerprint}, ${"SETTLED"}),
        (${pullRequest.id}, ${secondIssueId}, ${contributorId}, ${pullRequest.sponsorId}, 5, 6, 2, 4, ${proofFingerprint}, ${"SETTLED"})
    `;

    const rows = await sql<{ issue_id: string; proof_sha256: string }[]>`
      select issue_id, proof_sha256 from settlements where pull_request_id = ${pullRequest.id} order by issue_id
    `;
    expect(rows).toEqual([
      { issue_id: pullRequest.issueId, proof_sha256: proofFingerprint },
      { issue_id: secondIssueId, proof_sha256: proofFingerprint },
    ].sort((left, right) => left.issue_id.localeCompare(right.issue_id)));
  });

  it("claims an unclaimed GitHub identity without rewriting its proof or amount", async () => {
    const pullRequest = await insertPullRequest(sql);
    const contributorId = await insertUserWithLogin(sql, "later-contributor");
    const proofFingerprint = "f".repeat(64);

    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${pullRequest.issueId}, null, ${"later-contributor"}, ${pullRequest.sponsorId},
        5, 6, 2, 4, ${proofFingerprint}, ${"UNCLAIMED"}
      )
    `;

    await claimGitHubIdentity(sql, contributorId, "later-contributor");

    const [claimed] = await sql<{
      creditor_id: string;
      credits: number;
      proof_sha256: string;
      status: string;
    }[]>`
      select creditor_id, credits, proof_sha256, status
      from settlements where issue_id = ${pullRequest.issueId}
    `;
    expect(claimed).toEqual({
      creditor_id: contributorId,
      credits: 4,
      proof_sha256: proofFingerprint,
      status: "SETTLED",
    });
  });

  it("derives zero-sum ledger entries and account balances from settlements", async () => {
    const settlement = await insertSettledRecord("b".repeat(64));

    expect(await sumLedgerEntries(sql)).toBe(0);

    const balances = await sql<{ account_id: string; balance: number }[]>`
      select account_id, balance from balances
      where account_id in (${settlement.creditorId}, ${settlement.debtorId})
      order by account_id
    `;
    expect(balances).toEqual([
      { account_id: settlement.creditorId, balance: 4 },
      { account_id: settlement.debtorId, balance: -4 },
    ].sort((left, right) => left.account_id.localeCompare(right.account_id)));
  });

  it("retains self-work only in self-work calibrations", async () => {
    const pullRequest = await insertPullRequest(sql);

    await expect(sql`
      insert into settlements (
        pull_request_id,
        issue_id,
        creditor_id,
        debtor_id,
        opening_comparison_points,
        settled_points,
        review_rounds,
        credits,
        proof_sha256,
        status
      )
      values (
        ${pullRequest.id},
        ${pullRequest.issueId},
        ${pullRequest.sponsorId},
        ${pullRequest.sponsorId},
        5,
        6,
        2,
        4,
        ${"d".repeat(64)},
        ${"SETTLED"}
      )
    `).rejects.toThrow();

    const [calibration] = await sql<{ pull_request_id: string; user_id: string }[]>`
      insert into self_work_calibrations (
        pull_request_id,
        issue_id,
        user_id,
        opening_comparison_points,
        actual_points
      )
      values (
        ${pullRequest.id},
        ${pullRequest.issueId},
        ${pullRequest.sponsorId},
        5,
        6
      )
      returning pull_request_id, user_id
    `;

    expect(calibration).toEqual({
      pull_request_id: pullRequest.id,
      user_id: pullRequest.sponsorId,
    });
  });

  it("records calibration audits as account evaluation periods without settlement rerating fields", async () => {
    const accountId = await insertUser(sql);
    const reporterId = await insertUser(sql);
    const [audit] = await sql<{ account_id: string; settled_sample_size: number }[]>`
      insert into calibration_audits (
        account_id,
        reporter_id,
        rationale,
        sample_started_at,
        sample_ended_at,
        settled_sample_size
      )
      values (
        ${accountId},
        ${reporterId},
        ${"The account's settled sample warrants evaluation."},
        now() - interval '30 days',
        now(),
        3
      )
      returning account_id, settled_sample_size
    `;

    expect(audit).toEqual({ account_id: accountId, settled_sample_size: 3 });

    const columns = await sql<{ column_name: string }[]>`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'calibration_audits'
    `;
    const columnNames = columns.map((column) => column.column_name);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "account_id",
        "sample_started_at",
        "sample_ended_at",
        "settled_sample_size",
      ]),
    );
    expect(columnNames).not.toContain("settlement_id");
    expect(columnNames).not.toContain("corrected_points");
  });

  it("derives account calibration statistics from settled facts only", async () => {
    const settled = await insertSettledRecord("e".repeat(64));
    const unsettled = await insertUnsettledRecord("f".repeat(64));

    const [settledStatistics] = await sql<{
      account_id: string;
      settlement_count: number;
      average_points_delta: number | string;
    }[]>`
      select account_id, settlement_count, average_points_delta
      from calibration_statistics
      where account_id = ${settled.debtorId}
    `;
    expect(settledStatistics).toMatchObject({
      account_id: settled.debtorId,
      settlement_count: 1,
    });
    expect(Number(settledStatistics.average_points_delta)).toBe(1);

    const unsettledStatistics = await sql<{ account_id: string }[]>`
      select account_id
      from calibration_statistics
      where account_id = ${unsettled.debtorId}
    `;
    expect(unsettledStatistics).toEqual([]);
  });

  it("rejects direct writes to every derived view", async () => {
    await expect(sql`insert into ledger_entries default values`).rejects.toThrow();
    await expect(sql`insert into balances default values`).rejects.toThrow();
    await expect(sql`insert into calibration_statistics default values`).rejects.toThrow();
  });

  it("replaces a repository materialization atomically while retaining the first observed opening rating", async () => {
    const sponsorId = await insertUserWithLogin(sql, "materialization-sponsor");
    const contributorId = await insertUserWithLogin(sql, "materialization-contributor");
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string }[]>`
      select owner_name from registered_repositories where id = ${repositoryId}
    `;
    const store = new PostgresFoldStore(sql);
    const initial = foldRepository(materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      sponsorId,
      contributorId,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      existingIssues: [],
    }));
    const initialRun = await store.beginRun(repositoryId);

    await expect(store.materialize({ repositoryId, runId: initialRun, fold: initial })).resolves.toEqual({
      adds: 1,
      changes: 0,
      removals: 0,
    });

    const changed = foldRepository(materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      sponsorId,
      contributorId,
      issueLabels: ["L"],
      actualLabel: "delivered/7",
      existingIssues: initial.issues.map((issue) => ({
        githubIssueId: issue.githubIssueId,
        openingLabel: issue.openingLabel,
        openingComparisonPoints: issue.openingComparisonPoints,
        openingReservePoints: issue.openingReservePoints,
      })),
    }));
    const changedRun = await store.beginRun(repositoryId);

    await expect(store.materialize({ repositoryId, runId: changedRun, fold: changed })).resolves.toEqual({
      adds: 0,
      changes: 1,
      removals: 0,
    });
    const [issue] = await sql<{
      opening_label: string;
      opening_comparison_points: number;
      opening_reserve_points: number;
    }[]>`
      select opening_label, opening_comparison_points, opening_reserve_points
      from issues where repository_id = ${repositoryId}
    `;
    expect(issue).toEqual({
      opening_label: "M",
      opening_comparison_points: 5,
      opening_reserve_points: 5,
    });
    const [run] = await sql<{ repository_id: string; status: string }[]>`
      select repository_id, status from reconciliation_runs where id = ${changedRun}
    `;
    expect(run).toEqual({ repository_id: repositoryId, status: "COMPLETED" });

    const removedRun = await store.beginRun(repositoryId);
    await expect(
      store.materialize({
        repositoryId,
        runId: removedRun,
        fold: foldRepository({
          ...materializationSnapshot({
            repositoryId,
            ownerName: repository.owner_name,
            sponsorId,
            contributorId,
            issueLabels: ["M"],
            actualLabel: "delivered/6",
            existingIssues: [],
          }),
          issues: [],
        }),
      }),
    ).resolves.toEqual({ adds: 0, changes: 0, removals: 1 });
    expect(await sql`select id from issues where repository_id = ${repositoryId}`).toEqual([]);
    expect(await sql`select id from pull_requests where repository_id = ${repositoryId}`).toEqual([]);
    expect(await sql`select id from settlements where debtor_id = ${sponsorId}`).toEqual([]);
    const [removalChange] = await sql<{ change_kind: string; pull_request_id: string | null }[]>`
      select change_kind, pull_request_id
      from reconciliation_changes
      where reconciliation_run_id = ${removedRun} and change_kind = ${"REMOVE"}
    `;
    expect(removalChange).toEqual({ change_kind: "REMOVE", pull_request_id: null });
  });

  it("permits a failed GitHub delivery to be reclaimed for retry while keeping processed deliveries deduplicated", async () => {
    const store = new PostgresFoldStore(sql);
    const delivery = {
      deliveryId: "delivery-retryable",
      event: "pull_request" as const,
      action: "closed",
      repositoryGitHubId: nextExternalId(),
      repositoryFullName: "octo/example",
    };

    await expect(store.claimDelivery(delivery)).resolves.toBe("NEW");
    await store.markFailed(delivery.deliveryId, "connection string must never be saved");
    await expect(store.claimDelivery(delivery)).resolves.toBe("NEW");
    await store.markProcessed(delivery.deliveryId);
    await expect(store.claimDelivery(delivery)).resolves.toBe("DUPLICATE");

    const [record] = await sql<{ processing_state: string; error_message: string | null }[]>`
      select processing_state, error_message from webhook_deliveries
      where github_delivery_id = ${delivery.deliveryId}
    `;
    expect(record).toEqual({ processing_state: "PROCESSED", error_message: null });
  });
});

function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

async function insertUser(client: QueryableSql, githubUserId = nextExternalId()): Promise<string> {
  const [user] = await client<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${`member-${githubUserId}`})
    returning id
  `;
  return user.id;
}

async function insertRepository(
  client: QueryableSql,
  sponsorId: string,
  githubRepositoryId = nextExternalId(),
): Promise<string> {
  return insertRepositoryWithDifficultyScheme(
    client,
    sponsorId,
    validDifficultyScheme(),
    githubRepositoryId,
  );
}

async function insertRepositoryWithDifficultyScheme(
  client: QueryableSql,
  sponsorId: string,
  difficultyScheme: unknown,
  githubRepositoryId = nextExternalId(),
): Promise<string> {
  const encodedDifficultyScheme =
    difficultyScheme === null
      ? null
      : client.json(difficultyScheme as Parameters<typeof client.json>[0]);
  const [repository] = await client<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id,
      owner_name,
      sponsor_id,
      visibility,
      github_webhook_id,
      difficulty_scheme
    )
    values (
      ${githubRepositoryId},
      ${`owner-${githubRepositoryId}/repository-${githubRepositoryId}`},
      ${sponsorId},
      ${"PUBLIC"},
      ${nextExternalId()},
      ${encodedDifficultyScheme}::jsonb
    )
    returning id
  `;
  return repository.id;
}

function validDifficultyScheme(): DifficultyScheme {
  return {
    openingName: "Scope",
    actualName: "Delivered difficulty",
    openingLabels: [
      { label: "S", comparisonPoints: 2, reservePoints: 2 },
      { label: "M", comparisonPoints: 5, reservePoints: 5 },
      { label: "L", comparisonPoints: 8, reservePoints: 8 },
    ],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}

async function insertIssue(
  client: QueryableSql,
  options: { comparisonPoints?: number; reservePoints?: number } = {},
): Promise<{ id: string; sponsorId: string; repositoryId: string }> {
  const sponsorId = await insertUser(client);
  const repositoryId = await insertRepository(client, sponsorId);
  const githubIssueId = nextExternalId();
  const [issue] = await client<{ id: string }[]>`
    insert into issues (
      github_issue_id,
      repository_id,
      issue_number,
      title,
      body,
      url,
      state,
      opening_label,
      opening_comparison_points,
      opening_reserve_points
    )
    values (
      ${githubIssueId},
      ${repositoryId},
      ${nextExternalId()},
      ${"An eligible issue"},
      ${"Issue evidence"},
      ${`https://github.com/example/repository/issues/${githubIssueId}`},
      ${"OPEN"},
      ${"size/M"},
      ${options.comparisonPoints ?? 5},
      ${options.reservePoints ?? 5}
    )
    returning id
  `;
  return { id: issue.id, sponsorId, repositoryId };
}

async function insertPullRequest(
  client: QueryableSql,
  options: { actualPoints?: number } = {},
): Promise<{ id: string; issueId: string; sponsorId: string }> {
  const issue = await insertIssue(client);
  const contributorId = await insertUser(client);
  const githubPullRequestId = nextExternalId();
  const [pullRequest] = await client<{ id: string }[]>`
    insert into pull_requests (
      github_pull_request_id,
      repository_id,
      issue_id,
      pull_request_number,
      url,
      title,
      body,
      author_id,
      actual_label,
      actual_points,
      state,
      merged_at
    )
    values (
      ${githubPullRequestId},
      ${issue.repositoryId},
      ${issue.id},
      ${nextExternalId()},
      ${`https://github.com/example/repository/pull/${githubPullRequestId}`},
      ${"A merged contribution"},
      ${"Pull request evidence"},
      ${contributorId},
      ${"delivered/6"},
      ${options.actualPoints ?? 6},
      ${"MERGED"},
      now()
    )
    returning id
  `;
  await client`
    insert into pull_request_issues (pull_request_id, issue_id)
    values (${pullRequest.id}, ${issue.id})
  `;
  return { id: pullRequest.id, issueId: issue.id, sponsorId: issue.sponsorId };
}

async function insertSiblingIssue(client: QueryableSql, issueId: string): Promise<string> {
  const [source] = await client<{ repository_id: string }[]>`
    select repository_id from issues where id = ${issueId}
  `;
  const githubIssueId = nextExternalId();
  const [issue] = await client<{ id: string }[]>`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    values (
      ${githubIssueId}, ${source.repository_id}, ${nextExternalId()}, ${"A sibling issue"}, ${"Issue evidence"},
      ${`https://github.com/example/repository/issues/${githubIssueId}`}, ${"CLOSED"}, ${"size/M"}, 5, 5
    )
    returning id
  `;
  return issue.id;
}

async function insertUserWithLogin(client: QueryableSql, githubLogin: string): Promise<string> {
  const githubUserId = nextExternalId();
  const [user] = await client<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${githubLogin})
    returning id
  `;
  return user.id;
}

function materializationSnapshot(input: {
  repositoryId: string;
  ownerName: string;
  sponsorId: string;
  contributorId: string;
  issueLabels: string[];
  actualLabel: string;
  existingIssues: RepositoryFoldSnapshot["existingIssues"];
}): RepositoryFoldSnapshot {
  return {
    repository: {
      id: input.repositoryId,
      ownerName: input.ownerName,
      active: true,
      sponsor: { id: input.sponsorId, githubLogin: "materialization-sponsor", enforcementState: "ACTIVE" },
      difficultyScheme: validDifficultyScheme(),
    },
    users: [
      { id: input.sponsorId, githubLogin: "materialization-sponsor", enforcementState: "ACTIVE" },
      { id: input.contributorId, githubLogin: "materialization-contributor", enforcementState: "ACTIVE" },
    ],
    existingIssues: input.existingIssues,
    issues: [
      {
        id: 9_000_000,
        number: 1,
        title: "A materialized issue",
        body: "Issue body",
        url: "https://github.com/example/materialized/issues/1",
        state: "CLOSED",
        labels: input.issueLabels,
        closingPullRequests: [
          {
            id: 9_000_001,
            number: 11,
            title: "A materialized pull request",
            body: "Pull request body",
            url: "https://github.com/example/materialized/pull/11",
            state: "MERGED",
            mergedAt: "2026-09-01T12:00:00.000Z",
            authorLogin: "materialization-contributor",
            labels: [input.actualLabel],
            reviews: [],
            rawDiff: "materialized diff",
          },
        ],
      },
    ],
  };
}

async function insertSettledRecord(proofFingerprint: string): Promise<{
  creditorId: string;
  debtorId: string;
}> {
  return withTransaction(async (transactionSql) => {
    const pullRequest = await insertPullRequest(transactionSql);
    const creditorId = await insertUser(transactionSql);
    const [settlement] = await transactionSql<{ creditor_id: string; debtor_id: string }[]>`
      insert into settlements (
        pull_request_id,
        issue_id,
        creditor_id,
        debtor_id,
        opening_comparison_points,
        settled_points,
        review_rounds,
        credits,
        proof_sha256,
        status
      )
      values (
        ${pullRequest.id},
        ${pullRequest.issueId},
        ${creditorId},
        ${pullRequest.sponsorId},
        5,
        6,
        2,
        4,
        ${proofFingerprint},
        ${"SETTLED"}
      )
      returning creditor_id, debtor_id
    `;
    return { creditorId: settlement.creditor_id, debtorId: settlement.debtor_id };
  });
}

async function insertUnsettledRecord(proofFingerprint: string): Promise<{ debtorId: string }> {
  return withTransaction(async (transactionSql) => {
    const pullRequest = await insertPullRequest(transactionSql);
    const creditorId = await insertUser(transactionSql);
    const [settlement] = await transactionSql<{ debtor_id: string }[]>`
      insert into settlements (
        pull_request_id,
        issue_id,
        creditor_id,
        debtor_id,
        opening_comparison_points,
        settled_points,
        review_rounds,
        credits,
        proof_sha256,
        status
      )
      values (
        ${pullRequest.id},
        ${pullRequest.issueId},
        ${creditorId},
        ${pullRequest.sponsorId},
        5,
        null,
        0,
        0,
        ${proofFingerprint},
        ${"UNSETTLED"}
      )
      returning debtor_id
    `;
    return { debtorId: settlement.debtor_id };
  });
}

async function updateOriginalOpeningDifficulty(client: Sql, issueId: string): Promise<void> {
  await client`
    update issues
    set opening_comparison_points = 6
    where id = ${issueId}
  `;
}

async function sumLedgerEntries(client: Sql): Promise<number> {
  const [result] = await client<{ total: number }[]>`
    select coalesce(sum(amount), 0)::integer as total from ledger_entries
  `;
  return result.total;
}
