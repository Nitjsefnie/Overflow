import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let databaseUrl: string;
let observer: Sql | undefined;

interface SwitchableProxy {
  readonly port: number;
  /** Later connections are accepted and never answered — what a restarting postgres looks like. */
  blackHole(): void;
  forward(): void;
  close(): Promise<void>;
}

/**
 * A TCP relay in front of the container that can be switched between forwarding and swallowing
 * connections. A `connect_timeout` needs a server that completes the TCP handshake and then says
 * nothing; stopping the container gives `ECONNREFUSED` instead, which is a different error path.
 */
async function startSwitchableProxy(target: { host: string; port: number }): Promise<SwitchableProxy> {
  let forwarding = true;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((client) => {
    sockets.add(client);
    client.on("error", () => {});
    client.on("close", () => sockets.delete(client));
    if (!forwarding) return;

    const upstream = net.connect(target);
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.destroy();
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

  return {
    port: (server.address() as net.AddressInfo).port,
    blackHole: () => {
      forwarding = false;
    },
    forward: () => {
      forwarding = true;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

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

  it("serves a later reservation after a reconnect's connect times out", async () => {
    const upstream = new URL(databaseUrl);
    const proxy = await startSwitchableProxy({ host: upstream.hostname, port: Number(upstream.port) });
    upstream.host = `127.0.0.1:${proxy.port}`;
    const sql = postgres(upstream.toString(), { max: 1, connect_timeout: 1 });
    const record: string[] = [];

    try {
      const holder = await sql.reserve();
      const [backend] = await holder<{ pid: number }[]>`select pg_backend_pid()::integer as pid`;
      // The pool is at its bound and the only connection is reserved, so this one is queued.
      const queued = sql.reserve().then(() => "queued: served", () => "queued: refused");

      // The terminate provokes a reconnect, and the reconnect reaches a socket that accepts and
      // never answers, so its connect times out and the queued reservation is refused.
      proxy.blackHole();
      await observer!`select pg_terminate_backend(${backend!.pid})`;
      record.push(await queued);

      proxy.forward();
      const served = await sql.reserve();
      const [row] = await served<{ one: number }[]>`select 1 as one`;
      record.push(`later: ${JSON.stringify(row)}`);
      served.release();

      expect(record).toEqual(["queued: refused", `later: {"one":1}`]);
    } finally {
      await sql.end({ timeout: 0 });
      await proxy.close();
    }
  });

  it("runs a non-reserve query queued behind a terminated reserved connection exactly once", async () => {
    await observer!`create table if not exists queued_once (value text not null)`;
    await observer!`truncate queued_once`;
    const sql = postgres(databaseUrl, { max: 1 });

    try {
      const holder = await sql.reserve();
      const [backend] = await holder<{ pid: number }[]>`select pg_backend_pid()::integer as pid`;
      // The pool is at its bound and the only connection is reserved, so this insert is queued.
      // The close path hands it to the reconnect as that connection's startup query, which is
      // only safe because it takes the insert out of `queries` on the way.
      const queued = sql`insert into queued_once (value) values ('once')`.execute();

      await observer!`select pg_terminate_backend(${backend!.pid})`;
      await queued;

      // Counting over the same pool orders the count behind anything the close path left queued
      // on that connection, so a second execution is counted rather than raced.
      const [counted] = await sql<{ rows: number }[]>`select count(*)::integer as rows from queued_once`;
      expect(counted).toEqual({ rows: 1 });
    } finally {
      await sql.end({ timeout: 0 });
    }
  });

  it("ends a pool that is shutting down instead of opening it for a reservation", async () => {
    const sql = postgres(databaseUrl, { max: 1, fetch_types: false });
    // The reservation opens the pool's first connection, so it is that connection's startup
    // query; end() is called before the handshake finishes, so the pool is already shutting down
    // when the connection becomes ready. Handing it to the reserve instead of terminating it
    // leaves end() waiting on a connection nothing will close.
    const reserved = sql.reserve().then(() => "reserved", () => "refused");

    // A graceful end, so nothing tears the connection down on a deadline: it settles only once
    // every connection the pool holds has closed.
    await sql.end();

    expect(await Promise.race([reserved, Promise.resolve("still queued")])).toBe("still queued");
  });

  it("does not dispatch queued work to a connection the pool has already reclaimed", async () => {
    const record: string[] = [];
    const uncaught: string[] = [];
    const observe = (error: Error): void => {
      uncaught.push(error.message);
    };
    let reclaimed = (): void => {};
    // The pool calls this option from inside its own `onclose`, which is where it takes the
    // reservation back, and it does so before the reconnect it schedules can have run. Resuming
    // from this promise is a microtask of that same turn, so no timer has fired in between: the
    // release below lands in the window by ordering rather than by waiting for it.
    const reclaimedByPool = new Promise<void>((resolve) => {
      reclaimed = resolve;
    });
    // A short connect budget so that a wedged reconnect refuses the queued work instead of sitting
    // on the driver's thirty-second default. Nothing below asserts on how long anything took.
    const sql = postgres(databaseUrl, { max: 1, connect_timeout: 5, onclose: () => reclaimed() });

    // The dispatched write is flushed from a `setImmediate`, so a driver that writes to a socket
    // that is already gone throws where no caller can catch it and the process exits. Awaiting the
    // queries below would never see that, so it is observed directly. The listener is this test's
    // own and is removed again in the `finally`, so nothing outside it is left unguarded.
    process.on("uncaughtException", observe);
    try {
      const holder = await sql.reserve();
      const [backend] = await holder<{ pid: number }[]>`select pg_backend_pid()::integer as pid`;
      // The pool is at its bound and its only connection is reserved, so all three are queued. It
      // takes three because the close path hands the head of that queue to the reconnect as its
      // startup query: with nothing left behind it the pool would have nothing to dispatch, and
      // the release would be harmless for a reason that has nothing to do with the repair.
      //
      // Their rows are reported rather than destructured, because "resolved with no rows at all"
      // is one of the two things that go wrong here: a query dispatched onto a connection with no
      // socket is still sitting in its query slot when the replacement socket finishes its
      // handshake, and that handshake's ReadyForQuery resolves it with the empty result collected
      // so far. Which of that and the uncaught throw below a run gets is a race. Neither is
      // allowed, so both are asserted.
      const queued = [0, 1, 2].map((value) =>
        sql<{ value: number }[]>`select ${value}::integer as value`.execute().then(
          (rows) => `queued ${value}: ${rows.length === 1 ? rows[0]!.value : `${rows.length} rows`}`,
          (error: { code?: string }) => `queued ${value}: ${error.code}`,
        ));
      const held = holder`select pg_sleep(30)`.then(
        () => "held: served",
        (error: { code?: string }) => `held: ${error.code}`,
      );

      // Deliberately not awaited here: the await below has to be reached before the death is
      // processed, or the resumption lands a turn late with the reconnect already under way.
      const terminated = observer!`select pg_terminate_backend(${backend!.pid})`.execute();
      await reclaimedByPool;
      // The connection is the pool's again and has no socket. A release that hands it back a
      // second time is the pool dispatching queued work onto a dead connection.
      holder.release();

      record.push(await held, ...(await Promise.all(queued)));
      await terminated;

      expect(uncaught).toEqual([]);
      expect(record).toEqual([
        "held: CONNECTION_CLOSED",
        "queued 0: 0",
        "queued 1: 1",
        "queued 2: 2",
      ]);
    } finally {
      process.off("uncaughtException", observe);
      await sql.end({ timeout: 0 });
    }
  });

  it("does not refuse a queued query with the error that killed the connection before it", async () => {
    const sql = postgres(databaseUrl, { max: 1 });

    try {
      const holder = await sql.reserve();
      const [backend] = await holder<{ pid: number }[]>`select pg_backend_pid()::integer as pid`;
      // In flight when the backend goes, so the FATAL it sends on its way out arrives while the
      // driver is holding a query for it. A postgres error is kept until the ReadyForQuery that
      // ends that query, and a backend that has gone away never sends one.
      const held = holder`select pg_sleep(30)`.then(
        () => "held: served",
        (error: { code?: string }) => `held: ${error.code}`,
      );
      // The pool is at its bound and its only connection is reserved, so this is queued. The close
      // path hands it to the reconnect as that connection's startup query, which makes the
      // handshake's own ReadyForQuery -- the first to arrive on the *new* socket -- the one that
      // decides its fate.
      const queued = sql<{ value: number }[]>`select 1::integer as value`.execute().then(
        ([row]) => `queued: ${row!.value}`,
        (error: { code?: string }) => `queued: ${error.code}`,
      );

      await observer!`select pg_terminate_backend(${backend!.pid})`;

      // The queued query never reached the backend that died, so the death is not its answer: it
      // runs on the connection the pool opened in its place.
      expect([await held, await queued]).toEqual(["held: CONNECTION_CLOSED", "queued: 1"]);
    } finally {
      await sql.end({ timeout: 0 });
    }
  });

  it("keeps a spent reservation from taking back a connection someone else now holds", async () => {
    const sql = postgres(databaseUrl, { max: 1, fetch_types: false });

    try {
      const first = await sql.reserve();
      first.release();
      // The pool's one connection is free again, so this reservation takes that same connection.
      const second = await sql.reserve();
      // The release a caller makes twice — a `finally` that runs on a retried path, a wrapper that
      // releases what it has already released. It is spent, and the connection is no longer its
      // own to give away.
      first.release();

      let outcome = "queued";
      void sql.reserve().then(
        (reserved) => {
          outcome = "served";
          reserved.release();
        },
        () => {
          outcome = "refused";
        },
      );
      // A turn boundary rather than a duration: `setImmediate` runs once the microtask queue has
      // drained, so a reservation the pool was willing to serve has already been served by here.
      await new Promise((resolve) => setImmediate(resolve));

      // The pool is at its bound and `second` holds its only connection, so there is nothing to
      // serve a third reservation with. A spent release that put that connection back into the
      // pool's open queue hands one backend to two holders that each believe it is theirs alone.
      expect(outcome).toBe("queued");
      await expect(second<{ one: number }[]>`select 1 as one`).resolves.toEqual([{ one: 1 }]);
      second.release();
    } finally {
      await sql.end({ timeout: 0 });
    }
  });

  it("refuses every reservation queued behind a destroyed pool, not only the first", async () => {
    const sql = postgres(databaseUrl, { max: 1, fetch_types: false });
    const record: string[] = [];
    const track = (name: string, reservation: Promise<unknown>): void => {
      void reservation.then(
        () => record.push(`${name}: served`),
        (error: { code?: string }) => record.push(`${name}: ${error.code}`),
      );
    };

    // The pool is at its bound and its only connection is reserved, so both reservations below
    // are queued behind it.
    await sql.reserve();
    track("first", sql.reserve());
    track("second", sql.reserve());

    // A zero deadline destroys the pool: it terminates the connections and then drains `queries`,
    // shifting each queued item out and rejecting it, all before end() settles. The rejection
    // takes the reserve's own pseudo-query back out of `queries` by identity, which is a no-op on
    // one the drain has already shifted; a positional removal would take the *next* item out
    // instead, and the drain would stop one short of it with its caller left waiting forever.
    await sql.end({ timeout: 0 });
    // Every rejection has been issued by the time end() settles, but the handlers above record
    // them a microtask later. A macrotask turn drains the whole microtask queue, so the record
    // does not depend on how many ticks each reservation's settlement chain happens to take.
    // setImmediate is a turn boundary rather than a duration, so this is not a wall-clock margin.
    await new Promise((resolve) => setImmediate(resolve));

    expect(record).toEqual(["first: CONNECTION_DESTROYED", "second: CONNECTION_DESTROYED"]);
  });
});
