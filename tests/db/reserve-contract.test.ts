import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let databaseUrl: string;
let observer: Sql | undefined;

/**
 * `reserve()` promises a connection or an error, and the coordination pool has no way to tell a
 * reservation that will never settle from one that is merely slow — a dropped reservation reaches
 * a caller as a lock-wait deadline expiring, indistinguishable from a repository someone else
 * genuinely held for a minute.
 *
 * These drive the client directly, with array-type fetching turned off, because that is the
 * configuration in which a reserve handed to a connection as its startup query is dropped without
 * even the accidental rescue that fetching array types provides.
 */
describe("the client's reserve contract", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "reserve_contract",
      user: "reserve_contract",
      password: "reserve_contract",
    });
    container = started.container;
    databaseUrl = started.databaseUrl;
    observer = postgres(databaseUrl, { max: 2 });
  });

  afterAll(async () => {
    await observer?.end({ timeout: 0 });
    await container?.stop();
  });

  it("settles a reserve that opens the pool's first connection", async () => {
    const sql = postgres(databaseUrl, { max: 1, fetch_types: false });
    try {
      const reserved = await sql.reserve();
      const [row] = await reserved<{ one: number }[]>`select 1 as one`;
      expect(row).toEqual({ one: 1 });
      reserved.release();
    } finally {
      await sql.end({ timeout: 0 });
    }
  });

  it("settles a queued reserve when the connection it waits on is terminated", async () => {
    const sql = postgres(databaseUrl, { max: 1, fetch_types: false });
    try {
      const holder = await sql.reserve();
      const [backend] = await holder<{ pid: number }[]>`select pg_backend_pid()::integer as pid`;
      // The pool is at its bound and the only connection is reserved, so this one is queued.
      const queued = sql.reserve();

      await observer!`select pg_terminate_backend(${backend!.pid})`;

      const served = await queued;
      const [row] = await served<{ one: number }[]>`select 1 as one`;
      expect(row).toEqual({ one: 1 });
      served.release();
    } finally {
      await sql.end({ timeout: 0 });
    }
  });
});
