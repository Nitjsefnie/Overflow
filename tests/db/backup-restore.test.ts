import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";
import { createOwnedTempDirectoryRegistry } from "../support/owned-temp-directory";

const backupFixtures = createOwnedTempDirectoryRegistry([
  "overflow-backup-partial-", "overflow-backup-stub-", "overflow-backup-bound-",
  "overflow-backup-symlink-", "overflow-backup-race-", "overflow-backup-reap-", "overflow-backup-barrier-",
  "overflow-backup-test-",
].map(prefix => join(tmpdir(), prefix)));

// Use container clients to match the server version and its internal URL.
const DATABASE = "backup_restore_test";
const DRILL_DATABASE = "backup_restore_drill";
/** Two scratch databases, one per dump of the same-second collision test. */
const FIRST_RUN_DATABASE = "backup_restore_first_run";
const SECOND_RUN_DATABASE = "backup_restore_second_run";
const backupScript = resolve("scripts/db-backup.sh");
const restoreScript = resolve("scripts/db-restore.sh");

let container: StartedTestContainer | undefined;
/** The databaseUrl startPostgresContainer returned; every tool URL derives from it. */
let sourceDatabaseUrl: string | undefined;
/** The database that URL names: the logical name plus the shared server's per-suite suffix. */
let sourceDatabaseName: string | undefined;
let sql: Sql;
let drill: Sql | undefined;
let backupDir: string;
let dumpPath: string | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;

/** The tables the comparison holds against the seed, in a stable order. */
const comparedTables: ReadonlyArray<{ table: string; orderBy: string; columns: string[] }> = [
  { table: "users", orderBy: "github_user_id", columns: ["github_user_id", "github_login"] },
  {
    table: "registered_repositories",
    orderBy: "github_repository_id",
    columns: ["github_repository_id", "owner_name", "visibility"],
  },
  {
    table: "issues",
    orderBy: "github_issue_id",
    columns: ["github_issue_id", "issue_number", "title", "state"],
  },
];

const seedRows: Map<string, Record<string, unknown>[]> = new Map();

// Container tools connect through the internal port with this suite’s credentials.
function containerInternalUrl(database: string): string {
  const url = new URL(sourceDatabaseUrl!);
  url.hostname = "127.0.0.1";
  url.port = "5432";
  url.pathname = `/${database}`;
  url.search = "";
  return url.toString();
}

/** A connection string a host-side client can reach: the mapped port. */
function hostUrl(database: string): string {
  const url = new URL(sourceDatabaseUrl!);
  url.pathname = `/${database}`;
  return url.toString();
}

function runScript(script: string, args: string[], env: NodeJS.ProcessEnv): SpawnSyncReturns<string> {
  return spawnSync("sh", [script, ...args], { env, encoding: "utf8" });
}

