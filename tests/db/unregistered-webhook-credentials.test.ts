import { randomBytes, randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";

const backfillMigration = "048_unregistered_webhook_credentials.sql";
const migrationsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../db/migrations");

/** The migration applied immediately before 048, whatever lands between 046 and it. */
const precedingMigration = (() => {
  const names = readdirSync(migrationsDirectory).filter((name) => /^\d+_.+\.sql$/.test(name)).sort();
  return names[names.indexOf(backfillMigration) - 1];
})();

type RepositoryRow = Record<string, unknown> & {
  webhook_credential_id: string | null;
  encrypted_webhook_secret: Buffer | null;
  webhook_configured_at: Date | null;
};

const difficultyScheme = {
  openingName: "Size",
  actualName: "Delivered",
  openingLabels: [{ label: "size/M", comparisonPoints: 5, reservePoints: 5 }],
  actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
};

const originalDatabaseUrl = process.env.DATABASE_URL;
let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 7_710_000;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "unregistered_credentials",
    user: "unregistered_credentials",
    password: "unregistered_credentials",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql();
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

describe(`upgrading across ${backfillMigration}`, () => {
  it("drops the credential of every unregistered repository and of no other, repeatably", async () => {
    expect(precedingMigration).toBeDefined();
    await runMigrations({ upTo: precedingMigration });
    const unregistered = await insertRepository({ credential: true, active: false, unregistered: true });
    const moderated = await insertRepository({ credential: true, active: false, unregistered: false });
    const active = await insertRepository({ credential: true, active: true, unregistered: false });
    const legacyUnregistered = await insertRepository({ credential: false, active: false, unregistered: true });
    const before = await rowsById();

    await runMigrations();
    const after = await rowsById();

    expect(after.get(unregistered)).toEqual({
      ...before.get(unregistered),
      webhook_credential_id: null,
      encrypted_webhook_secret: null,
      webhook_configured_at: null,
    });
    for (const untouched of [moderated, active, legacyUnregistered]) {
      expect(after.get(untouched)).toEqual(before.get(untouched));
    }
    expect(before.get(moderated)!.webhook_credential_id).not.toBeNull();
    expect(before.get(active)!.webhook_credential_id).not.toBeNull();

    // Replayed by hand: the bookkeeping row would otherwise skip it.
    await sql.unsafe(readFileSync(path.join(migrationsDirectory, backfillMigration), "utf8"));
    expect(await rowsById()).toEqual(after);
  });

  it("leaves the credential constraints and the selector index in place", async () => {
    await runMigrations();
    const constraints = await sql<{ conname: string; convalidated: boolean }[]>`
      select conname, convalidated from pg_constraint
      where conrelid = 'registered_repositories'::regclass and conname like 'repository_webhook_%'
      order by conname
    `;
    expect(constraints).toEqual([
      { conname: "repository_webhook_configuration_material", convalidated: true },
      { conname: "repository_webhook_credential_pair", convalidated: true },
      { conname: "repository_webhook_material_hook", convalidated: true },
    ]);
    const indexes = await sql<{ indexname: string }[]>`
      select indexname from pg_indexes
      where tablename = 'registered_repositories' and indexname = 'repository_webhook_credential_selector'
    `;
    expect(indexes).toHaveLength(1);
  });
});

async function insertRepository(input: { credential: boolean; active: boolean; unregistered: boolean }): Promise<string> {
  const githubUserId = externalId++;
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (${githubUserId}, ${`sponsor-${githubUserId}`})
    returning id
  `;
  const githubRepositoryId = externalId++;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme,
      active, unregistered_at, webhook_credential_id, encrypted_webhook_secret, webhook_configured_at
    )
    values (
      ${githubRepositoryId}, ${`example/repository-${githubRepositoryId}`}, ${user.id}, ${"PUBLIC"},
      ${externalId++}, ${sql.json(difficultyScheme)}, ${input.active}, ${input.unregistered ? new Date() : null},
      ${input.credential ? randomUUID() : null}, ${input.credential ? randomBytes(48) : null},
      ${input.credential ? new Date() : null}
    )
    returning id
  `;
  return repository.id;
}

async function rowsById(): Promise<Map<string, RepositoryRow>> {
  const rows = await sql<RepositoryRow[]>`select * from registered_repositories`;
  return new Map(rows.map((row) => [String(row.id), row]));
}
