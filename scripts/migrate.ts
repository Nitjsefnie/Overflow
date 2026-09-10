import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { closeSql, withTransaction } from "../src/lib/db/client.ts";

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../db/migrations",
);

// The tree root, not derived from migrationsDirectory: git resolves paths against the working
// directory, and one ".." from db/migrations would land git in db/, where the default branch's
// `db/migrations` listing resolves to nothing.
const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
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

  const migrationNames = numberedNames.filter(
    (name) => options.upTo === undefined || name <= options.upTo,
  );

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

  const collisions: string[] = [];

  for (const [migrationNumber, collidingNames] of [...namesByNumber.entries()].sort(
    ([migrationNumber], [otherNumber]) => migrationNumber - otherNumber,
  )) {
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

    collisions.push(`${migrationNumber}: ${collidingNames.join(", ")}`);
  }

  if (collisions.length === 0) {
    return;
  }

  // Every colliding number in one throw, rather than the first one found: a merge that lands two
  // collisions is otherwise two rounds of renumber-and-rerun to discover.
  throw new Error(
    `More than one migration is numbered ${collisions.join("; ")}. ` +
      "Renumber all but one at each of those numbers to the next unused number.",
  );
}

/**
 * Refuses a migration directory whose numeric prefixes are not all the same width.
 *
 * The runner applies migrations in filename order, so a prefix of another width sorts away from
 * the number it stands for: `19_x.sql` runs after `020_y.sql`, and `0003_c.sql` runs before
 * `001_a.sql`. Such a prefix usually carries a number nothing else uses, which is why the
 * collision check cannot see it.
 *
 * No width is named as the one to renumber to, because at a boundary crossing there is none:
 * `10_j.sql` joining `1_a.sql`-`9_i.sql` cannot be written in one digit, and repadding the names
 * already in `schema_migrations` is what the exemption above exists to say nobody may do. What
 * the message carries instead is the constraint that leaves — widen before the first migration at
 * the new width is applied — because a failed `pnpm db:migrate` is all whoever hit this sees.
 */
