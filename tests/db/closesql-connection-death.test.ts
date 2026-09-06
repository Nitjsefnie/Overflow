import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";

const database = "overflow_closesql_death_test";
const originalDatabaseUrl = process.env.DATABASE_URL;

let container: StartedTestContainer | undefined;

/**
 * `closeSql()` is the last thing every entry point does, and `scripts/reconcile.ts`
 * awaits it in a `finally`. A shutdown that never settles is indistinguishable from
 * work still in progress: the process simply never exits, with nothing logged.
 *
 * No wall-clock margin is asserted anywhere here. The only bound is the suite's own
 * per-test timeout, and a shutdown that never settles is exactly what trips it.
 */
describe("closing the shared clients after a backend dies mid-query", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database, user: database, password: database });
    container = started.container;
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

  it("settles even though a pooled connection lost its backend with a query in flight", async () => {
    const sql = getSql();

    // A control query, so the pool is known to hold a live connection before one is killed.
    await expect(sql`select 1 as value`).resolves.toEqual([{ value: 1 }]);

    // The backend terminates itself, so this query can only reject. The rejection is the
    // fixture rather than the subject — but that it rejected at all is asserted, because a
    // statement that somehow resolved would leave the pool healthy and make the shutdown
    // below prove nothing. Which error it carries is deliberately left open: a clean FIN
    // surfaces CONNECTION_CLOSED and a reset surfaces the socket's own error, and that
    // distinction belongs to the kernel rather than to anything under test here.
    await expect(sql`select pg_terminate_backend(pg_backend_pid())`).rejects.toThrow();

    await expect(closeSql()).resolves.toBeUndefined();
  });
});
