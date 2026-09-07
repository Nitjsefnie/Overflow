import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { claimGitHubIdentity, PostgresFoldStore } from "@/lib/fold/postgres-store";
import { FOLD_REVISION } from "@/lib/fold/fold-revision";
import type { FoldResult } from "@/lib/fold/repository-fold";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

const tables = ["settlements", "self_work_calibrations", "unwritable_closures"] as const;
let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 1_000_000;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe("fold revision stamps", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "fold_revision_test", user: "fold_revision_test", password: "fold_revision_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it.each(tables)("defaults a direct %s insert to the unnamed revision 0", async (table) => {
    const { repositoryId } = await materializedFixture();
    const [source] = await rowsFor(table, repositoryId);
    // Reinsert the same valid business fields, explicitly omitting the revision.
    // The database must supply 0 even after materializers start supplying revision 1.
    const columns = Object.keys(source).filter((column) => column !== "fold_revision");
    await sql`delete from ${sql(table)} where id = ${source.id}`;
    await sql`insert into ${sql(table)} ${sql(source, columns)}`;
    expect((await rowsFor(table, repositoryId))[0]).toHaveProperty("fold_revision", 0);
  });

  it.each(tables)("stamps materialized %s inserts with the current revision", async (table) => {
    const { repositoryId, deltas } = await materializedFixture();
    expect(deltas).toEqual({ adds: 3, changes: 0, removals: 0 });
    expect(await rowsFor(table, repositoryId)).toEqual([
      expect.objectContaining({ fold_revision: FOLD_REVISION }),
    ]);
  });

  it.each(tables)("refreshes only a stale %s stamp without deltas or change records", async (table) => {
    const { repositoryId, store, fold } = await materializedFixture();
    const [row] = await rowsFor(table, repositoryId);
    await sql`update ${sql(table)} set fold_revision = ${FOLD_REVISION - 1} where id = ${row.id}`;
    const [before] = await rowsFor(table, repositoryId);
    const runId = await store.beginRun(repositoryId);

    expect(await store.materialize({ repositoryId, runId, fold })).toEqual({ adds: 0, changes: 0, removals: 0 });
    expect(await changesFor(runId)).toEqual([]);
    expect(await rowsFor(table, repositoryId)).toEqual([{ ...before, fold_revision: FOLD_REVISION }]);

    // xmin identifies the transaction that wrote the tuple. A current or newer
    // unchanged row must not receive even a redundant stamp update.
    for (const revision of [FOLD_REVISION, FOLD_REVISION + 1]) {
      await sql`update ${sql(table)} set fold_revision = ${revision} where id = ${row.id}`;
      const [version] = await sql`select xmin::text from ${sql(table)} where id = ${row.id}`;
      const repeatRun = await store.beginRun(repositoryId);
      expect(await store.materialize({ repositoryId, runId: repeatRun, fold }))
        .toEqual({ adds: 0, changes: 0, removals: 0 });
      expect(await changesFor(repeatRun)).toEqual([]);
      expect(await sql`select xmin::text from ${sql(table)} where id = ${row.id}`).toEqual([version]);
      expect((await rowsFor(table, repositoryId))[0].fold_revision).toBe(revision);
    }
  });

  it.each([
    { table: "settlements", column: "creditor_github_login", stale: "old-contributor-login",
      entity: "SETTLEMENT", stateKey: "creditorGitHubLogin" },
    { table: "self_work_calibrations", column: "actual_points", stale: 5, desired: 6,
      entity: "SELF_WORK_CALIBRATION", stateKey: "actualPoints" },
    { table: "unwritable_closures", column: "reason", stale: "Outdated reason", desired: "No closing pull request.",
      entity: "UNWRITABLE_CLOSURE", stateKey: "reason" },
  ] as const)("rewrites and stamps changed $table while recording its CHANGE", async (testCase) => {
    const { table, column, stale, entity, stateKey } = testCase;
    const { repositoryId, store, fold } = await materializedFixture();
    const [row] = await rowsFor(table, repositoryId);
    const desired = table === "settlements" ? fold.settlements[0].creditorGitHubLogin : testCase.desired;
    await sql`
      update ${sql(table)} set ${sql(column)} = ${stale}, fold_revision = ${FOLD_REVISION - 1}
      where id = ${row.id}
    `;
    const runId = await store.beginRun(repositoryId);

    expect(await store.materialize({ repositoryId, runId, fold })).toEqual({ adds: 0, changes: 1, removals: 0 });
    expect(await changesFor(runId)).toEqual([{
      entity_kind: entity, change_kind: "CHANGE",
      before_state: expect.objectContaining({ [stateKey]: stale }),
      after_state: expect.objectContaining({ [stateKey]: desired }),
    }]);
    const [change] = await changesFor(runId);
    expect(change.before_state).not.toHaveProperty("fold_revision");
    expect(change.after_state).not.toHaveProperty("fold_revision");
    expect(await rowsFor(table, repositoryId)).toEqual([{ ...row, fold_revision: FOLD_REVISION }]);
  });

  it("stamps a settlement updated by an identity claim", async () => {
    const { repositoryId, fold } = await materializedFixture();
    const [row] = await rowsFor("settlements", repositoryId);
    await sql`update settlements set creditor_id = null, status = 'UNCLAIMED', fold_revision = 0 where id = ${row.id}`;

    await claimGitHubIdentity(sql, fold.settlements[0].creditorId!, fold.settlements[0].creditorGitHubUserId!);

    expect(await rowsFor("settlements", repositoryId)).toEqual([{ ...row, fold_revision: FOLD_REVISION }]);
  });

  it.each([false, true])("stamps an identity claim's self-work calibration (existing: %s)", async (existing) => {
    const { repositoryId, fold } = await materializedFixture();
    const [row] = await rowsFor("settlements", repositoryId);
    const sponsorId = fold.settlements[0].debtorId;
    const sponsorGitHubId = fold.pullRequests[1].authorGitHubUserId!;
    await sql`
      update settlements set creditor_id = null, creditor_github_user_id = ${sponsorGitHubId},
        status = 'UNCLAIMED', fold_revision = 0 where id = ${row.id}
    `;
    if (existing) {
      await sql`
        insert into self_work_calibrations (pull_request_id, issue_id, user_id, opening_comparison_points, actual_points)
        values (${row.pull_request_id}, ${row.issue_id}, ${sponsorId}, 5, 5)
      `;
    }

    await claimGitHubIdentity(sql, sponsorId, sponsorGitHubId);

    expect(await sql`select * from settlements where id = ${row.id}`).toEqual([]);
    expect(await sql`
      select user_id, actual_points, fold_revision from self_work_calibrations where issue_id = ${row.issue_id}
    `).toEqual([{ user_id: sponsorId, actual_points: 6, fold_revision: FOLD_REVISION }]);
  });
});

