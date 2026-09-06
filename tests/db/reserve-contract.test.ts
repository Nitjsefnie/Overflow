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
});
