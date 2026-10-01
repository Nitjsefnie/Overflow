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
import { POST as productionRepositoryPost } from "@/app/api/repositories/route";

const expiryMigration = "046_api_token_expiry.sql";

/** The migration applied immediately before 046, whatever lands between 044 and it. */
const precedingMigration = (() => {
  const names = readdirSync(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations"),
  )
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();
  return names[names.indexOf(expiryMigration) - 1];
})();

const originalDatabaseUrl = process.env.DATABASE_URL;
let container: StartedTestContainer | undefined;
let adminSql: Sql | undefined;
let currentDatabaseUrl = "";
let externalId = 7_640_000;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "overflow_token_expiry",
    user: "overflow_token_expiry",
    password: "overflow_token_expiry",
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

describe("API token expiry in the store", () => {
  it("issues a token that resolves, bounded by the delivery window until its holder uses it", async () => {
    const sql = getSql();
    const userId = await insertUser(sql);
    const store = new PostgresApiTokenStore(sql);
    const { tokenHash } = mintApiToken();

    const issued = await store.issueToken(userId, tokenHash);

    // Read before the first use: confirming rewrites the expiry in the same
    // statement that resolves the token, so a summary taken afterwards
    // describes a different lifetime.
    expect(issued.confirmedAt).toBeNull();
    expect(issued.expiresAt).toEqual(await thirtyMinutesAfter(sql, issued.createdAt));
    await expect(store.getTokenSummary(userId)).resolves.toEqual({ ...issued, expired: false });
    await expect(store.findAccountByTokenHash(tokenHash)).resolves.toEqual({
      id: userId,
      tokenId: expect.any(String),
      role: "MEMBER",
      enforcementState: "ACTIVE",
    });
  });

  it("resolves no account for a token whose expiry has passed", async () => {
    const sql = getSql();
    const userId = await insertUser(sql);
    const store = new PostgresApiTokenStore(sql);
    const { tokenHash } = mintApiToken();
    const issued = await store.issueToken(userId, tokenHash);

    const [lapsed] = await expireTokenOf(sql, userId);

    await expect(store.findAccountByTokenHash(tokenHash)).resolves.toBeNull();
    // The panel's expired state reads this summary, so it must survive expiry.
    await expect(store.getTokenSummary(userId)).resolves.toEqual({
      ...issued,
      expiresAt: lapsed.expires_at,
      expired: true,
    });
  });

  it("decides expiry by the database clock, not the Node clock", async () => {
    const sql = getSql();
    const userId = await insertUser(sql);
    const store = new PostgresApiTokenStore(sql);
    const { tokenHash } = mintApiToken();
    await store.issueToken(userId, tokenHash);
    await expireTokenOf(sql, userId);

    // A Node clock decades behind would read the lapsed expiry as the future.
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2000-01-01T00:00:00.000Z") });
    try {
      await expect(store.findAccountByTokenHash(tokenHash)).resolves.toBeNull();
      // The panel's verdict reads the same clock as the refusal.
      await expect(store.getTokenSummary(userId)).resolves.toMatchObject({ expired: true });
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves no account for a token expiring at exactly the current instant", async () => {
    const sql = getSql();
    const userId = await insertUser(sql);
    const store = new PostgresApiTokenStore(sql);
    const { tokenHash } = mintApiToken();
    await store.issueToken(userId, tokenHash);

    // One transaction, so `now()` is the same instant in the update and the lookup.
    const [resolved, summary] = await sql.begin(async (transaction) => {
      await transaction`update api_tokens set expires_at = now() where user_id = ${userId}`;
      const inTransaction = new PostgresApiTokenStore(transaction as unknown as Sql);
      return [
        await inTransaction.findAccountByTokenHash(tokenHash),
        await inTransaction.getTokenSummary(userId),
      ] as const;
    });

    expect(resolved).toBeNull();
    // The panel's expired state agrees with the refusal at the same instant.
    expect(summary?.expired).toBe(true);
  });

  it("restarts the delivery window on regeneration after expiry", async () => {
    const sql = getSql();
    const userId = await insertUser(sql);
    const store = new PostgresApiTokenStore(sql);
    const expired = mintApiToken();
    const replacement = mintApiToken();
    await store.issueToken(userId, expired.tokenHash);
    const [lapsed] = await expireTokenOf(sql, userId);

    const reissued = await store.issueToken(userId, replacement.tokenHash);

    // A regeneration hands back a token nobody has used, so it starts the
    // window over rather than inheriting the replaced token's confirmation.
    expect(reissued.confirmedAt).toBeNull();
    expect(reissued.expiresAt).toEqual(await thirtyMinutesAfter(sql, reissued.createdAt));
    expect(reissued.expiresAt.getTime()).toBeGreaterThan(lapsed.expires_at.getTime());
    await expect(store.getTokenSummary(userId)).resolves.toEqual({ ...reissued, expired: false });
    await expect(store.findAccountByTokenHash(replacement.tokenHash)).resolves.toMatchObject({ id: userId });
    await expect(store.findAccountByTokenHash(expired.tokenHash)).resolves.toBeNull();
  });
});

describe("API token expiry for a writer that states none", () => {
  // The release still serving while a deploy builds, and a rollback target,
  // issue tokens with this exact statement: it predates the expiry column. Its
  // token arrives unconfirmed, so the default it inherits is the window.
  it("accepts the previous release's insert and gives the token the delivery window", async () => {
    const sql = getSql();
    const userId = await insertUser(sql);

    const [before] = await sql<{ now: Date }[]>`select now()`;
    const [row] = await sql<{ expires_at: Date }[]>`
      insert into api_tokens (user_id, token_hash)
      values (${userId}, ${mintApiToken().tokenHash})
      returning expires_at
    `;
    const [after] = await sql<{ now: Date }[]>`select now()`;

    expect(row.expires_at.getTime()).toBeGreaterThanOrEqual((await thirtyMinutesAfter(sql, before.now)).getTime());
    expect(row.expires_at.getTime()).toBeLessThanOrEqual((await thirtyMinutesAfter(sql, after.now)).getTime());
    expect(row.expires_at.getTime()).toBeLessThan((await ninetyDaysAfter(sql, after.now)).getTime());
  });
});

describe("API token expiry on a bearer route", () => {
  it("refuses an expired token with the same 401 as an unknown token", async () => {
    const sql = getSql();
    const userId = await insertUser(sql);
    const { token, tokenHash } = mintApiToken();
    await new PostgresApiTokenStore(sql).issueToken(userId, tokenHash);

    // Control: before expiry the credential is accepted, so the route moves on
    // to the body and refuses that instead.
    const live = await productionRepositoryPost(bearerRequest(token));
    expect(live.status).toBe(400);

    await expireTokenOf(sql, userId);
    const expired = await productionRepositoryPost(bearerRequest(token));
    const unknown = await productionRepositoryPost(bearerRequest(mintApiToken().token));

    const refusal = {
      error: { code: "UNAUTHENTICATED", message: "The supplied API token was not accepted." },
    };
    expect(expired.status).toBe(401);
    await expect(expired.json()).resolves.toEqual(refusal);
    expect(unknown.status).toBe(401);
    await expect(unknown.json()).resolves.toEqual(refusal);
  });
});

describe(`upgrading across ${expiryMigration}`, () => {
  it("gives an existing token ninety days from migration time and leaves the column not null", async () => {
    const outcome = await onNewDatabase("token_expiry_backfill", async (sql) => {
      await runMigrations({ upTo: precedingMigration });
      const userId = await insertUser(sql);
      // Generated long ago: an expiry measured from created_at would already have passed.
      await sql`
        insert into api_tokens (user_id, token_hash, created_at)
        values (${userId}, ${mintApiToken().tokenHash}, now() - interval '400 days')
      `;
      const [before] = await sql<{ now: Date }[]>`select now()`;
      // Stopped at 046: 058 clamps every existing token to the delivery window,
      // which is its own assertion, in tests/db/api-token-delivery-window.test.ts.
      await runMigrations({ upTo: expiryMigration });
      const [after] = await sql<{ now: Date }[]>`select now()`;
      const [row] = await sql<{ expires_at: Date }[]>`
        select expires_at from api_tokens where user_id = ${userId}
      `;
      const [column] = await sql<{ is_nullable: string; data_type: string }[]>`
        select is_nullable, data_type from information_schema.columns
        where table_schema = 'public' and table_name = 'api_tokens' and column_name = 'expires_at'
      `;
      return {
        expiresAt: row.expires_at,
        earliest: await ninetyDaysAfter(sql, before.now),
        latest: await ninetyDaysAfter(sql, after.now),
        column,
      };
    });

    expect(outcome.expiresAt.getTime()).toBeGreaterThanOrEqual(outcome.earliest.getTime());
    expect(outcome.expiresAt.getTime()).toBeLessThanOrEqual(outcome.latest.getTime());
    expect(outcome.column).toEqual({ is_nullable: "NO", data_type: "timestamp with time zone" });
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
    values (${externalId}, ${`token-expiry-${externalId}`})
    returning id
  `;
  return user.id;
}

async function expireTokenOf(sql: Sql, userId: string): Promise<{ expires_at: Date }[]> {
  return sql<{ expires_at: Date }[]>`
    update api_tokens set expires_at = now() - interval '1 second'
    where user_id = ${userId}
    returning expires_at
  `;
}

/** The lifetime spelled independently of the store, so the test cannot borrow its constant. */
async function ninetyDaysAfter(sql: Sql, instant: Date): Promise<Date> {
  const [row] = await sql<{ at: Date }[]>`select ${instant}::timestamptz + interval '90 days' as at`;
  return row.at;
}

/** Likewise the window an unused token is issued with. */
async function thirtyMinutesAfter(sql: Sql, instant: Date): Promise<Date> {
  const [row] = await sql<{ at: Date }[]>`select ${instant}::timestamptz + interval '30 minutes' as at`;
  return row.at;
}

function bearerRequest(token: string): Request {
  return new Request("http://overflow.test/api/repositories", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: "{}",
  });
}