describe("the backup and restore procedure", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: DATABASE,
      user: DATABASE,
      password: DATABASE,
    });
    container = started.container;
    sourceDatabaseUrl = started.databaseUrl;
    sourceDatabaseName = new URL(started.databaseUrl).pathname.slice(1);
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
  });

  beforeEach(async () => {
    await sql`truncate users cascade`;
    backupDir = backupFixtures.create(join(tmpdir(), "overflow-backup-test-"));
    dumpPath = undefined;
    await seed();
    await snapshot();
  });

  afterAll(async () => {
    await closeSql();
    await drill?.end();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  // Reap processes before removing their fixture files, even after a failed case.
  afterEach(async () => {
    try {
      await reapBackupRuns();
    } finally {
      try {
        await drill?.end();
      } finally {
        drill = undefined;
        try {
          if (backupDir !== undefined) backupFixtures.dispose(backupDir);
        } finally {
          backupFixtures.dispose();
        }
      }
    }
  });

  it("refuses to back up without DATABASE_URL", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    const result = runScript(backupScript, ["--output-dir", backupDir], env);

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_URL");
  });

  it("writes a dump pg_restore can list, prints its path, and prunes past retention", () => {
    // Retention must spare unrelated files.
    const staleDump = join(backupDir, "overflow-20260101T000000Z.dump");
    writeFileSync(staleDump, "stale");
    utimesSync(staleDump, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    const keptFile = join(backupDir, "retention-notes.txt");
    writeFileSync(keptFile, "keep");
    utimesSync(keptFile, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

    // A hostile child umask must still produce a private archive.
    const result = spawnSync("sh", [
      "-c", 'umask 022; exec sh "$@"', "backup-with-hostile-umask",
      backupScript, "--output-dir", backupDir, "--retention-days", "14",
    ], { env: scriptEnv(), encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
    dumpPath = printedDumpPath(result.stdout);
    expect(dumpPath, `stdout was: ${result.stdout}`).toBeDefined();
    expect(existsSync(dumpPath!)).toBe(true);
    expect(statSync(dumpPath!).size).toBeGreaterThan(0);
    expect(statSync(dumpPath!).mode & 0o777, "the dump file's mode").toBe(0o600);
    expect(existsSync(staleDump)).toBe(false);
    expect(existsSync(keptFile)).toBe(true);

    // This test's directory contains exactly its own newly installed dump.
    expect(
      dumpsIn(backupDir),
    ).toEqual([dumpPath!.split("/").pop()]);
  });

  it("reclaims a crash-leftover partial older than a day and spares young partials and real dumps", () => {
    // Sweep old partials by mtime while preserving young partials and real dumps.
    const oldPartial = join(backupDir, ".overflow-20260101T000000Z.dump.incomplete");
    writeFileSync(oldPartial, "truncated");
    utimesSync(oldPartial, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    const youngPartial = join(backupDir, ".overflow-20260102T000000Z.dump.incomplete");
    writeFileSync(youngPartial, "truncated");

    // A relative age stays between sweep and retention thresholds on every run date.
    const withinRetentionDump = join(backupDir, "overflow-20260920T000000Z.dump");
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    writeFileSync(withinRetentionDump, "within-retention");
    utimesSync(withinRetentionDump, threeDaysAgo, threeDaysAgo);

    const dumpsBefore = dumpsIn(backupDir);

    const result = runScript(backupScript, ["--output-dir", backupDir, "--retention-days", "14"], scriptEnv());

    expect(result.status, result.stderr).toBe(0);
    const freshDumpPath = printedDumpPath(result.stdout);
    expect(freshDumpPath, `stdout was: ${result.stdout}`).toBeDefined();

    expect(existsSync(oldPartial), "the old partial").toBe(false);
    expect(existsSync(youngPartial), "the young partial").toBe(true);

    // The sweep notice precedes the final dump path.
    expect(result.stdout).toContain(oldPartial);
    expect(
      result.stdout.indexOf(oldPartial),
      "the sweep's line for the reclaimed partial precedes the dump path",
    ).toBeLessThan(result.stdout.indexOf(freshDumpPath!));

    const dumpsAfter = dumpsIn(backupDir);
    for (const name of dumpsBefore) {
      expect(dumpsAfter, "real dumps present before the run").toContain(name);
    }
    const freshDumpName = freshDumpPath!.split("/").pop()!;
    expect(dumpsAfter).toContain(freshDumpName);
    expect(statSync(freshDumpPath!).size).toBeGreaterThan(0);
  });

  it("reclaims a partial left by a killed run of the current script", () => {
    // Reclaim a real killed run’s partial so a mismatched sweep glob fails.
    const dir = backupFixtures.create(join(tmpdir(), "overflow-backup-partial-"));
    const stubDir = backupFixtures.create(join(tmpdir(), "overflow-backup-stub-"));
    const killer = join(stubDir, "pg-dump-killer.sh");
    writeFileSync(killer, "#!/bin/sh\nprintf 'partial-bytes\\n'\nkill -9 $PPID\n");
    chmodSync(killer, 0o700);

    const killed = runScript(
      backupScript,
      ["--output-dir", dir],
      { ...scriptEnv(), OVERFLOW_PG_DUMP: killer, OVERFLOW_BACKUP_STAMP: "20260930T123000Z" },
    );
    expect(killed.status, "a run killed mid-dump").not.toBe(0);

    const partials = incompleteNames(dir);
    expect(partials, "the partial the killed run left behind").toHaveLength(1);
    const old = new Date("2026-01-01T00:00:00Z");
    utimesSync(join(dir, partials[0]!), old, old);

    const result = runScript(backupScript, ["--output-dir", dir], scriptEnv());

    expect(result.status, result.stderr).toBe(0);
    expect(existsSync(join(dir, partials[0]!)), "the killed run's own partial, past 24 hours").toBe(false);
    // The sweep prints what it reclaims before the final dump-path line.
    expect(result.stdout).toContain(partials[0]!);
  });

  it("sweeps crash leftovers even when the dump itself fails", () => {
    // Sweep before dumping so a failed dump still reclaims leftovers.
    const oldPartial = join(backupDir, ".overflow-20260103T000000Z.dump.incomplete");
    writeFileSync(oldPartial, "truncated");
    utimesSync(oldPartial, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

    const result = runScript(
      backupScript,
      ["--output-dir", backupDir, "--retention-days", "14"],
      { ...scriptEnv(), OVERFLOW_PG_DUMP: "false" },
    );

    expect(result.status, result.stderr).not.toBe(0);
    expect(existsSync(oldPartial), "the partial from the earlier crashed run").toBe(false);
  });

  it("refuses to restore onto the database DATABASE_URL names without --allow-live", async () => {
    const dump = await ensureDump();
    const [before] = await sql`select count(*)::int as count from issues`;
    const result = runScript(
      restoreScript,
      [sourceDatabaseName!, dump],
      scriptEnv(),
    );

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("--allow-live");
    const [after] = await sql`select count(*)::int as count from issues`;
    expect(after.count).toBe(before.count);
  });

  it("restores the dump into a scratch database reproducing the seeded rows", async () => {
    // Arrange this test's dump before mutating the source database.
    const dump = await ensureDump();
    await sql`update users set github_login = ${"mutated-owner"} where github_user_id = ${7_300_002}`;
    await sql`delete from issues where github_issue_id = ${7_500_004}`;
    const [repo] = await sql<{ id: string }[]>`select id from registered_repositories where github_repository_id = ${7_400_001}`;
    await insertIssue(sql, repo.id, 7_500_005, "Mutated issue five", "OPEN");

    await sql`drop database if exists ${sql(DRILL_DATABASE)}`;
    await sql`create database ${sql(DRILL_DATABASE)}`;

    const result = runScript(
      restoreScript,
      [DRILL_DATABASE, dump],
      scriptEnv(),
    );

    expect(result.status, result.stderr).toBe(0);

    drill = postgres(hostUrl(DRILL_DATABASE), { max: 1 });
    for (const { table, orderBy, columns } of comparedTables) {
      const restored = await drill.unsafe(`select ${columns.join(", ")} from ${table} order by ${orderBy}`);
      expect(restored, table).toEqual(seedRows.get(table));
    }

    // The restored rows must predate the live mutation.
    const [issueCount] = await drill`select count(*)::int as count from issues`;
    expect(issueCount.count).toBe(4);
  });

  it("keeps both dumps when two runs land on the same UTC second", async () => {
    // Pin the stamp and restored content to distinguish collisions from replacement.
    const stamp = "20260930T120000Z";
    const firstName = `overflow-${stamp}.dump`;
    const secondName = `overflow-${stamp}-1.dump`;
    const thirdName = `overflow-${stamp}-2.dump`;
    const markerTitle = "same-second-marker";

    // Rename between dumps to identify each restored archive.
    const [repo] = await sql<{ id: string }[]>`select id from registered_repositories where github_repository_id = ${7_400_001}`;
    await insertIssue(sql, repo.id, 7_500_006, markerTitle, "OPEN");

    // Observe partial removal before a later sweep could hide it.
    const partialsBefore = incompleteNames(backupDir);

    const firstRun = runScript(backupScript, ["--output-dir", backupDir, "--retention-days", "14"], stampedEnv(stamp));
    expect(firstRun.status, firstRun.stderr).toBe(0);
    expect(printedDumpPath(firstRun.stdout), `stdout was: ${firstRun.stdout}`).toBe(join(backupDir, firstName));

    await sql`update issues set title = ${"renamed-after-the-first-dump"} where github_issue_id = ${7_500_006}`;

    const secondRun = runScript(backupScript, ["--output-dir", backupDir, "--retention-days", "14"], stampedEnv(stamp));
    expect(secondRun.status, secondRun.stderr).toBe(0);
    const secondPath = printedDumpPath(secondRun.stdout);
    expect(secondPath, `stdout was: ${secondRun.stdout}`).toBeDefined();
    expect(existsSync(secondPath!), "the second run's dump").toBe(true);
    // Count this stamp only so unrelated dumps cannot satisfy the collision test.
    expect(dumpsForStamp(backupDir, stamp), "one dump per run, neither replaced").toHaveLength(2);
    expect(existsSync(join(backupDir, firstName)), "the first run's dump, after the second run").toBe(true);
    expect(secondPath, `stdout was: ${secondRun.stdout}`).toBe(join(backupDir, secondName));
    // Collision notices stay on stderr; stdout remains one dump path per run.
    expect(secondRun.stderr, "the collision notice").toContain("was already there");
    expect(firstRun.stderr, "no notice for a run that took the plain name").toBe("");

    // A third run proves the suffix search is a search and not a single retry.
    const thirdRun = runScript(backupScript, ["--output-dir", backupDir, "--retention-days", "14"], stampedEnv(stamp));
    expect(thirdRun.status, thirdRun.stderr).toBe(0);
    expect(printedDumpPath(thirdRun.stdout), `stdout was: ${thirdRun.stdout}`).toBe(join(backupDir, thirdName));
    expect(dumpsForStamp(backupDir, stamp), "one dump per run, none replaced").toHaveLength(3);
    // All three succeeded, so all three cleaned up after themselves.
    expect(incompleteNames(backupDir), "partials after three successful runs").toEqual(partialsBefore);

    // Restored contents distinguish the two dumps.
    const firstRestored = await restoreInto(FIRST_RUN_DATABASE, join(backupDir, firstName));
    try {
      const rows = await firstRestored`select title from issues where github_issue_id = ${7_500_006}`;
      expect(rows.map((row) => row.title), "the surviving first dump's contents").toEqual([markerTitle]);
    } finally {
      await firstRestored.end();
    }

    const secondRestored = await restoreInto(SECOND_RUN_DATABASE, join(backupDir, secondName));
    try {
      const rows = await secondRestored`select title from issues where github_issue_id = ${7_500_006}`;
      expect(rows.map((row) => row.title), "the second dump's contents").toEqual(["renamed-after-the-first-dump"]);
    } finally {
      await secondRestored.end();
    }
  });

  it("fails loudly when the dump cannot be installed for a reason other than a taken name", () => {
    // An invalid filename must abort rather than search suffixes.
    const before = dumpsIn(backupDir);
    const beforeIncomplete = incompleteNames(backupDir);
    const result = runScript(
      backupScript,
      ["--output-dir", backupDir, "--retention-days", "14"],
      // Pin the child locale for the ENAMETOOLONG diagnostic.
      { ...scriptEnv(), LC_ALL: "C", OVERFLOW_BACKUP_STAMP: "9".repeat(300) },
    );

    expect(result.status, "a run that cannot install its dump").not.toBe(0);
    // The abort wording distinguishes this branch from suffix exhaustion.
    expect(result.stderr).toContain("could not install the dump as");
    // Relay the filesystem reason to the operator.
    expect(result.stderr).toContain("File name too long");
    expect(dumpsIn(backupDir), "no dump was installed by the failed run").toEqual(before);
    // The run's own partial is cleaned up on the failure path.
    expect(incompleteNames(backupDir), "partials left behind").toEqual(beforeIncomplete);
  });

  it("gives up with a message once every suffixed name is taken", () => {
    // Stub bytes isolate bounded name search from container dump latency.
    const dir = backupFixtures.create(join(tmpdir(), "overflow-backup-bound-"));
    const stamp = "20260930T121500Z";
    const env: NodeJS.ProcessEnv = {
      ...scriptEnv(),
      OVERFLOW_PG_DUMP: bytesStub(),
      OVERFLOW_PG_RESTORE: "true",
      OVERFLOW_BACKUP_STAMP: stamp,
    };

    let result = runScript(backupScript, ["--output-dir", dir, "--retention-days", "14"], env);
    const occupied: string[] = [];
    for (let taken = 0; result.status === 0 && taken < 1000; taken += 1) {
      // An occupied directory catches ln linking into the destination.
      const installed = printedDumpPath(result.stdout);
      expect(installed, `stdout was: ${result.stdout}`).toBeDefined();
      const name = join(dir, basename(installed!));
      rmSync(name, { force: true });
      mkdirSync(name);
      occupied.push(name);
      result = runScript(backupScript, ["--output-dir", dir, "--retention-days", "14"], env);
    }

    expect(result.status, `the run that found every name taken; stderr was: ${result.stderr}`).not.toBe(0);
    expect(result.stderr).toContain(stamp);
    expect(occupied.length, "the search was bounded, and long before this cap").toBeLessThan(1000);
    // Nothing was linked into an occupied name.
    for (const name of occupied) {
      expect(readdirSync(name), `contents of the occupied name ${name}`).toEqual([]);
    }
  });

  it("takes the next suffix past a dangling symlink sitting on the plain name", () => {
    // A dangling symlink still occupies its name.
    const dir = backupFixtures.create(join(tmpdir(), "overflow-backup-symlink-"));
    const stamp = "20260930T133000Z";
    symlinkSync(join(dir, "target-that-was-removed"), join(dir, `overflow-${stamp}.dump`));

    const result = runScript(
      backupScript,
      ["--output-dir", dir, "--retention-days", "14"],
      {
        ...scriptEnv(),
        OVERFLOW_PG_DUMP: bytesStub("dump-behind-a-dangling-link\n"),
        OVERFLOW_PG_RESTORE: "true",
        OVERFLOW_BACKUP_STAMP: stamp,
      },
    );

    expect(result.status, `stderr was: ${result.stderr}`).toBe(0);
    const installed = printedDumpPath(result.stdout);
    expect(installed, `stdout was: ${result.stdout}`).toBe(join(dir, `overflow-${stamp}-1.dump`));
    expect(readFileSync(installed!, "utf8")).toBe("dump-behind-a-dangling-link\n");
  });

  it("keeps every run's dump when same-second runs install at the same time", async () => {
    // The barrier forces overlapping installs and distinct contents identify every run.
    const dir = backupFixtures.create(join(tmpdir(), "overflow-backup-race-"));
    const { stub, arrived, release } = barrierStub(backupFixtures.create(join(tmpdir(), "overflow-backup-barrier-")));

    // Sixteen contenders increase the chance of catching a non-atomic install.
    const runs = 16;
    const stamp = "20260930T130000Z";
    const running = Array.from({ length: runs }, (_, index) =>
      startBackup(
        ["--output-dir", dir, "--retention-days", "14"],
        {
          ...scriptEnv(),
          OVERFLOW_PG_DUMP: stub,
          OVERFLOW_PG_RESTORE: "true",
          OVERFLOW_BACKUP_STAMP: stamp,
          BARRIER_ARRIVED: arrived,
          BARRIER_RELEASE: release,
          BARRIER_MARKER: `run-${index}`,
        },
      ),
    );

    // Release only after every contender reaches the stub.
    await vi.waitFor(() => {
      expect(readdirSync(arrived), "every run parked in the dump stub").toHaveLength(runs);
    }, { timeout: 60_000, interval: 25 });
    writeFileSync(release, "");
    const finished = await Promise.all(running.map((run) => run.finished));
    for (const [index, run] of finished.entries()) {
      expect(run.status, `run-${index} stderr: ${run.stderr}`).toBe(0);
    }

    const names = dumpsIn(dir).sort();
    expect(names, "one dump per run, none sharing a name").toHaveLength(runs);
    // Sort labels lexically: run-10 precedes run-2.
    expect(names.map((name) => readFileSync(join(dir, name), "utf8")).sort()).toEqual(
      Array.from({ length: runs }, (_, index) => `run-${index}\n`).sort(),
    );
    expect(incompleteNames(dir), "no run left its partial behind").toEqual([]);
  }, 120_000);

  it("reaps the runs it abandons when a barrier never opens", async () => {
    // Reap abandoned script groups and their stub processes after every exit path.
    const dir = backupFixtures.create(join(tmpdir(), "overflow-backup-reap-"));
    const { stub, arrived, release } = barrierStub(backupFixtures.create(join(tmpdir(), "overflow-backup-barrier-")));
    const stamp = "20260930T134500Z";

    const started = Array.from({ length: 4 }, (_, index) =>
      startBackup(
        ["--output-dir", dir, "--retention-days", "14"],
        {
          ...scriptEnv(),
          OVERFLOW_PG_DUMP: stub,
          OVERFLOW_PG_RESTORE: "true",
          OVERFLOW_BACKUP_STAMP: stamp,
          BARRIER_ARRIVED: arrived,
          BARRIER_RELEASE: release,
          BARRIER_MARKER: `stranded-${index}`,
        },
      ),
    );
    // Arrival files expose the stub grandchildren’s PIDs.
    await vi.waitFor(() => {
      expect(readdirSync(arrived), "every run parked in the dump stub").toHaveLength(started.length);
    }, { timeout: 60_000, interval: 25 });
    const stubPids = readdirSync(arrived).map((name) => Number(readFileSync(join(arrived, name), "utf8").trim()));
    expect(started.every((run) => isAlive(run.pid)), "the runs are alive before the reap").toBe(true);
    expect(stubPids.every((pid) => Number.isInteger(pid) && isAlive(pid)), "the stubs are alive before the reap").toBe(true);
    // Register stubs before reaping so the bounded wait covers their separate exits.
    for (const pid of stubPids) watchReapedPid(pid);

    const reaped = await reapBackupRuns();

    expect([...reaped].sort((a, b) => a - b)).toEqual(started.map((run) => run.pid).sort((a, b) => a - b));
    // Assert all watched PIDs inside the bounded wait.
    for (const pid of [...started.map((run) => run.pid), ...stubPids]) {
      expect(isAlive(pid), `pid ${pid} survived the reap`).toBe(false);
    }
    // An empty registry makes repeated reaping harmless.
    expect(await reapBackupRuns(), "a second reap has nothing left").toEqual([]);
  }, 60_000);
});

/** Produce a dump of this test's seeded source before any mutations. */
async function ensureDump(): Promise<string> {
  if (dumpPath !== undefined) {
    return dumpPath;
  }
  const result = runScript(
    backupScript,
    ["--output-dir", backupDir, "--retention-days", "14"],
    scriptEnv(),
  );
  expect(result.status, result.stderr).toBe(0);
  const printed = printedDumpPath(result.stdout);
  if (printed === undefined) {
    throw new Error(`db-backup.sh printed no dump path; stdout was: ${result.stdout}`);
  }
  dumpPath = printed;
  return dumpPath;
}

/** Environment for a script run: container-internal DATABASE_URL, exec'd client tools. */
function scriptEnv(): NodeJS.ProcessEnv {
  const exec = (tool: string) => `docker exec -i ${container!.getId()} ${tool}`;
  return {
    ...process.env,
    DATABASE_URL: containerInternalUrl(sourceDatabaseName!),
    OVERFLOW_PG_DUMP: exec("pg_dump"),
    OVERFLOW_PG_RESTORE: exec("pg_restore"),
  };
}

/** scriptEnv with the run's stamp pinned, so two runs collide on purpose. */
function stampedEnv(stamp: string): NodeJS.ProcessEnv {
  return { ...scriptEnv(), OVERFLOW_BACKUP_STAMP: stamp };
}

/** The dumps in a directory, by the same matcher the prune and the tests use. */
function dumpsIn(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /^overflow-.*\.dump$/.test(entry.name))
    .map((entry) => entry.name);
}

/** The dumps one stamp produced: the name count a replaced dump collapses. */
function dumpsForStamp(directory: string, stamp: string): string[] {
  return dumpsIn(directory).filter((name) => name.startsWith(`overflow-${stamp}`));
}

/** The crash-leftover partials in a directory. */
function incompleteNames(directory: string): string[] {
  return readdirSync(directory).filter((name) => name.endsWith(".incomplete"));
}

/** Restore a dump into a fresh scratch database and hand back a client for it. */
async function restoreInto(database: string, dump: string): Promise<Sql> {
  await sql`drop database if exists ${sql(database)}`;
  await sql`create database ${sql(database)}`;
  const result = runScript(restoreScript, [database, dump], scriptEnv());
  expect(result.status, result.stderr).toBe(0);
  return postgres(hostUrl(database), { max: 1 });
}

// Stub bytes keep install tests independent of pg_dump cost.
function bytesStub(body = "custom-format-archive-bytes\n"): string {
  const stub = join(backupFixtures.create(join(tmpdir(), "overflow-backup-stub-")), "pg-dump-bytes.sh");
  // A quoted heredoc preserves apostrophes and the caller’s exact trailing newline.
  const text = body.endsWith("\n") ? body : `${body}\n`;
  writeFileSync(stub, `#!/bin/sh\ncat <<'OVERFLOW_STUB_EOF'\n${text}OVERFLOW_STUB_EOF\n`);
  chmodSync(stub, 0o700);
  return stub;
}

// Bound the barrier wait so an unreleased stub cannot outlive its case.
function barrierStub(barrierDir: string): { stub: string; arrived: string; release: string } {
  const arrived = join(barrierDir, "arrived");
  const release = join(barrierDir, "release");
  mkdirSync(arrived);
  const stub = join(barrierDir, "pg-dump-barrier.sh");
  writeFileSync(
    stub,
    [
      "#!/bin/sh",
      'printf "%s\\n" "$$" > "$BARRIER_ARRIVED/$BARRIER_MARKER"',
      'waited=0',
      'while [ ! -e "$BARRIER_RELEASE" ] && [ "$waited" -lt 600 ]; do',
      "  sleep 0.05",
      "  waited=$((waited + 1))",
      "done",
      'printf "%s\\n" "$BARRIER_MARKER"',
      "",
    ].join("\n"),
  );
  chmodSync(stub, 0o700);
  return { stub, arrived, release };
}

/** Backup runs this file has started and not yet reaped, by pid. */
const unreapedBackups = new Set<number>();

// Track stubs separately so afterEach also waits for their exits.
const watchedReapPids = new Set<number>();

/** Add a pid the reap must wait for, and which a bare check may not replace. */
function watchReapedPid(pid: number): void {
  watchedReapPids.add(pid);
}

/** Whether a pid is still a live process we could signal. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Kill whole groups and wait for both scripts and watched stubs to disappear.
async function reapBackupRuns(): Promise<number[]> {
  const pids = [...unreapedBackups];
  const watched = [...watchedReapPids];
  unreapedBackups.clear();
  watchedReapPids.clear();
  for (const pid of pids) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone, or never made it into a group of its own.
    }
  }
  await vi.waitFor(
    () => {
      for (const pid of [...pids, ...watched]) {
        expect(isAlive(pid), `pid ${pid} is still alive after the reap`).toBe(false);
      }
    },
    { timeout: 15_000, interval: 20 },
  );
  return pids;
}

// Register detached groups immediately so a failed case still reaps them.
function startBackup(
  args: string[],
  env: NodeJS.ProcessEnv,
): { pid: number; finished: Promise<{ status: number | null; stderr: string }> } {
  const child = spawn("sh", [backupScript, ...args], { env, detached: true });
  const pid = child.pid;
  if (pid === undefined) {
    throw new Error("spawning a backup run returned no pid");
  }
  unreapedBackups.add(pid);
  const finished = new Promise<{ status: number | null; stderr: string }>((resolveRun, rejectRun) => {
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      unreapedBackups.delete(pid);
      rejectRun(error);
    });
    child.on("close", (status) => {
      unreapedBackups.delete(pid);
      resolveRun({ status, stderr });
    });
  });
  return { pid, finished };
}

function printedDumpPath(stdout: string): string | undefined {
  const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
  const last = lines.at(-1)?.trim();
  return last && /overflow-.*\.dump$/.test(last) ? last : undefined;
}

async function seed(): Promise<void> {
  await sql`insert into users (github_user_id, github_login) values
    (${7_300_001}, ${"seed-sponsor"}),
    (${7_300_002}, ${"seed-owner"}),
    (${7_300_003}, ${"seed-third"})`;
  const owner = await sql<{ id: string }[]>`select id from users where github_user_id = ${7_300_002}`;
  const third = await sql<{ id: string }[]>`select id from users where github_user_id = ${7_300_003}`;
  await sql`insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    ) values
    (${7_400_001}, ${"seed-owner/repository-one"}, ${owner[0]!.id}, ${"PUBLIC"}, ${7_600_001}, ${sql.json(validDifficultyScheme())}::jsonb),
    (${7_400_002}, ${"seed-third/repository-two"}, ${third[0]!.id}, ${"PUBLIC"}, ${7_600_002}, ${sql.json(validDifficultyScheme())}::jsonb)`;
  const repoOne = await sql<{ id: string }[]>`select id from registered_repositories where github_repository_id = ${7_400_001}`;
  const repoTwo = await sql<{ id: string }[]>`select id from registered_repositories where github_repository_id = ${7_400_002}`;
  await insertIssue(sql, repoOne[0]!.id, 7_500_001, "Seed issue one", "OPEN");
  await insertIssue(sql, repoOne[0]!.id, 7_500_002, "Seed issue two", "OPEN");
  await insertIssue(sql, repoTwo[0]!.id, 7_500_003, "Seed issue three", "CLOSED");
  await insertIssue(sql, repoTwo[0]!.id, 7_500_004, "Seed issue four", "CLOSED");
}

async function insertIssue(client: Sql, repositoryId: string, githubIssueId: number, title: string, state: string): Promise<void> {
  await client`
    insert into issues (
      github_issue_id,
      repository_id,
      issue_number,
      title,
      body,
      url,
      state,
      opening_label,
      opening_comparison_points,
      opening_reserve_points
    )
    values (
      ${githubIssueId},
      ${repositoryId},
      ${githubIssueId},
      ${title},
      ${"Seed issue body"},
      ${`https://github.com/seed/repository/issues/${githubIssueId}`},
      ${state},
      ${"size/M"},
      5,
      5
    )`;
}

async function snapshot(): Promise<void> {
  for (const { table, orderBy, columns } of comparedTables) {
    seedRows.set(table, await sql.unsafe(`select ${columns.join(", ")} from ${table} order by ${orderBy}`));
  }
}
