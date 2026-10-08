import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";

/**
 * Migration 063 (issue 1075): nothing stores the GitHub avatar URL anymore,
 * so the migration nulls what earlier releases wrote. The column stays — old
 * rows need no drop — and the `users_deleted_account_scrubbed_check` must
 * still read the post-migration state as scrubbed: a deleted row carries a
 * null avatar, and a live row may carry one only in the pre-migration shape
 * this migration erases.
 */

const originalDatabaseUrl = process.env.DATABASE_URL;
let container: StartedTestContainer | undefined;
let avatarUserId: string | undefined;
let deletedAvatarUserId: string | undefined;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "overflow_1071_avatar_nulling",
    user: "overflow_1071_avatar_nulling",
    password: "overflow_1071_avatar_nulling",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  // The pre-migration schema: everything through 062, so the seed below is
  // the old world's write.
  await runMigrations({ upTo: "062_webhook_delivery_body_digest.sql" });
  const sql = getSql();
  const [live] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, avatar_url)
    values (76_820_001, 'avatar-nulling-live', 'https://avatars.example/pre-migration.png')
    returning id
  `;
  avatarUserId = live!.id;
  // A deleted row in the only shape 045's check admits: avatar nulled at the
  // scrub. The migration must leave it exactly as it is.
  const [deleted] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, avatar_url, deleted_at)
    values (76_820_002, 'avatar-nulling-deleted', null, now())
    returning id
  `;
  deletedAvatarUserId = deleted!.id;
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("migration 063 nulls the stored avatar URLs", () => {
  it("nulls every existing avatar value the old releases wrote", async () => {
    const sql = getSql();
    const [row] = await sql<{ avatar_url: string | null }[]>`
      select avatar_url from users where id = ${avatarUserId!}
    `;
    expect(row!.avatar_url).toBeNull();
  });

  it("keeps the column nullable and present, so no row needed a drop", async () => {
    const sql = getSql();
    const [column] = await sql<{ is_nullable: string; data_type: string }[]>`
      select is_nullable, data_type
      from information_schema.columns
      where table_schema = 'public' and table_name = 'users' and column_name = 'avatar_url'
    `;
    expect(column).toEqual({ is_nullable: "YES", data_type: "text" });
  });

  it("leaves a deleted row scrubbed and the scrubbed check enforcing (issue 1075)", async () => {
    const sql = getSql();
    const [row] = await sql<{ avatar_url: string | null; deleted_at: Date | null }[]>`
      select avatar_url, deleted_at from users where id = ${deletedAvatarUserId!}
    `;
    // The deleted row the migration found stays scrubbed: null avatar, and
    // 045's check keeps admitting it.
    expect(row!.avatar_url).toBeNull();
    expect(row!.deleted_at).not.toBeNull();

    // The check still enforces its shape: a live row may carry an avatar
    // (the pre-migration state), but a deleted row may not.
    await sql`update users set avatar_url = 'https://avatars.example/live-again.png' where id = ${avatarUserId!}`;
    await expect(
      sql`update users set deleted_at = now() where id = ${avatarUserId!}`,
    ).rejects.toMatchObject({ code: "23514" });
    await sql`update users set avatar_url = null where id = ${avatarUserId!}`;
  });
});
