import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);
const migrationNames = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort();

const originalDatabaseUrl = process.env.DATABASE_URL;
let container: StartedTestContainer | undefined;
let adminSql: Sql | undefined;
let adminDatabaseUrl = "";

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "overflow_checksum",
    user: "overflow_checksum",
    password: "overflow_checksum",
  });
  container = started.container;
  adminDatabaseUrl = started.databaseUrl;
  adminSql = postgres(adminDatabaseUrl, { max: 1 });
});

afterAll(async () => {
  await closeSql();
  await adminSql?.end();
  await container?.stop();
  restoreDatabaseUrl();
});

describe("migration checksums", () => {
  it("records the file's checksum when it applies a migration", async () => {
    await onNewDatabase("record_checksum", async (sql) => {
      await runMigrations();

      const recorded = await migrationChecksums(sql);
      expect(recorded).toEqual(expectedMigrationChecksums());
    });
  });

  it("refuses when an applied migration's file no longer matches its recorded checksum", async () => {
    await onNewDatabase("reject_modified_checksum", async (sql) => {
      await runMigrations({ upTo: "011_api_tokens.sql" });
      const appliedBeforeMismatch = await appliedMigrationNames(sql);
      await sql`
        update schema_migrations
        set checksum = repeat('0', 64)
        where name = ${"011_api_tokens.sql"}
      `;

      const rejection = await rejectionMessage(runMigrations());

      expect(rejection).toContain("db/migrations/011_api_tokens.sql");
      await expect(appliedMigrationNames(sql)).resolves.toEqual(appliedBeforeMismatch);
    });
  });

  it("adopts current content for rows recorded before checksums existed", async () => {
    await onNewDatabase("adopt_legacy_checksums", async (sql) => {
      await runMigrations({ upTo: "003_multi_issue_settlements_and_claims.sql" });
      const rowsToAdopt = await sql<{ name: string }[]>`
        update schema_migrations set checksum = null returning name
      `;
      const expectedNames = rowsToAdopt.map(({ name }) => name);

      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await runMigrations();
        await expect(migrationChecksums(sql)).resolves.toEqual(expectedMigrationChecksums());
        await runMigrations();
        expect(announcedAdoptionNames(stderrWrite.mock.calls.map(([chunk]) => chunk)).sort())
          .toEqual(expectedNames.sort());
      } finally {
        stderrWrite.mockRestore();
      }
    });
  });

  it("names recorded and current checksums in the refusal", async () => {
    await onNewDatabase("name_both_checksums", async (sql) => {
      const migrationName = "011_api_tokens.sql";
      const recordedChecksum = "0".repeat(64);
      const currentChecksum = checksumFor(migrationName);

      await runMigrations({ upTo: migrationName });
      await sql`
        update schema_migrations
        set checksum = ${recordedChecksum}
        where name = ${migrationName}
      `;

      const rejection = await rejectionMessage(runMigrations());

      expect(rejection).toContain(recordedChecksum);
      expect(rejection).toContain(currentChecksum);
    });
  });

  it("announces when it adopts current content for a legacy row", async () => {
    await onNewDatabase("announce_checksum_adoption", async (sql) => {
      await runMigrations({ upTo: "003_multi_issue_settlements_and_claims.sql" });
      const rowsToAdopt = await sql<{ name: string }[]>`
        update schema_migrations set checksum = null returning name
      `;
      const expectedNames = rowsToAdopt.map(({ name }) => name);

      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      try {
        await runMigrations();
        expect(announcedAdoptionNames(stderrWrite.mock.calls.map(([chunk]) => chunk)).sort())
          .toEqual(expectedNames.sort());
      } finally {
        stderrWrite.mockRestore();
      }
    });
  });
});

function checksumFor(migrationName: string): string {
  return checksumContents(readFileSync(path.join(migrationsDirectory, migrationName), "utf8"));
}

function checksumContents(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

function expectedMigrationChecksums(): { name: string; checksum: string }[] {
  return migrationNames.map((name) => ({ name, checksum: checksumFor(name) }));
}

async function migrationChecksums(sql: Sql): Promise<{ name: string; checksum: string | null }[]> {
  return sql<{ name: string; checksum: string | null }[]>`
    select name, checksum from schema_migrations order by name
  `;
}

async function appliedMigrationNames(sql: Sql): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    select name from schema_migrations order by name
  `;
  return rows.map((row) => row.name);
}

async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("Expected migration checksum verification to reject.");
}

function admin(): Sql {
  if (adminSql === undefined) {
    throw new Error("The admin connection is not open.");
  }
  return adminSql;
}

function databaseUrlFor(databaseName: string): string {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function restoreDatabaseUrl(): void {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
}

function announcedAdoptionNames(chunks: readonly unknown[]): string[] {
  return chunks
    .flatMap((chunk) => String(chunk).split(/\r?\n/))
    .filter((line) => line.startsWith("adopting "))
    .map((line) => {
      const match = /^adopting the current content of db\/migrations\/(\S+) as its recorded checksum;/.exec(line);
      if (match === null) {
        throw new Error(`Unexpected migration adoption announcement: ${line}`);
      }
      return match[1]!;
    });
}

/** Runs one case against a database of its own, then closes its client and restores the admin URL. */
async function onNewDatabase<T>(databaseName: string, body: (sql: Sql) => Promise<T>): Promise<T> {
  await admin()`create database ${admin()(databaseName)}`;
  process.env.DATABASE_URL = databaseUrlFor(databaseName);
  try {
    return await body(getSql());
  } finally {
    await closeSql();
    process.env.DATABASE_URL = adminDatabaseUrl;
  }
}
