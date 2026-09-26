import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import type { FoldResult } from "@/lib/fold/repository-fold";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

/**
 * Issue 659: the materializer decides whether a stored settlement or self-work
 * calibration changed by comparing a state built from the database row with a
 * state built from the fold. The row side renders every timestamp through
 * Date#toISOString (always with milliseconds); the fold carries GitHub's own
 * string form, which has none. Unless both sides share one form, an unchanged
 * row compares unequal on every pass, is rewritten, and gains a CHANGE record.
 */
let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe("reconciliation compares timestamps as instants", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "timestamp_canonical_test", user: "timestamp_canonical_test", password: "timestamp_canonical_test",
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

  it("records nothing and rewrites nothing for an unchanged repository whose fold timestamps have no milliseconds", async () => {
    const { repositoryId, store, fold } = await materializeRepositoryFixture(sql);
    const githubFold = withGitHubTimestamps(fold);
    expect(githubFold.settlements[0]!.mergedAt).toBe("2026-09-01T12:00:00Z");
    expect(githubFold.selfWorkCalibrations[0]!.mergedAt).toBe("2026-09-01T12:00:00Z");
    expect(githubFold.settlements[0]!.settledLabelAppliedAt).toBe("2026-09-01T11:00:00Z");
    expect(githubFold.selfWorkCalibrations[0]!.rationaleCommentedAt).toBe("2026-09-01T11:30:00Z");
    const versions = await derivedRowVersions(repositoryId);

    for (let pass = 0; pass < 2; pass += 1) {
      const runId = await store.beginRun(repositoryId);
      const deltas = await store.withRepositoryReconciliation(repositoryId, () => store.materialize({ repositoryId, runId, fold: githubFold }));
      expect(await changesFor(runId)).toEqual([]);
      expect(deltas).toEqual({ adds: 0, changes: 0, removals: 0 });
      // xmin names the transaction that wrote the tuple: an unchanged row must
      // not be rewritten either.
      expect(await derivedRowVersions(repositoryId)).toEqual(versions);
    }
  });

  it("records an ADD in the same timestamp form a later comparison reads back", async () => {
    const { repositoryId, store, fold } = await materializeRepositoryFixture(sql);
    const githubFold = withGitHubTimestamps(fold);
    const withoutDerived = { ...githubFold, settlements: [], selfWorkCalibrations: [] };
    const removalRun = await store.beginRun(repositoryId);
    await store.withRepositoryReconciliation(repositoryId, () => store.materialize({ repositoryId, runId: removalRun, fold: withoutDerived }));

    const addRun = await store.beginRun(repositoryId);
    expect(await store.withRepositoryReconciliation(repositoryId, () => store.materialize({ repositoryId, runId: addRun, fold: githubFold })))
      .toEqual({ adds: 2, changes: 0, removals: 0 });
    const adds = await changesFor(addRun);
    expect(adds).toEqual([
      {
        entity_kind: "SELF_WORK_CALIBRATION", change_kind: "ADD", before_state: null,
        after_state: expect.objectContaining({
          mergedAt: "2026-09-01T12:00:00.000Z",
          actualLabelAppliedAt: "2026-09-01T11:00:00.000Z",
          rationaleCommentedAt: "2026-09-01T11:30:00.000Z",
        }),
      },
      {
        entity_kind: "SETTLEMENT", change_kind: "ADD", before_state: null,
        after_state: expect.objectContaining({
          mergedAt: "2026-09-01T12:00:00.000Z",
          settledLabelAppliedAt: "2026-09-01T11:00:00.000Z",
          settledRationaleCommentedAt: "2026-09-01T11:30:00.000Z",
        }),
      },
    ]);

    const repeatRun = await store.beginRun(repositoryId);
    expect(await store.withRepositoryReconciliation(repositoryId, () => store.materialize({ repositoryId, runId: repeatRun, fold: githubFold })))
      .toEqual({ adds: 0, changes: 0, removals: 0 });
    expect(await changesFor(repeatRun)).toEqual([]);
  });

  it.each([
    {
      entity: "SETTLEMENT", table: "settlements", issueIndex: 0,
      change: (fold: FoldResult) => {
        fold.settlements[0] = { ...fold.settlements[0]!, settledLabel: "delivered/7", settledPoints: 7, credits: 7 };
      },
      before: { settledLabel: "delivered/6", settledPoints: 6 },
      after: { settledLabel: "delivered/7", settledPoints: 7 },
    },
    {
      entity: "SELF_WORK_CALIBRATION", table: "self_work_calibrations", issueIndex: 1,
      change: (fold: FoldResult) => {
        fold.selfWorkCalibrations[0] = { ...fold.selfWorkCalibrations[0]!, actualLabel: "delivered/7", actualPoints: 7 };
      },
      before: { actualLabel: "delivered/6", actualPoints: 6 },
      after: { actualLabel: "delivered/7", actualPoints: 7 },
    },
  ] as const)("records exactly one CHANGE for a $entity whose settled label changed", async ({ entity, table, issueIndex, change, before, after }) => {
    const { repositoryId, store, fold } = await materializeRepositoryFixture(sql);
    const versions = await derivedRowVersions(repositoryId);
    const changed = withGitHubTimestamps(fold);
    changed.issues[issueIndex] = { ...changed.issues[issueIndex]!, settledLabel: "delivered/7" };
    change(changed);

    const runId = await store.beginRun(repositoryId);
    expect(await store.withRepositoryReconciliation(repositoryId, () => store.materialize({ repositoryId, runId, fold: changed })))
      .toEqual({ adds: 0, changes: 1, removals: 0 });
    const recorded = await changesFor(runId);
    expect(recorded).toEqual([{
      entity_kind: entity, change_kind: "CHANGE",
      before_state: expect.objectContaining({ ...before, mergedAt: "2026-09-01T12:00:00.000Z" }),
      after_state: expect.objectContaining({ ...after, mergedAt: "2026-09-01T12:00:00.000Z" }),
    }]);
    // The recorded change is also written: only the changed row is rewritten,
    // and it now stores the new points.
    const rewritten = await rewrittenRows(versions, repositoryId);
    expect(rewritten.map(({ kind, points }) => ({ kind, points }))).toEqual([{ kind: table, points: 7 }]);
  });

  it.each([
    {
      entity: "SETTLEMENT", table: "settlements", pullRequestIndex: 0,
      move: (fold: FoldResult, mergedAt: string) => {
        fold.settlements[0] = { ...fold.settlements[0]!, mergedAt };
      },
    },
    {
      entity: "SELF_WORK_CALIBRATION", table: "self_work_calibrations", pullRequestIndex: 1,
      move: (fold: FoldResult, mergedAt: string) => {
        fold.selfWorkCalibrations[0] = { ...fold.selfWorkCalibrations[0]!, mergedAt };
      },
    },
  ] as const)("records exactly one CHANGE for a $entity whose merge moved to another instant", async ({ entity, table, pullRequestIndex, move }) => {
    const { repositoryId, store, fold } = await materializeRepositoryFixture(sql);
    const versions = await derivedRowVersions(repositoryId);
    const moved = withGitHubTimestamps(fold);
    const mergedAt = "2026-09-01T12:00:01Z";
    moved.pullRequests[pullRequestIndex] = { ...moved.pullRequests[pullRequestIndex]!, mergedAt };
    move(moved, mergedAt);

    const runId = await store.beginRun(repositoryId);
    expect(await store.withRepositoryReconciliation(repositoryId, () => store.materialize({ repositoryId, runId, fold: moved })))
      .toEqual({ adds: 0, changes: 1, removals: 0 });
    expect(await changesFor(runId)).toEqual([{
      entity_kind: entity, change_kind: "CHANGE",
      before_state: expect.objectContaining({ mergedAt: "2026-09-01T12:00:00.000Z" }),
      after_state: expect.objectContaining({ mergedAt: "2026-09-01T12:00:01.000Z" }),
    }]);
    expect((await rewrittenRows(versions, repositoryId)).map(({ kind }) => kind)).toEqual([table]);
  });
});

