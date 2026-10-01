import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { mintApiToken } from "@/lib/security/api-token";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

const deliveryWindowMigration = "057_api_token_delivery_window.sql";

/** The migration applied immediately before 057, whatever lands between 056 and it. */
const precedingMigration = (() => {
  const names = readdirSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations"),
  )
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  const index = names.indexOf(deliveryWindowMigration);
  return index > 0 ? names[index - 1] : undefined;
})();

const originalDatabaseUrl = process.env.DATABASE_URL;
let container: StartedTestContainer | undefined;
let adminSql: Sql | undefined;
let currentDatabaseUrl = "";
let externalId = 7_649_000;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "overflow_token_delivery_window",
    user: "overflow_token_delivery_window",
    password: "overflow_token_delivery_window",
  });
  container = started.container;
  currentDatabaseUrl = started.databaseUrl;
  adminSql = postgres(currentDatabaseUrl, { max: 1 });
  process.env.DATABASE_URL = currentDatabaseUrl;
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await adminSql?.end();
  await container?.stop();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe("the API token delivery window", () => {
  it("bounds an issued token to the delivery window until its holder uses it", async () => {
    const sql = getSql();
    const userId = await insertUser(sql);
    const store = new PostgresApiTokenStore(sql);

    const issued = await store.issueToken(userId, mintApiToken().tokenHash);

    expect(issued.confirmedAt).toBeNull();
    expect(issued.expiresAt).toEqual(await thirtyMinutesAfter(sql, issued.createdAt));
    await expect(store.getTokenSummary(userId)).resolves.toEqual({
      ...issued, confirmedAt: null, expired: false,
    });
  });

  it("starts the ninety-day lifetime at the first request that authenticates with the value", async () => {
    const sql = getSql();
    const userId = await insertUser(sql);
    const store = new PostgresApiTokenStore(sql);
    const tokenHash = mintApiToken().tokenHash;
    const issued = await store.issueToken(userId, tokenHash);

    await expect(store.findAccountByTokenHash(tokenHash)).resolves.toMatchObject({ id: userId });

    const row = await tokenRow(sql, userId);
    expect(row.confirmed_at).toBeInstanceOf(Date);
    // Measured from the recorded confirmation, not from the Node clock and not
    // from issuance: an unconfirmed token's window is not its lifetime.
    expect(row.expires_at).toEqual(await ninetyDaysAfter(sql, row.confirmed_at as Date));
    expect(row.expires_at.getTime()).toBeGreaterThan(issued.expiresAt.getTime());
    await expect(store.getTokenSummary(userId)).resolves.toEqual({
      createdAt: issued.createdAt, expiresAt: row.expires_at, confirmedAt: row.confirmed_at, expired: false,
    });
  });

  it("leaves a confirmed token's expiry alone however often it authenticates", async () => {
    const sql = getSql();
    const userId = await insertUser(sql);
    const store = new PostgresApiTokenStore(sql);
    const tokenHash = mintApiToken().tokenHash;
    await store.issueToken(userId, tokenHash);
    await store.findAccountByTokenHash(tokenHash);
    const first = await tokenRow(sql, userId);

    // Past the throttle, so the second lookup's statement really runs and can
    // be caught rolling the expiry forward.
    await sql`update api_tokens set last_used_at = now() - interval '2 minutes' where user_id = ${userId}`;
    await expect(store.findAccountByTokenHash(tokenHash)).resolves.toMatchObject({ id: userId });

    const second = await tokenRow(sql, userId);
    expect(second.confirmed_at).toEqual(first.confirmed_at);
    expect(second.expires_at).toEqual(first.expires_at);
    expect(second.expires_at).toEqual(await ninetyDaysAfter(sql, first.confirmed_at as Date));
  });

  it("extends the expiry once when the first two uses race each other", async () => {
    const sql = getSql();
    const userId = await insertUser(sql);
    const tokenHash = mintApiToken().tokenHash;
    await new PostgresApiTokenStore(sql).issueToken(userId, tokenHash);
    // Both statements would write on an unthrottled row, which is the race.
    await sql`update api_tokens set last_used_at = null where user_id = ${userId}`;

    const racers = [postgres(currentDatabaseUrl, { max: 1 }), postgres(currentDatabaseUrl, { max: 1 })];
    try {
      await Promise.all(
        racers.map((racer) => new PostgresApiTokenStore(racer).findAccountByTokenHash(tokenHash)),
      );
    } finally {
      await Promise.all(racers.map((racer) => racer.end()));
    }

    const row = await tokenRow(sql, userId);
    // Whichever statement won, the expiry is ninety days from the instant that
    // statement recorded — never ninety days from a later one.
    expect(row.confirmed_at).toBeInstanceOf(Date);
    expect(row.expires_at).toEqual(await ninetyDaysAfter(sql, row.confirmed_at as Date));
  });

  it("resolves no account for an unused token whose delivery window has closed", async () => {
    const sql = getSql();
    const userId = await insertUser(sql);
    const store = new PostgresApiTokenStore(sql);
    const tokenHash = mintApiToken().tokenHash;
    await store.issueToken(userId, tokenHash);
    await closeDeliveryWindow(sql, userId);

    // A Node clock decades behind would read the closed window as the future.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2000-01-01T00:00:00.000Z") });
    try {
      await expect(store.findAccountByTokenHash(tokenHash)).resolves.toBeNull();
      await expect(store.getTokenSummary(userId)).resolves.toMatchObject({ expired: true, confirmedAt: null });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("an API token whose acknowledgement never arrived", () => {
  it("stays unconfirmed and bounded, and a retry supersedes it", async () => {
    const sql = getSql();
    const userId = await insertUser(sql);
    const store = new PostgresApiTokenStore(sql);

    // The mint is committed and the response is lost. Destructuring the hash
    // alone is the whole mechanism: the plaintext is never bound to a name, so
    // no client holds a value that could present this token. The hash is all
    // that reaches the database, exactly as on the real path.
    const { tokenHash: orphanedHash } = mintApiToken();
    const issued = await store.issueToken(userId, orphanedHash);

    const orphaned = await store.getTokenSummary(userId);
    expect(orphaned).toEqual({
      createdAt: issued.createdAt, expiresAt: issued.expiresAt, confirmedAt: null, expired: false,
    });
    expect(orphaned?.expiresAt).toEqual(await thirtyMinutesAfter(sql, issued.createdAt));

    // Nobody has used it, so it authenticates nobody once its window closes —
    // the credential cannot outlive the acknowledgement it never got.
    await closeDeliveryWindow(sql, userId);
    await expect(store.findAccountByTokenHash(orphanedHash)).resolves.toBeNull();

    // The retry a client that never received the value would make.
    const retryHash = mintApiToken().tokenHash;
    await store.issueToken(userId, retryHash);

    const retried = await store.getTokenSummary(userId);
    expect(retried?.confirmedAt).toBeNull();
    expect(retried?.expiresAt).toEqual(await thirtyMinutesAfter(sql, retried?.createdAt as Date));

    await expect(store.findAccountByTokenHash(retryHash)).resolves.toMatchObject({ id: userId });
    // The orphan is not live behind the retry: it was superseded, not shadowed.
    await expect(store.findAccountByTokenHash(orphanedHash)).resolves.toBeNull();
  });
});

describe(`upgrading across ${deliveryWindowMigration}`, () => {
  it("confirms a token carrying use evidence and clamps only the one carrying none", async () => {
    const outcome = await onNewDatabase("token_delivery_window_backfill", async (sql) => {
      await runMigrations({ upTo: precedingMigration });
      const usedUserId = await insertUser(sql);
      const untouchedUserId = await insertUser(sql);
      // Neither names an expiry, so each takes the default this release
      // inherits before the migration below changes it.
      const [used] = await sql<{ expires_at: Date }[]>`
        insert into api_tokens (user_id, token_hash, last_used_at)
        values (${usedUserId}, ${mintApiToken().tokenHash}, now() - interval '2 hours')
        returning expires_at
      `;
      await sql`
        insert into api_tokens (user_id, token_hash)
        values (${untouchedUserId}, ${mintApiToken().tokenHash})
      `;
      const [before] = await sql<{ now: Date }[]>`select now()`;
      await runMigrations();
      const [after] = await sql<{ now: Date }[]>`select now()`;
      const [usedAfter] = await sql<
        { expires_at: Date; confirmed_at: Date | null; last_used_at: Date | null }[]
      >`
        select expires_at, confirmed_at, last_used_at from api_tokens where user_id = ${usedUserId}
      `;
      const [untouched] = await sql<{ expires_at: Date; confirmed_at: Date | null }[]>`
        select expires_at, confirmed_at from api_tokens where user_id = ${untouchedUserId}
      `;
      const [column] = await sql<{ is_nullable: string; data_type: string; column_default: string | null }[]>`
        select is_nullable, data_type, column_default from information_schema.columns
        where table_schema = 'public' and table_name = 'api_tokens' and column_name = 'confirmed_at'
      `;
      return {
        usedExpiresAtBefore: used.expires_at,
        usedAfter,
        untouched,
        earliest: await thirtyMinutesAfter(sql, before.now),
        latest: await thirtyMinutesAfter(sql, after.now),
        column,
      };
    });

    expect(outcome.column).toEqual({
      is_nullable: "YES", data_type: "timestamp with time zone", column_default: null,
    });
    // A stamp on this row is a use of the value it currently holds: the
    // regeneration that replaces a value clears last_used_at in the same
    // statement. So this one is not an orphan, and its ninety days stand.
    expect(outcome.usedAfter.confirmed_at).toEqual(outcome.usedAfter.last_used_at);
    expect(outcome.usedAfter.expires_at).toEqual(outcome.usedExpiresAtBefore);
    // No stamp at all is the defect's exact population: a token nobody has
    // used since it was minted, which takes the delivery window.
    expect(outcome.untouched.confirmed_at).toBeNull();
    expect(outcome.untouched.expires_at.getTime()).toBeGreaterThanOrEqual(outcome.earliest.getTime());
    expect(outcome.untouched.expires_at.getTime()).toBeLessThanOrEqual(outcome.latest.getTime());
  });

  it("gives a writer that names no expiry the delivery window, not the lifetime", async () => {
    const outcome = await onNewDatabase("token_delivery_window_default", async (sql) => {
      await runMigrations();
      const userId = await insertUser(sql);
      const [before] = await sql<{ now: Date }[]>`select now()`;
      // The release this migration has to keep working: no expires_at named,
      // which is the insert 046 gave a default to.
      const [row] = await sql<{ expires_at: Date; confirmed_at: Date | null }[]>`
        insert into api_tokens (user_id, token_hash)
        values (${userId}, ${mintApiToken().tokenHash})
        returning expires_at, confirmed_at
      `;
      const [after] = await sql<{ now: Date }[]>`select now()`;
      const [expiryColumn] = await sql<{ is_nullable: string }[]>`
        select is_nullable from information_schema.columns
        where table_schema = 'public' and table_name = 'api_tokens' and column_name = 'expires_at'
      `;
      return {
        expiresAt: row.expires_at,
        confirmedAt: row.confirmed_at,
        isNullable: expiryColumn.is_nullable,
        earliest: await thirtyMinutesAfter(sql, before.now),
        latest: await thirtyMinutesAfter(sql, after.now),
        lifetime: await ninetyDaysAfter(sql, before.now),
      };
    });

    // Not null with a default is what lets that insert through at all; the
    // value is what stops it minting an unconfirmed credential with a lifetime.
    expect(outcome.isNullable).toBe("NO");
    expect(outcome.confirmedAt).toBeNull();
    expect(outcome.expiresAt.getTime()).toBeGreaterThanOrEqual(outcome.earliest.getTime());
    expect(outcome.expiresAt.getTime()).toBeLessThanOrEqual(outcome.latest.getTime());
    expect(outcome.expiresAt.getTime()).toBeLessThan(outcome.lifetime.getTime());
  });
});

/** Runs `body` against a database of its own, then points the shared client back at the suite's. */
async function onNewDatabase<T>(databaseName: string, body: (sql: Sql) => Promise<T>): Promise<T> {
  if (adminSql === undefined) {
    throw new Error("The admin connection is not open.");
  }
  await adminSql`create database ${adminSql(databaseName)}`;
  const url = new URL(currentDatabaseUrl);
  url.pathname = `/${databaseName}`;
  await closeSql();
  process.env.DATABASE_URL = url.toString();
  try {
    return await body(getSql());
  } finally {
    await closeSql();
    process.env.DATABASE_URL = currentDatabaseUrl;
  }
}

async function insertUser(sql: Sql): Promise<string> {
  externalId += 1;
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${externalId}, ${`token-delivery-window-${externalId}`})
    returning id
  `;
  return user.id;
}

async function tokenRow(sql: Sql, userId: string): Promise<{ expires_at: Date; confirmed_at: Date | null }> {
  const [row] = await sql<{ expires_at: Date; confirmed_at: Date | null }[]>`
    select expires_at, confirmed_at from api_tokens where user_id = ${userId}
  `;
  return row;
}

/** Past the window, by the database clock, the way the store's own predicate reads it. */
async function closeDeliveryWindow(sql: Sql, userId: string): Promise<void> {
  await sql`update api_tokens set expires_at = now() - interval '1 second' where user_id = ${userId}`;
}

/** Spelled independently of the store, so a test cannot borrow its constants. */
async function thirtyMinutesAfter(sql: Sql, instant: Date): Promise<Date> {
  const [row] = await sql<{ at: Date }[]>`select ${instant}::timestamptz + interval '30 minutes' as at`;
  return row.at;
}

async function ninetyDaysAfter(sql: Sql, instant: Date): Promise<Date> {
  const [row] = await sql<{ at: Date }[]>`select ${instant}::timestamptz + interval '90 days' as at`;
  return row.at;
}