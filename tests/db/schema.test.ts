import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql, type TransactionSql } from "postgres";
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
import { processWebhook } from "@/lib/webhooks/processor";

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
    const rows = await sql<{ name: string; count: number }[]>`
      select name, count(*)::integer as count
      from schema_migrations
      group by name
      order by name
    `;

    expect(rows).toEqual([
      "001_initial.sql",
      "002_repository_difficulty_scheme.sql",
      "003_multi_issue_settlements_and_claims.sql",
      "004_preserve_reconciliation_provenance.sql",
      "005_harden_materialization_invariants.sql",
      "006_account_moderation_snapshots.sql",
      "007_authoritative_history_and_merge_proof.sql",
      "008_moderator_role_changes.sql",
    ].map((name) => ({ name, count: 1 })));
  });

  it("rejects out-of-range opening and issue-owned settled difficulty points", async () => {
    await expect(insertIssue(sql, { comparisonPoints: 11 })).rejects.toThrow();
    const issue = await insertIssue(sql);
    await expect(sql`
      update issues
      set settled_label = ${"delivered/0"}, settled_points = 0,
          settled_label_event_id = ${"settled-event-0"},
          settled_label_actor_login = ${"issue-owner"},
          settled_label_applied_at = ${"2026-09-01T11:00:00.000Z"},
          settled_rationale_comment_id = ${"comment-0"},
          settled_rationale_actor_login = ${"issue-owner"},
          settled_rationale_commented_at = ${"2026-09-01T11:30:00.000Z"}
      where id = ${issue.id}
    `).rejects.toThrow();
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

  it("persists immutable issue-owned rating evidence and an exact merge commit OID", async () => {
    const pullRequest = await insertPullRequest(sql);
    const mergeCommitOid = "0123456789abcdef0123456789abcdef01234567";
    await sql`
      update issues
      set owner_github_login = ${"issue-owner"},
          opening_source_event_id = ${"opening-event-1"},
          opening_source_actor_login = ${"issue-owner"},
          opening_source_at = ${"2026-09-01T09:00:00.000Z"},
          settled_label = ${"delivered/6"},
          settled_points = 6,
          settled_label_event_id = ${"settled-event-1"},
          settled_label_actor_login = ${"issue-owner"},
          settled_label_applied_at = ${"2026-09-01T11:00:00.000Z"},
          settled_rationale_comment_id = ${"comment-1"},
          settled_rationale_actor_login = ${"issue-owner"},
          settled_rationale_commented_at = ${"2026-09-01T11:30:00.000Z"}
      where id = ${pullRequest.issueId}
    `;
    await sql`
      update pull_requests
      set merge_commit_oid = ${mergeCommitOid}, final_commit_at = ${"2026-09-01T10:00:00.000Z"}
      where id = ${pullRequest.id}
    `;

    const [proof] = await sql<{
      opening_source_event_id: string;
      settled_label_event_id: string;
      settled_rationale_comment_id: string;
      merge_commit_oid: string;
    }[]>`
      select
        issues.opening_source_event_id,
        issues.settled_label_event_id,
        issues.settled_rationale_comment_id,
        pull_requests.merge_commit_oid
      from issues
      join pull_request_issues on pull_request_issues.issue_id = issues.id
      join pull_requests on pull_requests.id = pull_request_issues.pull_request_id
      where issues.id = ${pullRequest.issueId}
    `;
    expect(proof).toEqual({
      opening_source_event_id: "opening-event-1",
      settled_label_event_id: "settled-event-1",
      settled_rationale_comment_id: "comment-1",
      merge_commit_oid: mergeCommitOid,
    });
    const pullRequestColumns = await sql<{ column_name: string }[]>`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'pull_requests'
    `;
    expect(pullRequestColumns.map((column) => column.column_name)).not.toEqual(
      expect.arrayContaining(["actual_label", "actual_points"]),
    );

    await expect(sql`
      update issues set opening_source_event_id = ${"rewritten-event"} where id = ${pullRequest.issueId}
    `).rejects.toThrow(/immutable/i);
    await expect(sql`
      update pull_requests set merge_commit_oid = ${"not-forty-hex"} where id = ${pullRequest.id}
    `).rejects.toThrow();
  });

  it("keeps moderation history immutable and resolves eligibility at the merge timestamp", async () => {
    const targetId = await insertUser(sql);
    const actorId = await insertUser(sql);
    const [event] = await sql<{ id: string }[]>`
      insert into moderation_events (
        target_user_id, actor_id, prior_state, new_state, reason, created_at
      )
      values (
        ${targetId}, ${actorId}, ${"ACTIVE"}, ${"BANNED"}, ${"Historical sanction"},
        ${"2026-09-02T00:00:00.000Z"}
      )
      returning id
    `;

    const [before] = await sql<{ eligible: boolean }[]>`
      select participation_eligible_at(${targetId}, ${"2026-09-01T12:00:00.000Z"}) as eligible
    `;
    const [after] = await sql<{ eligible: boolean }[]>`
      select participation_eligible_at(${targetId}, ${"2026-09-03T12:00:00.000Z"}) as eligible
    `;
    expect(before.eligible).toBe(true);
    expect(after.eligible).toBe(false);
    await expect(sql`
      update moderation_events set reason = ${"Rewritten"} where id = ${event.id}
    `).rejects.toThrow(/immutable/i);
    await expect(sql`delete from moderation_events where id = ${event.id}`).rejects.toThrow(/immutable/i);
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

  it("claims historically eligible unclaimed work after the contributor is sanctioned later", async () => {
    const pullRequest = await insertPullRequest(sql);
    const contributorId = await insertUserWithLogin(sql, `later-sanctioned-${nextExternalId()}`);
    const moderatorId = await insertUser(sql);
    const [contributor] = await sql<{ github_login: string }[]>`
      select github_login from users where id = ${contributorId}
    `;
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${pullRequest.issueId}, null, ${contributor.github_login}, ${pullRequest.sponsorId},
        5, 6, 0, 6, ${"9".repeat(64)}, ${"UNCLAIMED"}
      )
    `;
    await sql`
      insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason, created_at)
      select ${contributorId}, ${moderatorId}, ${"ACTIVE"}, ${"BANNED"}, ${"Sanction after eligible merge"},
        pull_requests.merged_at + interval '1 minute'
      from pull_requests where id = ${pullRequest.id}
    `;
    await sql`update users set enforcement_state = ${"BANNED"} where id = ${contributorId}`;

    await claimGitHubIdentity(sql, contributorId, contributor.github_login);

    await expect(sql<{ creditor_id: string | null; status: string }[]>`
      select creditor_id, status from settlements where issue_id = ${pullRequest.issueId}
    `).resolves.toEqual([{ creditor_id: contributorId, status: "SETTLED" }]);
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

  it("rebuilds the original opening proof and mutation violation into an empty materialization", async () => {
    const sponsorLogin = `opening-owner-${nextExternalId()}`;
    const contributorLogin = `opening-worker-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string }[]>`
      select owner_name from registered_repositories where id = ${repositoryId}
    `;
    const snapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      sponsorId,
      contributorId,
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      githubIssueId: nextExternalId(),
      githubPullRequestId: nextExternalId(),
    });
    const issue = snapshot.issues[0]!;
    issue.labels = ["L", "delivered/6"];
    issue.history.push(
      {
        kind: "UNLABELED",
        id: "opening-M-removed-after-assignment",
        actorLogin: sponsorLogin,
        label: "M",
        createdAt: "2026-09-01T09:30:00.000Z",
      },
      {
        kind: "LABELED",
        id: "opening-L-added-after-assignment",
        actorLogin: sponsorLogin,
        label: "L",
        createdAt: "2026-09-01T09:31:00.000Z",
      },
    );
    const fold = foldRepository(snapshot);
    expect(fold.issues[0]).toMatchObject({
      openingLabel: "M",
      openingComparisonPoints: 5,
      openingSourceEventId: `opening-${issue.id}`,
      openingSourceActorLogin: sponsorLogin,
    });
    expect(fold.policyViolations).toContainEqual({
      code: "OPENING_LABEL_MUTATED",
      githubIssueId: issue.id,
    });

    const store = new PostgresFoldStore(sql);
    const runId = await store.beginRun(repositoryId);
    await store.materialize({ repositoryId, runId, fold });

    await expect(sql`
      select opening_label, opening_comparison_points, opening_source_event_id,
             opening_source_actor_login
      from issues where repository_id = ${repositoryId}
    `).resolves.toEqual([{
      opening_label: "M",
      opening_comparison_points: 5,
      opening_source_event_id: `opening-${issue.id}`,
      opening_source_actor_login: sponsorLogin,
    }]);
    await expect(sql`
      select after_state
      from reconciliation_changes
      where reconciliation_run_id = ${runId} and change_kind = ${"POLICY_VIOLATION"}
    `).resolves.toEqual([{
      after_state: { code: "OPENING_LABEL_MUTATED", githubIssueId: issue.id },
    }]);
  });

  it("repairs a legacy opening once when immutable GitHub source proof is first attached", async () => {
    const sponsorLogin = `legacy-opening-owner-${nextExternalId()}`;
    const contributorLogin = `legacy-opening-worker-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string }[]>`
      select owner_name from registered_repositories where id = ${repositoryId}
    `;
    const githubIssueId = nextExternalId();
    const snapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      sponsorId,
      contributorId,
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      githubIssueId,
      githubPullRequestId: nextExternalId(),
    });
    const authoritativeIssue = snapshot.issues[0]!;

    await sql`
      insert into issues (
        github_issue_id, repository_id, issue_number, title, body, url, state,
        opening_label, opening_comparison_points, opening_reserve_points
      )
      values (
        ${githubIssueId}, ${repositoryId}, ${authoritativeIssue.number}, ${authoritativeIssue.title},
        ${authoritativeIssue.body}, ${authoritativeIssue.url}, ${authoritativeIssue.state},
        ${"L"}, 8, 8
      )
    `;

    const store = new PostgresFoldStore(sql);
    const runId = await store.beginRun(repositoryId);
    await store.materialize({ repositoryId, runId, fold: foldRepository(snapshot) });

    await expect(sql`
      select opening_label, opening_comparison_points, opening_reserve_points,
             opening_source_event_id, opening_source_actor_login
      from issues where github_issue_id = ${githubIssueId}
    `).resolves.toEqual([{
      opening_label: "M",
      opening_comparison_points: 5,
      opening_reserve_points: 5,
      opening_source_event_id: `opening-${githubIssueId}`,
      opening_source_actor_login: sponsorLogin,
    }]);
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
    }));
    const initialRun = await store.beginRun(repositoryId);

    await expect(store.materialize({ repositoryId, runId: initialRun, fold: initial })).resolves.toEqual({
      adds: 1,
      changes: 0,
      removals: 0,
    });

    const changedSnapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      sponsorId,
      contributorId,
      issueLabels: ["M"],
      actualLabel: "delivered/7",
    });
    changedSnapshot.issues[0]!.labels = ["L", "delivered/7"];
    changedSnapshot.issues[0]!.history.push(
      {
        kind: "UNLABELED",
        id: "opening-M-removed",
        actorLogin: "materialization-sponsor",
        label: "M",
        createdAt: "2026-09-01T09:30:00.000Z",
      },
      {
        kind: "LABELED",
        id: "opening-L-added",
        actorLogin: "materialization-sponsor",
        label: "L",
        createdAt: "2026-09-01T09:31:00.000Z",
      },
    );
    const changed = foldRepository(changedSnapshot);
    expect(changed.policyViolations).toContainEqual({
      code: "OPENING_LABEL_MUTATED",
      githubIssueId: initial.issues[0]!.githubIssueId,
    });
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

  it("records proof-only issue-history and merge-OID changes with the true prior canonical state", async () => {
    const sponsorLogin = `proof-sponsor-${nextExternalId()}`;
    const contributorLogin = `proof-contributor-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string }[]>`
      select owner_name from registered_repositories where id = ${repositoryId}
    `;
    const snapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      sponsorId,
      contributorId,
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      githubIssueId: nextExternalId(),
      githubPullRequestId: nextExternalId(),
    });
    const store = new PostgresFoldStore(sql);
    const initialRun = await store.beginRun(repositoryId);
    await store.materialize({ repositoryId, runId: initialRun, fold: foldRepository(snapshot) });

    const changedSnapshot = structuredClone(snapshot);
    const issue = changedSnapshot.issues[0]!;
    const actualEvent = issue.history.find((event) => event.kind === "LABELED" && event.label === "delivered/6");
    if (actualEvent === undefined) throw new Error("Expected actual label proof fixture.");
    actualEvent.id = "replacement-actual-event";
    issue.comments[0]!.id = "replacement-rationale-comment";
    issue.closingPullRequests[0]!.mergeCommitOid = "f".repeat(40);

    const changedRun = await store.beginRun(repositoryId);
    await expect(store.materialize({
      repositoryId,
      runId: changedRun,
      fold: foldRepository(changedSnapshot),
    })).resolves.toEqual({ adds: 0, changes: 1, removals: 0 });

    const [change] = await sql<{
      before_state: { settledLabelEventId: string; settledRationaleCommentId: string; mergeCommitOid: string };
      after_state: { settledLabelEventId: string; settledRationaleCommentId: string; mergeCommitOid: string };
    }[]>`
      select before_state, after_state
      from reconciliation_changes
      where reconciliation_run_id = ${changedRun} and entity_kind = ${"SETTLEMENT"}
    `;
    expect(change.before_state).toMatchObject({
      settledLabelEventId: `actual-${snapshot.issues[0]!.id}`,
      settledRationaleCommentId: `rationale-${snapshot.issues[0]!.id}`,
      mergeCommitOid: snapshot.issues[0]!.closingPullRequests[0]!.mergeCommitOid,
    });
    expect(change.after_state).toMatchObject({
      settledLabelEventId: "replacement-actual-event",
      settledRationaleCommentId: "replacement-rationale-comment",
      mergeCommitOid: "f".repeat(40),
    });
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
          authoritativeIssue({ id: changedIssueId, number: 1, ownerLogin: sponsorLogin }),
          authoritativeIssue({ id: addedIssueId, number: 3, ownerLogin: sponsorLogin }),
        ],
        closingPullRequests: new Map([
          [1, [authoritativePullRequest({
            id: changedPullRequestId,
            number: 11,
            authorLogin: contributorLogin,
          })]],
          [3, [authoritativePullRequest({
            id: addedPullRequestId,
            number: 13,
            authorLogin: contributorLogin,
          })]],
        ]),
      },
      {
        issues: [
          authoritativeIssue({ id: addedIssueId, number: 3, ownerLogin: sponsorLogin }),
          authoritativeIssue({ id: changedIssueId, number: 1, ownerLogin: sponsorLogin }),
        ],
        closingPullRequests: new Map([
          [3, [authoritativePullRequest({
            id: addedPullRequestId,
            number: 13,
            authorLogin: contributorLogin,
          })]],
          [1, [authoritativePullRequest({
            id: changedPullRequestId,
            number: 11,
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

  it("serializes a repository before snapshot work and releases the cross-process lock on success or error", async () => {
    const repositoryId = await insertRepository(sql, await insertUser(sql));
    const firstWorker = new PostgresFoldStore(sql);
    const secondWorker = new PostgresFoldStore(sql);
    let releaseOlder!: () => void;
    let olderStarted!: () => void;
    const started = new Promise<void>((resolve) => { olderStarted = resolve; });
    const holdOlder = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const order: string[] = [];

    const older = firstWorker.withRepositoryReconciliation(repositoryId, async () => {
      order.push("older-snapshot-started");
      olderStarted();
      await holdOlder;
      order.push("older-materialized");
    });
    await started;
    const newer = secondWorker.withRepositoryReconciliation(repositoryId, async () => {
      order.push("newer-snapshot-started");
      order.push("newer-materialized");
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(order).toEqual(["older-snapshot-started"]);

    releaseOlder();
    await Promise.all([older, newer]);
    expect(order).toEqual([
      "older-snapshot-started",
      "older-materialized",
      "newer-snapshot-started",
      "newer-materialized",
    ]);

    await expect(firstWorker.withRepositoryReconciliation(repositoryId, async () => {
      throw new Error("expected worker failure");
    })).rejects.toThrow("expected worker failure");
    await expect(secondWorker.withRepositoryReconciliation(repositoryId, async () => "lock-released"))
      .resolves.toBe("lock-released");
  });

  it("keeps the shared pool available while a full cohort of repository reconciliations waits", async () => {
    const sharedPoolCapacity = sql.options.max;
    expect(sharedPoolCapacity).toBe(10);
    const tokenEncryptionKey = Buffer.alloc(32, 15).toString("base64url");
    const sponsorLogin = `pool-sponsor-${nextExternalId()}`;
    const contributorLogin = `pool-contributor-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    await sql`
      update users
      set encrypted_oauth_token = ${Buffer.from(encryptToken("pool-token", tokenEncryptionKey), "utf8")}
      where id = ${sponsorId}
    `;
    const githubRepositoryId = nextExternalId();
    const repositoryId = await insertRepository(sql, sponsorId, githubRepositoryId);
    const [repository] = await sql<{ owner_name: string }[]>`
      select owner_name from registered_repositories where id = ${repositoryId}
    `;
    const githubIssueId = nextExternalId();
    const githubPullRequestId = nextExternalId();
    const runOrder: string[] = [];
    const pointsByRun = new Map<string, number>();
    let activeSnapshotFetches = 0;
    let maximumActiveSnapshotFetches = 0;
    let releaseOwnerFetch!: () => void;
    let markOwnerFetchStarted!: () => void;
    const ownerFetchStarted = new Promise<void>((resolve) => { markOwnerFetchStarted = resolve; });
    const holdOwnerFetch = new Promise<void>((resolve) => { releaseOwnerFetch = resolve; });

    const trackedGateway = (
      runName: string,
      points: number,
      hold: Promise<void> | undefined,
    ): ReconciliationGateway => {
      pointsByRun.set(runName, points);
      const snapshot = materializationSnapshot({
        repositoryId,
        ownerName: repository.owner_name,
        sponsorId,
        contributorId,
        sponsorLogin,
        contributorLogin,
        issueLabels: ["M"],
        actualLabel: `delivered/${points}`,
        githubIssueId,
        githubPullRequestId,
      });
      const gateway = gatewayForSnapshot(snapshot);
      return {
        ...gateway,
        async listIssues(reference) {
          runOrder.push(runName);
          activeSnapshotFetches += 1;
          maximumActiveSnapshotFetches = Math.max(maximumActiveSnapshotFetches, activeSnapshotFetches);
          try {
            if (hold !== undefined) {
              markOwnerFetchStarted();
              await hold;
            }
            return await gateway.listIssues(reference);
          } finally {
            activeSnapshotFetches -= 1;
          }
        },
      };
    };

    const ownerStore = new PostgresFoldStore(sql, tokenEncryptionKey);
    const ownerGateway = trackedGateway("owner", 1, holdOwnerFetch);
    const delivery = {
      deliveryId: `delivery-pool-contention-${nextExternalId()}`,
      event: "pull_request" as const,
      action: "closed",
      repositoryGitHubId: githubRepositoryId,
      repositoryFullName: repository.owner_name,
    };
    const ownerRun = processWebhook({
      store: ownerStore,
      reconcileRepository: (id) => reconcileRepository({ store: ownerStore, github: ownerGateway }, id),
      leaseHeartbeatIntervalMs: 25,
    }, delivery);
    await ownerFetchStarted;

    const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
    const [initialLease] = await observer<{ lease_expires_at: string }[]>`
      select lease_expires_at::text
      from webhook_deliveries
      where github_delivery_id = ${delivery.deliveryId}
    `;
    const waiterRuns = Array.from({ length: sharedPoolCapacity }, (_, index) => {
      const points = index + 1;
      const waiterStore = new PostgresFoldStore(sql, tokenEncryptionKey);
      return reconcileRepository({
        store: waiterStore,
        github: trackedGateway(`waiter-${points}`, points, undefined),
      }, repositoryId);
    });
    const reconciliationCleanup = Promise.allSettled([ownerRun, ...waiterRuns]);
    const ordinaryQuery = sql<{ value: number }[]>`select 1::integer as value`;

    try {
      // Synchronize deterministically with the former blocking implementation. The
      // nonblocking coordinator never creates an ungranted advisory lock, so this
      // bounded probe simply expires while its callers wait outside the pool.
      const blockingWaitersDetected = await conditionWithin(async () => {
        const [locks] = await observer<{ waiting: number }[]>`
          select count(*)::integer as waiting
          from pg_locks
          where locktype = 'advisory' and granted = false
        `;
        return locks.waiting >= sharedPoolCapacity - 1;
      }, 750);

      expect(runOrder).toEqual(["owner"]);
      await expect(resolveWithin(ordinaryQuery, 750)).resolves.toEqual([{ value: 1 }]);
      expect(blockingWaitersDetected).toBe(false);
      await expect(conditionWithin(async () => {
        const [lease] = await observer<{ renewed: boolean }[]>`
          select lease_expires_at > ${initialLease.lease_expires_at}::timestamptz as renewed
          from webhook_deliveries
          where github_delivery_id = ${delivery.deliveryId}
        `;
        return lease.renewed;
      }, 750)).resolves.toBe(true);
    } finally {
      releaseOwnerFetch();
      await observer`
        select pg_cancel_backend(pid)
        from pg_locks
        where locktype = 'advisory'
          and granted = false
          and pid <> pg_backend_pid()
      `;
      await Promise.all([reconciliationCleanup, ordinaryQuery]);
      await observer.end();
    }

    await expect(ownerRun).resolves.toEqual({ status: "PROCESSED" });
    await expect(Promise.all(waiterRuns)).resolves.toHaveLength(sharedPoolCapacity);
    expect(runOrder).toHaveLength(sharedPoolCapacity + 1);
    expect(new Set(runOrder).size).toBe(sharedPoolCapacity + 1);
    expect(maximumActiveSnapshotFetches).toBe(1);
    const finalRun = runOrder.at(-1);
    expect(finalRun).toBeDefined();
    const [settlement] = await sql<{ settled_points: number }[]>`
      select settlements.settled_points
      from settlements
      join issues on issues.id = settlements.issue_id
      where issues.repository_id = ${repositoryId}
    `;
    expect(settlement.settled_points).toBe(pointsByRun.get(finalRun!));

    await expect(ownerStore.withRepositoryReconciliation(repositoryId, async () => {
      throw new Error("expected saturated-worker failure");
    })).rejects.toThrow("expected saturated-worker failure");
    await expect(ownerStore.withRepositoryReconciliation(repositoryId, async () => "released-after-error"))
      .resolves.toBe("released-after-error");
  });

  it("keeps a slow older reconciliation from overwriting the newer authoritative snapshot", async () => {
    const tokenEncryptionKey = Buffer.alloc(32, 10).toString("base64url");
    const sponsorLogin = `concurrency-sponsor-${nextExternalId()}`;
    const contributorLogin = `concurrency-contributor-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    await sql`
      update users
      set encrypted_oauth_token = ${Buffer.from(encryptToken("concurrency-token", tokenEncryptionKey), "utf8")}
      where id = ${sponsorId}
    `;
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string }[]>`
      select owner_name from registered_repositories where id = ${repositoryId}
    `;
    const githubIssueId = nextExternalId();
    const githubPullRequestId = nextExternalId();
    const olderSnapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      sponsorId,
      contributorId,
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/5",
      githubIssueId,
      githubPullRequestId,
    });
    const newerSnapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      sponsorId,
      contributorId,
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/7",
      githubIssueId,
      githubPullRequestId,
    });
    const olderGatewayBase = gatewayForSnapshot(olderSnapshot);
    const newerGatewayBase = gatewayForSnapshot(newerSnapshot);
    let releaseOlderFetch!: () => void;
    let markOlderFetchStarted!: () => void;
    const olderFetchStarted = new Promise<void>((resolve) => { markOlderFetchStarted = resolve; });
    const holdOlderFetch = new Promise<void>((resolve) => { releaseOlderFetch = resolve; });
    const order: string[] = [];
    const olderGateway: ReconciliationGateway = {
      ...olderGatewayBase,
      async listIssues(reference) {
        order.push("older-fetch-started");
        markOlderFetchStarted();
        await holdOlderFetch;
        order.push("older-fetch-completed");
        return olderGatewayBase.listIssues(reference);
      },
    };
    const newerGateway: ReconciliationGateway = {
      ...newerGatewayBase,
      async listIssues(reference) {
        order.push("newer-fetch-started");
        return newerGatewayBase.listIssues(reference);
      },
    };
    const olderWorker = new PostgresFoldStore(sql, tokenEncryptionKey);
    const newerWorker = new PostgresFoldStore(sql, tokenEncryptionKey);

    const olderRun = reconcileRepository({ store: olderWorker, github: olderGateway }, repositoryId);
    await olderFetchStarted;
    const newerRun = reconcileRepository({ store: newerWorker, github: newerGateway }, repositoryId);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(order).toEqual(["older-fetch-started"]);

    releaseOlderFetch();
    const [olderResult, newerResult] = await Promise.all([olderRun, newerRun]);

    expect(olderResult).toMatchObject({ adds: 1, changes: 0, removals: 0 });
    expect(newerResult).toMatchObject({ adds: 0, changes: 1, removals: 0 });
    expect(order).toEqual(["older-fetch-started", "older-fetch-completed", "newer-fetch-started"]);
    await expect(sql`
      select settlements.settled_points, settlements.credits, issues.settled_label
      from settlements join issues on issues.id = settlements.issue_id
      where issues.repository_id = ${repositoryId}
    `).resolves.toEqual([{ settled_points: 7, credits: 7, settled_label: "delivered/7" }]);
  });

  it("preserves historically eligible settlement and self-work facts after later sanctions", async () => {
    const tokenEncryptionKey = Buffer.alloc(32, 11).toString("base64url");
    const sponsorLogin = `history-sponsor-${nextExternalId()}`;
    const contributorLogin = `history-contributor-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    const moderatorId = await insertUser(sql);
    await sql`
      update users
      set encrypted_oauth_token = ${Buffer.from(encryptToken("history-token", tokenEncryptionKey), "utf8")}
      where id = ${sponsorId}
    `;
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string }[]>`
      select owner_name from registered_repositories where id = ${repositoryId}
    `;
    const outsiderSnapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      sponsorId,
      contributorId,
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      githubIssueId: nextExternalId(),
      githubPullRequestId: nextExternalId(),
    });
    const selfWorkSnapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      sponsorId,
      contributorId,
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/7",
      githubIssueId: nextExternalId(),
      githubPullRequestId: nextExternalId(),
    });
    selfWorkSnapshot.issues[0]!.number = 2;
    selfWorkSnapshot.issues[0]!.closingPullRequests[0]!.number = 12;
    selfWorkSnapshot.issues[0]!.closingPullRequests[0]!.authorLogin = sponsorLogin;
    outsiderSnapshot.issues.push(selfWorkSnapshot.issues[0]!);

    const store = new PostgresFoldStore(sql, tokenEncryptionKey);
    const initialRun = await store.beginRun(repositoryId);
    await store.materialize({ repositoryId, runId: initialRun, fold: foldRepository(outsiderSnapshot) });
    const factsBefore = await historicalRepositoryFacts(repositoryId, [sponsorId, contributorId]);

    for (const [targetId, newState] of [[contributorId, "BANNED"], [sponsorId, "RECALIBRATING"]] as const) {
      await sql`
        insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason, created_at)
        values (${targetId}, ${moderatorId}, ${"ACTIVE"}, ${newState}, ${"Sanction after the recorded merge"},
          ${"2026-09-02T00:00:00.000Z"})
      `;
      await sql`update users set enforcement_state = ${newState} where id = ${targetId}`;
    }

    await expect(reconcileRepository({ store, github: gatewayForSnapshot(outsiderSnapshot) }, repositoryId))
      .resolves.toMatchObject({ adds: 0, changes: 0, removals: 0 });
    await expect(historicalRepositoryFacts(repositoryId, [sponsorId, contributorId])).resolves.toEqual(factsBefore);
  });

  it.each(["RECALIBRATING", "BANNED"] as const)(
    "keeps work merged while the sponsor is %s ineligible",
    async (state) => {
      const tokenEncryptionKey = Buffer.alloc(32, state === "BANNED" ? 13 : 12).toString("base64url");
      const sponsorLogin = `ineligible-sponsor-${state.toLowerCase()}-${nextExternalId()}`;
      const contributorLogin = `ineligible-contributor-${nextExternalId()}`;
      const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
      const contributorId = await insertUserWithLogin(sql, contributorLogin);
      const moderatorId = await insertUser(sql);
      await sql`
        update users
        set encrypted_oauth_token = ${Buffer.from(encryptToken("ineligible-token", tokenEncryptionKey), "utf8")},
            enforcement_state = ${state}
        where id = ${sponsorId}
      `;
      await sql`
        insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason, created_at)
        values (${sponsorId}, ${moderatorId}, ${"ACTIVE"}, ${state}, ${"Sanction before merge"},
          ${"2026-08-31T00:00:00.000Z"})
      `;
      const repositoryId = await insertRepository(sql, sponsorId);
      const [repository] = await sql<{ owner_name: string }[]>`
        select owner_name from registered_repositories where id = ${repositoryId}
      `;
      const snapshot = materializationSnapshot({
        repositoryId,
        ownerName: repository.owner_name,
        sponsorId,
        contributorId,
        sponsorLogin,
        contributorLogin,
        issueLabels: ["M"],
        actualLabel: "delivered/6",
        githubIssueId: nextExternalId(),
        githubPullRequestId: nextExternalId(),
      });
      const store = new PostgresFoldStore(sql, tokenEncryptionKey);

      await expect(reconcileRepository({ store, github: gatewayForSnapshot(snapshot) }, repositoryId))
        .resolves.toMatchObject({ adds: 0, changes: 0, removals: 0 });
      await expect(sql`select id from settlements where debtor_id = ${sponsorId}`).resolves.toEqual([]);
      await expect(sql`select id from self_work_calibrations where user_id = ${sponsorId}`).resolves.toEqual([]);
    },
  );

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
    const changedIssue = selfWorkChangedSnapshot.issues[0]!;
    changedIssue.labels = changedIssue.labels.map((label) => label === "delivered/6" ? "delivered/7" : label);
    const actualEvent = changedIssue.history.find((event) => event.kind === "LABELED" && event.label === "delivered/6");
    if (actualEvent === undefined || actualEvent.kind !== "LABELED") {
      throw new Error("Expected actual label history fixture.");
    }
    actualEvent.label = "delivered/7";
    changedIssue.comments[0]!.body = "Settled as delivered/7.";
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

  it("renews only the current webhook lease far enough to cover continued reconciliation", async () => {
    const store = new PostgresFoldStore(sql);
    const delivery = {
      deliveryId: "delivery-renewal",
      event: "pull_request" as const,
      action: "closed",
      repositoryGitHubId: nextExternalId(),
      repositoryFullName: "octo/example",
    };
    const claim = expectClaimedLease(await store.claimDelivery(delivery));

    await expect(
      store.renewDeliveryLease(delivery.deliveryId, "00000000-0000-4000-8000-000000000099"),
    ).resolves.toBe(false);
    await expect(store.renewDeliveryLease(delivery.deliveryId, claim.leaseToken)).resolves.toBe(true);

    const [record] = await sql<{ renewed: boolean }[]>`
      select lease_expires_at > now() + interval '4 minutes' as renewed
      from webhook_deliveries
      where github_delivery_id = ${delivery.deliveryId}
    `;
    expect(record).toEqual({ renewed: true });
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

async function resolveWithin<T>(promise: PromiseLike<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`Operation exceeded ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function conditionWithin(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  if (await condition()) {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (await condition()) {
      return true;
    }
  }
  return false;
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
    issues: [
      {
        id: githubIssueId,
        number: 1,
        title: "A materialized issue",
        body: "Issue body",
        url: "https://github.com/example/materialized/issues/1",
        state: "CLOSED",
        createdAt: "2026-09-01T08:00:00.000Z",
        authorLogin: sponsorLogin,
        labels: [...input.issueLabels, input.actualLabel],
        claimAssigneeGitHubLogin: contributorLogin,
        history: [
          {
            kind: "LABELED",
            id: `opening-${githubIssueId}`,
            actorLogin: sponsorLogin,
            label: input.issueLabels[0] ?? "M",
            createdAt: "2026-09-01T08:01:00.000Z",
          },
          {
            kind: "ASSIGNED",
            id: `assigned-${githubIssueId}`,
            actorLogin: sponsorLogin,
            assigneeLogin: contributorLogin,
            createdAt: "2026-09-01T09:00:00.000Z",
          },
          {
            kind: "LABELED",
            id: `actual-${githubIssueId}`,
            actorLogin: sponsorLogin,
            label: input.actualLabel,
            createdAt: "2026-09-01T11:00:00.000Z",
          },
        ],
        comments: [{
          id: `rationale-${githubIssueId}`,
          databaseId: githubIssueId + 20_000_000,
          authorLogin: sponsorLogin,
          body: `Settled as ${input.actualLabel}.`,
          createdAt: "2026-09-01T11:30:00.000Z",
        }],
        closingPullRequests: [
          {
            id: githubPullRequestId,
            number: 11,
            title: "A materialized pull request",
            body: "Pull request body",
            url: "https://github.com/example/materialized/pull/11",
            state: "MERGED",
            mergedAt: "2026-09-01T12:00:00.000Z",
            mergeCommitOid: githubPullRequestId.toString(16).padStart(40, "0"),
            finalCommitAt: "2026-09-01T10:00:00.000Z",
            authorLogin: contributorLogin,
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

function authoritativeIssue(input: { id: number; number: number; ownerLogin: string }): GitHubIssue {
  return {
    id: input.id,
    number: input.number,
    title: `Reconciled issue ${input.number}`,
    body: `Reconciled issue ${input.number} body`,
    url: `https://github.com/example/materialized/issues/${input.number}`,
    state: "CLOSED",
    createdAt: "2026-09-01T08:00:00.000Z",
    authorLogin: input.ownerLogin,
    labels: ["M", "delivered/6"],
    claimAssigneeGitHubLogin: null,
    history: [
      { kind: "LABELED", id: `opening-${input.id}`, actorLogin: input.ownerLogin, label: "M", createdAt: "2026-09-01T08:01:00.000Z" },
      { kind: "LABELED", id: `actual-${input.id}`, actorLogin: input.ownerLogin, label: "delivered/6", createdAt: "2026-09-01T11:00:00.000Z" },
    ],
    comments: [{
      id: `rationale-${input.id}`,
      databaseId: input.id + 20_000_000,
      authorLogin: input.ownerLogin,
      body: "Settled as delivered/6.",
      createdAt: "2026-09-01T11:30:00.000Z",
    }],
  };
}

function authoritativePullRequest(input: {
  id: number;
  number: number;
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
    mergeCommitOid: input.id.toString(16).padStart(40, "0"),
    finalCommitAt: "2026-09-01T10:00:00.000Z",
    authorLogin: input.authorLogin,
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
      proof_sha256: string | null;
    }[]>`
      select
        github_pull_request_id, pull_request_number, title, state,
        proof_sha256
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

function gatewayForSnapshot(snapshot: RepositoryFoldSnapshot): ReconciliationGateway {
  const issues: GitHubIssue[] = snapshot.issues.map((issue) => ({
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    state: issue.state,
    createdAt: issue.createdAt,
    authorLogin: issue.authorLogin,
    labels: issue.labels,
    claimAssigneeGitHubLogin: issue.claimAssigneeGitHubLogin ?? null,
    history: issue.history,
    comments: issue.comments,
  }));
  const pullRequestsByIssue = new Map(snapshot.issues.map((issue) => [
    issue.number,
    issue.closingPullRequests.map((pullRequest): GitHubPullRequest => ({
      id: pullRequest.id,
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body,
      url: pullRequest.url,
      state: pullRequest.state,
      mergedAt: pullRequest.mergedAt,
      mergeCommitOid: pullRequest.mergeCommitOid,
      finalCommitAt: pullRequest.finalCommitAt,
      authorLogin: pullRequest.authorLogin,
    })),
  ]));
  const evidenceByPullRequest = new Map(snapshot.issues.flatMap((issue) => (
    issue.closingPullRequests.map((pullRequest) => [pullRequest.number, pullRequest] as const)
  )));
  return {
    listIssues: async () => issues,
    getIssueClosingPullRequests: async (_repository, issueNumber) => pullRequestsByIssue.get(issueNumber) ?? [],
    getPullRequestReviews: async (_repository, pullRequestNumber) => (
      evidenceByPullRequest.get(pullRequestNumber)?.reviews ?? []
    ),
    getPullRequestDiff: async (_repository, pullRequestNumber) => (
      evidenceByPullRequest.get(pullRequestNumber)?.rawDiff ?? ""
    ),
  };
}

async function historicalRepositoryFacts(repositoryId: string, accountIds: string[]) {
  const [issues, settlements, calibrations, ledger, balances] = await Promise.all([
    sql`
      select
        id, opening_label, opening_comparison_points, opening_reserve_points,
        opening_source_event_id, opening_source_actor_login, opening_source_at,
        settled_label, settled_points, settled_label_event_id, settled_label_actor_login,
        settled_label_applied_at, settled_rationale_comment_id,
        settled_rationale_actor_login, settled_rationale_commented_at
      from issues where repository_id = ${repositoryId} order by github_issue_id
    `,
    sql`
      select
        settlements.id, settlements.issue_id, settlements.pull_request_id,
        settlements.creditor_id, settlements.debtor_id, settlements.opening_comparison_points,
        settlements.settled_points, settlements.review_rounds, settlements.credits,
        settlements.proof_sha256, settlements.status, pull_requests.merge_commit_oid,
        pull_requests.merged_at
      from settlements
      join issues on issues.id = settlements.issue_id
      join pull_requests on pull_requests.id = settlements.pull_request_id
      where issues.repository_id = ${repositoryId}
      order by settlements.id
    `,
    sql`
      select
        self_work_calibrations.id, self_work_calibrations.issue_id,
        self_work_calibrations.pull_request_id, self_work_calibrations.user_id,
        self_work_calibrations.opening_comparison_points, self_work_calibrations.actual_points,
        pull_requests.proof_sha256, pull_requests.merge_commit_oid, pull_requests.merged_at
      from self_work_calibrations
      join issues on issues.id = self_work_calibrations.issue_id
      join pull_requests on pull_requests.id = self_work_calibrations.pull_request_id
      where issues.repository_id = ${repositoryId}
      order by self_work_calibrations.id
    `,
    sql`
      select ledger_entries.settlement_id, ledger_entries.account_id, ledger_entries.amount
      from ledger_entries
      join settlements on settlements.id = ledger_entries.settlement_id
      join issues on issues.id = settlements.issue_id
      where issues.repository_id = ${repositoryId}
      order by ledger_entries.settlement_id, ledger_entries.account_id
    `,
    sql`
      select account_id, balance from balances
      where account_id::text = any(${sql.array(accountIds)})
      order by account_id
    `,
  ]);
  return { issues, settlements, calibrations, ledger, balances };
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
