import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let databaseUrl: string;

describe("outstanding reservations when the client ends", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "reserve_end",
      user: "reserve_end",
      password: "reserve_end",
    });
    container = started.container;
    databaseUrl = started.databaseUrl;
  });

  afterAll(async () => {
    await container?.stop();
  });

  it("and the shutdown that races it both settle when the client is ending", async () => {
    const sql = postgres(databaseUrl, { max: 1 });

    // A reservation and a shutdown issued in the same tick, on a pool with nothing connected yet:
    // the reservation is still in flight when the shutdown begins. That is the window `closeSql()`
    // races in production, reached here with no timing left to chance because a pool with no open
    // connection cannot serve a reservation before it has finished connecting.
    const reserving = sql.reserve().then(
      (reserved) => ({ status: "reserved" as const, reserved }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    // No timeout, exactly as `closeSql()` calls it: nothing but the connections themselves can
    // settle this, so a client that serves the reservation and says nothing about the shutdown
    // strands it — the defect the patch's first hunk already exists to fix, by another door.
    const ending = sql.end();

    // The shutdown itself has to complete. Unbounded, and the only wait in this test that can trip
    // the suite timeout.
    await expect(ending).resolves.toBeUndefined();

    // What the reservation had done by the time the shutdown completed — asserted as an ordering
    // between two events rather than as an elapsed time, so there is no clock here and nothing for
    // a slow machine to fail. Racing an already-settled `ending` is what turns "never settles" into
    // a sentence: a reservation still pending loses the race and is named below, where waiting on
    // it directly would leave the next reader a bare 120-second suite timeout to interpret.
    const shutdownFinishedFirst = { status: "pending" as const };
    const settled = await Promise.race([reserving, ending.then(() => shutdownFinishedFirst)]);
    if (settled.status === "pending") {
      throw new Error(
        "the client finished shutting down with the reservation still pending: end() resolved and " +
          "nothing settled reserve(), so its caller is left waiting on a pool that no longer exists",
      );
    }
    if (settled.status === "reserved") {
      settled.reserved.release();
      throw new Error("the reservation was served a connection from a client that was shutting down");
    }
    // Rejection is the settlement a caller should see once the client is ending: the connection it
    // would have been handed is being torn down. Which error carries that is the driver's own
    // vocabulary rather than behaviour a caller depends on, so it is not pinned — but a rejection
    // has to carry a reason, or an empty throw from inside the driver would read as a settlement.
    expect(settled.error).toBeInstanceOf(Error);
    expect(String(settled.error)).toMatch(/: \S/);
  });

  it("rejects both queued reservations before shutdown completes when the held backend dies", async () => {
    const sql = postgres(databaseUrl, { max: 1 });
    const admin = postgres(databaseUrl, { max: 1 });

    try {
      const held = await sql.reserve();
      const [row] = await held`select pg_backend_pid()::int as pid`;

      // The only connection is held, so both reservations synchronously enter the queue.
      // A second waiter catches a disposal that settles only the head and later serves the next.
      const queued = [sql.reserve(), sql.reserve()].map((reservation) => reservation.then(
        (reserved) => ({ status: "reserved" as const, reserved }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      ));
      const ending = sql.end();

      await expect(admin`select pg_terminate_backend(${row.pid}) as terminated`).resolves.toEqual([
        { terminated: true },
      ]);
      await expect(ending).resolves.toBeUndefined();

      // The shutdown is the observation boundary, not a timer: neither a pending waiter nor
      // a waiter served from the closing client is acceptable. Rejection by this boundary also
      // prevents a later reconnect from handing either caller a live connection after end().
      const shutdownFinishedFirst = { status: "pending" as const };
      const settled = await Promise.all(queued.map((reservation) => Promise.race([
        reservation,
        ending.then(() => shutdownFinishedFirst),
      ])));

      for (const result of settled) {
        if (result.status === "reserved") result.reserved.release();
      }
      expect(settled.map((result) => result.status), "queued reservations A and B at shutdown").toEqual([
        "rejected",
        "rejected",
      ]);
      for (const result of settled) {
        if (result.status === "rejected") {
          expect(result.error).toBeInstanceOf(Error);
          expect(String(result.error)).toMatch(/: \S/);
        }
      }
    } finally {
      await sql.end();
      await admin.end();
    }
  });
});
