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
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

/**
 * The periodic restore test for the backup procedure: seed a real database, run
 * scripts/db-backup.sh against it, mutate the source, restore the dump into a
 * second scratch database with scripts/db-restore.sh, and hold the restored
 * copy against the seed.
 *
 * pg_dump and pg_restore never run from the host: the CI image may ship a
 * client older than the postgres:17 server, and pg_dump refuses a version
 * mismatch. Both tools are exec'd inside the container through the scripts'
 * OVERFLOW_PG_DUMP / OVERFLOW_PG_RESTORE prefixes, and DATABASE_URL passed to
 * the scripts names the server from inside the container (127.0.0.1:5432),
 * which is the address the exec'd tools can actually reach.
 */
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

/**
 * A connection string the tools inside the container can reach: the server is
 * in there, so the suite's own databaseUrl re-hosted onto 127.0.0.1:5432 —
 * credentials and all, whatever server (shared or private) this run got.
 */
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
    backupDir = mkdtempSync(join(tmpdir(), "overflow-backup-test-"));
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

  // A case that dies mid-flight cannot clean up after itself, so the file does
  // it here: whatever the case started, whatever route it left by. A no-op
  // whenever the case finished its own runs, which is every green run.
  afterEach(async () => {
    await reapBackupRuns();
  });

  it("refuses to back up without DATABASE_URL", () => {
    const env: NodeJS.ProcessEnv = { ...process.env };
    delete env.DATABASE_URL;
    const result = runScript(backupScript, ["--output-dir", backupDir], env);

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_URL");
  });

  it("writes a dump pg_restore can list, prints its path, and prunes past retention", () => {
    // An old dump and an old non-dump file sit in the backup directory before
    // the run: the dump shape must be pruned by --retention-days, the file that
    // does not match overflow-*.dump must survive it.
    const staleDump = join(backupDir, "overflow-20260101T000000Z.dump");
    writeFileSync(staleDump, "stale");
    utimesSync(staleDump, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    const keptFile = join(backupDir, "retention-notes.txt");
    writeFileSync(keptFile, "keep");
    utimesSync(keptFile, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));

    // Force a hostile umask in the child: workers cannot change process.umask,
    // and the test must not change the permissions policy of other test files.
    // The archive carries database contents, so the script must constrain its
    // mode even when the caller would otherwise create world-readable files.
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

    // The dump must describe the database as it was, because the source is
    // about to be mutated: what db-restore.sh returns later is the dump, not
    // the live rows.
    expect(
      dumpsIn(backupDir),
    ).toEqual([dumpPath!.split("/").pop()]);
  });

  it("reclaims a crash-leftover partial older than a day and spares young partials and real dumps", () => {
    // A run killed mid-dump leaves a .overflow-<pid>.dump.incomplete behind —
    // pid-stemmed, since two runs in one second would otherwise share one
    // partial; the next run's sweep must reclaim one older than 24 hours —
    // keyed on mtime, not anything in the name — while a young partial and
    // every real dump survive.
    const oldPartial = join(backupDir, ".overflow-20260101T000000Z.dump.incomplete");
    writeFileSync(oldPartial, "truncated");
    utimesSync(oldPartial, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-01T00:00:00Z"));
    const youngPartial = join(backupDir, ".overflow-20260102T000000Z.dump.incomplete");
    writeFileSync(youngPartial, "truncated");

    // A real dump older than the 24-hour sweep threshold but well inside the
    // 14-day retention window: a sweep whose name pattern widened past the
    // partial grammar would delete it, and the containment check below is
    // what kills such a mutant. Three days back satisfies both bounds on any
    // run date; a fixed date would age past retention and break the test.
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

    // The sweep's printed line for the reclaimed partial must reach stdout,
    // and before the final dump-path line (the print half of the two-pass
    // print-then-delete contract).
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
    // The existing sweep cases write their fixture partials by hand, so they
    // keep passing whatever the script names its own partial. This one kills a
    // real run mid-dump and reclaims what the script actually left, which is
    // what a partial name that falls outside the sweep glob would break: real
    // leftovers would sit in the directory forever, unreclaimed.
    const dir = mkdtempSync(join(tmpdir(), "overflow-backup-partial-"));
    const stubDir = mkdtempSync(join(tmpdir(), "overflow-backup-stub-"));
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
    // "Every run begins by sweeping" includes runs whose dump never
    // completes: a sweep placed after the dump completes would leave this
    // partial behind on the fail path, so this test pins the placement.
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
    // The dump must predate the mutations below: what comes back is the
    // archive's seed, not the live rows. When the whole file runs, this
    // reuses test 2's dump; alone, it produces one here first.
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

    // The mutation that must NOT have been carried: the scratch database holds
    // the dump's four seeded issues, not the live table's five.
    const [issueCount] = await drill`select count(*)::int as count from issues`;
    expect(issueCount.count).toBe(4);
  });

  it("keeps both dumps when two runs land on the same UTC second", async () => {
    // The stamp has second resolution, so two runs inside one second derive one
    // name. OVERFLOW_BACKUP_STAMP pins the stamp so the collision is the
    // variable under test rather than the wall clock: a name count alone let
    // the replacing mv through (it read "expected 1 to be 2"), so the first
    // dump is also identified by what it CONTAINS.
    const stamp = "20260930T120000Z";
    const firstName = `overflow-${stamp}.dump`;
    const secondName = `overflow-${stamp}-1.dump`;
    const thirdName = `overflow-${stamp}-2.dump`;
    const markerTitle = "same-second-marker";

    // The marker row is present for the first dump and renamed before the
    // second: a surviving first dump still restores the marker, a first dump
    // replaced by the second restores the rename.
    const [repo] = await sql<{ id: string }[]>`select id from registered_repositories where github_repository_id = ${7_400_001}`;
    await insertIssue(sql, repo.id, 7_500_006, markerTitle, "OPEN");

    // A successful run removes its own partial as it installs, and this is the
    // only place that is visible: the sweep would reclaim one after a day, so
    // a dropped cleanup here is silent. Compared against the directory as it
    // stands, because an earlier case's young partial is meant to be in it.
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
    // The invariant the defect broke: two runs, two dumps. Counted over this
    // stamp's names only, so the dumps earlier cases left in the directory do
    // not stand in for the second run's.
    expect(dumpsForStamp(backupDir, stamp), "one dump per run, neither replaced").toHaveLength(2);
    expect(existsSync(join(backupDir, firstName)), "the first run's dump, after the second run").toBe(true);
    expect(secondPath, `stdout was: ${secondRun.stdout}`).toBe(join(backupDir, secondName));
    // The run says on STDERR that it took a suffix rather than the plain name.
    // The stream is the claim: stdout's contract is that its last line is the
    // installed path, so a notice there could be read as one. Asserted on
    // stderr only — a notice on stdout as well would be the defect.
    expect(secondRun.stderr, "the collision notice").toContain("was already there");
    expect(firstRun.stderr, "no notice for a run that took the plain name").toBe("");

    // A third run proves the suffix search is a search and not a single retry.
    const thirdRun = runScript(backupScript, ["--output-dir", backupDir, "--retention-days", "14"], stampedEnv(stamp));
    expect(thirdRun.status, thirdRun.stderr).toBe(0);
    expect(printedDumpPath(thirdRun.stdout), `stdout was: ${thirdRun.stdout}`).toBe(join(backupDir, thirdName));
    expect(dumpsForStamp(backupDir, stamp), "one dump per run, none replaced").toHaveLength(3);
    // All three succeeded, so all three cleaned up after themselves.
    expect(incompleteNames(backupDir), "partials after three successful runs").toEqual(partialsBefore);

    // Content, not names: the first dump still restores the row the second no
    // longer holds, and the second restores the rename.
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
    // A name the filesystem refuses outright (here: past its length limit) is
    // not a taken name, and retrying another suffix would never help. The run
    // must abort with a message on stderr instead of searching forever.
    const before = dumpsIn(backupDir);
    const beforeIncomplete = incompleteNames(backupDir);
    const result = runScript(
      backupScript,
      ["--output-dir", backupDir, "--retention-days", "14"],
      // LC_ALL pins the message this case reads below: "File name too long"
      // is coreutils' rendering of strerror(ENAMETOOLONG), so it follows the
      // host's locale. The run is a child, so this is where the locale goes.
      { ...scriptEnv(), LC_ALL: "C", OVERFLOW_BACKUP_STAMP: "9".repeat(300) },
    );

    expect(result.status, "a run that cannot install its dump").not.toBe(0);
    // The abort arm's OWN words, not the program's name and not a regex the
    // candidate path satisfies on its own: the bound arm dies with the same
    // program name and the same path in its message, so anything less specific
    // here passes for a run that searched all 100 suffixes before giving up.
    expect(result.stderr).toContain("could not install the dump as");
    // The link's own reason has to reach the operator, or the message names a
    // failure it does not explain. This one is about the relay, not about which
    // arm fired — the line above is what discriminates the arm.
    expect(result.stderr).toContain("File name too long");
    expect(dumpsIn(backupDir), "no dump was installed by the failed run").toEqual(before);
    // The run's own partial is cleaned up on the failure path.
    expect(incompleteNames(backupDir), "partials left behind").toEqual(beforeIncomplete);
  });

  it("gives up with a message once every suffixed name is taken", () => {
    // The stub tools keep this loop fast: it is the install search under test,
    // not the dump, and a real pg_dump per attempt would make a bounded search
    // unbounded in wall-clock terms. Each iteration occupies the next name, so
    // the loop ends only when the script itself gives up. It runs in its own
    // directory because it leaves one dump-named directory per attempt behind,
    // and the shared directory's other cases count dump-shaped names.
    const dir = mkdtempSync(join(tmpdir(), "overflow-backup-bound-"));
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
      // Occupy the name this run just took, as a DIRECTORY rather than the
      // file it installed: ln against a directory target links INTO it and
      // reports success, which would install the dump somewhere nobody reads.
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
    // A backup directory restored from somewhere else, or half-recovered, can
    // carry a symlink whose target is gone. The name is taken — the link
    // refuses it — but a plain existence test follows the link, calls the name
    // free, and sends the run down the "not a collision" arm. Loud, no data
    // lost, and the night's backup is still missing: this is the -1 case.
    const dir = mkdtempSync(join(tmpdir(), "overflow-backup-symlink-"));
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
    // The atomicity requirement 3 exists for, and the case above cannot reach
    // it: its two runs are sequential, so a name chosen by a test-then-move is
    // never wrong, because no two runs are ever inside the script together.
    // These runs are all parked in the dump stub and released together, so the
    // installs overlap. Each writes bytes no other run writes, so the
    // assertions are on what the runs DID — one file per run, holding that
    // run's own content, nothing left behind. No assertion on elapsed time:
    // the barrier is a file this test creates, not a stopwatch.
    const dir = mkdtempSync(join(tmpdir(), "overflow-backup-race-"));
    const { stub, arrived, release } = barrierStub(mkdtempSync(join(tmpdir(), "overflow-backup-barrier-")));

    // Sixteen, not eight: the mutant is caught when two runs interleave between
    // their existence test and their move, and the pairs that can do that grow
    // with the square of the contender count. The kill is a rate, not a
    // certainty — what must not happen is a green suite on broken code, so the
    // count is raised until that residual is vanishing.
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

    // Release only once every run is parked inside the stub, so what follows
    // is N installs contending for one name rather than N sequential runs.
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
    // The content is the point: two runs that picked one name leave the file
    // count right and the bytes of one run gone, which is the whole defect.
    // Both sides sort, because these are labels and not numbers: run-10 sorts
    // before run-2, and comparing them in index order would be an assertion
    // about spelling that passes or fails for the wrong reason.
    expect(names.map((name) => readFileSync(join(dir, name), "utf8")).sort()).toEqual(
      Array.from({ length: runs }, (_, index) => `run-${index}\n`).sort(),
    );
    expect(incompleteNames(dir), "no run left its partial behind").toEqual([]);
  }, 120_000);

  it("reaps the runs it abandons when a barrier never opens", async () => {
    // Every route out of the case above abandons its runs rather than
    // cancelling them: a run that rejects, a barrier that never fills, the
    // case's own timeout. An abandoned run is not a leaked promise, it is a
    // live process sitting in the stub's wait loop, waking twenty times a
    // second, and there is one per participant. So this asserts the reap
    // rather than assuming it: start runs that can never be released, reap
    // them, and prove each one is gone — the script AND the stub it is parked
    // inside, which is a separate process and needs the group kill.
    const dir = mkdtempSync(join(tmpdir(), "overflow-backup-reap-"));
    const { stub, arrived, release } = barrierStub(mkdtempSync(join(tmpdir(), "overflow-backup-barrier-")));
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
    // Each stub records its own pid in its arrival marker, which is what lets
    // the assertion below reach the grandchild and not just the script.
    await vi.waitFor(() => {
      expect(readdirSync(arrived), "every run parked in the dump stub").toHaveLength(started.length);
    }, { timeout: 60_000, interval: 25 });
    const stubPids = readdirSync(arrived).map((name) => Number(readFileSync(join(arrived, name), "utf8").trim()));
    expect(started.every((run) => isAlive(run.pid)), "the runs are alive before the reap").toBe(true);
    expect(stubPids.every((pid) => Number.isInteger(pid) && isAlive(pid)), "the stubs are alive before the reap").toBe(true);
    // Registered before the reap, not asserted after it: a stub is a separate
    // process in the group, it is orphaned when the group dies, and its own
    // latency to go is bounded by nothing else the test waits on. The reap
    // below has to wait for it on the same terms as the scripts, or this case
    // is a point-in-time check landing in the window between the two.
    for (const pid of stubPids) watchReapedPid(pid);

    const reaped = await reapBackupRuns();

    expect([...reaped].sort((a, b) => a - b)).toEqual(started.map((run) => run.pid).sort((a, b) => a - b));
    // Every pid the reap was asked to cover is asserted INSIDE its bounded
    // wait, which is where the scripts' pids have always been asserted. There
    // is no bare isAlive left in this file.
    for (const pid of [...started.map((run) => run.pid), ...stubPids]) {
      expect(isAlive(pid), `pid ${pid} survived the reap`).toBe(false);
    }
    // Nothing left to reap: the registry is what makes the afterEach reap a
    // no-op rather than a second round of kills against dead pids.
    expect(await reapBackupRuns(), "a second reap has nothing left").toEqual([]);
  }, 60_000);
});

