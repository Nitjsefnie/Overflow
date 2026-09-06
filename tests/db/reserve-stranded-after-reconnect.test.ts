import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";

const database = "overflow_reserve_reconnect_test";
/** Teardown only. A wedged connection would otherwise replace a named assertion failure with a bare suite timeout. */
const cleanupTimeoutSeconds = 5;

let container: StartedTestContainer | undefined;
let databaseUrl: string;
let upstream: { host: string; port: number };

/** A port nothing is listening on, so the first connect to it is refused rather than hanging. */
async function takeFreePort(): Promise<number> {
  const probe = net.createServer();
  const port = await new Promise<number>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "object" && address !== null) {
        resolve(address.port);
        return;
      }
      reject(new Error("the probe server reported no port"));
    });
  });
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** Puts a listener on a port that had none, so the same client can fail to connect and then succeed. */
async function startForwarder(port: number, target: { host: string; port: number }): Promise<net.Server> {
  const server = net.createServer((client) => {
    const outbound = net.connect(target.port, target.host);
    const destroy = () => {
      client.destroy();
      outbound.destroy();
    };
    client.on("error", destroy);
    outbound.on("error", destroy);
    client.pipe(outbound);
    outbound.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve());
  });
  return server;
}

/**
 * Reconciliation coordination takes a connection out of its pool with `reserve()` and holds it for
 * the whole critical section, so every other coordinator's `reserve()` waits on the pool. What
 * these cases pin is that such a wait always ends. Whatever becomes of the connection a reservation
 * is queued behind — the backend is terminated under it and the pool reconnects, or the database is
 * not there to connect to at all — the caller is handed a usable connection or told why it cannot
 * have one.
 *
 * A reservation that goes missing instead does not fail: it never settles at all, and every
 * reconciliation then waits out its full lock deadline before being refused, while the work pool
 * never reserves and so keeps answering — which is what makes the service look healthy while
 * nothing reconciles.
 *
 * The second thing pinned here is what a reservation must not leave behind once it is settled. The
 * pool serves a waiting reservation by handing it the connection that has just come up; a spent
 * reservation still sitting in that queue absorbs the connection instead — nobody is served and the
 * connection is never returned to the pool — so the damage lands on the *next* caller rather than
 * the one that was lost. Both cases below therefore go on using the pool after the reservation they
 * were written for has been dealt with.
 *
 * No wall-clock margin is asserted anywhere here. Every wait is unbounded and the suite's own
 * per-test timeout is the only bound — which is exactly what a promise that never settles trips.
 */
describe("a reservation the pool cannot serve straight away", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database, user: database, password: database });
    container = started.container;
    databaseUrl = started.databaseUrl;
    upstream = { host: started.container.getHost(), port: started.container.getMappedPort(5432) };
  });

  afterAll(async () => {
    await container?.stop();
  });

  it("is handed the reconnected connection when the held backend is terminated", async () => {
    const sql = postgres(databaseUrl, { max: 1 });
    // A second client, because the pool under test has its one connection reserved throughout: the
    // termination has to arrive from a session this pool does not own.
    const admin = postgres(databaseUrl, { max: 1 });

    try {
      const held = await sql.reserve();
      const [row] = await held`select pg_backend_pid()::int as pid`;
      const pid: number = row.pid;

      // Queued rather than served: `max: 1` and `held` owns the only connection. `reserve()` pushes
      // its pseudo-query onto the pool's queue before it returns, so the termination below cannot
      // race ahead of it.
      const queued = sql.reserve().then(
        (reserved) => ({ status: "reserved" as const, reserved }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );

      // Killing the backend, rather than restarting the database, is the whole defect in three
      // seconds and with no timing race: the pool sees its connection close with work queued, which
      // is the single condition a restart spends its downtime arranging.
      await expect(admin`select pg_terminate_backend(${pid})`).resolves.toBeDefined();

      const settled = await queued;
      if (settled.status === "rejected") {
        // Settling at all is the fix, but a rejection here would be the wrong settlement: the
        // database is still up, and the reconnecting connection is the one this reservation was
        // queued for. Reported rather than swallowed, so the failure names the error.
        throw new Error(`the queued reservation rejected instead of being served: ${String(settled.error)}`);
      }

      // Served, and serving: a reservation handed a connection that cannot answer would satisfy
      // "settled" while leaving the caller exactly as stuck.
      await expect(settled.reserved`select 1 as value`).resolves.toEqual([{ value: 1 }]);

      settled.reserved.release();

      // The release is what exposes an already-settled reservation left behind on the pool's queue:
      // `release()` runs the pool's `onopen()`, which would shift it, resolve nothing, and never
      // give the connection back — so this query would join the reservation in never settling.
      await expect(sql`select 2 as value`).resolves.toEqual([{ value: 2 }]);
    } finally {
      await sql.end({ timeout: cleanupTimeoutSeconds });
      await admin.end({ timeout: cleanupTimeoutSeconds });
    }
  });

  it("rejects when its connection cannot be opened, and the next one is served once it can", async () => {
    const port = await takeFreePort();
    const sql = postgres(`postgresql://${database}:${database}@127.0.0.1:${port}/${database}`, { max: 1 });
    let forwarder: net.Server | undefined;

    try {
      // Nothing is listening yet. The reservation is held as that connection's `initial`, so the
      // refused connect rejects it through the same routes that settle an ordinary query — the
      // database being down has to reach the caller, not silence.
      const refused = await sql.reserve().then(
        (reserved) => ({ status: "reserved" as const, reserved }),
        (error: unknown) => ({ status: "rejected" as const, error }),
      );
      if (refused.status === "reserved") {
        refused.reserved.release();
        throw new Error("the reservation was served a connection although nothing was listening on the port");
      }
      // Which error carries the refusal is the driver's own vocabulary rather than behaviour a
      // caller depends on, so it is not pinned — but the rejection has to name a reason, or an
      // empty throw from inside the driver would reach the caller as an unexplained failure.
      expect(refused.error).toBeInstanceOf(Error);
      expect(String(refused.error)).toMatch(/: \S/);

      forwarder = await startForwarder(port, upstream);

      // The database is back. A reservation the pool had also kept on its queue would still be
      // sitting there, spent: this `reserve()` would open the connection, `onopen()` would shift
      // that spent reservation, resolve nothing, and leave the connection in `connecting` — so this
      // call would never settle even though the database is answering again.
      const reserved = await sql.reserve();
      await expect(reserved`select 1 as value`).resolves.toEqual([{ value: 1 }]);
      reserved.release();
    } finally {
      await sql.end({ timeout: cleanupTimeoutSeconds });
      const listening = forwarder;
      if (listening !== undefined) {
        await new Promise<void>((resolve) => listening.close(() => resolve()));
      }
    }
  });
});
