import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";

const database = "overflow_closesql_shutdown_test";
const originalDatabaseUrl = process.env.DATABASE_URL;

/**
 * The statement below is found again by its text in `pg_stat_activity`, so the duration it is
 * recognised by is stated once here and read from here by both the statement and the pattern.
 */
const inFlightSleepSeconds = 30;
const inFlightStatementPattern = `%pg_sleep(${inFlightSleepSeconds})%`;

/** Teardown only. A wedged observer would otherwise replace a named assertion failure with a bare suite timeout. */
const cleanupTimeoutSeconds = 5;

let container: StartedTestContainer | undefined;
let databaseUrl: string;

/**
 * The reverse order of `closesql-connection-death.test.ts`, and the order is the whole point:
 * the shutdown is registered while a query is still on the wire, and the backend running that
 * query dies afterwards.
 *
 * `end()` cannot take its fast path with a query in flight, so it hands back a promise whose
 * only resolver runs on a `ReadyForQuery` — a message a backend that has been killed never
 * sends. `scripts/reconcile.ts` awaits `closeSql()` in a `finally`, so a shutdown left in that
 * state is indistinguishable from work still in progress: the process never exits and nothing
 * is logged.
 *
 * No wall-clock margin is asserted anywhere here, and nothing is ordered by sleeping. Each step
 * is sequenced behind an observable event — a completed round trip, a row in `pg_stat_activity`
 * — and the only bound on the shutdown is the suite's own per-test timeout, which is exactly
 * what a shutdown that never settles trips.
 */
describe("closing the shared clients before the backend of an in-flight query dies", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database, user: database, password: database });
    container = started.container;
    databaseUrl = started.databaseUrl;
    process.env.DATABASE_URL = started.databaseUrl;
  });

  afterAll(async () => {
    await container?.stop();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("settles even though the shutdown was registered before the connection lost its backend", async () => {
    const sql = getSql();

    // A control query, so the pool is known to hold one live connection before it is shut down.
    await expect(sql`select 1 as value`).resolves.toEqual([{ value: 1 }]);

    // Still running when the shutdown is registered below. Its handlers are attached in the
    // expression that creates it, so the rejection that arrives once the backend is killed is
    // never an unhandled one. That rejection is a fixture rather than the subject, but it is
    // asserted at the end: a statement that somehow resolved would hand the connection back to
    // the pool and make the shutdown prove nothing. The duration is interpolated as a fragment
    // rather than as a value: a bound parameter would put `pg_sleep($1)` in `pg_stat_activity`,
    // which the pattern above would never match.
    const inFlight = sql`select pg_sleep(${sql.unsafe(String(inFlightSleepSeconds))})`.then(
      () => "resolved",
      () => "rejected",
    );

    // A second client the test owns, so the backend under test can be watched and then killed
    // from outside the pool that is being shut down.
    const observer = postgres(databaseUrl, { max: 1 });

    try {
      // The trial round trip the poll below depends on: an observer that cannot reach the
      // server fails here, by name, instead of spinning until the suite times out.
      await expect(observer`select 1 as value`).resolves.toEqual([{ value: 1 }]);

      // Ordering by observation rather than by sleeping: poll until the statement is visibly on
      // the wire, which is also what yields the pid to kill.
      let backendPid: number | undefined;
      while (backendPid === undefined) {
        const running = await observer<{ pid: number }[]>`
          select pid
          from pg_stat_activity
          where state = 'active'
            and pid <> pg_backend_pid()
            and query like ${inFlightStatementPattern}
        `;
        backendPid = running[0]?.pid;
      }

      // Registered, and deliberately not awaited yet. A rejection handler goes on immediately
      // because the shutdown stays pending across the round trips below, where a failure would
      // otherwise surface as an unhandled rejection instead of as this test's assertion.
      const shutdown = closeSql();
      void shutdown.catch(() => undefined);

      // A completed round trip on the observer, so the shutdown is known to have reached every
      // connection before anything kills a backend. `sql.end()` yields once and then calls
      // `end()` on each connection synchronously, so a full round trip cannot have finished
      // ahead of it.
      await expect(observer`select 1 as value`).resolves.toEqual([{ value: 1 }]);

      // `pg_terminate_backend` reports whether it signalled the process. A false here would mean
      // nothing was killed and the assertion below would pass for the wrong reason.
      await expect(observer`select pg_terminate_backend(${backendPid}) as terminated`).resolves.toEqual([
        { terminated: true },
      ]);

      // The assertion this test exists for, awaited unbounded.
      await expect(shutdown).resolves.toBeUndefined();

      await expect(inFlight).resolves.toBe("rejected");
    } finally {
      await observer.end({ timeout: cleanupTimeoutSeconds });
    }
  });
});
