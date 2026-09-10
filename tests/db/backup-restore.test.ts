import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { existsSync, readdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
const backupScript = resolve("scripts/db-backup.sh");
const restoreScript = resolve("scripts/db-restore.sh");

let container: StartedTestContainer | undefined;
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

/** A connection string the tools inside the container can reach: the server is in there. */
function containerInternalUrl(database: string): string {
  return `postgresql://${DATABASE}:${DATABASE}@127.0.0.1:5432/${database}`;
}

/** A connection string a host-side client can reach: the mapped port. */
function hostUrl(database: string): string {
  return `postgresql://${DATABASE}:${DATABASE}@${container!.getHost()}:${container!.getMappedPort(5432)}/${database}?client_min_messages=warning`;
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

    const result = runScript(
      backupScript,
      ["--output-dir", backupDir, "--retention-days", "14"],
      scriptEnv(),
    );

    expect(result.status, result.stderr).toBe(0);
    dumpPath = printedDumpPath(result.stdout);
    expect(dumpPath, `stdout was: ${result.stdout}`).toBeDefined();
    expect(existsSync(dumpPath!)).toBe(true);
    expect(statSync(dumpPath!).size).toBeGreaterThan(0);
    expect(existsSync(staleDump)).toBe(false);
    expect(existsSync(keptFile)).toBe(true);

    // The dump must describe the database as it was, because the source is
    // about to be mutated: what db-restore.sh returns later is the dump, not
    // the live rows.
    expect(
      readdirSync(backupDir).filter((name) => /^overflow-.*\.dump$/.test(name)),
    ).toEqual([dumpPath!.split("/").pop()]);
  });

  it("refuses to restore onto the database DATABASE_URL names without --allow-live", async () => {
    const [before] = await sql`select count(*)::int as count from issues`;
    const result = runScript(
      restoreScript,
      [DATABASE, dumpPath!],
      scriptEnv(),
    );

    expect(result.status, result.stderr).not.toBe(0);
    expect(result.stderr).toContain("--allow-live");
    const [after] = await sql`select count(*)::int as count from issues`;
    expect(after.count).toBe(before.count);
  });

  it("restores the dump into a scratch database reproducing the seeded rows", async () => {
    // Mutate the source after the dump exists: deleted and changed rows prove
    // the restore reads the archive, and an added row proves it carries
    // nothing else.
    await sql`update users set github_login = ${"mutated-owner"} where github_user_id = ${7_300_002}`;
    await sql`delete from issues where github_issue_id = ${7_500_004}`;
    const [repo] = await sql<{ id: string }[]>`select id from registered_repositories where github_repository_id = ${7_400_001}`;
    await insertIssue(sql, repo.id, 7_500_005, "Mutated issue five", "OPEN");

    await sql`drop database if exists ${sql(DRILL_DATABASE)}`;
    await sql`create database ${sql(DRILL_DATABASE)}`;

    const result = runScript(
      restoreScript,
      [DRILL_DATABASE, dumpPath!],
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
});

/** Environment for a script run: container-internal DATABASE_URL, exec'd client tools. */
function scriptEnv(): NodeJS.ProcessEnv {
  const exec = (tool: string) => `docker exec -i ${container!.getId()} ${tool}`;
  return {
    ...process.env,
    DATABASE_URL: containerInternalUrl(DATABASE),
    OVERFLOW_PG_DUMP: exec("pg_dump"),
    OVERFLOW_PG_RESTORE: exec("pg_restore"),
  };
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
