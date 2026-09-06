import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";

const originalDatabaseUrl = process.env.DATABASE_URL;
const inFlightSleepSeconds = 300;
const inFlightStatement = `select pg_sleep(${inFlightSleepSeconds})`;
let container: StartedTestContainer | undefined;
let databaseUrl: string;

/** Relay real protocol traffic, then reset the client-facing socket instead of sending a FIN. */
async function startResetProxy(target: { host: string; port: number }) {
  const clients = new Set<net.Socket>();
  const upstreams = new Set<net.Socket>();
  const server = net.createServer((client) => {
    clients.add(client);
    const upstream = net.connect(target);
    upstreams.add(upstream);
    client.on("error", () => {});
    upstream.on("error", () => client.destroy());
    client.on("close", () => {
      clients.delete(client);
      upstream.destroy();
    });
    upstream.on("close", () => {
      upstreams.delete(upstream);
      client.destroy();
    });
    client.pipe(upstream);
    upstream.pipe(client);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    port: (server.address() as net.AddressInfo).port,
    async reset() {
      expect(clients.size).toBe(1);
      await Promise.all([...clients].map((client) => new Promise<void>((resolve) => {
        client.once("close", () => resolve());
        client.resetAndDestroy();
      })));
    },
    async close() {
      for (const socket of [...clients, ...upstreams]) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

describe("closing the shared clients before a socket error", () => {
  beforeAll(async () => {
    const database = "overflow_closesql_socket_error";
    const started = await startPostgresContainer({ database, user: database, password: database });
    container = started.container;
    databaseUrl = started.databaseUrl;
  });

  afterAll(async () => {
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("settles a shutdown already waiting when the socket is reset with ECONNRESET", async () => {
    const target = new URL(databaseUrl);
    const proxy = await startResetProxy({ host: target.hostname, port: Number(target.port) });
    target.host = `127.0.0.1:${proxy.port}`;
    process.env.DATABASE_URL = target.toString();
    const sql = getSql();
    const observer = postgres(databaseUrl, { max: 1 });
    const observed: string[] = [];

    try {
      const [backend] = await sql<{ pid: number }[]>`select pg_backend_pid() as pid`;
      // Longer than the test timeout: completion cannot rescue a stranded shutdown.
      const inFlight = sql`select pg_sleep(${sql.unsafe(String(inFlightSleepSeconds))})`.then(
        () => "resolved",
        (error: { code?: string }) => {
          observed.push("query rejected");
          return error.code;
        },
      );

      await expect(observer`select 1 as value`).resolves.toEqual([{ value: 1 }]);
      let running = false;
      while (!running) {
        const rows = await observer`
          select 1 from pg_stat_activity
          where pid = ${backend!.pid} and state = 'active' and query = ${inFlightStatement}
        `;
        running = rows.length === 1;
      }

      const shutdown = closeSql();
      const shutdownRecorded = shutdown.then(
        () => observed.push("shutdown settled"),
        () => observed.push("shutdown rejected"),
      );
      // The round trip follows end()'s yield and registers shutdown before the reset.
      await expect(observer`select 1 as value`).resolves.toEqual([{ value: 1 }]);
      expect(observed).toEqual([]);

      await proxy.reset();
      // A clean FIN would exercise a different closed(hadError) arm and prove nothing here.
      await expect(inFlight).resolves.toBe("ECONNRESET");
      await expect(shutdown).resolves.toBeUndefined();
      await shutdownRecorded;
      expect(observed).toEqual(["query rejected", "shutdown settled"]);
    } finally {
      await proxy.close();
      await observer.end({ timeout: 5 });
    }
  }, 120_000);
});
