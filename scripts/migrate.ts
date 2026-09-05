import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeSql, withTransaction } from "../src/lib/db/client.ts";

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../db/migrations",
);

export async function runMigrations(options: { upTo?: string } = {}): Promise<void> {
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .filter((name) => options.upTo === undefined || name <= options.upTo)
    .sort();

  const appliedNames = await readAppliedMigrations();

  for (const migrationName of migrationNames) {
    if (appliedNames.has(migrationName)) {
      continue;
    }

    const migration = await readFile(path.join(migrationsDirectory, migrationName), "utf8");

    // One transaction per migration, not one for the whole run. A migration may only build on
    // catalogue state an earlier migration committed: PostgreSQL refuses to read an enum label
    // added by ALTER TYPE ... ADD VALUE until the adding transaction has committed, so 007 can
    // only name the labels 006 adds if 006 committed first. Running from empty hid this, because
    // 001 then created every enum type in the same transaction that extended it.
    //
    // The bookkeeping row is written inside the migration's own transaction, so a migration and
    // the record of it commit together or not at all. A migration that fails leaves the ones
    // before it applied and recorded, which is what lets a rerun resume rather than restart.
    await withTransaction(async (sql) => {
      await sql.unsafe(migration);
      await sql`
        insert into schema_migrations (name)
        values (${migrationName})
      `;
    });
  }
}

/** Creates the migration ledger if this database has none, and reads back what it records. */
async function readAppliedMigrations(): Promise<Set<string>> {
  return withTransaction(async (sql) => {
    await sql.unsafe(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamp with time zone not null default now()
      )
    `);

    const appliedRows = await sql<{ name: string }[]>`
      select name from schema_migrations
    `;

    return new Set(appliedRows.map((row) => row.name));
  });
}

if (isDirectExecution()) {
  try {
    await runMigrations();
  } finally {
    await closeSql();
  }
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}
