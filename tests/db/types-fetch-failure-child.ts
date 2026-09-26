/**
 * Child process for tests/db/types-fetch-failure.test.ts. It runs in a Node process of its own so
 * that the test can watch the PROCESS survive a failed array-type fetch, which an in-worker test
 * cannot: vitest registers its own unhandled-rejection handling in the worker.
 *
 * Environment:
 * - TYPES_FETCH_ROLE_URL: a role that cannot read pg_catalog.pg_type, so the fetch a new
 *   connection sends before its first query fails with 42501;
 * - TYPES_FETCH_ADMIN_URL: a superuser, used to grant that read back once the waiting query has
 *   settled;
 * - TYPES_FETCH_WAITING: "query" to wait on a plain query, "reserve" to wait on sql.reserve().
 *
 * Prints one JSON line (ChildReport) on stdout, and exits 1 when any promise rejection went
 * unhandled.
 */
import postgres from "postgres";

export type Outcome =
  | { status: "fulfilled"; value: unknown }
  | { status: "rejected"; code: string | undefined; message: string };

export interface ChildReport {
  waiting: Outcome;
  later: Outcome;
  unhandled: string[];
}

const unhandled: string[] = [];
process.on("unhandledRejection", (reason) => {
  const detail = reason as { code?: unknown; message?: unknown } | null;
  unhandled.push(`${String(detail?.code)}: ${String(detail?.message ?? reason)}`);
});

async function settle(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { status: "fulfilled", value: await run() };
  } catch (error) {
    const detail = error as { code?: string; message?: string };
    return { status: "rejected", code: detail.code, message: String(detail.message) };
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is not set`);
  }
  return value;
}

const roleUrl = required("TYPES_FETCH_ROLE_URL");
const adminUrl = required("TYPES_FETCH_ADMIN_URL");
const waitingOn = required("TYPES_FETCH_WAITING");

const sql = postgres(roleUrl, { max: 1 });

const waiting = await settle(async () => {
  if (waitingOn === "reserve") {
    const reserved = await sql.reserve();
    reserved.release();
    return "reserved";
  }
  return (await sql`select 1 as one`).map((row) => row.one);
});

// The failure cause is removed, so the client's next connection can fetch its types.
const admin = postgres(adminUrl, { max: 1 });
try {
  await admin.unsafe("grant select on pg_catalog.pg_type to public");
} finally {
  await admin.end({ timeout: 5 });
}

const later = await settle(async () => (await sql`select ${sql.array([1, 2])}::bigint[] as v`).map((row) => row.v));

await sql.end({ timeout: 5 });

// Node reports an unhandled rejection once the microtask queue has drained, which is before any
// setImmediate callback runs; waiting one turn makes sure the listener has seen every rejection.
await new Promise((resolve) => setImmediate(resolve));

const report: ChildReport = { waiting, later, unhandled };
process.stdout.write(`${JSON.stringify(report)}\n`);
process.exitCode = unhandled.length === 0 ? 0 : 1;
