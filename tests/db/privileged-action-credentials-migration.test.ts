import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { mintApiToken } from "@/lib/security/api-token";
import { API_TOKEN_LIFETIME_DAYS } from "@/lib/tokens/lifetime";

const originalDatabaseUrl = process.env.DATABASE_URL;
let container: StartedTestContainer | undefined;
let userId: string;
let previousRows: Record<string, unknown>[];
const tables = ["moderator_role_changes", "moderation_events"] as const;

// These are the previous release's exact column lists and upsert assignments,
// from the stores at 7942a98a. No new column is named by any writer here.
async function oldReleaseWrites() {
  const sql = getSql();
  await sql`
    insert into moderator_role_changes (target_account_id, actor_id, new_role)
    values (${userId}, ${userId}, ${"MODERATOR"})
  `;
  await sql`
    insert into moderation_events (
      target_user_id,
      actor_id,
      audit_id,
      prior_state,
      new_state,
      reason,
      cohort_definition,
      cohort_statistics,
      recalibration_plan
    )
    values (
      ${userId},
      ${userId},
      ${null},
      ${"ACTIVE"},
      ${"WARNED"},
      ${"migration compatibility"},
      ${sql.json({})},
      ${sql.json({})},
      ${null}
    )
  `;
  await sql`
    insert into api_tokens (user_id, token_hash, expires_at)
    values (${userId}, ${mintApiToken().tokenHash}, now() + make_interval(days => ${API_TOKEN_LIFETIME_DAYS}))
    on conflict (user_id) do update
    set token_hash = excluded.token_hash, created_at = now(), expires_at = excluded.expires_at
    returning created_at, expires_at
  `;
}

async function historyRows() {
  const sql = getSql();
  const rows: Record<string, unknown>[] = [];
  for (const table of tables) {
    const records = await sql<{ row: Record<string, unknown> }[]>`
      select to_jsonb(t) as row from ${sql(table)} t order by id
    `;
    rows.push(...records.map(({ row }) => row));
  }
  return rows;
}

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "overflow_credentials_migration",
    user: "overflow_credentials_migration",
    password: "overflow_credentials_migration",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  await runMigrations({ upTo: "052_repository_policy_violations.sql" });
  const sql = getSql();
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (7682001, 'credentials-migration') returning id
  `;
  userId = user.id;
  await oldReleaseWrites();
  previousRows = await historyRows();
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("privileged action credential migration", () => {
  it("adds nullable columns without defaults and with the intended types", async () => {
    const sql = getSql();
    const columns = await sql`
      select table_name, column_name, data_type, is_nullable, column_default
      from information_schema.columns
      where table_schema = 'public' and (
        (table_name = 'api_tokens' and column_name = 'last_used_at') or
        (table_name in ('moderator_role_changes', 'moderation_events')
          and column_name in ('credential_kind', 'credential_token_id'))
      ) order by table_name, column_name
    `;
    expect([...columns]).toEqual([
      { table_name: "api_tokens", column_name: "last_used_at", data_type: "timestamp with time zone", is_nullable: "YES", column_default: null },
      ...["moderation_events", "moderator_role_changes"].flatMap((table_name) => [
        { table_name, column_name: "credential_kind", data_type: "text", is_nullable: "YES", column_default: null },
        { table_name, column_name: "credential_token_id", data_type: "uuid", is_nullable: "YES", column_default: null },
      ]),
    ]);
  });

  it("upgrades across 054 with existing history without updating immutable events", async () => {
    expect(await historyRows()).toEqual(previousRows.map((row) => ({
      ...row, credential_kind: null, credential_token_id: null,
    })));
    const sql = getSql();
    await expect(sql`update moderation_events set reason = reason where target_user_id = ${userId}`)
      .rejects.toThrow("Moderation event history is immutable");
  });

  it("accepts old-release inserts and token regeneration after migrating", async () => {
    await oldReleaseWrites();
    const rows = await historyRows();
    expect(rows).toHaveLength(4);
    for (const row of rows) {
      expect(row).toMatchObject({ credential_kind: null, credential_token_id: null });
    }
    const sql = getSql();
    const [token] = await sql`select last_used_at from api_tokens where user_id = ${userId}`;
    expect(token.last_used_at).toBeNull();
  });

  for (const table of tables) {
    const tokenId = randomUUID();
    it.each([
      ["token", null], ["session", tokenId], ["bogus", null],
    ])(`${table} rejects credential (%s, %s)`, async (kind, token) => {
      await expect(insertHistory(table, kind, token)).rejects.toMatchObject({
        code: "23514", constraint_name: `${table}_credential_check`,
      });
    });
    it.each([
      [null, null], ["session", null], ["token", tokenId],
    ])(`${table} accepts credential (%s, %s) without requiring a live token`, async (kind, token) => {
      await expect(insertHistory(table, kind, token)).resolves.toMatchObject([
        { credential_kind: kind, credential_token_id: token },
      ]);
    });
  }
});

function insertHistory(table: typeof tables[number], kind: string | null, token: string | null) {
  const sql = getSql();
  return table === "moderator_role_changes"
    ? sql`
        insert into moderator_role_changes (target_account_id, actor_id, new_role, credential_kind, credential_token_id)
        values (${userId}, ${userId}, 'MODERATOR', ${kind}, ${token})
        returning credential_kind, credential_token_id
      `
    : sql`
        insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason, credential_kind, credential_token_id)
        values (${userId}, ${userId}, 'ACTIVE', 'WARNED', 'credential check', ${kind}, ${token})
        returning credential_kind, credential_token_id
      `;
}
