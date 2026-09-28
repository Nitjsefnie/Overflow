import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql, type TransactionSql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { ABANDONED_RUN_MESSAGE, finalizeAbandonedRuns } from "@/lib/fold/abandoned-runs";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
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

  it("leaves a pending run without a repository byte-for-byte unchanged", async () => {
    const [orphan] = await sql<{ id: string }[]>`
      insert into reconciliation_runs (repository_id, status, rederivation)
      values (null, 'PENDING', true) returning id
    `;
    const before = await sql`select * from reconciliation_runs where id = ${orphan.id}`;
    expect(await finalizeAbandonedRuns(sql)).toEqual({ finalized: 0, skippedLocked: 0 });
    expect(await sql`select * from reconciliation_runs where id = ${orphan.id}`).toEqual(before);
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

  it("keeps abandonment terminal after a live owner's coordination backend ends", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    const ownerCoordination = postgres(databaseUrl, { max: 1 });
    const ownerConnection = await ownerCoordination.reserve();
    let backendTerminated = false;
    const coordinatedConnection = Object.assign(
      (strings: TemplateStringsArray, ...values: unknown[]) => {
        if (backendTerminated) return Promise.reject(new Error("Owner coordination backend ended."));
        return (ownerConnection as unknown as (...args: unknown[]) => Promise<unknown>)(strings, ...values);
      },
      {
        release: ownerConnection.release.bind(ownerConnection),
        unsafe: (query: string) => backendTerminated
          ? Promise.reject(new Error("Owner coordination backend ended.")) : ownerConnection.unsafe(query),
      },
    );
    const ownerStore = new PostgresFoldStore(sql, undefined,
      { reserve: async () => coordinatedConnection } as unknown as Sql);
    let releaseWork!: () => void;
    let completedLateWrites!: () => void;
    let startedWork!: (value: { completedRun: string; failedRun: string; pid: number }) => void;
    const blocked = new Promise<void>((resolve) => { releaseWork = resolve; });
    const lateWrites = new Promise<void>((resolve) => { completedLateWrites = resolve; });
    const started = new Promise<{ completedRun: string; failedRun: string; pid: number }>((resolve) => { startedWork = resolve; });
    const work = ownerStore.withRepositoryReconciliation(fixture.repositoryId, async () => {
      const completedRun = await ownerStore.beginRun(fixture.repositoryId);
      const failedRun = await ownerStore.beginRun(fixture.repositoryId);
      const [backend] = await sql<{ pid: number }[]>`
        select pid from pg_locks where locktype = 'advisory' and granted and mode = 'ExclusiveLock'
          and database = (select oid from pg_database where datname = current_database())
          and classid = ((hashtextextended(${fixture.repositoryId}, 684029183)::bigint >> 32) & 4294967295)::oid
          and objid = (hashtextextended(${fixture.repositoryId}, 684029183)::bigint & 4294967295)::oid
          and objsubid = 1
      `;
      if (backend === undefined) throw new Error("Owner lock was not visible.");
      startedWork({ completedRun, failedRun, pid: backend.pid });
      await blocked;
      await ownerStore.completeRun(completedRun);
      await ownerStore.failRun(failedRun, "late owner failure");
      completedLateWrites();
    });
    const settledWork = work.catch(() => undefined);
    try {
      const { completedRun, failedRun, pid } = await started;
      await sql`select pg_terminate_backend(${pid})`;
      backendTerminated = true;
      expect(await finalizeAbandonedRuns(sql)).toEqual({ finalized: 2, skippedLocked: 0 });
      releaseWork();
      await lateWrites;
      const rows = await sql<{ id: string; status: string; error_message: string | null }[]>`
        select id, status, error_message from reconciliation_runs
        where id in (${completedRun}, ${failedRun}) order by id
      `;
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(expect.arrayContaining([
        { id: completedRun, status: "FAILED", error_message: ABANDONED_RUN_MESSAGE },
        { id: failedRun, status: "FAILED", error_message: ABANDONED_RUN_MESSAGE },
      ]));
    } finally {
      releaseWork();
      await settledWork;
      ownerConnection.release();
      await ownerCoordination.end();
    }
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

  it("releases an ambiguous try-lock after the reserved backend changes", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    await fixture.store.beginRun(fixture.repositoryId);
    const oldBackend = postgres(databaseUrl, { max: 1 });
    const newBackend = postgres(databaseUrl, { max: 1 });
    const oldConnection = await oldBackend.reserve();
    let newConnection: Awaited<ReturnType<Sql["reserve"]>> | undefined;
    const coordinationSql = {
      reserve: async () => {
        newConnection = await newBackend.reserve();
        const connection = (strings: TemplateStringsArray, ...values: unknown[]) => {
          const query = strings.join(" ");
          if (query.includes("pg_backend_pid() as pid") && !query.includes("pg_try_advisory_lock")) {
            return (oldConnection as unknown as (...args: unknown[]) => Promise<unknown>)(strings, ...values);
          }
          const result = (newConnection as unknown as (...args: unknown[]) => Promise<unknown>)(strings, ...values);
          if (query.includes("pg_try_advisory_lock")) {
            return Promise.resolve(result).then(() => { throw new Error("replacement try-lock response lost"); });
          }
          return result;
        };
        return Object.assign(connection, { release: () => newConnection?.release(), unsafe: newConnection.unsafe.bind(newConnection) });
      },
      begin: (callback: (transaction: TransactionSql) => Promise<unknown>) => newBackend.begin(async (transaction) => {
        const wrapped = ((strings: TemplateStringsArray, ...values: unknown[]) => {
          const result = (transaction as unknown as (...args: unknown[]) => Promise<unknown>)(strings, ...values);
          if (strings.join(" ").includes("pg_try_advisory_xact_lock")) {
            return Promise.resolve(result).then(() => { throw new Error("replacement try-lock response lost"); });
          }
          return result;
        }) as unknown as TransactionSql;
        return callback(wrapped);
      }),
    } as unknown as Sql;
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
      if (newConnection !== undefined) {
        await newConnection`select pg_advisory_unlock_all()`;
        newConnection.release();
      }
      oldConnection.release();
      await Promise.all([observer.end(), newBackend.end(), oldBackend.end()]);
    }
  });
});
