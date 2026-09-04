import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeSql, withTransaction } from "../src/lib/db/client.ts";

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../db/migrations",
);

export async function runMigrations(): Promise<void> {
  const migrationNames = (await readdir(migrationsDirectory))
    .filter((name) => /^\d+_.+\.sql$/.test(name))
    .sort();

  await withTransaction(async (sql) => {
    await sql.unsafe(`
      create table if not exists schema_migrations (
        name text primary key,
        applied_at timestamp with time zone not null default now()
      )
    `);

    const appliedRows = await sql<{ name: string }[]>`
      select name from schema_migrations
    `;
    const appliedNames = new Set(appliedRows.map((row) => row.name));

    for (const migrationName of migrationNames) {
      if (appliedNames.has(migrationName)) {
        continue;
      }

      const migration = await readFile(path.join(migrationsDirectory, migrationName), "utf8");
      await sql.unsafe(migration);
      await sql`
        insert into schema_migrations (name)
        values (${migrationName})
      `;
    }
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
