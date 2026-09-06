import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeSql, withTransaction } from "../src/lib/db/client.ts";

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../db/migrations",
);

/**
 * What a migration file is, for the runner and for the numbering guards alike.
 *
 * One expression rather than one per caller, because a runner and a guard that disagree about
 * this is the failure they exist to prevent: a `013_reconciliation_cooldown.sql.orig` left behind
 * by a conflicted merge would otherwise be a second migration numbered 013 to the guard and no
 * migration at all to the runner.
 */
const migrationFilename = /^(\d+)_.+\.sql$/;

/**
 * The collisions this repository is stuck with, each keyed by the number the collision is at and
 * mapped to the exact filenames allowed to share it.
 *
 * The 013 pair is applied to production under those exact names, and `schema_migrations.name` is
 * the key, so renaming either one would make production run it a second time. Keying by number
 * and comparing the filenames exactly is what keeps this an exemption for two known files rather
 * than for a number: a new `013_something_else.sql` alongside either of them still collides.
 * Nothing is ever added here — a collision caught on a branch gets renumbered on that branch,
 * before any database has recorded the name.
 */
const grandfatheredCollisions: ReadonlyMap<number, readonly string[]> = new Map([
  [13, ["013_immutable_github_identity.sql", "013_reconciliation_cooldown.sql"] as const],
]);

/** Selects the migrations out of a directory listing, in filename order. */
export function listMigrationNames(entries: readonly string[]): string[] {
  return numberedMigrations(entries).map(({ name }) => name);
}

export async function runMigrations(options: { upTo?: string } = {}): Promise<void> {
  const numberedNames = listMigrationNames(await readdir(migrationsDirectory));

  // The whole directory is checked, not just the part `upTo` selects: bad numbering is a property
  // of the directory, and an upgrade test that stops halfway must not be the run that misses it.
  assertUniqueMigrationNumbers(numberedNames);
  assertUniformMigrationNumberWidth(numberedNames);

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
 * Two branches open at the same time each number themselves against a `main` that does not yet
 * hold the other's migration, so the collision only comes into being when both are merged.
 * Nothing downstream notices it: the runner sorts whole filenames, so the order of a colliding
 * pair falls out of an alphabetical comparison of the text after the number, which has no
 * relation to the order the migrations were written in. Failing here makes that a merge-time
 * error rather than one discovered against a database.
 */
export function assertUniqueMigrationNumbers(migrationNames: readonly string[]): void {
  const namesByNumber = new Map<number, string[]>();

  for (const { name, prefix } of numberedMigrations(migrationNames)) {
    // The number is what collides, not the text of the prefix: 013 and 13 are the same migration
    // number written two ways.
    const migrationNumber = Number.parseInt(prefix, 10);
    const collidingNames = namesByNumber.get(migrationNumber);
    if (collidingNames === undefined) {
      namesByNumber.set(migrationNumber, [name]);
    } else {
      collidingNames.push(name);
    }
  }

  for (const [migrationNumber, collidingNames] of namesByNumber) {
    if (collidingNames.length < 2) {
      continue;
    }

    const permittedNames = grandfatheredCollisions.get(migrationNumber);
    if (
      permittedNames !== undefined &&
      collidingNames.length === permittedNames.length &&
      collidingNames.every((name) => permittedNames.includes(name))
    ) {
      continue;
    }

    throw new Error(
      `More than one migration is numbered ${migrationNumber}: ${collidingNames.join(", ")}. ` +
        "Renumber all but one of them to the next unused number.",
    );
  }
}

/**
 * Refuses a migration directory whose numeric prefixes are not all the same width.
 *
 * The runner applies migrations in filename order, so `19_x.sql` runs after `020_y.sql` on a
 * fresh database — the wrong order, and silently so. A prefix of an odd width usually carries a
 * number nothing else uses, which is why the collision check above cannot see it.
 */
export function assertUniformMigrationNumberWidth(migrationNames: readonly string[]): void {
  const migrations = numberedMigrations(migrationNames);
  const namesByWidth = new Map<number, string[]>();

  for (const { name, prefix } of migrations) {
    const sameWidthNames = namesByWidth.get(prefix.length);
    if (sameWidthNames === undefined) {
      namesByWidth.set(prefix.length, [name]);
    } else {
      sameWidthNames.push(name);
    }
  }

  if (namesByWidth.size < 2) {
    return;
  }

  // The width the directory is written in is the one most of it uses. A tie falls to the width
  // the first migration in filename order carries, which is the order this map was filled in and
  // which a stable sort preserves.
  const [[prevailingWidth]] = [...namesByWidth.entries()].sort(
    ([, names], [, otherNames]) => otherNames.length - names.length,
  );

  for (const { name, prefix } of migrations) {
    if (prefix.length === prevailingWidth) {
      continue;
    }

    throw new Error(
      `Migration ${name} is numbered with ${prefix.length} digits, where db/migrations ` +
        `otherwise uses ${prevailingWidth}. Migrations are applied in filename order, so a ` +
        "prefix of another width runs out of order; renumber it to the prevailing width.",
    );
  }
}

/**
 * Pairs every migration in a directory listing with its numeric prefix, in filename order.
 *
 * Sorting here is what makes a rejection read the same however the listing arrived: a directory
 * listing is in whatever order the filesystem returns, and the message names the files it
 * rejected.
 */
function numberedMigrations(entries: readonly string[]): { name: string; prefix: string }[] {
  return [...entries].sort().flatMap((name) => {
    const prefixMatch = migrationFilename.exec(name);
    return prefixMatch === null ? [] : [{ name, prefix: prefixMatch[1] }];
  });
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
