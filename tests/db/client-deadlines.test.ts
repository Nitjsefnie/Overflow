import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer, type StartedPostgres } from "../support/postgres-container";
import postgres from "postgres";
import { closeSql, getSql, withTransaction } from "@/lib/db/client";
import type { SqlClient, TransactionClient } from "@/lib/db/types";
import { runMigrations } from "../../scripts/migrate";
import { runPruneNoopReconciliationChangesCli } from "../../scripts/prune-noop-reconciliation-changes";

const exec = promisify(execFile);

/**
 * Issue 661: the shared clients are the single choke point every database
 * connection in the process flows through, and issue 661 gives them real
 * deadlines. Four properties are pinned here:
 *
 * - the connect phase fails fast (connect_timeout 5 s, not the library's 30 s
 *   default) while the server is unreachable;
 * - a statement that cannot run — blocked behind a lock another session holds
 *   — is cancelled by the server inside the statement deadline;
 * - the deadline is in force by default ("30s") and a transaction may exempt
 *   itself with `set local statement_timeout = 0`, which is exactly the shape
 *   the migration runner's per-migration transaction takes, so long DDL is not
 *   killed mid-migration;
 * - the deadline reaches statement bodies inside transactions too.
 *
 * The suite runs against a container of its own (the init script forces the
 * private-container path): the connect-phase test pauses the database with
 * `docker pause`, which only makes sense on a container this suite owns — the
 * shared server's facade forbids container manipulation for the whole run's
 * sake (tests/support/postgres-container.ts). No wall-clock margin is used to
 * sequence anything; the only elapsed assertions are the upper bounds the
 * deadline property itself demands (a rejection that arrives only after the
 * bound is the old behaviour, not the new one).
 */
