import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { mintApiToken } from "@/lib/security/api-token";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { exportAccount } from "@/lib/accounts/export";

const originalDatabaseUrl = process.env.DATABASE_URL;
let container: StartedTestContainer | undefined;
let githubUserId = 7682100;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "overflow_token_last_used",
    user: "overflow_token_last_used",
    password: "overflow_token_last_used",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

async function issue() {
  const sql = getSql();
  githubUserId += 1;
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${`last-used-${githubUserId}`}) returning id
  `;
  const store = new PostgresApiTokenStore(sql);
  const { tokenHash } = mintApiToken();
  const summary = await store.issueToken(user.id, tokenHash);
  const [token] = await sql<{ id: string }[]>`select id from api_tokens where user_id = ${user.id}`;
  return { sql, store, tokenHash, userId: user.id, tokenId: token.id, githubUserId, summary };
}

describe("API token usage and issuance identity", () => {
  it("returns the token id and stamps first use in the lookup's single statement", async () => {
    const { sql, tokenHash, userId, tokenId } = await issue();
    await sql.begin(async (tx) => {
      const statements: string[] = [];
      const recordingSql = ((strings: TemplateStringsArray, ...values: never[]) => {
        statements.push(strings.join("?"));
        return tx(strings, ...values);
      }) as unknown as Sql;
      const resolved = await new PostgresApiTokenStore(recordingSql).findAccountByTokenHash(tokenHash);
      expect(resolved).toEqual({ id: userId, tokenId, role: "MEMBER", enforcementState: "ACTIVE" });
      expect(statements).toHaveLength(1);
      const [row] = await tx`select last_used_at = now() as stamped from api_tokens where id = ${tokenId}`;
      expect(row.stamped).toBe(true);
    });
  });

  it.each([
    ["30 seconds", false], ["1 minute", false], ["2 minutes", true],
  ])("throttles a timestamp %s old (restamp: %s)", async (age, restamp) => {
    const { sql, store, tokenHash, tokenId, userId } = await issue();
    // A confirmed token: the throttle below governs the hot auth path of a token
    // already in use, not the confirmation a token still inside its delivery
    // window needs (which is its own case, below).
    await store.findAccountByTokenHash(tokenHash);
    await sql.begin(async (tx) => {
      const [before] = await tx`
        update api_tokens set last_used_at = now() - ${age}::interval
        where id = ${tokenId} returning last_used_at
      `;
      await expect(new PostgresApiTokenStore(tx as unknown as Sql).findAccountByTokenHash(tokenHash))
        .resolves.toMatchObject({ id: userId, tokenId });
      const [after] = await tx`
        select last_used_at, last_used_at = now() as stamped from api_tokens where id = ${tokenId}
      `;
      expect(after.stamped).toBe(restamp);
      if (!restamp) expect(after.last_used_at).toEqual(before.last_used_at);
    });
  });

  it("confirms an unconfirmed token whose last stamp is inside the throttle", async () => {
    const { sql, store, tokenHash, tokenId, userId } = await issue();
    const [before] = await sql<{ last_used_at: Date }[]>`
      update api_tokens set last_used_at = now() where id = ${tokenId} returning last_used_at
    `;

    await expect(store.findAccountByTokenHash(tokenHash)).resolves.toMatchObject({ id: userId });

    const [after] = await sql<{ confirmed_at: Date | null; last_used_at: Date }[]>`
      select confirmed_at, last_used_at from api_tokens where id = ${tokenId}
    `;
    // The throttle governs the hot auth path of a token already in use. An
    // unconfirmed one still has its confirmation to record, so the statement
    // writes, and the stamp moves forward rather than being held back.
    expect(after.confirmed_at).toBeInstanceOf(Date);
    expect(after.last_used_at.getTime()).toBeGreaterThan(before.last_used_at.getTime());
  });

  it.each(["1 second", "0 seconds"])("neither returns nor stamps a token expired %s ago", async (age) => {
    const { sql, tokenHash, tokenId } = await issue();
    await sql.begin(async (tx) => {
      await tx`update api_tokens set expires_at = now() - ${age}::interval where id = ${tokenId}`;
      await expect(new PostgresApiTokenStore(tx as unknown as Sql).findAccountByTokenHash(tokenHash))
        .resolves.toBeNull();
      const [row] = await tx`select last_used_at from api_tokens where id = ${tokenId}`;
      expect(row.last_used_at).toBeNull();
    });
  });

  it("ignores an unknown hash without stamping another token", async () => {
    const { sql, store, tokenId } = await issue();
    await expect(store.findAccountByTokenHash(mintApiToken().tokenHash)).resolves.toBeNull();
    const [row] = await sql`select last_used_at from api_tokens where id = ${tokenId}`;
    expect(row.last_used_at).toBeNull();
  });

  it("rotates the issuance id and clears its usage timestamp and confirmation on regeneration", async () => {
    const { sql, store, tokenHash, userId, tokenId } = await issue();
    await sql`update api_tokens set last_used_at = now() where id = ${tokenId}`;
    await store.findAccountByTokenHash(tokenHash);
    const replacement = mintApiToken();
    await store.issueToken(userId, replacement.tokenHash);
    const rows = await sql`select id, last_used_at, confirmed_at from api_tokens where user_id = ${userId}`;
    expect(rows).toHaveLength(1);
    expect(rows[0].id).not.toBe(tokenId);
    expect(rows[0].last_used_at).toBeNull();
    // The replaced value's confirmation says nothing about the new one, which
    // its holder has not used yet.
    expect(rows[0].confirmed_at).toBeNull();
    await expect(store.findAccountByTokenHash(tokenHash)).resolves.toBeNull();
    await expect(store.findAccountByTokenHash(replacement.tokenHash)).resolves.toMatchObject({ tokenId: rows[0].id });
  });

  it.each([null, "2026-01-02T03:04:05.000Z"])("exports the stored last use (%s)", async (lastUsedAt) => {
    const { sql, tokenId, githubUserId, summary } = await issue();
    if (lastUsedAt !== null) {
      await sql`update api_tokens set last_used_at = ${lastUsedAt}::timestamptz where id = ${tokenId}`;
    }
    const exported = await exportAccount(sql, githubUserId);
    expect(exported?.apiToken).toEqual({
      createdAt: summary.createdAt.toISOString(), expiresAt: summary.expiresAt.toISOString(), lastUsedAt,
    });
  });
});
