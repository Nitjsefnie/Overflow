import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { countOperationStatements, measurePerfWorkloads } from "../../scripts/perf-workloads.ts";
import {
  POSTGRES_IMAGE, postgresConnectionUrl, postgresWaitStrategy,
  publishPostgresOnLoopback, startedPostgresEndpoint,
} from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: ReturnType<typeof postgres>;
let databaseUrl: string;
const previousMigrationGuard = process.env.OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD;
const root = fileURLToPath(new URL("../../", import.meta.url));

beforeAll(async () => {
  const password = randomBytes(24).toString("hex");
  const options = { database: "overflow_ci", user: "perf_test" };
  const built = new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({ POSTGRES_DB: options.database, POSTGRES_USER: options.user, POSTGRES_PASSWORD: password })
    .withExposedPorts(5432)
    .withWaitStrategy(postgresWaitStrategy(options));
  publishPostgresOnLoopback(built, "0");
  container = await built.start();
  databaseUrl = postgresConnectionUrl({ ...options, password, ...await startedPostgresEndpoint(container) });
  process.env.OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD = "skip";
  const migration = spawnSync("pnpm", ["db:migrate"], {
    cwd: root, encoding: "utf8", env: { ...process.env, OVERFLOW_DATABASE_URL: databaseUrl },
  });
  expect(migration.status, migration.stderr).toBe(0);
  sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
});

beforeEach(async () => {
  await sql`insert into users (github_user_id, github_login) values (1, 'parent-sentinel')
    on conflict (github_user_id) do update set github_login = excluded.github_login`;
});

afterAll(async () => {
  await sql?.end();
  await container?.stop();
  if (previousMigrationGuard === undefined) delete process.env.OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD;
  else process.env.OVERFLOW_MIGRATE_DEFAULT_BRANCH_GUARD = previousMigrationGuard;
});

it("measures all real workloads twice deterministically without touching the parent database", async () => {
  const measurements = await measurePerfWorkloads(databaseUrl);
  process.stdout.write(`${JSON.stringify(measurements)}\n`);
  expect(Object.keys(measurements).sort()).toEqual(["board-load", "repository-fold", "webhook-ingestion"]);
  for (const samples of Object.values(measurements)) {
    expect(samples).toHaveLength(2);
    expect(samples[0]).toBeGreaterThan(0);
    expect(samples[1]).toBe(samples[0]);
  }
  const users = await sql`select github_login from users`;
  expect(users).toEqual([expect.objectContaining({ github_login: "parent-sentinel" })]);
  const databases = await sql`select datname from pg_database where datname like 'overflow_perf_%'`;
  expect(databases).toHaveLength(0);
});

it("runs the workflow's plain Node command against an isolated migrated database", () => {
  const gate = spawnSync(process.execPath, ["scripts/check-perf-budget.ts"], {
    cwd: root, encoding: "utf8", env: { ...process.env, OVERFLOW_DATABASE_URL: databaseUrl },
  });
  expect(gate.stderr).not.toContain("Transform Types is an experimental feature");
  expect(gate.status, `${gate.stdout}\n${gate.stderr}`).toBe(0);
  expect(gate.stdout).toContain("performance budget check: 0 violation(s)");
});

it("refuses the database query override before it can truncate the parent sentinel", async () => {
  const override = new URL(databaseUrl);
  override.searchParams.set("database", "overflow_ci");
  const gate = spawnSync(process.execPath, ["scripts/check-perf-budget.ts"], {
    cwd: root, encoding: "utf8", env: { ...process.env, OVERFLOW_DATABASE_URL: override.href },
  });
  const users = await sql`select github_login from users where github_user_id = 1`;
  const databases = await sql`select datname from pg_database where datname like 'overflow_perf_%'`;
  expect({ exit: gate.status, users, databases }, `${gate.stdout}\n${gate.stderr}`).toEqual({
    exit: 2, users: [expect.objectContaining({ github_login: "parent-sentinel" })], databases: [],
  });
  expect(gate.stderr).toContain("routing query parameter");
});

it("counts the same operation on cold and fully initialized pools", async () => {
  const count = async (prewarm: boolean) => {
    const client = postgres(databaseUrl, { max: 4, onnotice: () => {} });
    try {
      if (prewarm) {
        const held: Awaited<ReturnType<typeof client.reserve>>[] = [];
        try {
          for (let index = 0; index < 4; index += 1) {
            const connection = await client.reserve();
            held.push(connection);
            await connection`select 1`;
          }
        } finally { for (const connection of held) connection.release(); }
      }
      return await countOperationStatements(client, "overflow_ci", async () => {
        const coordination = await client.reserve();
        try {
          await coordination`select 1`;
          await client.begin(async (tx) => { await tx`select 1`; });
        } finally { coordination.release(); }
      });
    } finally { await client.end(); }
  };
  const cold = await count(false);
  const warm = await count(true);
  expect({ cold, warm }).toEqual({ cold: 4, warm: 4 });
});

it("refuses an effective-database mismatch before the operation can write", async () => {
  let error: unknown;
  try {
    await countOperationStatements(sql, "overflow_perf_other", async () => {
      await sql`update users set github_login = 'wrong-target-write' where github_user_id = 1`;
    });
  } catch (cause) { error = cause; }
  const users = await sql`select github_login from users where github_user_id = 1`;
  expect(users).toEqual([expect.objectContaining({ github_login: "parent-sentinel" })]);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toContain("database target mismatch");
});

it("proves the migration process uses the expected scratch database before migrations", () => {
  const preload = new URL("../../scripts/perf-node-setup.mjs", import.meta.url).href;
  const migration = spawnSync("pnpm", ["db:migrate"], {
    cwd: root, encoding: "utf8", env: { ...process.env, OVERFLOW_DATABASE_URL: databaseUrl,
      OVERFLOW_PERF_EXPECTED_DATABASE: "overflow_perf_other",
      NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}` },
  });
  expect(migration.status, migration.stdout + migration.stderr).not.toBe(0);
  expect(migration.stderr).toContain("database target mismatch");
});
