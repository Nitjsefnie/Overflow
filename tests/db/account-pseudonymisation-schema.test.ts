import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 6_500_000;
const originalDatabaseUrl = process.env.DATABASE_URL;

function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

async function insertUser(): Promise<string> {
  const id = nextExternalId();
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, avatar_url, encrypted_oauth_token)
    values (${id}, ${`pseudonymisation-user-${id}`}, ${`https://avatars.example/${id}`}, ${Buffer.from("token")})
    returning id
  `;
  return user!.id;
}

async function insertForgeIdentity(userId: string): Promise<string> {
  const [identity] = await sql<{ id: string }[]>`
    insert into user_forge_identities (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token)
    values (${userId}, 'gitlab', 'https://gitlab.com', ${nextExternalId()}, 'gitlab-login', ${Buffer.from("forge-token")})
    returning id
  `;
  return identity!.id;
}

async function columnShape(table: string, column: string): Promise<{ is_nullable: string; data_type: string }> {
  const [shape] = await sql<{ is_nullable: string; data_type: string }[]>`
    select is_nullable, data_type
    from information_schema.columns
    where table_schema = 'public' and table_name = ${table} and column_name = ${column}
  `;
  return shape!;
}

describe("account pseudonymisation schema", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "account_pseudonymisation_test",
      user: "account_pseudonymisation_test",
      password: "account_pseudonymisation_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    // The second run replays every migration against the installed schema, so a
    // migration that is not re-runnable fails here rather than in production.
    await runMigrations();
    await runMigrations();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("adds a nullable timestamptz users.deleted_at that new rows leave null", async () => {
    await expect(columnShape("users", "deleted_at")).resolves.toEqual({
      is_nullable: "YES",
      data_type: "timestamp with time zone",
    });

    const userId = await insertUser();
    const [row] = await sql<{ deleted_at: Date | null }[]>`select deleted_at from users where id = ${userId}`;
    expect(row!.deleted_at).toBeNull();
  });

  it("rejects marking a row deleted while it still carries an avatar", async () => {
    const userId = await insertUser();
    await sql`update users set encrypted_oauth_token = null where id = ${userId}`;

    await expect(sql`update users set deleted_at = now() where id = ${userId}`).rejects.toMatchObject({
      constraint_name: "users_deleted_account_scrubbed_check",
    });
  });

  it("rejects marking a row deleted while it still carries an OAuth token", async () => {
    const userId = await insertUser();
    await sql`update users set avatar_url = null where id = ${userId}`;

    await expect(sql`update users set deleted_at = now() where id = ${userId}`).rejects.toMatchObject({
      constraint_name: "users_deleted_account_scrubbed_check",
    });
  });

  it("accepts marking a row deleted when avatar and token are cleared in the same update", async () => {
    const userId = await insertUser();

    const [row] = await sql<{ deleted_at: Date | null; avatar_url: string | null; encrypted_oauth_token: Buffer | null }[]>`
      update users set deleted_at = now(), avatar_url = null, encrypted_oauth_token = null
      where id = ${userId}
      returning deleted_at, avatar_url, encrypted_oauth_token
    `;
    expect(row!.deleted_at).toBeInstanceOf(Date);
    expect(row!.avatar_url).toBeNull();
    expect(row!.encrypted_oauth_token).toBeNull();
  });

  it("accepts re-registration: clearing deleted_at while restoring avatar and token in one statement", async () => {
    const userId = await insertUser();
    await sql`
      update users set deleted_at = now(), avatar_url = null, encrypted_oauth_token = null
      where id = ${userId}
    `;

    const [row] = await sql<{ deleted_at: Date | null; avatar_url: string | null; encrypted_oauth_token: Buffer | null }[]>`
      update users
      set deleted_at = null, avatar_url = 'https://avatars.example/returned', encrypted_oauth_token = ${Buffer.from("fresh")}
      where id = ${userId}
      returning deleted_at, avatar_url, encrypted_oauth_token
    `;
    expect(row!.deleted_at).toBeNull();
    expect(row!.avatar_url).toBe("https://avatars.example/returned");
    expect(row!.encrypted_oauth_token).toEqual(Buffer.from("fresh"));
  });

  it("makes user_forge_identities.encrypted_token nullable and admits the tombstone login", async () => {
    await expect(columnShape("user_forge_identities", "encrypted_token")).resolves.toMatchObject({
      is_nullable: "YES",
    });

    const identityId = await insertForgeIdentity(await insertUser());

    const [row] = await sql<{ encrypted_token: Buffer | null; forge_login: string }[]>`
      update user_forge_identities
      set encrypted_token = null, forge_login = '(deleted account)'
      where id = ${identityId}
      returning encrypted_token, forge_login
    `;
    expect(row!.encrypted_token).toBeNull();
    expect(row!.forge_login).toBe("(deleted account)");
  });
});
