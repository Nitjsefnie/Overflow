import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { ABANDONED_RUN_MESSAGE, finalizeAbandonedRuns } from "@/lib/fold/abandoned-runs";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
let container: StartedTestContainer;
let databaseUrl: string;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "abandoned_runs", user: "abandoned_runs", password: "abandoned_runs" });
  container = started.container;
  databaseUrl = started.databaseUrl;
  process.env.DATABASE_URL = databaseUrl;
  sql = getSql();
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("abandoned reconciliation runs", () => {
  it("finalizes pending runs in every unlocked repository without changing finished runs", async () => {
    const one = await materializeRepositoryFixture(sql);
    const two = await materializeRepositoryFixture(sql);
    const pending = await Promise.all([
      one.store.beginRun(one.repositoryId), one.store.beginRun(one.repositoryId),
      two.store.beginRun(two.repositoryId), two.store.beginRun(two.repositoryId),
    ]);
    const failed = await one.store.beginRun(one.repositoryId);
    await one.store.failRun(failed, "upstream text must not be stored");
    const finishedBefore = await sql`
      select * from reconciliation_runs where id in (${one.runId}, ${two.runId}, ${failed}) order by id
    `;

    const log = vi.spyOn(console, "info").mockImplementation(() => undefined);
    try {
      expect(await finalizeAbandonedRuns(sql)).toEqual({ finalized: 4, skippedLocked: 0 });
      expect(log).toHaveBeenCalledTimes(1);
      expect(await finalizeAbandonedRuns(sql)).toEqual({ finalized: 0, skippedLocked: 0 });
      expect(log).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }

    const rows = await sql<{ id: string; status: string; completed_at: Date | null; error_message: string | null }[]>`
      select id, status, completed_at, error_message from reconciliation_runs where id in ${sql(pending)}
    `;
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row.status).toBe("FAILED");
      expect(row.error_message).toBe(ABANDONED_RUN_MESSAGE);
      expect(row.completed_at).not.toBeNull();
    }
    expect(await sql`
      select * from reconciliation_runs where id in (${one.runId}, ${two.runId}, ${failed}) order by id
    `).toEqual(finishedBefore);
    await expect(one.store.withRepositoryReconciliation(one.repositoryId, async () => "lock released"))
      .resolves.toBe("lock released");
  });

  it("keeps a live owner's run pending and still finalizes another repository", async () => {
    const live = await materializeRepositoryFixture(sql);
    const orphan = await materializeRepositoryFixture(sql);
    const orphanRun = await orphan.store.beginRun(orphan.repositoryId);
    let releaseWork!: () => void;
    let startedWork!: (runId: string) => void;
    const blocked = new Promise<void>((resolve) => { releaseWork = resolve; });
    const started = new Promise<string>((resolve) => { startedWork = resolve; });
    const work = live.store.withRepositoryReconciliation(live.repositoryId, async () => {
      const runId = await live.store.beginRun(live.repositoryId);
      startedWork(runId);
      await blocked;
      await live.store.completeRun(runId);
    });
    const liveRun = await started;
    try {
      expect(await finalizeAbandonedRuns(sql)).toEqual({ finalized: 1, skippedLocked: 1 });
      expect(await sql`select status from reconciliation_runs where id = ${liveRun}`).toEqual([{ status: "PENDING" }]);
      expect(await sql`select status, error_message from reconciliation_runs where id = ${orphanRun}`)
        .toEqual([{ status: "FAILED", error_message: ABANDONED_RUN_MESSAGE }]);
    } finally {
      releaseWork();
      await work;
    }
    expect(await sql`select status from reconciliation_runs where id = ${liveRun}`).toEqual([{ status: "COMPLETED" }]);
  });

  it("finalizes a run after the separate lock owner's connection ends", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    const runId = await fixture.store.beginRun(fixture.repositoryId);
    const owner = postgres(databaseUrl, { max: 1 });
    try {
      await owner`select pg_advisory_lock(hashtextextended(${fixture.repositoryId}, 684029183))`;
      expect(await finalizeAbandonedRuns(sql)).toEqual({ finalized: 0, skippedLocked: 1 });
      expect(await sql`select status from reconciliation_runs where id = ${runId}`).toEqual([{ status: "PENDING" }]);
    } finally {
      await owner.end();
    }
    expect(await finalizeAbandonedRuns(sql)).toEqual({ finalized: 1, skippedLocked: 0 });
    const [row] = await sql<{ status: string; completed_at: Date | null; error_message: string | null }[]>`
      select status, completed_at, error_message from reconciliation_runs where id = ${runId}
    `;
    expect(row).toMatchObject({ status: "FAILED", error_message: ABANDONED_RUN_MESSAGE });
    expect(row.completed_at).not.toBeNull();
  });

  it("reclaims a lock when the server takes it but the try-lock response is lost", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    await fixture.store.beginRun(fixture.repositoryId);
    const held = await sql.reserve();
    let released = false;
    const wrapped = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        const query = (held as unknown as (...args: unknown[]) => Promise<unknown>)(strings, ...values);
        if (strings.join(" ").includes("pg_try_advisory_lock")) {
          return Promise.resolve(query).then(() => { throw new Error("try-lock response lost"); });
        }
        return query;
      },
      {
        release: () => { released = true; held.release(); },
        unsafe: held.unsafe.bind(held),
      },
    );
    const coordinationSql = { reserve: async () => wrapped } as unknown as Sql;
    const observer = postgres(databaseUrl, { max: 1 });
    try {
      await expect(finalizeAbandonedRuns(sql, coordinationSql)).rejects.toThrow();
      const [attempt] = await observer<{ acquired: boolean }[]>`
        select pg_try_advisory_lock(hashtextextended(${fixture.repositoryId}, 684029183)) as acquired
      `;
      expect(attempt.acquired).toBe(true);
      if (attempt.acquired) {
        await observer`select pg_advisory_unlock(hashtextextended(${fixture.repositoryId}, 684029183))`;
      }
    } finally {
      await observer.end();
      if (!released) {
        await held`select pg_advisory_unlock_all()`;
        held.release();
      }
    }
  });
});
