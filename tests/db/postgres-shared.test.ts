import postgres, { type Sql } from "postgres";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import {
  assertNoSharedProvisionSurvivors,
  resolveSharedPostgresFacts,
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
