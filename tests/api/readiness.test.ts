import net from "node:net";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { closeSql, getSql } from "@/lib/db/client";
import {
  GET,
  createReadinessGetHandler,
  missingMigrations,
  type ReadinessProbeOutcome,
} from "@/app/api/readiness/route";
import { bundledMigrationNames } from "@/lib/db/migration-manifest";
import { runMigrations } from "../../scripts/migrate";
import { finalFixMigrationFixtures } from "../fixtures/migration-compatibility";
import { pendingMigrationLines, readMigrationTree } from "../../scripts/deploy-migration-status";
import { startPostgresContainer } from "../support/postgres-container";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const readinessDirectories = createOwnedTempDirectoryRegistry([
  "overflow-1055-readiness-", "overflow-1055-readiness-order-", "overflow-1055-final-fix-",
].map(prefix => path.join(tmpdir(), prefix)));


/**
 * The cap reason the handler renders when a probe outlives the structural
 * hard cap — spelled as a literal so a wording or number change fails here.
 */
const hardCapReason = "database: probe did not settle within the 3000 ms hard cap";

/**
 * Spies on console.error with a no-op implementation so a journal line never
 * reaches the runner's output; call sites restore via afterEach.
 */
function spyOnProbeJournal(): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(console, "error").mockImplementation(() => {});
}

