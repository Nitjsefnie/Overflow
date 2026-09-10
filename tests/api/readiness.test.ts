import net from "node:net";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeSql } from "@/lib/db/client";
import { GET, createReadinessGetHandler, type Readiness } from "@/app/api/readiness/route";
import { startPostgresContainer } from "../support/postgres-container";

describe("readiness endpoint", () => {
  it("answers 200 ready with no-store when the probe succeeds", async () => {
    const handler = createReadinessGetHandler({ probe: async () => "ready", now: () => 0 });

    const response = await handler();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ready" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 503 unavailable when the probe rejects", async () => {
    const handler = createReadinessGetHandler({
      probe: async () => "unavailable",
      now: () => 0,
    });

    const response = await handler();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 503 unavailable when the probe throws synchronously", async () => {
    const handler = createReadinessGetHandler({
      probe: () => {
        throw new Error("probe exploded before returning a promise");
      },
      now: () => 0,
    });

    const response = await handler();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
  });

  it("answers 503 when the probe never settles, through the structural hard cap", async () => {
    const handler = createReadinessGetHandler({
      probe: () => new Promise<Readiness>(() => {}),
      now: () => 0,
    });

    // The vitest timeout is the failure mode if the hard cap is missing: this
    // await must resolve through the cap, never through the stalled probe.
    const response = await handler();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
  });

  it("serves twenty concurrent requests from a single in-flight probe", async () => {
    let started!: () => void;
    const firstProbeStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const probe = async () => {
      calls += 1;
      started();
      await gate;
      return "ready" as const;
    };
    const handler = createReadinessGetHandler({ probe, now: () => 0 });

    const pending = Array.from({ length: 20 }, () => handler());
    await firstProbeStart;
    expect(calls).toBe(1);
    release();
    const responses = await Promise.all(pending);

    expect(calls).toBe(1);
    expect(responses).toHaveLength(20);
    for (const response of responses) {
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "ready" });
    }
  });

  it("serves a completed result from the TTL cache and re-probes after expiry", async () => {
    let clock = 0;
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return "ready" as const;
    };
    const handler = createReadinessGetHandler({ probe, now: () => clock });

    await handler();
    clock = 2999;
    const cached = await handler();
    expect(calls).toBe(1);
    expect(cached.status).toBe(200);

    const expiredHandler = createReadinessGetHandler({ probe, now: () => clock });
    const before = calls;
    clock = 6000;
    await expiredHandler();
    clock = 9001;
    await expiredHandler();
    expect(calls - before).toBe(2);
  });

  it("serves a cached failure the same as a cached success within its window", async () => {
    let calls = 0;
    const probe = async () => {
      calls += 1;
      throw new Error("database unreachable");
    };
    const handler = createReadinessGetHandler({ probe, now: () => 0 });

    const first = await handler();
    const second = await handler();

    expect(calls).toBe(1);
    expect(first.status).toBe(503);
    expect(second.status).toBe(503);
    await expect(second.json()).resolves.toEqual({ status: "unavailable" });
  });
});

/**
 * The production route against a real PostgreSQL and against a socket that
 * accepts connections and never answers — the two shapes a broken deployment
 * actually produces.
 */
describe("readiness endpoint against real databases", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let container: StartedTestContainer | undefined;

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "readiness_test",
      user: "readiness_test",
      password: "readiness_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    await closeSql();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("answers 200 through the production GET export against a real database", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ready" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 503 against a black-holed socket and bounds concurrent probes to one connection", async () => {
    let connections = 0;
    const sockets = new Set<net.Socket>();
    let sawFirstConnection!: () => void;
    const firstConnection = new Promise<void>((resolve) => {
      sawFirstConnection = resolve;
    });
    const blackHole = net.createServer((socket) => {
      connections += 1;
      sockets.add(socket);
      socket.on("error", () => {});
      sawFirstConnection();
    });
    await new Promise<void>((resolve) => blackHole.listen(0, "127.0.0.1", resolve));
    const port = (blackHole.address() as net.AddressInfo).port;

    try {
      process.env.DATABASE_URL = `postgresql://probe:probe@127.0.0.1:${port}/probe`;
      await closeSql();

      // A fresh production handler, not the shared GET export: that export's
      // closure still holds the preceding test's cached 200, whose zero-work
      // TTL hit would answer without ever probing the black-hole socket.
      // Fresh construction is the same reset path the unit tests use.
      const get = createReadinessGetHandler();
      const first = get();
      await firstConnection;
      const burst = Array.from({ length: 10 }, () => get());
      const responses = await Promise.all([first, ...burst]);

      for (const response of responses) {
        expect(response.status).toBe(503);
        await expect(response.json()).resolves.toEqual({ status: "unavailable" });
      }
      expect(connections).toBe(1);
    } finally {
      // Destroy the stalled sockets BEFORE ending the client: the pool's end()
      // waits out a live handshake, and a peer that never answers would hang
      // the shutdown — a socket close is the event that settles it.
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        blackHole.close((error) => (error ? reject(error) : resolve()));
      });
      await closeSql();
    }
  });
});
