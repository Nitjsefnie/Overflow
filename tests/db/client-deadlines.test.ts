import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { startPostgresContainer, type StartedPostgres } from "../support/postgres-container";
import postgres from "postgres";
import { closeSql, getCoordinationSql, getSql, withTransaction } from "@/lib/db/client";
import type { SqlClient, TransactionClient } from "@/lib/db/types";
import { runMigrations } from "../../scripts/migrate";
import { runPruneNoopReconciliationChangesCli } from "../../scripts/prune-noop-reconciliation-changes";

const exec = promisify(execFile);

/**
 * A virtual migration this suite appends to the runner's directory listing so
 * the migration-exemption test can drive the REAL runMigrations() entry (issue
 * 661) without committing a migration: the file never touches disk, so the
 * numbering guards and every other suite's listings see only the real files.
 * Its single statement deterministically outruns the tight override the test
 * puts in force, so the runner completes only if its own `set local
 * statement_timeout = 0` exemption lifted the deadline on the real path.
 */
const migrationFixture = vi.hoisted(() => ({
  name: "999_issue661_statement_deadline_fixture.sql",
  content: "select pg_sleep(2);",
}));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (async (path: Parameters<typeof actual.readdir>[0]) => {
      const entries = await actual.readdir(path);
      return [...entries, migrationFixture.name];
    }) as unknown as typeof actual.readdir,
    readFile: (async (
      path: Parameters<typeof actual.readFile>[0],
      options?: Parameters<typeof actual.readFile>[1],
    ) => {
      if (String(path).endsWith(migrationFixture.name)) {
        return migrationFixture.content;
      }
      return options === undefined
        ? actual.readFile(path)
        : actual.readFile(path, options);
    }) as unknown as typeof actual.readFile,
  };
});

/**
 * Issue 661: the shared clients are the single choke point every database
 * connection in the process flows through, and issue 661 gives them real
 * deadlines. The posture pinned here (task 5's measurement rescoped it): the
 * WORK pool carries the statement deadline, the coordination pool carries
 * none. Properties pinned here:
 *
 * - the connect phase fails fast (connect_timeout 5 s, not the library's 30 s
 *   default) while the server is unreachable;
 * - a statement that cannot run — blocked behind a lock another session holds
 *   — is cancelled by the server inside the work pool's statement deadline;
 * - the deadline is in force by default ("30s") and a transaction may exempt
 *   itself with `set local statement_timeout = 0`, which is exactly the shape
 *   the migration runner's per-migration transaction takes, so long DDL is not
 *   killed mid-migration;
 * - the deadline reaches statement bodies inside transactions too;
 * - the coordination pool advertises no statement deadline, and a
 *   coordination statement blocked behind a lock survives the tight
 *   work-pool deadline and resolves when the holder releases.
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

  it("puts the 30 s default deadline in force and drives the real migration runner's set local exemption", async () => {
    const sql = await openPoolWithStatementTimeout(undefined);

    // The startup parameter took effect: the session deadline is the default
    // 30000 ms, not the server's own (0, unlimited).
    expect(await showStatementTimeout(sql)).toBe("30s");

    // The exemption is proven on the real path: runMigrations() itself, against
    // this suite's scratch database, with the virtual long migration appended
    // to its listing (see migrationFixture). Its pg_sleep deterministically
    // outruns the tight override in force here, so the runner only completes
    // if the `set local statement_timeout = 0` it runs as every migration
    // transaction's first statement lifted the deadline — deleting that line
    // cancels the fixture mid-sleep and fails this test.
    const tightSql = await openPoolWithStatementTimeout("1000");
    await expect(runMigrations()).resolves.toBeUndefined();

    // The fixture migration committed through the real runner: the sleep ran
    // to completion inside the exempted transaction and the runner recorded it.
    const [fixtureRow] = await tightSql<{ name: string }[]>`
      select name from schema_migrations where name = ${migrationFixture.name}
    `;
    expect(fixtureRow?.name).toBe(migrationFixture.name);

    // Control: the override really is in force on this pool after the run —
    // `set local` did not leak past the migration transactions — so the
    // exemption above was load-bearing rather than a deadline that was never
    // set. The same sleep the fixture survived is cancelled here.
    await expect(tightSql`select pg_sleep(2)`).rejects.toMatchObject({ code: "57014" });
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

  it.each([
    ["the empty string", ""],
    ["a non-numeric value", "abc"],
    ["a negative value", "-5"],
    ["zero", "0"],
  ])("refuses %s for DATABASE_STATEMENT_TIMEOUT_MS at client construction", async (_shape, invalid) => {
    // A set-but-invalid value used to flow into the startup packet as-is: the
    // empty string in particular silently disabled the deadline the default
    // exists to guarantee (issue 661). Construction is the loud failure point —
    // the pool is never built, and the error names the variable and the problem.
    await expect(openPoolWithStatementTimeout(invalid)).rejects.toThrow(
      /DATABASE_STATEMENT_TIMEOUT_MS/,
    );
  });

  it("keeps the 30000 default when DATABASE_STATEMENT_TIMEOUT_MS is unset", async () => {
    const sql = await openPoolWithStatementTimeout(undefined);
    expect(await showStatementTimeout(sql)).toBe("30s");
  });

  it("advertises no statement deadline on the coordination pool", async () => {
    // The rescope (issue 661, task 5): the work pool carries the deadline, the
    // coordination pool carries none. A coordination statement queued behind a
    // lock is a wait, not work — a deadline there could only cancel a
    // legitimate wait.
    const workPool = await openPoolWithStatementTimeout(undefined);
    expect(await showStatementTimeout(workPool)).toBe("30s");
    expect(await showStatementTimeout(getCoordinationSql())).toBe("0");
  });

  it("lets a coordination statement wait behind a lock the tight work-pool deadline would cancel", async () => {
    // Behavioral half of the same posture pin: with the work pool at 500 ms,
    // a coordination-pool statement blocked behind a held lock survives the
    // point where the deadline would have fired and completes when the holder
    // releases — under the old both-pools posture it was cancelled.
    const workPool = await openPoolWithStatementTimeout("500");
    expect(await showStatementTimeout(workPool)).toBe("500ms");
    await workPool`create table if not exists db_deadlines_coordination_fixture (id int primary key)`;

    // The holder signals the lock is taken, keeps holding through a
    // server-side sleep (1.5 s — three times the work pool's deadline), and
    // releases on its own, so the waiting coordination statement resolves
    // rather than deadlocking the test.
    const holder = postgres(databaseUrl, { max: 1 });
    let lockHeld: () => void = () => {};
    const lockHeldPromise = new Promise<void>((resolve) => { lockHeld = resolve; });
    const holderDone = (async () => {
      try {
        await holder.begin(async (tx) => {
          await tx`set local statement_timeout = 0`;
          await tx`lock table db_deadlines_coordination_fixture in access exclusive mode`;
          lockHeld();
          await tx`select pg_sleep(1.5)`;
        });
      } finally {
        await holder.end();
      }
    })();
    await lockHeldPromise;
    try {
      // Blocked for the rest of the holder's 1.5 s hold; a 500 ms deadline on
      // this pool would have cancelled it long before it could resolve.
      const [row] = await getCoordinationSql()`select count(*)::int as count from db_deadlines_coordination_fixture`;
      expect(row.count).toBe(0);
    } finally {
      await holderDone;
    }
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
