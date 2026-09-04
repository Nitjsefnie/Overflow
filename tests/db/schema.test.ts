import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import { GenericContainer, Wait } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql, withTransaction } from "@/lib/db/client";
import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";
import { claimGitHubIdentity } from "@/lib/fold/postgres-store";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import { foldRepository, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";
import type { GitHubIssue, GitHubPullRequest } from "@/lib/github/types";
import { encryptToken } from "@/lib/security/token-cipher";

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
      insert into pull_request_issues (pull_request_id, issue_id, repository_id)
      values (${pullRequest.id}, ${secondIssueId}, ${pullRequest.repositoryId})
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

  it("rejects a cross-repository PR/issue association before any settlement can reference it", async () => {
    const pullRequest = await insertPullRequest(sql);
    const foreignIssue = await insertIssue(sql);
    const [pullRequestRow] = await sql<{ repository_id: string }[]>`
      select repository_id from pull_requests where id = ${pullRequest.id}
    `;

    await expect(sql`
      insert into pull_request_issues (pull_request_id, issue_id, repository_id)
      values (${pullRequest.id}, ${foreignIssue.id}, ${pullRequestRow.repository_id})
    `).rejects.toThrow(/foreign key/);
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

  it.each([
    ["creditor", "WARNED"],
    ["creditor", "UNDER_AUDIT"],
    ["sponsor", "WARNED"],
    ["sponsor", "UNDER_AUDIT"],
  ] as const)("claims an unclaimed identity when the %s is %s", async (eligibleActor, state) => {
    const pullRequest = await insertPullRequest(sql);
    const contributorId = await insertUserWithLogin(sql, `eligible-${nextExternalId()}`);
    const [contributor] = await sql<{ github_login: string }[]>`
      select github_login from users where id = ${contributorId}
    `;
    const eligibleUserId = eligibleActor === "creditor" ? contributorId : pullRequest.sponsorId;
    const proofFingerprint = `${state === "WARNED" ? "a" : "d"}`.repeat(64);

    await sql`
      update users set enforcement_state = ${state} where id = ${eligibleUserId}
    `;
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${pullRequest.issueId}, null, ${contributor.github_login}, ${pullRequest.sponsorId},
        5, 6, 2, 4, ${proofFingerprint}, ${"UNCLAIMED"}
      )
    `;

    await claimGitHubIdentity(sql, contributorId, contributor.github_login);

    const [claimed] = await sql<{
      creditor_id: string | null;
      status: string;
      credits: number;
      proof_sha256: string;
    }[]>`
      select creditor_id, status, credits, proof_sha256
      from settlements where issue_id = ${pullRequest.issueId}
    `;
    expect(claimed).toEqual({
      creditor_id: contributorId,
      status: "SETTLED",
      credits: 4,
      proof_sha256: proofFingerprint,
    });
  });

  it.each([
    ["creditor", "BANNED"],
    ["creditor", "RECALIBRATING"],
    ["sponsor", "BANNED"],
    ["sponsor", "RECALIBRATING"],
  ])("leaves an unclaimed settlement unclaimed when its %s is %s", async (ineligibleActor, state) => {
    const pullRequest = await insertPullRequest(sql);
    const contributorId = await insertUserWithLogin(sql, `ineligible-${nextExternalId()}`);
    const [contributor] = await sql<{ github_login: string }[]>`
      select github_login from users where id = ${contributorId}
    `;
    const ineligibleUserId = ineligibleActor === "creditor" ? contributorId : pullRequest.sponsorId;
    const proofFingerprint = `${state === "BANNED" ? "b" : "c"}`.repeat(64);

    await sql`
      update users set enforcement_state = ${state} where id = ${ineligibleUserId}
    `;
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${pullRequest.issueId}, null, ${contributor.github_login}, ${pullRequest.sponsorId},
        5, 6, 2, 4, ${proofFingerprint}, ${"UNCLAIMED"}
      )
    `;

    await claimGitHubIdentity(sql, contributorId, contributor.github_login);

    const [claimed] = await sql<{
      creditor_id: string | null;
      status: string;
      credits: number;
    }[]>`
      select creditor_id, status, credits
      from settlements where issue_id = ${pullRequest.issueId}
    `;
    expect(claimed).toEqual({ creditor_id: null, status: "UNCLAIMED", credits: 4 });
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

  it("converges real PostgreSQL materialization across reordered GraphQL snapshots", async () => {
    const tokenEncryptionKey = Buffer.alloc(32, 7).toString("base64url");
    const sponsorLogin = `reconciliation-sponsor-${nextExternalId()}`;
    const contributorLogin = `reconciliation-contributor-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    await sql`
      update users
      set encrypted_oauth_token = ${Buffer.from(encryptToken("reconciliation-token", tokenEncryptionKey), "utf8")}
      where id = ${sponsorId}
    `;
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string }[]>`
      select owner_name from registered_repositories where id = ${repositoryId}
    `;
    const changedIssueId = nextExternalId();
    const changedPullRequestId = nextExternalId();
    const obsoleteIssueId = nextExternalId();
    const obsoletePullRequestId = nextExternalId();
    const addedIssueId = nextExternalId();
    const addedPullRequestId = nextExternalId();
    const staleSnapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      sponsorId,
      contributorId,
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/5",
      existingIssues: [],
      githubIssueId: changedIssueId,
      githubPullRequestId: changedPullRequestId,
    });
    const obsoleteIssue = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      sponsorId,
      contributorId,
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/5",
      existingIssues: [],
      githubIssueId: obsoleteIssueId,
      githubPullRequestId: obsoletePullRequestId,
    }).issues[0]!;
    obsoleteIssue.number = 2;
    obsoleteIssue.title = "An obsolete materialized issue";
    obsoleteIssue.url = "https://github.com/example/materialized/issues/2";
    obsoleteIssue.closingPullRequests[0]!.number = 12;
    obsoleteIssue.closingPullRequests[0]!.title = "An obsolete materialized pull request";
    obsoleteIssue.closingPullRequests[0]!.url = "https://github.com/example/materialized/pull/12";
    staleSnapshot.issues.push(obsoleteIssue);

    const store = new PostgresFoldStore(sql, tokenEncryptionKey);
    const staleRunId = await store.beginRun(repositoryId);
    await expect(store.materialize({
      repositoryId,
      runId: staleRunId,
      fold: foldRepository(staleSnapshot),
    })).resolves.toEqual({ adds: 2, changes: 0, removals: 0 });

    const snapshots: AuthoritativeReconciliationSnapshot[] = [
      {
        issues: [
          authoritativeIssue({ id: changedIssueId, number: 1 }),
          authoritativeIssue({ id: addedIssueId, number: 3 }),
        ],
        closingPullRequests: new Map([
          [1, [authoritativePullRequest({
            id: changedPullRequestId,
            number: 11,
            actualLabel: "delivered/6",
            authorLogin: contributorLogin,
          })]],
          [3, [authoritativePullRequest({
            id: addedPullRequestId,
            number: 13,
            actualLabel: "delivered/6",
            authorLogin: contributorLogin,
          })]],
        ]),
      },
      {
        issues: [
          authoritativeIssue({ id: addedIssueId, number: 3 }),
          authoritativeIssue({ id: changedIssueId, number: 1 }),
        ],
        closingPullRequests: new Map([
          [3, [authoritativePullRequest({
            id: addedPullRequestId,
            number: 13,
            actualLabel: "delivered/6",
            authorLogin: contributorLogin,
          })]],
          [1, [authoritativePullRequest({
            id: changedPullRequestId,
            number: 11,
            actualLabel: "delivered/6",
            authorLogin: contributorLogin,
          })]],
        ]),
      },
    ];
    let snapshotIndex = 0;
    let currentSnapshot = snapshots[0]!;
    const github: ReconciliationGateway = {
      listIssues: async () => {
        const snapshot = snapshots[snapshotIndex];
        snapshotIndex += 1;
        if (snapshot === undefined) {
          throw new Error("No authoritative reconciliation snapshot remained.");
        }
        currentSnapshot = snapshot;
        return snapshot.issues;
      },
      getIssueClosingPullRequests: async (_repository, issueNumber) => (
        currentSnapshot.closingPullRequests.get(issueNumber) ?? []
      ),
      getPullRequestReviews: async () => [],
      getPullRequestDiff: async (_repository, pullRequestNumber) => (
        pullRequestNumber === 11 ? "materialized diff" : "added materialized diff"
      ),
    };

    const first = await reconcileRepository({ store, github }, repositoryId);
    const canonicalStateAfterFirstRun = await reconciliationMaterializationState(repositoryId);
    const second = await reconcileRepository({ store, github }, repositoryId);

    expect(first).toMatchObject({ adds: 1, changes: 1, removals: 1 });
    expect(canonicalStateAfterFirstRun.issues.map((issue) => Number(issue.github_issue_id))).toEqual([
      changedIssueId,
      addedIssueId,
    ]);
    expect(second).toMatchObject({ adds: 0, changes: 0, removals: 0 });
    await expect(reconciliationMaterializationState(repositoryId)).resolves.toEqual(canonicalStateAfterFirstRun);
  });

  it("records deterministic add, change, and removal provenance for self-work and hand closures", async () => {
    const selfWorkSponsorLogin = `self-work-sponsor-${nextExternalId()}`;
    const selfWorkSponsorId = await insertUserWithLogin(sql, selfWorkSponsorLogin);
    const selfWorkContributorId = await insertUserWithLogin(sql, `self-work-contributor-${nextExternalId()}`);
    const selfWorkRepositoryId = await insertRepository(sql, selfWorkSponsorId);
    const [selfWorkRepository] = await sql<{ owner_name: string }[]>`
      select owner_name from registered_repositories where id = ${selfWorkRepositoryId}
    `;
    const store = new PostgresFoldStore(sql);
    const selfWorkSnapshot = materializationSnapshot({
      repositoryId: selfWorkRepositoryId,
      ownerName: selfWorkRepository.owner_name,
      sponsorId: selfWorkSponsorId,
      contributorId: selfWorkContributorId,
      sponsorLogin: selfWorkSponsorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      existingIssues: [],
      githubIssueId: nextExternalId(),
      githubPullRequestId: nextExternalId(),
    });
    selfWorkSnapshot.issues[0]!.closingPullRequests[0]!.authorLogin = selfWorkSponsorLogin;

    const selfWorkAddRun = await store.beginRun(selfWorkRepositoryId);
    await expect(store.materialize({
      repositoryId: selfWorkRepositoryId,
      runId: selfWorkAddRun,
      fold: foldRepository(selfWorkSnapshot),
    })).resolves.toEqual({ adds: 1, changes: 0, removals: 0 });

    const selfWorkChangedSnapshot = structuredClone(selfWorkSnapshot);
    selfWorkChangedSnapshot.issues[0]!.closingPullRequests[0]!.labels = ["delivered/7"];
    const selfWorkChangeRun = await store.beginRun(selfWorkRepositoryId);
    await expect(store.materialize({
      repositoryId: selfWorkRepositoryId,
      runId: selfWorkChangeRun,
      fold: foldRepository(selfWorkChangedSnapshot),
    })).resolves.toEqual({ adds: 0, changes: 1, removals: 0 });

    const selfWorkRemoveRun = await store.beginRun(selfWorkRepositoryId);
    await expect(store.materialize({
      repositoryId: selfWorkRepositoryId,
      runId: selfWorkRemoveRun,
      fold: foldRepository({ ...selfWorkChangedSnapshot, issues: [] }),
    })).resolves.toEqual({ adds: 0, changes: 0, removals: 1 });

    const selfWorkChanges = await sql<{
      entity_kind: string;
      change_kind: string;
      before_state: { actualPoints?: number } | null;
      after_state: { actualPoints?: number } | null;
    }[]>`
      select entity_kind, change_kind, before_state, after_state
      from reconciliation_changes
      where reconciliation_run_id in (${selfWorkAddRun}, ${selfWorkChangeRun}, ${selfWorkRemoveRun})
      order by created_at, id
    `;
    expect(selfWorkChanges).toEqual([
      {
        entity_kind: "SELF_WORK_CALIBRATION",
        change_kind: "ADD",
        before_state: null,
        after_state: expect.objectContaining({ actualPoints: 6 }),
      },
      {
        entity_kind: "SELF_WORK_CALIBRATION",
        change_kind: "CHANGE",
        before_state: expect.objectContaining({ actualPoints: 6 }),
        after_state: expect.objectContaining({ actualPoints: 7 }),
      },
      {
        entity_kind: "SELF_WORK_CALIBRATION",
        change_kind: "REMOVE",
        before_state: expect.objectContaining({ actualPoints: 7 }),
        after_state: null,
      },
    ]);

    const closureSponsorId = await insertUserWithLogin(sql, `closure-sponsor-${nextExternalId()}`);
    const closureContributorId = await insertUserWithLogin(sql, `closure-contributor-${nextExternalId()}`);
    const closureRepositoryId = await insertRepository(sql, closureSponsorId);
    const [closureRepository] = await sql<{ owner_name: string }[]>`
      select owner_name from registered_repositories where id = ${closureRepositoryId}
    `;
    const closureSnapshot = materializationSnapshot({
      repositoryId: closureRepositoryId,
      ownerName: closureRepository.owner_name,
      sponsorId: closureSponsorId,
      contributorId: closureContributorId,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      existingIssues: [],
      githubIssueId: nextExternalId(),
      githubPullRequestId: nextExternalId(),
    });
    closureSnapshot.issues[0]!.closingPullRequests = [];
    const closureAddFold = foldRepository(closureSnapshot);
    const closureAddRun = await store.beginRun(closureRepositoryId);
    await expect(store.materialize({
      repositoryId: closureRepositoryId,
      runId: closureAddRun,
      fold: closureAddFold,
    })).resolves.toEqual({ adds: 1, changes: 0, removals: 0 });

    const closureChangeFold = structuredClone(closureAddFold);
    closureChangeFold.unwritableClosures[0]!.reason = "No authoritative closing PR remains after refresh.";
    const closureChangeRun = await store.beginRun(closureRepositoryId);
    await expect(store.materialize({
      repositoryId: closureRepositoryId,
      runId: closureChangeRun,
      fold: closureChangeFold,
    })).resolves.toEqual({ adds: 0, changes: 1, removals: 0 });

    const closureRemoveFold = structuredClone(closureChangeFold);
    closureRemoveFold.unwritableClosures = [];
    const closureRemoveRun = await store.beginRun(closureRepositoryId);
    await expect(store.materialize({
      repositoryId: closureRepositoryId,
      runId: closureRemoveRun,
      fold: closureRemoveFold,
    })).resolves.toEqual({ adds: 0, changes: 0, removals: 1 });

    const closureChanges = await sql<{
      entity_kind: string;
      change_kind: string;
      before_state: { reason?: string } | null;
      after_state: { reason?: string } | null;
    }[]>`
      select entity_kind, change_kind, before_state, after_state
      from reconciliation_changes
      where reconciliation_run_id in (${closureAddRun}, ${closureChangeRun}, ${closureRemoveRun})
      order by created_at, id
    `;
    expect(closureChanges).toEqual([
      {
        entity_kind: "UNWRITABLE_CLOSURE",
        change_kind: "ADD",
        before_state: null,
        after_state: expect.objectContaining({ reason: "No merged GitHub GraphQL closing pull request was found." }),
      },
      {
        entity_kind: "UNWRITABLE_CLOSURE",
        change_kind: "CHANGE",
        before_state: expect.objectContaining({ reason: "No merged GitHub GraphQL closing pull request was found." }),
        after_state: expect.objectContaining({ reason: "No authoritative closing PR remains after refresh." }),
      },
      {
        entity_kind: "UNWRITABLE_CLOSURE",
        change_kind: "REMOVE",
        before_state: expect.objectContaining({ reason: "No authoritative closing PR remains after refresh." }),
        after_state: null,
      },
    ]);
  });

  it("keeps a fresh PENDING delivery deduplicated after interruption and reclaims it when its lease is stale", async () => {
    const store = new PostgresFoldStore(sql);
    const delivery = {
      deliveryId: "delivery-stale-reclaim",
      event: "pull_request" as const,
      action: "closed",
      repositoryGitHubId: nextExternalId(),
      repositoryFullName: "octo/example",
    };

    const first = expectClaimedLease(await store.claimDelivery(delivery));
    await expect(store.claimDelivery(delivery)).resolves.toEqual({ status: "DUPLICATE" });

    await sql`
      update webhook_deliveries
      set lease_expires_at = now() - interval '1 second'
      where github_delivery_id = ${delivery.deliveryId}
    `;
    const reclaimed = expectClaimedLease(await store.claimDelivery(delivery));
    expect(reclaimed.leaseToken).not.toBe(first.leaseToken);

    const [record] = await sql<{ processing_state: string; attempt_count: number }[]>`
      select processing_state, attempt_count from webhook_deliveries
      where github_delivery_id = ${delivery.deliveryId}
    `;
    expect(record).toEqual({ processing_state: "PENDING", attempt_count: 2 });
  });

  it("allows only the current delivery lease owner to complete a webhook", async () => {
    const store = new PostgresFoldStore(sql);
    const delivery = {
      deliveryId: "delivery-owner-check",
      event: "pull_request" as const,
      action: "closed",
      repositoryGitHubId: nextExternalId(),
      repositoryFullName: "octo/example",
    };

    const first = expectClaimedLease(await store.claimDelivery(delivery));
    await sql`
      update webhook_deliveries
      set lease_expires_at = now() - interval '1 second'
      where github_delivery_id = ${delivery.deliveryId}
    `;
    const replacement = expectClaimedLease(await store.claimDelivery(delivery));

    await expect(store.markProcessed(delivery.deliveryId, first.leaseToken)).resolves.toBe(false);
    await expect(store.markProcessed(delivery.deliveryId, replacement.leaseToken)).resolves.toBe(true);

    const [record] = await sql<{ processing_state: string }[]>`
      select processing_state from webhook_deliveries
      where github_delivery_id = ${delivery.deliveryId}
    `;
    expect(record).toEqual({ processing_state: "PROCESSED" });
  });

  it("reclaims a failed delivery only through a new lease and persists a sanitized failure", async () => {
    const store = new PostgresFoldStore(sql);
    const delivery = {
      deliveryId: "delivery-retryable",
      event: "pull_request" as const,
      action: "closed",
      repositoryGitHubId: nextExternalId(),
      repositoryFullName: "octo/example",
    };

    const first = expectClaimedLease(await store.claimDelivery(delivery));
    await expect(
      store.markFailed(delivery.deliveryId, first.leaseToken, "connection string must never be saved"),
    ).resolves.toBe(true);
    const retry = expectClaimedLease(await store.claimDelivery(delivery));
    await expect(store.markProcessed(delivery.deliveryId, retry.leaseToken)).resolves.toBe(true);
    await expect(store.claimDelivery(delivery)).resolves.toEqual({ status: "DUPLICATE" });

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

function expectClaimedLease(
  claim: Awaited<ReturnType<PostgresFoldStore["claimDelivery"]>>,
): { status: "CLAIMED"; leaseToken: string } {
  expect(claim).toEqual({ status: "CLAIMED", leaseToken: expect.any(String) });
  if (claim.status !== "CLAIMED") {
    throw new Error("Expected a claimed webhook delivery lease.");
  }
  return claim;
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
): Promise<{ id: string; issueId: string; sponsorId: string; repositoryId: string }> {
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
    insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequest.id}, ${issue.id}, ${issue.repositoryId})
  `;
  return {
    id: pullRequest.id,
    issueId: issue.id,
    sponsorId: issue.sponsorId,
    repositoryId: issue.repositoryId,
  };
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
  sponsorLogin?: string;
  contributorLogin?: string;
  issueLabels: string[];
  actualLabel: string;
  existingIssues: RepositoryFoldSnapshot["existingIssues"];
  githubIssueId?: number;
  githubPullRequestId?: number;
}): RepositoryFoldSnapshot {
  const sponsorLogin = input.sponsorLogin ?? "materialization-sponsor";
  const contributorLogin = input.contributorLogin ?? "materialization-contributor";
  const githubIssueId = input.githubIssueId ?? 9_000_000;
  const githubPullRequestId = input.githubPullRequestId ?? 9_000_001;
  return {
    repository: {
      id: input.repositoryId,
      ownerName: input.ownerName,
      active: true,
      sponsor: { id: input.sponsorId, githubLogin: sponsorLogin, enforcementState: "ACTIVE" },
      difficultyScheme: validDifficultyScheme(),
    },
    users: [
      { id: input.sponsorId, githubLogin: sponsorLogin, enforcementState: "ACTIVE" },
      { id: input.contributorId, githubLogin: contributorLogin, enforcementState: "ACTIVE" },
    ],
    existingIssues: input.existingIssues,
    issues: [
      {
        id: githubIssueId,
        number: 1,
        title: "A materialized issue",
        body: "Issue body",
        url: "https://github.com/example/materialized/issues/1",
        state: "CLOSED",
        labels: input.issueLabels,
        closingPullRequests: [
          {
            id: githubPullRequestId,
            number: 11,
            title: "A materialized pull request",
            body: "Pull request body",
            url: "https://github.com/example/materialized/pull/11",
            state: "MERGED",
            mergedAt: "2026-09-01T12:00:00.000Z",
            authorLogin: contributorLogin,
            labels: [input.actualLabel],
            reviews: [],
            rawDiff: "materialized diff",
          },
        ],
      },
    ],
  };
}

type AuthoritativeReconciliationSnapshot = {
  issues: GitHubIssue[];
  closingPullRequests: Map<number, GitHubPullRequest[]>;
};

function authoritativeIssue(input: { id: number; number: number }): GitHubIssue {
  return {
    id: input.id,
    number: input.number,
    title: `Reconciled issue ${input.number}`,
    body: `Reconciled issue ${input.number} body`,
    url: `https://github.com/example/materialized/issues/${input.number}`,
    state: "CLOSED",
    labels: ["M"],
    claimAssigneeGitHubLogin: null,
  };
}

function authoritativePullRequest(input: {
  id: number;
  number: number;
  actualLabel: string;
  authorLogin: string;
}): GitHubPullRequest {
  return {
    id: input.id,
    number: input.number,
    title: `Reconciled pull request ${input.number}`,
    body: `Reconciled pull request ${input.number} body`,
    url: `https://github.com/example/materialized/pull/${input.number}`,
    state: "MERGED",
    mergedAt: "2026-09-01T12:00:00.000Z",
    authorLogin: input.authorLogin,
    labels: [input.actualLabel],
  };
}

async function reconciliationMaterializationState(repositoryId: string) {
  const [issues, pullRequests, settlements, reviewRounds, issueLinks, unwritableClosures] = await Promise.all([
    sql<{
      github_issue_id: number | string;
      issue_number: number | string;
      title: string;
      state: string;
      opening_label: string;
      opening_comparison_points: number | string;
      opening_reserve_points: number | string;
    }[]>`
      select
        github_issue_id, issue_number, title, state, opening_label,
        opening_comparison_points, opening_reserve_points
      from issues
      where repository_id = ${repositoryId}
      order by github_issue_id
    `,
    sql<{
      github_pull_request_id: number | string;
      pull_request_number: number | string;
      title: string;
      state: string;
      actual_label: string | null;
      actual_points: number | string | null;
      proof_sha256: string | null;
    }[]>`
      select
        github_pull_request_id, pull_request_number, title, state,
        actual_label, actual_points, proof_sha256
      from pull_requests
      where repository_id = ${repositoryId}
      order by github_pull_request_id
    `,
    sql<{
      github_issue_id: number | string;
      github_pull_request_id: number | string;
      creditor_id: string | null;
      creditor_github_login: string | null;
      debtor_id: string;
      opening_comparison_points: number | string;
      settled_points: number | string | null;
      review_rounds: number | string;
      credits: number | string;
      proof_sha256: string;
      status: string;
    }[]>`
      select
        issues.github_issue_id,
        pull_requests.github_pull_request_id,
        settlements.creditor_id,
        settlements.creditor_github_login,
        settlements.debtor_id,
        settlements.opening_comparison_points,
        settlements.settled_points,
        settlements.review_rounds,
        settlements.credits,
        settlements.proof_sha256,
        settlements.status
      from settlements
      join issues on issues.id = settlements.issue_id
      join pull_requests on pull_requests.id = settlements.pull_request_id
      where issues.repository_id = ${repositoryId}
      order by issues.github_issue_id, pull_requests.github_pull_request_id
    `,
    sql<{
      github_pull_request_id: number | string;
      github_review_id: number | string;
      submitted_at: string;
    }[]>`
      select pull_requests.github_pull_request_id, review_rounds.github_review_id, review_rounds.submitted_at
      from review_rounds
      join pull_requests on pull_requests.id = review_rounds.pull_request_id
      where pull_requests.repository_id = ${repositoryId}
      order by pull_requests.github_pull_request_id, review_rounds.github_review_id
    `,
    sql<{
      github_issue_id: number | string;
      github_pull_request_id: number | string;
    }[]>`
      select issues.github_issue_id, pull_requests.github_pull_request_id
      from pull_request_issues
      join issues on issues.id = pull_request_issues.issue_id
      join pull_requests on pull_requests.id = pull_request_issues.pull_request_id
      where pull_request_issues.repository_id = ${repositoryId}
      order by issues.github_issue_id, pull_requests.github_pull_request_id
    `,
    sql<{
      github_issue_id: number | string;
      reason: string;
    }[]>`
      select issues.github_issue_id, unwritable_closures.reason
      from unwritable_closures
      join issues on issues.id = unwritable_closures.issue_id
      where issues.repository_id = ${repositoryId}
      order by issues.github_issue_id
    `,
  ]);
  return { issues, pullRequests, settlements, reviewRounds, issueLinks, unwritableClosures };
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