function changesFor(runId: string) {
  return sql`
    select entity_kind, change_kind, before_state, after_state
    from reconciliation_changes where reconciliation_run_id = ${runId}
  `;
}

function rowsFor(table: typeof tables[number], repositoryId: string) {
  return sql`
    select derived.* from ${sql(table)} as derived
    join issues on issues.id = derived.issue_id
    where issues.repository_id = ${repositoryId}
  `;
}

async function materializedFixture() {
  const sponsorGitHubId = externalId++;
  const contributorGitHubId = externalId++;
  const [sponsor] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${sponsorGitHubId}, ${`sponsor-${sponsorGitHubId}`}) returning id
  `;
  const [contributor] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${contributorGitHubId}, ${`contributor-${contributorGitHubId}`}) returning id
  `;
  const repositoryGitHubId = externalId++;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    ) values (
      ${repositoryGitHubId}, ${`owner/repo-${repositoryGitHubId}`}, ${sponsor.id}, 'PUBLIC',
      ${externalId++}, ${sql.json(validDifficultyScheme())}
    ) returning id
  `;
  const issueIds = [externalId++, externalId++, externalId++];
  const pullRequestIds = [externalId++, externalId++];
  const mergedAt = "2026-09-01T12:00:00.000Z";
  const mergeCommitOid = "a".repeat(40);
  const proofSha256 = repositoryGitHubId.toString(16).padStart(64, "0");
  const settledEvidence = {
    settledLabel: "delivered/6", settledPoints: 6,
    settledLabelEventId: "actual", settledLabelActorLogin: `sponsor-${sponsorGitHubId}`,
    settledLabelAppliedAt: "2026-09-01T11:00:00.000Z",
    settledRationaleCommentId: "rationale", settledRationaleActorLogin: `sponsor-${sponsorGitHubId}`,
    settledRationaleCommentedAt: "2026-09-01T11:30:00.000Z",
  };
  // A literal materializer input keeps this suite focused on storing the fold's
  // output. Each derived kind has its own issue, as it would in a real fold.
  const fold: FoldResult = {
    issues: issueIds.map((githubIssueId, index) => ({
      githubIssueId, number: index + 1, title: "Revision fixture", body: "", url: "https://example.test/issue",
      state: "CLOSED", openingLabel: "M", openingComparisonPoints: 5, openingReservePoints: 5,
      ownerGitHubLogin: `sponsor-${sponsorGitHubId}`, openingSourceEventId: `opening-${githubIssueId}`,
      openingSourceActorLogin: `sponsor-${sponsorGitHubId}`, openingSourceAt: "2026-09-01T08:00:00.000Z",
      claimAssigneeGitHubLogin: null, ...settledEvidence,
    })),
    pullRequests: pullRequestIds.map((githubPullRequestId, index) => ({
      githubPullRequestId, number: index + 11, title: "Revision fixture", body: "", url: "https://example.test/pr",
      state: "MERGED", mergedAt, mergeCommitOid, finalCommitAt: "2026-09-01T10:00:00.000Z",
      authorId: index === 0 ? contributor.id : sponsor.id,
      authorGitHubLogin: index === 0 ? `contributor-${contributorGitHubId}` : `sponsor-${sponsorGitHubId}`,
      authorGitHubUserId: index === 0 ? contributorGitHubId : sponsorGitHubId,
      proofSha256, githubIssueIds: [issueIds[index]], reviewRounds: [],
    })),
    settlements: [{
      githubIssueId: issueIds[0], githubPullRequestId: pullRequestIds[0], creditorId: contributor.id,
      creditorGitHubLogin: `contributor-${contributorGitHubId}`, creditorGitHubUserId: contributorGitHubId,
      debtorId: sponsor.id, openingComparisonPoints: 5, ...settledEvidence,
      mergeCommitOid, mergedAt, reviewRounds: 0, credits: 6, proofSha256, status: "SETTLED",
    }],
    selfWorkCalibrations: [{
      githubIssueId: issueIds[1], githubPullRequestId: pullRequestIds[1], userId: sponsor.id,
      openingComparisonPoints: 5, actualLabel: settledEvidence.settledLabel, actualPoints: 6,
      actualLabelEventId: settledEvidence.settledLabelEventId,
      actualLabelActorLogin: settledEvidence.settledLabelActorLogin,
      actualLabelAppliedAt: settledEvidence.settledLabelAppliedAt,
      rationaleCommentId: settledEvidence.settledRationaleCommentId,
      rationaleActorLogin: settledEvidence.settledRationaleActorLogin,
      rationaleCommentedAt: settledEvidence.settledRationaleCommentedAt, mergeCommitOid, mergedAt,
    }],
    unwritableClosures: [{
      githubIssueId: issueIds[2], githubPullRequestId: null, kind: "NO_CLOSING_PULL_REQUEST",
      reason: "No closing pull request.",
    }],
    policyViolations: [], ledgerEntries: [],
  };
  const store = new PostgresFoldStore(sql);
  const repositoryId = repository.id;
  const runId = await store.beginRun(repositoryId);
  const deltas = await store.materialize({ repositoryId, runId, fold });
  return { repositoryId, store, fold, runId, deltas };
}