export function assertUniformMigrationNumberWidth(migrationNames: readonly string[]): void {
  const namesByWidth = new Map<number, string[]>();

  for (const { name, prefix } of numberedMigrations(migrationNames)) {
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

  const widthGroups = [...namesByWidth.entries()]
    .sort(([width], [otherWidth]) => width - otherWidth)
    .map(([width, names]) => `${width} ${width === 1 ? "digit" : "digits"} (${names.join(", ")})`);

  throw new Error(
    `db/migrations mixes numeric prefix widths: ${widthGroups.join(", ")}. Migrations are ` +
      "applied in filename order, so a prefix of another width is applied out of turn: every " +
      "migration has to carry the same width. A name schema_migrations already records must not " +
      "be renamed, so widening has to happen before the first migration at the new width is " +
      "applied.",
  );
}

/**
 * The local refs the default branch is resolved from, in the order they are tried.
 *
 * Only refs a plain clone carries are consulted, and `git rev-parse` runs against the tree root,
 * so resolution never touches the network: a stale `origin/main` is the worst it can see, and
 * the refusal's fetch remedy is what covers that staleness.
 */
const defaultBranchRefCandidates = [
  "refs/remotes/origin/HEAD",
  "refs/remotes/origin/main",
  "refs/remotes/origin/master",
  "refs/heads/main",
  "refs/heads/master",
] as const;

/**
 * Resolves the repository's default branch from local refs alone.
 *
 * Returns the first candidate ref that resolves, so the refusal below can name what it compared
 * against, or `undefined` when none does — a git-less context, or a detached checkout that
 * fetched a single commit. It is the caller's choice what `undefined` means: the command-line
 * path prints a skip line and runs, because the incident a named feature branch in a real clone
 * produced is always determinable, and what fail-open admits is only a deliberately detached
 * checkout, which deliberate evasion can override explicitly anyway.
 */
export function resolveDefaultBranchRef(repositoryRoot: string): string | undefined {
  for (const candidate of defaultBranchRefCandidates) {
    if (git(repositoryRoot, ["rev-parse", "--verify", "--quiet", candidate]) !== undefined) {
      return candidate;
    }
  }

  return undefined;
}

/** Lists the migration filenames the given ref's `db/migrations` carries, in filename order. */
export function listDefaultBranchMigrationNames(
  defaultBranchRef: string,
  repositoryRoot: string,
): string[] {
  const listing = git(repositoryRoot, ["ls-tree", "--name-only", `${defaultBranchRef}:db/migrations`]);
  if (listing === undefined) {
    throw new Error(
      `Could not list db/migrations on ${defaultBranchRef}. ` +
        "The default branch resolved, so its tree has to be readable; " +
        "check the repository's git state and retry.",
    );
  }

  return listMigrationNames(listing.split("\n"));
}

/**
 * Refuses migrations the working tree carries that the repository's default branch does not.
 *
 * `pnpm db:migrate` targets whatever `DATABASE_URL` names, and the documented local verification
 * chain runs it first — so the moment a branch tree carries a migration, the documented gate
 * applies that migration to the pointed-at database from an unmerged tree. `schema_migrations`
 * keys on filename, so the name is frozen there once applied, and correcting a migration applied
 * from an unmerged tree takes yet another migration (issue 511).
 *
 * The comparison is name-based, against the listing one specific ref carries; a migration merged
 * after the local ref was last fetched reads as foreign, and the refusal's fetch remedy is what
 * covers that staleness — it must not be widened to silently pass what it cannot verify.
 */
export function assertMigrationsOnDefaultBranch(
  treeMigrationNames: readonly string[],
  defaultBranchMigrationNames: readonly string[],
  defaultBranchRef: string,
): void {
  const foreignMigrationNames = treeMigrationNames.filter(
    (name) => !defaultBranchMigrationNames.includes(name),
  );

  if (foreignMigrationNames.length === 0) {
    return;
  }

  throw new Error(
    `db/migrations carries ${foreignMigrationNames.join(", ")}, which ${defaultBranchRef} does ` +
      "not. Migrations are recorded in schema_migrations by filename, so a migration applied " +
      "from an unmerged branch is frozen there under its name, and correcting it later takes " +
      "yet another migration (issue 511). If the migration is already merged, the local ref may " +
      "simply be stale — fetch origin and retry. If this database is disposable, set " +
      "OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD=skip to apply it anyway.",
  );
}

/** Runs git in the repository root and returns its stdout, or `undefined` when git failed. */
function git(repositoryRoot: string, args: readonly string[]): string | undefined {
  const result = spawnSync("git", args, { cwd: repositoryRoot, encoding: "utf8" });
  if (result.error !== undefined || result.status !== 0) {
    return undefined;
  }

  return result.stdout;
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
    await enforceDefaultBranchGuard();
    await runMigrations();
  } finally {
    await closeSql();
  }
}

/**
 * The command-line run's default-branch guard, with its two visible escape states.
 *
 * The override speaks first and prints what it is allowing, the undeterminable case prints the
 * one honest line it owes and runs, and only a resolvable default branch with a foreign migration
 * in the tree refuses. The exported runMigrations() is deliberately not routed through here:
 * testcontainer suites and fresh-clone tooling call it directly, and a guard on it would need
 * every suite to seed refs no suite carries.
 */
async function enforceDefaultBranchGuard(): Promise<void> {
  if (process.env.OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD === "skip") {
    process.stderr.write(
      "OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD=skip: applying every migration the working tree " +
        "carries without comparing it against the default branch — for a disposable database " +
        "only (issue 511).\n",
    );
    return;
  }

  const defaultBranchRef = resolveDefaultBranchRef(repositoryRoot);
  if (defaultBranchRef === undefined) {
    process.stderr.write(
      `could not determine the repository's default branch from local refs (tried ` +
        `${defaultBranchRefCandidates.join(", ")}); the default-branch guard is skipped for ` +
        "this run (issue 511).\n",
    );
    return;
  }

  assertMigrationsOnDefaultBranch(
    listMigrationNames(await readdir(migrationsDirectory)),
    listDefaultBranchMigrationNames(defaultBranchRef, repositoryRoot),
    defaultBranchRef,
  );
}

function isDirectExecution(): boolean {
  const entrypoint = process.argv[1];
  return entrypoint !== undefined && import.meta.url === pathToFileURL(entrypoint).href;
}
