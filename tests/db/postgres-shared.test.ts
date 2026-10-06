import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { connect, createServer, getDefaultAutoSelectFamilyAttemptTimeout, setDefaultAutoSelectFamilyAttemptTimeout, type Socket } from "node:net";
import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, describe, expect, inject, it } from "vitest";
import {
  assertNoSharedProvisionSurvivors,
  clientSocketIsEstablished,
  lastSharedSurvivorAuditBranch,
  postgresConnectionUrl,
  readClientTcpSockets,
  resolveSharedPostgresFacts,
  sharedAuditSurvivors,
  startPostgresContainer,
} from "../support/postgres-container";

/**
 * Regression tests for the shared-postgres arrangement (issue 626): every
 * startPostgresContainer call without initScripts provisions a per-suite role
 * and database on ONE server started once per run by tests/support/
 * global-setup.ts, instead of each suite starting its own container.
 *
 * Written first (TDD): on the per-suite-container helper these fail because
 * the two databases live on two different servers, stop() really does stop,
 * and no parked failure is ever thrown.
 */

/** Suite-style options; the shared path ignores nothing we pass here. */
function start(options: { database: string; user: string; password: string }) {
  return startPostgresContainer(options);
}

describe("suites share one postgres server through startPostgresContainer", () => {
  const clients: Sql[] = [];
  const facades: { stop(): Promise<unknown> }[] = [];

  afterEach(async () => {
    while (clients.length > 0) {
      await clients.pop()!.end();
    }
  });

  afterAll(async () => {
    // GREEN: no-ops through the facade (the run's teardown owns the server).
    // RED: really stops the private containers this file started.
    for (const facade of facades.splice(0)) {
      await facade.stop();
    }
  });

  function client(url: string): Sql {
    const sql = postgres(url, { max: 1 });
    clients.push(sql);
    return sql;
  }

  it("connects through the provided port despite a stalled family attempt", async () => {
    const facts = resolveSharedPostgresFacts(inject("sharedPostgres"));
    expect(facts.host).not.toBe("localhost");
    const previousTimeout = getDefaultAutoSelectFamilyAttemptTimeout();
    let socket: Socket | undefined;
    try {
      setDefaultAutoSelectFamilyAttemptTimeout(10);
      const connectedSocket = connect({ host: facts.host, port: facts.port });
      socket = connectedSocket;
      connectedSocket.on("connectionAttempt", (_address, _port, family) => {
        if (family === 6) {
          process.nextTick(() => {
            const until = Date.now() + 100;
            while (Date.now() < until) { /* Hold the event loop past the attempt timer. */ }
          });
        }
      });

      const outcome = await new Promise<"connected" | Error>((resolve) => {
        connectedSocket.once("connect", () => resolve("connected"));
        connectedSocket.once("error", resolve);
      });
      expect(outcome).toBe("connected");
    } finally {
      socket?.destroy();
      setDefaultAutoSelectFamilyAttemptTimeout(previousTimeout);
    }
  });

  it("gives two calls two distinct databases on the one shared server", async () => {
    const first = await start({ database: "shared_first", user: "shared_first", password: "it's" });
    const second = await start({ database: "shared_second", user: "shared_second", password: "p@ss/word#1" });
    facades.push(first.container, second.container);

    const firstUrl = new URL(first.databaseUrl);
    const secondUrl = new URL(second.databaseUrl);

    // One random suffix per call, in the 8-hex shape the helper signs every
    // shared database and role with.
    expect(firstUrl.pathname).toMatch(/^\/shared_first_[0-9a-f]{8}$/);
    expect(secondUrl.pathname).toMatch(/^\/shared_second_[0-9a-f]{8}$/);
    expect(firstUrl.pathname).not.toBe(secondUrl.pathname);

    // The same server, not two private ones.
    expect(`${firstUrl.protocol}//${firstUrl.host}`).toBe(`${secondUrl.protocol}//${secondUrl.host}`);

    // Both usable, each behind its own credentials — the apostrophe and the
    // URL-hostile password exercise SQL-literal quoting and URL-encoding.
    expect(await client(first.databaseUrl)`select 1 as ok`).toEqual([{ ok: 1 }]);
    expect(await client(second.databaseUrl)`select 1 as ok`).toEqual([{ ok: 1 }]);

    // Cluster-wide system view from the first connection can see the second
    // database: one postgres cluster, two databases.
    const secondDatabaseName = secondUrl.pathname.slice(1);
    const seen = await client(first.databaseUrl)`select datname from pg_database where datname = ${secondDatabaseName}`;
    expect(seen).toEqual([{ datname: secondDatabaseName }]);
  });

  it("gives two calls with identical options distinct role names and distinct database names", async () => {
    // Guard against a constant suffix: the uniqueness contract is per call,
    // not per option set, so the same options twice must still collide on
    // nothing.
    const options = { database: "shared_twin", user: "shared_twin", password: "shared_twin" };
    const first = await start(options);
    const second = await start(options);
    facades.push(first.container, second.container);

    const firstUrl = new URL(first.databaseUrl);
    const secondUrl = new URL(second.databaseUrl);
    const firstDatabase = firstUrl.pathname.slice(1);
    const secondDatabase = secondUrl.pathname.slice(1);
    const firstRole = decodeURIComponent(firstUrl.username);
    const secondRole = decodeURIComponent(secondUrl.username);

    expect(firstDatabase).toMatch(/^shared_twin_[0-9a-f]{8}$/);
    expect(secondDatabase).toMatch(/^shared_twin_[0-9a-f]{8}$/);
    expect(firstDatabase).not.toBe(secondDatabase);
    expect(firstRole).toMatch(/^shared_twin_[0-9a-f]{8}$/);
    expect(secondRole).toMatch(/^shared_twin_[0-9a-f]{8}$/);
    expect(firstRole).not.toBe(secondRole);
  });

  it("keeps the shared server serving after a suite stops its container facade", async () => {
    const first = await start({ database: "shared_third", user: "shared_third", password: "shared_third" });
    const second = await start({ database: "shared_fourth", user: "shared_fourth", password: "shared_fourth" });
    facades.push(first.container, second.container);

    const own = client(first.databaseUrl);
    expect(await own`select 1 as before_stop`).toEqual([{ before_stop: 1 }]);

    const stopped = await first.container.stop();
    expect(stopped.getId()).toBe(first.container.getId());

    // The no-op stop must not have taken the suite's own database down.
    expect(await own`select 1 as after_stop`).toEqual([{ after_stop: 1 }]);

    // And the server still provisions new suites after that stop.
    const third = await start({ database: "shared_fifth", user: "shared_fifth", password: "shared_fifth" });
    facades.push(third.container);
    expect(await client(third.databaseUrl)`select 1 as after_stop_third`).toEqual([{ after_stop_third: 1 }]);
  });

  it("publishes the shared server's 5432 on the loopback interface only", async () => {
    const facts = resolveSharedPostgresFacts(inject("sharedPostgres"));
    const { getContainerRuntimeClient } = await import("testcontainers");
    const client = await getContainerRuntimeClient();
    const inspected = await client.container.inspect(client.container.getById(facts.containerId));
    const bindings = inspected.NetworkSettings.Ports?.["5432/tcp"] ?? [];
    expect(bindings.length).toBeGreaterThan(0);
    for (const binding of bindings) {
      expect(binding.HostIp).toBe("127.0.0.1");
    }
  });

  it("carries a per-run generated admin password in the provided facts", () => {
    const facts = resolveSharedPostgresFacts(inject("sharedPostgres"));
    // 24 random bytes, hex-encoded, generated by tests/support/global-setup.ts
    // for THIS run; the committed "overflow_shared" constant it replaces is 15
    // characters and cannot match.
    expect(facts.adminPassword).toMatch(/^[0-9a-f]{48}$/);
  });

  it("generates a per-call password when the caller omits one", async () => {
    const first = await startPostgresContainer({ database: "shared_generated", user: "shared_generated" });
    const second = await startPostgresContainer({ database: "shared_generated", user: "shared_generated" });
    facades.push(first.container, second.container);

    const firstPassword = decodeURIComponent(new URL(first.databaseUrl).password);
    const secondPassword = decodeURIComponent(new URL(second.databaseUrl).password);
    // 24 random bytes, hex-encoded, per call — not a committed constant.
    expect(firstPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(secondPassword).toMatch(/^[0-9a-f]{48}$/);
    expect(firstPassword).not.toBe(secondPassword);

    // The generated password is the role's real password: the returned URL
    // authenticates with it (a successful connect IS the proof).
    expect(await client(first.databaseUrl)`select 1 as ok`).toEqual([{ ok: 1 }]);
    expect(await client(second.databaseUrl)`select 1 as ok`).toEqual([{ ok: 1 }]);
  });

  it("throws the parked error verbatim when global setup parked a failure", () => {
    // The decision is pinned at the exported resolver: the vi.mock inject
    // override this test once used stopped working when vitest.setup.ts
    // pulled the real helper module into every worker ahead of any per-file
    // mock registration, so the mock never fired again. The inject wiring
    // around the resolver is one line and is exercised by every provisioning
    // test above.
    const parkedMessage = "docker unavailable: parked by tests/support/global-setup.ts for this run";
    expect(() => resolveSharedPostgresFacts({ error: parkedMessage })).toThrow(parkedMessage);
    expect(() => resolveSharedPostgresFacts(undefined)).toThrow(/no shared postgres was provided/);
    expect(resolveSharedPostgresFacts({ host: "127.0.0.1", port: 5432, adminUser: "u", adminPassword: "p", containerId: "c" }).host).toBe("127.0.0.1");
  });
});

/**
 * The survivor audit exists because the shared server removed the loud
 * tripwire a leaked pool used to produce: a suite that skips closeSql() now
 * hands the next file a pool still pointed at the previous suite's database,
 * and the gate scores green. The audit runs in each file's afterAll
 * (vitest.setup.ts) while this worker is still alive — globalSetup teardown
 * cannot see worker-held sockets, because vitest reaps the workers before it.
 * This file pins the audit itself against a real server.
 */
describe("the shared-provision survivor audit", () => {
  it("classifies visible TCP states and preserves strict unknowns", () => {
    const sockets = [
      { localPort: 41001, remotePort: 5432, state: 0x01 },
      { localPort: 41002, remotePort: 5432, state: 0x04 },
    ];
    expect(clientSocketIsEstablished(41001, 43000, sockets)).toBe(true);
    expect(clientSocketIsEstablished(41002, 43000, sockets)).toBe(false);
    expect(clientSocketIsEstablished(41003, 43000, sockets)).toBe(false);
    expect(clientSocketIsEstablished(null, 43000, sockets)).toBe(true);
    expect(clientSocketIsEstablished(41003, 43000, null)).toBe(true);
  });

  it("refines missing and closing sockets only after its admin socket calibrates", () => {
    const rows = [
      { usename: "live", datname: "db", client_port: 41001 },
      { usename: "closing", datname: "db", client_port: 41002 },
      { usename: "unseen", datname: "db", client_port: 41003 },
      { usename: "unknown", datname: "db", client_port: null },
    ];
    const sockets = [
      { localPort: 42000, remotePort: 43000, state: 0x01 },
      { localPort: 41001, remotePort: 5432, state: 0x01 },
      { localPort: 41002, remotePort: 5432, state: 0x04 },
    ];
    expect(sharedAuditSurvivors(rows, 42000, 43000, sockets)).toEqual([rows[0], rows[3]]);
    expect(sharedAuditSurvivors(rows, 42001, 43000, sockets)).toEqual(rows);
    expect(sharedAuditSurvivors(rows, null, 43000, sockets)).toEqual(rows);
    expect(sharedAuditSurvivors(rows, 42000, 43000, null)).toEqual(rows);
  });

  it.skipIf(process.platform !== "linux")("counts a live TCP client, then stops counting it after FIN", async () => {
    let peer: Socket | undefined;
    let client: Socket | undefined;
    const server = createServer((socket) => { peer = socket; });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

    try {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("TCP test server has no port");
      client = connect(address.port, "127.0.0.1");
      await once(client, "connect");
      if (client.localPort === undefined) throw new Error("TCP test client has no local port");
      expect(clientSocketIsEstablished(client.localPort, address.port, readClientTcpSockets())).toBe(true);

      client.end();
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline && clientSocketIsEstablished(client.localPort, address.port, readClientTcpSockets())) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(clientSocketIsEstablished(client.localPort, address.port, readClientTcpSockets())).toBe(false);
    } finally {
      client?.destroy();
      peer?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 10_000);

  it.skipIf(process.platform !== "linux")("ignores a backend frozen after its client has ended", async () => {
    const started = await startPostgresContainer({ database: "shared_audit_exiting", user: "shared_audit_exiting", password: "shared_audit_exiting" });
    const open = postgres(started.databaseUrl, { max: 1 });
    const [{ pid }] = await open<{ pid: number }[]>`select pg_backend_pid() as pid`;
    const role = decodeURIComponent(new URL(started.databaseUrl).username);
    const facts = resolveSharedPostgresFacts(inject("sharedPostgres"));
    const inspect = postgres(
      postgresConnectionUrl({ host: facts.host, port: facts.port, user: facts.adminUser, password: facts.adminPassword, database: "postgres" }),
      { max: 1 },
    );
    let stopped = false;

    try {
      execFileSync("docker", ["exec", "-i", started.container.getId(), "kill", "-STOP", String(pid)]);
      stopped = true;
      const status = execFileSync("docker", ["exec", "-i", started.container.getId(), "cat", `/proc/${pid}/status`], { encoding: "utf8" });
      expect(status).toMatch(/^State:\s+T\s/m);

      await open.end({ timeout: 0 });
      await expect(assertNoSharedProvisionSurvivors()).resolves.toBeUndefined();
      expect(lastSharedSurvivorAuditBranch()).toBe("calibrated");
    } finally {
      if (stopped) {
        execFileSync("docker", ["exec", "-i", started.container.getId(), "kill", "-CONT", String(pid)]);
      }
      try {
        const deadline = Date.now() + 10_000;
        let remaining = 1;
        while (Date.now() < deadline) {
          [{ remaining }] = await inspect<{ remaining: number }[]>`
            select count(*)::integer as remaining from pg_stat_activity
            where usename = ${role}
          `;
          if (remaining === 0) break;
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        expect(remaining).toBe(0);
      } finally {
        await inspect.end({ timeout: 5 });
        await open.end({ timeout: 0 });
      }
    }
  }, 30_000);

  it("throws while this file's provisioned role still holds a client, and passes once it is closed", async () => {
    const started = await startPostgresContainer({ database: "shared_audit", user: "shared_audit", password: "shared_audit" });

    // Managed locally, not through client(): afterEach would end it before
    // the second half of this case can observe the clean audit.
    const open = postgres(started.databaseUrl, { max: 1 });
    await open`select 1 as held`;

    await expect(assertNoSharedProvisionSurvivors()).rejects.toThrow(/survivor audit/);

    await open.end({ timeout: 5 });
    await expect(assertNoSharedProvisionSurvivors()).resolves.toBeUndefined();
  }, 30_000);
});
