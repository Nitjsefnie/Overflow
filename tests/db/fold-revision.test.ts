import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { claimGitHubIdentity } from "@/lib/fold/postgres-store";
import { FOLD_REVISION } from "@/lib/fold/fold-revision";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

const tables = ["settlements", "self_work_calibrations", "unwritable_closures"] as const;
let container: StartedTestContainer | undefined;
let sql: Sql;
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

  it.each(tables)("detects stale %s rows only in their own repository", async (table) => {
    const { repositoryId, store } = await materializeRepositoryFixture(sql);
    const other = await materializeRepositoryFixture(sql);
    const [row] = await rowsFor(table, repositoryId);
    await sql`update ${sql(table)} set fold_revision = ${FOLD_REVISION - 1} where id = ${row.id}`;
    expect(await store.hasDerivedRowsBelowFoldRevision(repositoryId, FOLD_REVISION)).toBe(true);
    expect(await store.hasDerivedRowsBelowFoldRevision(other.repositoryId, FOLD_REVISION)).toBe(false);
    expect(await store.hasDerivedRowsBelowFoldRevision(repositoryId, FOLD_REVISION - 1)).toBe(false);
    await sql`update ${sql(table)} set fold_revision = ${FOLD_REVISION} where id = ${row.id}`;
    expect(await store.hasDerivedRowsBelowFoldRevision(repositoryId, FOLD_REVISION)).toBe(false);
  });

  it.each([true, false, undefined])("records run rederivation=%s with an omitted option defaulting to false", async (rederivation) => {
    const { repositoryId, store } = await materializeRepositoryFixture(sql);
    const runId = await store.beginRun(repositoryId, rederivation === undefined ? undefined : { rederivation });
    expect(await sql`select rederivation from reconciliation_runs where id = ${runId}`)
      .toEqual([{ rederivation: rederivation ?? false }]);
  });

  it.each(tables)("defaults a direct %s insert to the unnamed revision 0", async (table) => {
    const { repositoryId } = await materializeRepositoryFixture(sql);
    const [source] = await rowsFor(table, repositoryId);
    // Reinsert the same valid business fields, explicitly omitting the revision.
    // The database must supply 0 even after materializers start supplying revision 1.
    const columns = Object.keys(source).filter((column) => column !== "fold_revision");
    await sql`delete from ${sql(table)} where id = ${source.id}`;
    await sql`insert into ${sql(table)} ${sql(source, columns)}`;
    expect((await rowsFor(table, repositoryId))[0]).toHaveProperty("fold_revision", 0);
  });

  it.each(tables)("stamps materialized %s inserts with the current revision", async (table) => {
    const { repositoryId, deltas } = await materializeRepositoryFixture(sql);
    expect(deltas).toEqual({ adds: 3, changes: 0, removals: 0 });
    expect(await rowsFor(table, repositoryId)).toEqual([
      expect.objectContaining({ fold_revision: FOLD_REVISION }),
    ]);
  });

  it.each(tables)("refreshes only a stale %s stamp without deltas or change records", async (table) => {
    const { repositoryId, store, fold } = await materializeRepositoryFixture(sql);
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
    const { repositoryId, store, fold } = await materializeRepositoryFixture(sql);
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

  it("preserves the revision and values of a settlement updated by an identity claim", async () => {
    const { repositoryId, fold } = await materializeRepositoryFixture(sql);
    const [row] = await rowsFor("settlements", repositoryId);
    await sql`
      update settlements set creditor_id = null, status = 'UNCLAIMED',
        opening_comparison_points = 3, fold_revision = 0 where id = ${row.id}
    `;

    await claimGitHubIdentity(sql, fold.settlements[0].creditorId!, fold.settlements[0].creditorGitHubUserId!);

    expect(await rowsFor("settlements", repositoryId)).toEqual([{
      ...row, creditor_id: fold.settlements[0].creditorId, status: "SETTLED",
      opening_comparison_points: 3, fold_revision: 0,
    }]);
  });

  it.each([
    { sourceRevision: 0, existingRevision: null },
    { sourceRevision: 0, existingRevision: 1 },
    { sourceRevision: 1, existingRevision: 0 },
  ])("preserves self-work provenance on an identity claim (source: $sourceRevision, existing: $existingRevision)", async ({ sourceRevision, existingRevision }) => {
    const { repositoryId, fold } = await materializeRepositoryFixture(sql);
    const [row] = await rowsFor("settlements", repositoryId);
    const sponsorId = fold.settlements[0].debtorId;
    const sponsorGitHubId = fold.pullRequests[1].authorGitHubUserId!;
    await sql`
      update settlements set creditor_id = null, creditor_github_user_id = ${sponsorGitHubId},
        status = 'UNCLAIMED', opening_comparison_points = 3,
        fold_revision = ${sourceRevision} where id = ${row.id}
    `;
    if (existingRevision !== null) {
      await sql`
        insert into self_work_calibrations (
          pull_request_id, issue_id, user_id, opening_comparison_points, actual_points, fold_revision
        )
        values (${row.pull_request_id}, ${row.issue_id}, ${sponsorId}, 5, 5, ${existingRevision})
      `;
    }

    await claimGitHubIdentity(sql, sponsorId, sponsorGitHubId);

    expect(await sql`select * from settlements where id = ${row.id}`).toEqual([]);
    expect(await sql`
      select user_id, opening_comparison_points, actual_points, fold_revision
      from self_work_calibrations where issue_id = ${row.issue_id}
    `).toEqual([{ user_id: sponsorId, opening_comparison_points: 3, actual_points: 6, fold_revision: 0 }]);
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