describe("database client deadlines", () => {
  const databaseUrlOriginal = process.env.DATABASE_URL;
  const statementTimeoutOriginal = process.env.DATABASE_STATEMENT_TIMEOUT_MS;

  let started: StartedPostgres;
  let databaseUrl: string;

  beforeAll(async () => {
    started = await startPostgresContainer({
      database: "client_deadlines_test",
      user: "client_deadlines_test",
      password: "client_deadlines_test",
      // A private container: only its own init script takes the suite off the
      // shared server, and docker pause below must not freeze anyone else's
      // database.
      initScripts: [{ name: "661_own_container.sql", content: "select 1;" }],
    });
    databaseUrl = started.databaseUrl;
    process.env.DATABASE_URL = databaseUrl;
  });

  afterAll(async () => {
    await closeSql();
    await started?.container.stop();
    if (databaseUrlOriginal === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = databaseUrlOriginal;
    }
    if (statementTimeoutOriginal === undefined) {
      delete process.env.DATABASE_STATEMENT_TIMEOUT_MS;
    } else {
      process.env.DATABASE_STATEMENT_TIMEOUT_MS = statementTimeoutOriginal;
    }
  });

  /**
   * A pool is a module singleton, and its options are read once, when the
   * singleton is built. Every test starts here so each one pins the deadline
   * posture it asserts against: close the previous pool, set the env override
   * the test needs, and let the next getSql() build a fresh client.
   */
  async function openPoolWithStatementTimeout(statementTimeoutMs: string | undefined) {
    await closeSql();
    if (statementTimeoutMs === undefined) {
      delete process.env.DATABASE_STATEMENT_TIMEOUT_MS;
    } else {
      process.env.DATABASE_STATEMENT_TIMEOUT_MS = statementTimeoutMs;
    }
    return getSql();
  }

  async function showStatementTimeout(client: SqlClient | TransactionClient) {
    const [row] = await client<{ statement_timeout: string }[]>`show statement_timeout`;
    return row?.statement_timeout;
  }

  it("fails a first query within the connect_timeout bound while the database is paused", async () => {
    // A fresh singleton holds no connection yet, so the first query has to
    // complete a whole connection attempt against a server that cannot answer.
    const sql = await openPoolWithStatementTimeout(undefined);
    const containerId = started.container.getId();
    await exec("docker", ["pause", containerId]);
    const attemptStartedAt = performance.now();
    try {
      await expect(sql`select 1 as value`).rejects.toMatchObject({ code: "CONNECT_TIMEOUT" });
      const elapsedMs = performance.now() - attemptStartedAt;
      // Well under the 30 s library default this option replaces; the deadline
      // itself is 5 s, so the margin is generous while still separating the
      // new behaviour from the old one.
      expect(elapsedMs).toBeLessThan(15_000);
    } finally {
      await exec("docker", ["unpause", containerId]);
    }
  });

  it("cancels a lock-blocked query within the statement deadline while the lock is still held", async () => {
    const sql = await openPoolWithStatementTimeout("500");
    await sql`create table if not exists db_deadlines_lock_fixture (id int primary key)`;

    // A second session holds ACCESS EXCLUSIVE on the fixture table until the
    // blocked query has settled, so only the deadline can end the wait.
    let acquireLock: () => void = () => {};
    let releaseLock: () => void = () => {};
    const lockAcquired = new Promise<void>((resolve) => {
      acquireLock = resolve;
    });
    const lockReleased = new Promise<void>((resolve) => {
      releaseLock = resolve;
    });
    const holder = postgres(databaseUrl, { max: 1 });
    const holderDone = holder.begin(async (tx) => {
      await tx`lock table db_deadlines_lock_fixture in access exclusive mode`;
      acquireLock();
      await lockReleased;
    });
    await lockAcquired;

    const queryStartedAt = performance.now();
    let raceTimer: NodeJS.Timeout | undefined;
    const stillBlocked = new Promise<"still-blocked">((resolve) => {
      raceTimer = setTimeout(() => resolve("still-blocked"), 10_000);
    });
    const outcome = await Promise.race([
      sql`select count(*) from db_deadlines_lock_fixture`.then(
        () => "resolved" as const,
        (error: unknown) => error,
      ),
      stillBlocked,
    ]);
    clearTimeout(raceTimer);

    releaseLock();
    await holderDone;
    await holder.end();

    // Resolving would mean the deadline never fired; still-blocked would mean
    // it did not settle the query inside its bound; anything else is the
    // server's cancellation, which is what the deadline produces.
    expect(outcome).not.toBe("resolved");
    expect(outcome).not.toBe("still-blocked");
    expect((outcome as { code?: string }).code).toBe("57014");
    expect(performance.now() - queryStartedAt).toBeLessThan(15_000);
  });

  it("cancels a work-pool query that exceeds the statement deadline", async () => {
    const sql = await openPoolWithStatementTimeout("500");
    const queryStartedAt = performance.now();
    await expect(sql`select pg_sleep(2)`).rejects.toMatchObject({ code: "57014" });
    expect(performance.now() - queryStartedAt).toBeLessThan(15_000);
  });

  it("puts the 30 s default deadline in force and lets a migration-shaped transaction outlive it via set local", async () => {
    const sql = await openPoolWithStatementTimeout(undefined);

    // The startup parameter took effect: the session deadline is the default
    // 30000 ms, not the server's own (0, unlimited).
    expect(await showStatementTimeout(sql)).toBe("30s");

    // The migration runner's exemption pattern: the FIRST statement inside the
    // transaction lifts the deadline for the rest of it, so long DDL runs to
    // completion. The sleep is far longer than the 30 s deadline in force
    // outside, so the transaction only completes if the exemption worked.
    const transactionStartedAt = performance.now();
    await expect(
      withTransaction(async (tx) => {
        await tx`set local statement_timeout = 0`;
        await tx`select pg_sleep(31)`;
      }),
    ).resolves.toBeUndefined();
    expect(performance.now() - transactionStartedAt).toBeGreaterThanOrEqual(30_000);

    // `set local` is transaction-scoped, so the deadline is back in force for
    // everything after the migration's transaction commits.
    expect(await showStatementTimeout(sql)).toBe("30s");
  });

  it("cancels a long statement inside a transaction that does not exempt itself", async () => {
    const sql = await openPoolWithStatementTimeout("1000");
    expect(await showStatementTimeout(sql)).toBe("1s");

    // Without `set local statement_timeout = 0` the deadline reaches
    // transaction bodies too: this is what an unexempted migration statement
    // that outran the deadline would suffer.
    await expect(
      withTransaction(async (tx) => {
        await tx`select pg_sleep(3)`;
      }),
    ).rejects.toMatchObject({ code: "57014" });
  });

  it("exempts a transaction whose first statement lifts the deadline against a tight override, without leaking the exemption", async () => {
    const sql = await openPoolWithStatementTimeout("1000");

    await expect(
      withTransaction(async (tx) => {
        await tx`set local statement_timeout = 0`;
        expect(await showStatementTimeout(tx)).toBe("0");
        await tx`select pg_sleep(2)`;
      }),
    ).resolves.toBeUndefined();

    expect(await showStatementTimeout(sql)).toBe("1s");
  });

  it("runs the prune script's own pool under a statement deadline to completion", async () => {
    // The pool only has to exist with the deadline in force: the migrations
    // and the CLI both take the shared singleton from inside their modules.
    await openPoolWithStatementTimeout("1000");
    // The schema the prune script reads; applying it under the deadline also
    // walks the migration runner's exemption path once per migration.
    await runMigrations();

    const lines: string[] = [];
    const exit = await runPruneNoopReconciliationChangesCli(["--execute", "--batch-size", "2"], {
      write: (line) => lines.push(line),
    });
    expect(exit).toBe(0);
    // The table is empty, so one empty batch and the summary are the whole
    // run: the exemption path executed end to end without failing the CLI.
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      { batch: 1, scanned: 0, deleted: 0, total: 0 },
      { executed: true, deleted: 0, matched: 0 },
    ]);
  });
});
