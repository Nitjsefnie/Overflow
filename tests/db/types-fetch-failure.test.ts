import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startPostgresContainer } from "../support/postgres-container";
import type { ChildReport } from "./types-fetch-failure-child";

const database = "overflow_types_fetch_failure_test";
const childScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "types-fetch-failure-child.ts");

let container: StartedTestContainer | undefined;
let adminUrl: string;
let roleUrl: string;
let deniedRole: string;

interface ChildRun {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

function runChild(env: Record<string, string>): Promise<ChildRun> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [childScript], { env: { ...process.env, ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}

async function asAdmin(statement: string): Promise<void> {
  const admin = postgres(adminUrl, { max: 1 });
  try {
    await admin.unsafe(statement);
  } finally {
    await admin.end({ timeout: 5 });
  }
}

/**
 * Runs the child against a database where the dedicated role cannot read pg_catalog.pg_type, so
 * the array-type fetch that a new connection sends before its first query fails, every time, with
 * 42501. The child grants the read back after its waiting query has settled.
 */
async function runWithTypesFetchDenied(waiting: "query" | "reserve"): Promise<{ run: ChildRun; report: ChildReport | undefined }> {
  await asAdmin("revoke select on pg_catalog.pg_type from public");
  const run = await runChild({
    TYPES_FETCH_ROLE_URL: roleUrl,
    TYPES_FETCH_ADMIN_URL: adminUrl,
    TYPES_FETCH_WAITING: waiting,
  });
  const lastLine = run.stdout.trim().split("\n").at(-1);
  const report = lastLine ? (JSON.parse(lastLine) as ChildReport) : undefined;
  return { run, report };
}

/**
 * postgres.js fetches the server's array types on every new connection before running the query
 * the connection was opened for. When that fetch fails, the query waiting on the connection must
 * be rejected with the server's error, the connection must close rather than serve queries with no
 * array types (sql.array would then bind as its scalar element type), and the process must keep
 * running: the fetch's own promise must not be left rejected with no handler, which is what
 * terminated the process before (issue 719, upstream porsager/postgres issue 1192).
 */
describe("a new connection whose array-type fetch fails", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database, user: database, password: database });
    container = started.container;
    adminUrl = started.databaseUrl;
    deniedRole = `types_fetch_denied_${randomBytes(4).toString("hex")}`;
    await asAdmin(`create role "${deniedRole}" login password 'denied'`);
    const url = new URL(adminUrl);
    url.username = deniedRole;
    url.password = "denied";
    roleUrl = url.toString();
  });

  afterAll(async () => {
    if (deniedRole !== undefined) {
      await asAdmin("grant select on pg_catalog.pg_type to public");
      await asAdmin(`drop role if exists "${deniedRole}"`);
    }
    await container?.stop();
  });

  it("rejects the waiting query with the server's error, keeps the process alive, and serves a later sql.array query", async () => {
    const { run, report } = await runWithTypesFetchDenied("query");

    expect(report, run.stderr).toMatchObject({
      unhandled: [],
      waiting: { status: "rejected", code: "42501" },
      later: { status: "fulfilled", value: [["1", "2"]] },
    });
    expect(run.exitCode, run.stderr).toBe(0);
  });

  it("rejects a waiting reserve with the server's error instead of handing it a connection with no array types", async () => {
    const { run, report } = await runWithTypesFetchDenied("reserve");

    expect(report, run.stderr).toMatchObject({
      unhandled: [],
      waiting: { status: "rejected", code: "42501" },
      later: { status: "fulfilled", value: [["1", "2"]] },
    });
    expect(run.exitCode, run.stderr).toBe(0);
  });
});
