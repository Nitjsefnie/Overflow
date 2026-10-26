import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
let container: StartedTestContainer;
const original = process.env.OVERFLOW_DATABASE_URL;
beforeAll(async () => {
  const started = await startPostgresContainer({ database: "walk_schema", user: "walk_schema" });
  container = started.container; process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql(); await runMigrations();
});
afterAll(async () => {
  await closeSql(); await container?.stop();
  if (original === undefined) delete process.env.OVERFLOW_DATABASE_URL; else process.env.OVERFLOW_DATABASE_URL = original;
});

describe("sweep walk schema", () => {
  async function insertPass() {
    const { repositoryId } = await materializeRepositoryFixture(sql);
    const passId = randomUUID();
    // The previous release's insert omits walk_anchors.
    await sql`insert into reconciliation_sweep_passes (repository_id, pass_id, scan_started_at, dirty_subjects)
      values (${repositoryId}, ${passId}, now(), '[]'::jsonb)`;
    return passId;
  }

  it("keeps anchors nullable jsonb for the previous release's pass writer", async () => {
    const passId = await insertPass();
    expect(await sql`select walk_anchors from reconciliation_sweep_passes where pass_id = ${passId}`)
      .toEqual([{ walk_anchors: null }]);
    expect(await sql`select data_type, is_nullable from information_schema.columns
      where table_name = 'reconciliation_sweep_passes' and column_name = 'walk_anchors'`)
      .toEqual([{ data_type: "jsonb", is_nullable: "YES" }]);
  });

  it("stores finite timestamps, jsonb and bigint subject keys with a composite primary key", async () => {
    const passId = await insertPass();
    const other = await insertPass();
    const updatedAt = new Date("2030-01-01T00:00:00Z");
    for (const [id, kind, key] of [[passId, "issue", 4_000_000_001], [passId, "pull_request", 4_000_000_001],
      [passId, "issue", 2], [other, "issue", 4_000_000_001]] as const) {
      await sql`insert into reconciliation_sweep_walk_subjects (pass_id, kind, subject_key, updated_at, payload)
        values (${id}, ${kind}, ${key}, ${updatedAt}, '{"nested":[1,true,null]}'::jsonb)`;
    }
    expect(await sql`select data_type, is_nullable from information_schema.columns
      where table_name = 'reconciliation_sweep_walk_subjects' order by ordinal_position`).toEqual([
      { data_type: "uuid", is_nullable: "NO" }, { data_type: "text", is_nullable: "NO" },
      { data_type: "bigint", is_nullable: "NO" }, { data_type: "timestamp with time zone", is_nullable: "NO" },
      { data_type: "jsonb", is_nullable: "NO" },
    ]);
    await expect(sql`insert into reconciliation_sweep_walk_subjects (pass_id, kind, subject_key, updated_at, payload)
      values (${passId}, 'issue', 4000000001, ${updatedAt}, '{}')`).rejects.toMatchObject({ code: "23505" });
  });

  it.each(["comment", "ISSUE"])("rejects the unsupported fold kind %s", async (kind) => {
    const passId = await insertPass();
    await expect(sql`insert into reconciliation_sweep_walk_subjects (pass_id, kind, subject_key, updated_at, payload)
      values (${passId}, ${kind}, 1, now(), '{}')`).rejects.toMatchObject({ code: "23514" });
  });

  it.each(["infinity", "-infinity"])("rejects nonfinite last updates: %s", async (updatedAt) => {
    const passId = await insertPass();
    await expect(sql`insert into reconciliation_sweep_walk_subjects (pass_id, kind, subject_key, updated_at, payload)
      values (${passId}, 'issue', 1, ${updatedAt}::text::timestamptz, '{}')`).rejects.toMatchObject({ code: "23514" });
  });

  it("requires a live pass and cascades its subjects on deletion", async () => {
    const passId = await insertPass();
    await sql`insert into reconciliation_sweep_walk_subjects (pass_id, kind, subject_key, updated_at, payload)
      values (${passId}, 'issue', 1, now(), '{}')`;
    expect(await sql`select 1 from reconciliation_sweep_walk_subjects where pass_id = ${passId}`).toHaveLength(1);
    await sql`delete from reconciliation_sweep_passes where pass_id = ${passId}`;
    expect(await sql`select 1 from reconciliation_sweep_walk_subjects where pass_id = ${passId}`).toEqual([]);
    await expect(sql`insert into reconciliation_sweep_walk_subjects (pass_id, kind, subject_key, updated_at, payload)
      values (${passId}, 'issue', 1, now(), '{}')`).rejects.toMatchObject({ code: "23503" });
  });
});
