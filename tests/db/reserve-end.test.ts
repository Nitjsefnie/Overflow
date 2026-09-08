import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let databaseUrl: string;

type ReservationOutcome =
  | { status: "pending" }
  | { status: "reserved"; reserved: postgres.ReservedSql }
  | { status: "rejected"; error: unknown };

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
    let outcome: ReservationOutcome = { status: "pending" };
    void sql.reserve().then(
      (reserved) => { outcome = { status: "reserved", reserved }; },
      (error: unknown) => { outcome = { status: "rejected", error }; },
    );

    // No timeout, exactly as `closeSql()` calls it: nothing but the connections themselves can
    // settle this, so a client that serves the reservation and says nothing about the shutdown
    // strands it — the defect the patch's first hunk already exists to fix, by another door.
    const ending = sql.end();
    // Both observers are attached directly to the public promises before yielding. Save the
    // outcome in the shutdown callback: a race constructed after awaiting shutdown can miss
    // a rejection delivered in a later microtask of that same turn.
    const atShutdown = ending.then(() => outcome);

    // The shutdown itself has to complete. Unbounded, and the only wait in this test that can trip
    // the suite timeout.
    await expect(ending).resolves.toBeUndefined();

    const settled = await atShutdown;
    if (settled.status === "pending") {
      throw new Error(
        "the client finished shutting down before the reservation settled: " +
          "reserve() was still pending at the public end() callback",
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
      const outcomes: ReservationOutcome[] = [{ status: "pending" }, { status: "pending" }];
      outcomes.forEach((_, index) => {
        void sql.reserve().then(
          (reserved) => { outcomes[index] = { status: "reserved", reserved }; },
          (error: unknown) => { outcomes[index] = { status: "rejected", error }; },
        );
      });
      const ending = sql.end();
      // Capture before awaiting even the administrator's I/O. Copy the entries so later
      // settlement cannot change the states seen by this first public shutdown observer.
      const atShutdown = ending.then(() => outcomes.slice());

      await expect(admin`select pg_terminate_backend(${row.pid}) as terminated`).resolves.toEqual([
        { terminated: true },
      ]);
      await expect(ending).resolves.toBeUndefined();

      // These callers lose their held backend during shutdown and must be rejected by that
      // boundary. This does not constrain a holder releasing during shutdown: a waiter may
      // legitimately be served before end() completes in that different scenario.
      const settled = await atShutdown;

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

  it("rejects a reservation requested after a warmed pool has finished shutting down", async () => {
    const sql = postgres(databaseUrl, { max: 1 });

    try {
      // Open and use the pool before closing it, so admitting a later reservation would
      // resurrect a connection from a client that has already reported itself closed.
      await expect(sql`select 1 as value`).resolves.toEqual([{ value: 1 }]);
      await expect(sql.end()).resolves.toBeUndefined();

      // This is a new caller after shutdown, distinct from a waiter whose turn arrives
      // while shutdown is still in flight. Await it unbounded: silence is a failure too.
      const settled = await sql.reserve().then(
        (reserved) => ({ status: "reserved" as const, reserved }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      if (settled.status === "reserved") {
        settled.reserved.release();
        throw new Error("a reservation requested after end() resolved was served a connection");
      }
      expect(settled.error).toBeInstanceOf(Error);
      expect(String(settled.error)).toMatch(/: \S/);
    } finally {
      await sql.end();
    }
  });
});
