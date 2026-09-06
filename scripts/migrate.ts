import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeSql, withTransaction } from "../src/lib/db/client.ts";

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../db/migrations",
);

/**
 * The only numbering collision this repository tolerates.
 *
 * Both files are applied to production under these exact names, and `schema_migrations.name` is
 * the key, so renaming either one would make production run it a second time. Nothing is ever
 * added here: a collision caught on a branch gets renumbered on that branch, before any database
 * has recorded the name.
 */
const grandfatheredCollision = [
  "013_immutable_github_identity.sql",
  "013_reconciliation_cooldown.sql",
];

export async function runMigrations(options: { upTo?: string } = {}): Promise<void> {
  const numberedNames = (await readdir(migrationsDirectory)).filter((name) =>
    /^\d+_.+\.sql$/.test(name),
  );

  // The whole directory is checked, not just the part `upTo` selects: a collision is a property of
  // the directory, and an upgrade test that stops halfway must not be the run that misses it.
  assertUniqueMigrationNumbers(numberedNames);

  const migrationNames = numberedNames
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

/**
 * Refuses a migration directory in which two files share a number.
 *
 * Two branches open at once each number themselves against a `main` that does not yet hold the
 * other's migration, so the collision only comes into being when both are merged. Nothing
 * downstream notices it: the runner sorts whole filenames, so the order of a colliding pair falls
 * out of an alphabetical comparison of the text after the number, which has no relation to the
 * order the migrations were written in. Failing here makes that a merge-time error rather than
 * one discovered against a database.
 */
export function assertUniqueMigrationNumbers(migrationNames: readonly string[]): void {
  const namesByNumber = new Map<number, string[]>();

  for (const migrationName of migrationNames) {
    const numberedName = /^(\d+)_/.exec(migrationName);
    if (numberedName === null) {
      continue;
    }

    // The number is what collides, not the text of the prefix: 013 and 13 are the same migration
    // number written two ways.
    const migrationNumber = Number.parseInt(numberedName[1], 10);
    const collidingNames = namesByNumber.get(migrationNumber);
    if (collidingNames === undefined) {
      namesByNumber.set(migrationNumber, [migrationName]);
    } else {
      collidingNames.push(migrationName);
    }
  }

  for (const [migrationNumber, collidingNames] of namesByNumber) {
    if (collidingNames.length < 2) {
      continue;
    }

    const sortedNames = [...collidingNames].sort();
    if (
      sortedNames.length === grandfatheredCollision.length &&
      sortedNames.every((name) => grandfatheredCollision.includes(name))
    ) {
      continue;
    }

    throw new Error(
      `More than one migration is numbered ${migrationNumber}: ${sortedNames.join(", ")}. ` +
        "Renumber all but one of them to the next unused number.",
    );
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