describe("readiness endpoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers 200 ready with no-store, the exact ready body, and no journal line", async () => {
    const errorSpy = spyOnProbeJournal();
    const handler = createReadinessGetHandler({
      probe: async () => ({ status: "ready" as const }),
      now: () => 0,
    });

    const response = await handler();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ready" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("answers status-only 503 when the probe rejects, journaling the cause once", async () => {
    const errorSpy = spyOnProbeJournal();
    const handler = createReadinessGetHandler({
      probe: async () => {
        throw new Error("database unreachable");
      },
      now: () => 0,
    });

    const response = await handler();

    const reason = "database: Error: database unreachable";
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toBe(`Readiness probe failed: ${reason}`);
  });

  it("answers status-only 503 when the probe throws synchronously, journaling the cause once", async () => {
    const errorSpy = spyOnProbeJournal();
    const handler = createReadinessGetHandler({
      probe: () => {
        throw new Error("probe exploded before returning a promise");
      },
      now: () => 0,
    });

    const response = await handler();

    const reason = "database: Error: probe exploded before returning a promise";
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toBe(`Readiness probe failed: ${reason}`);
  });

  it("answers status-only 503 and journals the hard-cap reason when the probe never settles", async () => {
    const errorSpy = spyOnProbeJournal();
    const handler = createReadinessGetHandler({
      probe: () => new Promise<ReadinessProbeOutcome>(() => {}),
      now: () => 0,
    });

    // The vitest timeout is the failure mode if the hard cap is missing: this
    // await must resolve through the cap, never through the stalled probe.
    const response = await handler();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toBe(`Readiness probe failed: ${hardCapReason}`);
  });

  it("answers status-only 503 and journals the behind-schema reason a fixture outcome carries", async () => {
    const errorSpy = spyOnProbeJournal();
    const reason =
      "database: schema is behind the build; missing migrations: 058_api_token_delivery_window.sql";
    const handler = createReadinessGetHandler({
      probe: async () => ({ status: "unavailable", reason }),
      now: () => 0,
    });

    const response = await handler();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toBe(`Readiness probe failed: ${reason}`);
  });

  it("answers status-only 503 and journals the fallback for an outcome without a reason", async () => {
    const errorSpy = spyOnProbeJournal();
    const handler = createReadinessGetHandler({
      probe: async () => ({ status: "unavailable" }),
      now: () => 0,
    });

    const response = await handler();

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ status: "unavailable" });
    expect(errorSpy.mock.calls).toEqual([[
      "Readiness probe failed: database: an unavailable probe outcome arrived without a reason",
    ]]);
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
      return { status: "ready" as const };
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
      return { status: "ready" as const };
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
    const errorSpy = spyOnProbeJournal();
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
    await expect(first.json()).resolves.toEqual({ status: "unavailable" });
    await expect(second.json()).resolves.toEqual({ status: "unavailable" });
    expect(errorSpy.mock.calls).toEqual([["Readiness probe failed: database: Error: database unreachable"]]);
  });

  it("does not journal a TTL-cached failure again within its window", async () => {
    const errorSpy = spyOnProbeJournal();
    let calls = 0;
    const probe = async () => {
      calls += 1;
      return { status: "unavailable" as const, reason: "database: fixture outage" };
    };
    const handler = createReadinessGetHandler({ probe, now: () => 0 });

    const first = await handler();
    const second = await handler();

    expect(calls).toBe(1);
    expect(second.status).toBe(503);
    await expect(first.json()).resolves.toEqual({ status: "unavailable" });
    await expect(second.json()).resolves.toEqual({ status: "unavailable" });
    expect(errorSpy.mock.calls).toEqual([["Readiness probe failed: database: fixture outage"]]);
  });

  it("keeps error details out of the body and redacts credentials in the journal line", async () => {
    const errorSpy = spyOnProbeJournal();
    const handler = createReadinessGetHandler({
      probe: async () => {
        const credentials = ["overflow", "pw"].join(":");
        throw new Error(`connect failed: postgresql://${credentials}@10.0.0.9/overflow`);
      },
      now: () => 0,
    });

    const response = await handler();

    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body).toEqual({ status: "unavailable" });
    expect(errorSpy.mock.calls).toEqual([[
      "Readiness probe failed: database: Error: connect failed: postgresql://***@10.0.0.9/overflow",
    ]]);
  });

  it("does not log again when a late race loser settles after the hard cap", async () => {
    vi.useFakeTimers();
    try {
      const errorSpy = spyOnProbeJournal();
      const probe = () =>
        new Promise<ReadinessProbeOutcome>((resolve) => {
          // Settles an unavailable outcome one tick past the cap: the race's
          // late loser. A ready loser could not catch a dropped guard, which
          // only misbehaves when the loser logs.
          setTimeout(
            () => resolve({ status: "unavailable", reason: "database: late loser" }),
            3100,
          );
        });
      const handler = createReadinessGetHandler({ probe, now: () => 0 });

      const pending = handler();
      await vi.advanceTimersByTimeAsync(3000);
      const response = await pending;

      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({ status: "unavailable" });
      expect(errorSpy).toHaveBeenCalledTimes(1);

      // The loser's settlement lands: consumed without resolving or logging
      // again. Assert what the code did — the spy count and the reason —
      // never a timing value.
      await vi.advanceTimersByTimeAsync(100);
      expect(errorSpy).toHaveBeenCalledTimes(1);
      expect(errorSpy.mock.calls[0][0]).toBe(`Readiness probe failed: ${hardCapReason}`);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("missingMigrations", () => {
  it("returns every bundled name when nothing is applied", () => {
    expect(missingMigrations([])).toEqual(bundledMigrationNames);
  });

  it("returns nothing when the schema matches the build", () => {
    expect(missingMigrations(bundledMigrationNames)).toEqual([]);
  });

  it("returns exactly the missing names in bundled order", () => {
    const applied = bundledMigrationNames.filter((_, index) => index % 2 === 0);
    const expected = bundledMigrationNames.filter((name) => !applied.includes(name));
    expect(missingMigrations(applied)).toEqual(expected);
  });
});

/**
 * The production route against a real PostgreSQL — migrated, behind and ahead
 * of the build — and against a socket that accepts connections and never
 * answers: the shapes a broken deployment actually produces.
 */
describe("readiness endpoint against real databases", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;
  let container: StartedTestContainer | undefined;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "readiness_test",
      user: "readiness_test",
      password: "readiness_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    await closeSql();
    // The probe reads schema_migrations, so the empty per-suite database has
    // to be brought up to the build before any case can expect a 200.
    await runMigrations();
  });

  afterAll(async () => {
    try {
      await closeSql();
      await container?.stop();
      if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = originalDatabaseUrl;
    } finally {
      await readinessDirectories.disposeAsync();
    }
  });

  it("answers 200 through the production GET export against a real database", async () => {
    const response = await GET();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "ready" });
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("answers 503 when behind and 200 when equal or ahead without flags", async () => {
    const errorSpy = spyOnProbeJournal();
    const sql = getSql();
    const newestBundled = bundledMigrationNames[bundledMigrationNames.length - 1];
    const appliedNames = async (): Promise<string[]> =>
      (await sql<{ name: string }[]>`select name from schema_migrations`).map((row) => row.name);
    // A fresh production handler per case: the shared GET export's closure
    // keeps its cached outcome (and its single-flight) across tests, so a
    // fresh construction is what makes each case run its own probe — the
    // same reset path the black-hole test below spells out.
    const probeResult = async (): Promise<{
      status: number;
      body: { status: string };
    }> => {
      const response = await createReadinessGetHandler()();
      return { status: response.status, body: await response.json() };
    };

    // Behind: the newest bundled migration is no longer recorded applied,
    // which is the state a deploy's migrate step has not yet run against.
    await sql`delete from schema_migrations where name = ${newestBundled}`;
    expect(await appliedNames()).not.toContain(newestBundled);
    try {
      const behind = await probeResult();
      expect(behind.status).toBe(503);
      expect(behind.body).toEqual({ status: "unavailable" });
      expect(errorSpy.mock.calls).toEqual([[
        `Readiness probe failed: database: schema is behind the build; missing migrations: ${newestBundled}`,
      ]]);
    } finally {
      await sql`insert into schema_migrations (name) values (${newestBundled})`;
    }

    // Equal: restoring the ledger row returns the schema to the migrated
    // state — the migration's objects were never dropped, only its record.
    expect(await appliedNames()).toContain(newestBundled);
    const equal = await probeResult();
    expect(equal.status).toBe(200);
    expect(equal.body).toEqual({ status: "ready" });

    // An extra unflagged row keeps a rollback ready.
    const futureName = "9999_ahead_of_this_build.sql";
    await sql`insert into schema_migrations (name) values (${futureName})`;
    expect(await appliedNames()).toContain(futureName);
    const ahead = await probeResult();
    expect(ahead.status).toBe(200);
    expect(ahead.body).toEqual({ status: "ready" });

    // Clean up the bogus row: this suite's database ends in the state the
    // equal case proved, not one row ahead of it.
    await sql`delete from schema_migrations where name = ${futureName}`;
    expect(await appliedNames()).not.toContain(futureName);
  });

  it.each([
    { label: "dangerous", marker: "", ddl: "alter table readiness_items drop column note;", status: 503 },
    { label: "safe-marked", marker: "-- overflow: mixed-version safe: retained releases stopped using note\n", ddl: "alter table readiness_items drop column note;", status: 200 },
    { label: "additive", marker: "", ddl: "alter table readiness_items add column extra text;", status: 200 },
  ])("answers $status after the real runner applies an extra $label migration", async ({ marker, ddl, status }) => {
    const sql = getSql();
    const filename = "900_readiness_fixture.sql";
    const directory = await readinessDirectories.createAsync(path.join(tmpdir(), "overflow-1055-readiness-"));
    await writeFile(path.join(directory, filename), `${marker}create table readiness_items (note text);\n${ddl}`);
    try {
      await runMigrations({ directory });
      // Put data that must never reach the public response into the database.
      await sql`create table readiness_private (payload text)`;
      await sql`insert into readiness_private values (${"private fixture payload"})`;
      const errorSpy = spyOnProbeJournal();
      const previousDebug = sql.options.debug;
      const queries: string[] = [];
      // Observe statements emitted by the real client, without replacing SQL
      // or timing the response. Count only this fresh handler's probe.
      sql.options.debug = (_connection, query) => { queries.push(query); };
      let response: Response;
      try {
        response = await createReadinessGetHandler()();
      } finally {
        sql.options.debug = previousDebug;
      }
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual(status === 200 ? { status: "ready" } : { status: "unavailable" });
      expect(errorSpy.mock.calls).toEqual(status === 200 ? [] : [[
        "Readiness probe failed: database: schema has moved past migrations this build predates and cannot run against: 900_readiness_fixture.sql",
      ]]);
      expect(queries).toHaveLength(1);
    } finally {
      vi.restoreAllMocks();
      await sql`delete from schema_migrations where name = ${filename}`;
      await sql`drop table if exists readiness_items, readiness_private`;
    }
  });

  it("journals only ahead flagged filenames in applied-name order, with behind taking precedence", async () => {
    const errorSpy = spyOnProbeJournal();
    const sql = getSql();
    const directory = await readinessDirectories.createAsync(path.join(tmpdir(), "overflow-1055-readiness-order-"));
    const later = "902_later.sql";
    const earlier = "901_earlier.sql";
    const unflagged = "903_unflagged.sql";
    const newestBundled = bundledMigrationNames[bundledMigrationNames.length - 1];
    try {
      await writeFile(path.join(directory, later), "create table readiness_later (note text); alter table readiness_later drop column note;");
      await runMigrations({ directory });
      await writeFile(path.join(directory, earlier), "create table readiness_earlier (note text); alter table readiness_earlier rename column note to memo;");
      await writeFile(path.join(directory, unflagged), "select 1;");
      await runMigrations({ directory });
      const ahead = await createReadinessGetHandler()();
      expect(ahead.status).toBe(503);
      await expect(ahead.json()).resolves.toEqual({ status: "unavailable" });
      expect(errorSpy.mock.calls).toEqual([[
        "Readiness probe failed: database: schema has moved past migrations this build predates and cannot run against: 901_earlier.sql, 902_later.sql",
      ]]);
      await sql`delete from schema_migrations where name = ${newestBundled}`;
      const behind = await createReadinessGetHandler()();
      expect(behind.status).toBe(503);
      await expect(behind.json()).resolves.toEqual({ status: "unavailable" });
      expect(errorSpy.mock.calls).toEqual([
        ["Readiness probe failed: database: schema has moved past migrations this build predates and cannot run against: 901_earlier.sql, 902_later.sql"],
        [`Readiness probe failed: database: schema is behind the build; missing migrations: ${newestBundled}`],
      ]);
    } finally {
      await sql`insert into schema_migrations (name) values (${newestBundled}) on conflict do nothing`;
      await sql`delete from schema_migrations where name in (${earlier}, ${later}, ${unflagged})`;
      await sql`drop table if exists readiness_earlier, readiness_later`;
    }
  });

  it.each(finalFixMigrationFixtures)("final fix real chain $name", async ({ name, contents, shape, writerCode }) => {
    const sql = getSql();
    const directory = await readinessDirectories.createAsync(path.join(tmpdir(), "overflow-1055-final-fix-"));
    await sql`create table items (note text)`;
    await writeFile(path.join(directory, name), contents);
    const errorSpy = spyOnProbeJournal();
    try {
      const lines = pendingMigrationLines(await readMigrationTree(directory), new Set());
      await runMigrations({ directory });
      const flags = await sql`select mixed_version_review from schema_migrations where name = ${name}`;
      const response = await createReadinessGetHandler()();
      const reason = `database: schema has moved past migrations this build predates and cannot run against: ${name}`;
      const oldValue = writerCode === "23502" ? null : "old writer value";
      await expect(sql.unsafe(oldValue === null
        ? "insert into items (note) values (NULL)"
        : "insert into items (note) values ('old writer value')")).rejects.toMatchObject({ code: writerCode });
      expect.soft(lines).toEqual([`${name}\treview\t${shape}`]);
      expect.soft(flags).toEqual([{ mixed_version_review: true }]);
      expect.soft(response.status).toBe(503);
      expect.soft(await response.json()).toEqual({ status: "unavailable" });
      expect.soft(errorSpy.mock.calls).toEqual([[`Readiness probe failed: ${reason}`]]);
    } finally {
      vi.restoreAllMocks();
      await sql`drop table items`;
      await sql`delete from schema_migrations where name = ${name}`;
      await rm(directory, { recursive: true, force: true });
    }
  });

  it.each(["private customer note\nforged journal line", "900_private customer payload", "not_numbered.sql", "900_trailing.sql\n"])(
    "final fix conceals invalid flagged ledger name %s", async (name) => {
      const sql = getSql();
      await sql`insert into schema_migrations (name, mixed_version_review) values (${name}, true)`;
      const errorSpy = spyOnProbeJournal();
      try {
        const response = await createReadinessGetHandler()();
        const reason = "database: schema has moved past migrations this build predates and cannot run against: <unrecognised migration name>";
        expect(response.status).toBe(503);
        expect.soft(await response.json()).toEqual({ status: "unavailable" });
        expect.soft(errorSpy.mock.calls).toEqual([[`Readiness probe failed: ${reason}`]]);
      } finally {
        vi.restoreAllMocks();
        await sql`delete from schema_migrations where name = ${name}`;
      }
    },
  );

  it.each(["private customer payload", "true", "yes", "1"])(
    "final fix ignores drifted text flag %s without exposing cast inputs", async (flag) => {
      const sql = getSql();
      await sql`alter table schema_migrations rename column mixed_version_review to saved_review`;
      await sql`alter table schema_migrations add column mixed_version_review text`;
      await sql`insert into schema_migrations (name, mixed_version_review) values ('900_drifted.sql', ${flag})`;
      const errorSpy = spyOnProbeJournal();
      try {
        const response = await createReadinessGetHandler()();
        expect.soft(response.status).toBe(200);
        expect.soft(await response.json()).toEqual({ status: "ready" });
        expect.soft(errorSpy.mock.calls).toEqual([]);
      } finally {
        vi.restoreAllMocks();
        await sql`delete from schema_migrations where name = '900_drifted.sql'`;
        await sql`alter table schema_migrations drop column mixed_version_review`;
        await sql`alter table schema_migrations rename column saved_review to mixed_version_review`;
      }
    },
  );

  it("answers 200 against an actual old ledger without the verdict column", async () => {
    const sql = getSql();
    // Preserve the fully migrated schema, but replace its ledger with the
    // pre-change shape rather than stubbing the query's result.
    await sql`alter table schema_migrations rename to saved_schema_migrations`;
    try {
      await sql`create table schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
      await sql`insert into schema_migrations (name) select name from saved_schema_migrations`;
      const response = await createReadinessGetHandler()();
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ status: "ready" });
    } finally {
      await sql`drop table schema_migrations`;
      await sql`alter table saved_schema_migrations rename to schema_migrations`;
    }
  });

  it("settles the real probe query at 2000 ms and not before", async () => {
    const sql = getSql();
    const holder = await sql.reserve();
    await holder`begin`;
    await holder`lock table schema_migrations in access exclusive mode`;
    const errorSpy = spyOnProbeJournal();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      let settled = false;
      const response = createReadinessGetHandler()().then((value) => { settled = true; return value; });
      await vi.advanceTimersByTimeAsync(1999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);
      const result = await response;
      const reason = "database: Error: probe query exceeded its 2000 ms budget";
      expect(result.status).toBe(503);
      await expect(result.json()).resolves.toEqual({ status: "unavailable" });
      expect(errorSpy.mock.calls).toEqual([[`Readiness probe failed: ${reason}`]]);
    } finally {
      vi.useRealTimers();
      vi.restoreAllMocks();
      await holder`rollback`;
      holder.release();
    }
    expect((await createReadinessGetHandler()()).status).toBe(200);
  });

  it("answers 503 against a black-holed socket and bounds concurrent probes to one connection", async () => {
    const errorSpy = spyOnProbeJournal();
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
      const credentials = ["probe", "probe"].join(":");
      process.env.DATABASE_URL = `postgresql://${credentials}@127.0.0.1:${port}/probe`;
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
      expect(errorSpy.mock.calls).toEqual([[
        "Readiness probe failed: database: Error: probe query exceeded its 2000 ms budget",
      ]]);
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
