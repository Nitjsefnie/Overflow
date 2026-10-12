import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, expect, it } from "vitest";
import { measurePerfWorkloads } from "../../scripts/perf-workloads.ts";
import {
  POSTGRES_IMAGE, postgresConnectionUrl, postgresWaitStrategy,
  publishPostgresOnLoopback, startedPostgresEndpoint,
} from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: ReturnType<typeof postgres>;
let databaseUrl: string;
const root = fileURLToPath(new URL("../../", import.meta.url));

beforeAll(async () => {
  const password = randomBytes(24).toString("hex");
  const options = { database: "perf_test", user: "perf_test" };
  const built = new GenericContainer(POSTGRES_IMAGE)
    .withName(`overflow-1144-perf-test-${randomBytes(4).toString("hex")}`)
    .withEnvironment({ POSTGRES_DB: options.database, POSTGRES_USER: options.user, POSTGRES_PASSWORD: password })
    .withExposedPorts(5432)
    .withWaitStrategy(postgresWaitStrategy(options));
  publishPostgresOnLoopback(built, "0");
  container = await built.start();
  databaseUrl = postgresConnectionUrl({ ...options, password, ...await startedPostgresEndpoint(container) });
  const migration = spawnSync("pnpm", ["db:migrate"], {
    cwd: root, encoding: "utf8", env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  expect(migration.status, migration.stderr).toBe(0);
  sql = postgres(databaseUrl, { max: 1, onnotice: () => {} });
  await sql`insert into users (github_user_id, github_login) values (1, 'parent-sentinel')`;
});

afterAll(async () => {
  await sql?.end();
  await container?.stop();
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
    cwd: root, encoding: "utf8", env: { ...process.env, DATABASE_URL: databaseUrl },
  });
  expect(gate.status, `${gate.stdout}\n${gate.stderr}`).toBe(0);
  expect(gate.stdout).toContain("performance budget check: 0 violation(s)");
});
