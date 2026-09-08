import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let databaseUrl: string;
let observer: postgres.Sql;
const clients: postgres.Sql[] = [];

// An observation window, as in issue 226's probe: end() itself has no timeout or
// forced disconnect to settle it. Keep the server reachable until assertions finish.
async function observe<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(
        (value) => ({ status: "resolved" as const, value }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ),
      new Promise<{ status: "pending" }>((resolve) => {
        timer = setTimeout(() => resolve({ status: "pending" }), 20_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
    const [shutdown, reserved] = await Promise.all([observe(ending), observe(reservation)]);

    await expect(observer`select 1 as value`).resolves.toEqual([{ value: 1 }]);
    expect({ shutdown: shutdown.status, reservation: reserved.status }).toEqual({
      shutdown: "resolved",
      reservation: "rejected",
    });
    if (reserved.status === "rejected") {
      expect(reserved.error).toMatchObject({ code: "CONNECTION_ENDED" });
    }
  });

  it("closes a reservation released after shutdown has begun", async () => {
    const sql = postgres(databaseUrl, { max: 2 });
    clients.push(sql);
    await expect(sql`select 1 as value`).resolves.toEqual([{ value: 1 }]);
    const held = await sql.reserve();
    const [{ pid }] = await held<{ pid: number }[]>`select pg_backend_pid()::int as pid`;

    const ending = sql.end();
    const shutdown = observe(ending);
    // Reproduce the issue's held-across-end ordering. The completed observer round
    // trip also proves shutdown's initial microtask ran before the release.
    await delay(500);
    await expect(observer`select 1 as value`).resolves.toEqual([{ value: 1 }]);
    held.release();

    const result = await shutdown;
    await expect(observer`select 1 as value`).resolves.toEqual([{ value: 1 }]);
    expect({ shutdown: result.status, reservation: "released" }).toEqual({
      shutdown: "resolved",
      reservation: "released",
    });
    // Promise settlement alone is insufficient: release must also close the backend.
    await expect.poll(async () => {
      const rows = await observer`select pid from pg_stat_activity where pid = ${pid}`;
      return rows.length;
    }, { timeout: 5_000 }).toBe(0);
  });
});
