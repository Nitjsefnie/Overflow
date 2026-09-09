import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let databaseUrl: string;
let observer: postgres.Sql;
const clients: postgres.Sql[] = [];

describe("reservations around shutdown of a reachable pool", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      name: "issue226-pg",
      database: "reserve_shutdown",
      user: "reserve_shutdown",
      password: "reserve_shutdown",
    });
    container = started.container;
    databaseUrl = started.databaseUrl;
    observer = postgres(databaseUrl, { max: 1 });
    await expect(observer`select 1 as value`).resolves.toEqual([{ value: 1 }]);
  });

  afterAll(async () => {
    await observer?.end({ timeout: 0 });
    // Only teardown may disconnect a stranded reservation on a failing build.
    await container?.stop();
    await Promise.all(clients.map((sql) => sql.end({ timeout: 0 })));
  });

  it("refuses a same-tick reservation and completes shutdown", async () => {
    const sql = postgres(databaseUrl, { max: 2 });
    clients.push(sql);
    await expect(sql`select 1 as value`).resolves.toEqual([{ value: 1 }]);

    // No await between these calls: reserve() must see shutdown on entry, before
    // end()'s first microtask can run. Holding an incorrectly served reservation
    // exposes the hang instead of repairing it with release() from the test.
    const ending = sql.end();
    const reservation = sql.reserve();
    // Settled, not raced against a window: both outcomes are asserted below, and a
    // wall-clock cap here would fail only when the machine ran correct code slower.
    const [shutdown, reserved] = await Promise.allSettled([ending, reservation]);

    await expect(observer`select 1 as value`).resolves.toEqual([{ value: 1 }]);
    expect({ shutdown: shutdown.status, reservation: reserved.status }).toEqual({
      shutdown: "fulfilled",
      reservation: "rejected",
    });
    if (reserved.status === "rejected") {
      expect(reserved.reason).toMatchObject({ code: "CONNECTION_ENDED" });
    }
  });

  it("closes a reservation released after shutdown has begun", async () => {
    const sql = postgres(databaseUrl, { max: 2 });
    clients.push(sql);
    await expect(sql`select 1 as value`).resolves.toEqual([{ value: 1 }]);
    const held = await sql.reserve();
    const [{ pid }] = await held<{ pid: number }[]>`select pg_backend_pid()::int as pid`;

    const shutdown = sql.end();
    // Reproduce the issue's held-across-end ordering. The completed observer round trip
    // proves shutdown's initial microtask ran before the release, without any fixed
    // sleep standing in for it: end()'s continuation is queued as microtasks of the
    // turn that called end(), and a database round trip spans event-loop turns of real
    // I/O, so those microtasks have always run by the time one completes.
    await expect(observer`select 1 as value`).resolves.toEqual([{ value: 1 }]);
    held.release();

    await shutdown;
    await expect(observer`select 1 as value`).resolves.toEqual([{ value: 1 }]);
    // Promise settlement alone is insufficient: release must also close the backend.
    // Waited on as a condition, unboundedly: a fixed budget here would fail only when
    // the machine ran the same correct code slower, and the runner's own test timeout
    // -- not this suite -- is the backstop for a build that never closes the backend.
    for (;;) {
      const rows = await observer`select pid from pg_stat_activity where pid = ${pid}`;
      if (rows.length === 0) break;
      await delay(50);
    }
  });
});