/**
 * Tests 3 and 4 consume the dump test 2 produces, and each must also pass
 * alone under a filtered -t run, so a missing dump is produced here on
 * demand instead of assumed.
 */
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

/**
 * A pg_dump stub that writes fixed bytes, for the cases that are about the
 * install loop rather than about the archive: it keeps a bounded search or a
 * run-per-attempt loop from costing a container round each time.
 */
function bytesStub(body = "custom-format-archive-bytes\n"): string {
  const stub = join(mkdtempSync(join(tmpdir(), "overflow-backup-stub-")), "pg-dump-bytes.sh");
  // The body goes in through a quoted heredoc rather than an interpolated
  // shell literal: a body carrying an apostrophe would otherwise close the
  // literal early and produce a stub that is not the stub. Written verbatim
  // after the heredoc's own newline, so the bytes are the caller's and not one
  // newline more than the caller asked for.
  const text = body.endsWith("\n") ? body : `${body}\n`;
  writeFileSync(stub, `#!/bin/sh\ncat <<'OVERFLOW_STUB_EOF'\n${text}OVERFLOW_STUB_EOF\n`);
  chmodSync(stub, 0o700);
  return stub;
}

/**
 * A pg_dump stub that parks every run on a barrier file: it records its own
 * pid where the test can find it, then blocks until the test creates the
 * release file. The wait is bounded, so a run whose barrier never opens ends
 * itself instead of outliving the case that was watching it.
 */
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

/**
 * Processes a case has asked the reap to wait for besides the runs themselves:
 * the stubs, which are separate processes in the same group and reach their
 * own exit on their own schedule. Kept here rather than in the case so the
 * afterEach covers them too — a case that dies between spawning and reaping
 * must not leave a stub behind either.
 */
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

/**
 * Kill every backup run still alive, and wait until it — and every watched pid
 * — is gone. Returns the run pids it reaped so a case can assert on the set
 * rather than assume the kill landed.
 *
 * A run is its own process group (see startBackup), so the kill reaches the
 * whole tree — the script and the stub it is waiting inside. Signalling only
 * the script would leave the stub polling a barrier nobody will ever open, and
 * the two die on their own schedules, so the wait covers both classes. Waiting
 * on the scripts alone left the assertion on the stubs a single point-in-time
 * check that reddened correct code about once in twenty-five runs.
 */
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

/**
 * Start one backup run without waiting for it, so several can overlap. The run
 * is detached into its own process group and registered for reaping, because
 * every route out of the case that starts it — a rejected run, a barrier that
 * never fills, the case's own timeout — abandons the others rather than
 * cancelling them, and an abandoned run sits in the stub waking 20 times a
 * second for as long as the box keeps it.
 */
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