/**
 * The same fold with its timestamps in GitHub's second-precision form
 * (`...:00Z`). A real fold carries `mergedAt` verbatim in that form; the
 * fixture's literals are written with milliseconds, and the defect needs the
 * other form. Every settlement and calibration timestamp is rewritten, not only
 * `mergedAt`, so each one is shown to compare as an instant. `openingSourceAt`
 * is left alone: the fold always canonicalises it, and the issue upsert rejects
 * any other form as a mismatch with immutable history.
 */
function withGitHubTimestamps(fold: FoldResult): FoldResult {
  return JSON.parse(JSON.stringify(fold), (key, value: unknown) =>
    key !== "openingSourceAt" && typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/.test(value)
      ? value.replace(".000Z", "Z")
      : value,
  ) as FoldResult;
}

function changesFor(runId: string) {
  return sql`
    select entity_kind, change_kind, before_state, after_state
    from reconciliation_changes where reconciliation_run_id = ${runId}
    order by entity_kind::text collate "C", change_kind
  `;
}

function derivedRowVersions(repositoryId: string) {
  return sql`
    select 'settlements' as kind, derived.id, derived.xmin::text as version, derived.settled_points as points
    from settlements as derived
    join issues on issues.id = derived.issue_id where issues.repository_id = ${repositoryId}
    union all
    select 'self_work_calibrations', derived.id, derived.xmin::text, derived.actual_points
    from self_work_calibrations as derived
    join issues on issues.id = derived.issue_id where issues.repository_id = ${repositoryId}
    order by kind
  `;
}

/** The derived rows whose tuple was written since `before` was read. */
async function rewrittenRows(before: readonly Record<string, unknown>[], repositoryId: string) {
  const versionBefore = new Map(before.map((row) => [row.id, row.version]));
  return (await derivedRowVersions(repositoryId)).filter((row) => versionBefore.get(row.id) !== row.version);
}
