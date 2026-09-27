import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import { pendingMigrationLines } from "../../scripts/deploy-migration-status";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql } from "@/lib/db/client";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
let container: StartedTestContainer | undefined;
let databaseUrl = "";

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "overflow_deploy_migration_status",
    user: "overflow_deploy_migration_status",
    password: "overflow_deploy_migration_status",
  });
  container = started.container;
  databaseUrl = started.databaseUrl;
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
});

describe("pending deploy migration status", () => {
  it("marks only unapplied migrations containing the mixed-version review marker", () => {
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
});
