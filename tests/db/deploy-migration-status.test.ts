import { spawnSync } from "node:child_process";
import postgres from "postgres";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import { pendingMigrationLines, readMigrationTree } from "../../scripts/deploy-migration-status";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql } from "@/lib/db/client";
import { migrationCompatibilityFixtures } from "../fixtures/migration-compatibility";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
let container: StartedTestContainer | undefined;
let databaseUrl = "";

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "overflow_deploy_migration_status",
    user: "overflow_deploy_migration_status",
  });
  container = started.container;
  databaseUrl = started.databaseUrl;
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
});

describe("pending deploy migration status", () => {
  it.each(["046_nested_do_body.sql", "047_nested_do_language.sql", "048_do_named_function_data.sql", "049_nested_quoted_language.sql"])("confirms %s executes its schema change in scratch PostgreSQL", async (name) => {
    const migration = migrationCompatibilityFixtures.find((fixture) => fixture.name === name)!;
    const sql = postgres(databaseUrl);
    try {
      await sql`create table items (note text)`;
      if (name === "048_do_named_function_data.sql") {
        await sql.unsafe('create function public."do"(text) returns text language sql as $$ select $1 $$');
      }
      await sql.unsafe(migration.contents);
      await expect(sql`select note from items`).rejects.toMatchObject({ code: "42703" });
    } finally {
      await sql`drop table if exists items`;
      if (name === "048_do_named_function_data.sql") {
        await sql.unsafe('drop function if exists public."do"(text)');
      }
      await sql.end();
    }
  });

  it("omits applied migrations and preserves the legacy review marker", () => {
    const tree = new Map([
      ["052_unmarked.sql", "alter table items add column note text;\n"],
      [
        "053_mixed_version_review.sql",
        "-- reviewed later: overflow: mixed-version review\nalter table items add constraint items_note_check check (note <> '');\n",
      ],
      ["054_applied.sql", "-- overflow: mixed-version review\nselect 1;\n"],
    ]);
    const applied = new Set(["054_applied.sql"]);

    expect(pendingMigrationLines(tree, applied)).toEqual([
      "052_unmarked.sql\t-",
      "053_mixed_version_review.sql\treview",
    ]);
  });

  it("fails closed when schema_migrations does not exist", () => {
    const result = spawnSync(process.execPath, ["scripts/deploy-migration-status.ts"], {
      cwd: repositoryRoot,
      encoding: "utf8",
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 10_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).not.toBe(0);
    expect(`${result.stderr}\n${result.stdout}`).toMatch(/schema_migrations|does not exist|query/i);
  });

  it("prints classified pending files through the real CLI against a legacy ledger", async () => {
    const sql = postgres(databaseUrl);
    try {
      await sql`create table schema_migrations (name text primary key)`;
      const tree = await readMigrationTree();
      const applied = [...tree.keys()].filter((name) => name !== "057_fold_evidence_facts.sql");
      for (const name of applied) await sql`insert into schema_migrations (name) values (${name})`;
      const result = spawnSync(process.execPath, ["scripts/deploy-migration-status.ts"], {
        cwd: repositoryRoot,
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: databaseUrl },
        timeout: 10_000,
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("057_fold_evidence_facts.sql\treview\tdrop column\n");
    } finally {
      await sql.end();
    }
  });
});
