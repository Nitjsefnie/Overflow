import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import type { StartedPostgres } from "../support/postgres-container";
import { startPostgresContainer } from "../support/postgres-container";
import type { ReconciliationWorkerSchedule } from "@/lib/fold/reconciliation-worker";
import { closeSql } from "@/lib/db/client";
import { runMigrations } from "../../scripts/migrate";

const exec = promisify(execFile);

/**
 * Issue 661, worker level: while the database is unreachable the server's
 * reconciliation wiring printed one full stack trace per five-second poll, and
 * recovery was visible only by the errors stopping. This suite runs the REAL
 * instrumentation wiring against a real database, stops the database, and
 * pins the bound end to end: exactly one full drain failure across a
 * multi-poll outage, and one recovery line when it returns.
 *
 * The database is a container of its own (the init script takes the suite off
 * the shared server, tests/support/postgres-container.ts): stopping it is the
 * outage, and only a suite-owned container may be brought back. The poll runs
 * at the production five-second interval, so the outage is measured in polls,
 * not in asserted wall-clock margins; every wait below is a bounded-deadline
 * wait on an observable event, and the assertions are counts of observed
 * events.
 */

const testState = vi.hoisted(() => ({
  sql: undefined as unknown,
  coordinationSql: undefined as unknown,
  pollTimers: [] as ReturnType<typeof setTimeout>[],
  ticks: 0,
}));

vi.mock("@/lib/db/client", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/db/client")>()),
  getSql: () => testState.sql,
  getCoordinationSql: () => testState.coordinationSql,
}));

// The production poll runs for the process's lifetime; the test owns the
// timer so afterEach can stop the worker, and counts the ticks so the
// multi-poll window is an observed count rather than an elapsed guess.
vi.mock("@/lib/fold/reconciliation-worker", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/fold/reconciliation-worker")>();
  return {
    ...actual,
    startReconciliationWorker: (schedule: ReconciliationWorkerSchedule): void => {
      actual.startReconciliationWorker({
        ...schedule,
        schedule: (callback: () => void, everyMs: number) => {
          const timer = setInterval(() => {
            testState.ticks += 1;
            callback();
          }, everyMs);
          testState.pollTimers.push(timer);
        },
      });
    },
  };
});

// Not this suite's subject: the sweep's cadence is hours, and its startup run
// would fold database traffic into what should be a drain-site-only capture.
vi.mock("@/lib/fold/sweep", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/fold/sweep")>()),
  startReconciliationSweep: () => {},
}));

const DRAIN_FAILURE_MESSAGE = "Reconciliation worker could not drain the job queue";

/** Just the captured calls, without vitest's instance generics. */
type ConsoleCapture = { mock: { calls: unknown[][] } };

/** The captured calls whose first argument is the drain site's message. */
function drainFailureLines(logged: ConsoleCapture): unknown[][] {
  return logged.mock.calls.filter((call) => call[0] === DRAIN_FAILURE_MESSAGE);
}

/** The captured calls announcing a drain-site recovery. */
function recoveryLines(logged: ConsoleCapture): unknown[][] {
  return logged.mock.calls.filter((call) => String(call[0]).startsWith("recovered: reconciliation-drain"));
}

describe("the reconciliation worker's drain failure logging during a database outage", () => {
  const databaseUrlOriginal = process.env.DATABASE_URL;
  let started: StartedPostgres;
  let databaseUrl: string;

  beforeAll(async () => {
    started = await startPostgresContainer({
      database: "worker_failure_logging_test",
      user: "worker_failure_logging_test",
      password: "worker_failure_logging_test",
      // A private container: only its own init script takes the suite off the
      // shared server, and the outage below stops the database outright.
      initScripts: [{ name: "661_own_container.sql", content: "select 1;" }],
      // The restart must reach the SAME host port: a dynamic mapping is
      // re-allocated on start, which would strand the original URL and every
      // client built from it. Loud, not silent, if two runs ever collide here.
      fixedHostPort: 45432,
    });
    databaseUrl = started.databaseUrl;
    process.env.DATABASE_URL = databaseUrl;
    await runMigrations();
    await closeSql();
    testState.sql = postgres(databaseUrl, { max: 10 });
    testState.coordinationSql = postgres(databaseUrl, { max: 10 });
  });

  afterEach(async () => {
    for (const timer of testState.pollTimers) clearInterval(timer);
    testState.pollTimers.length = 0;
    // Let a poll already in flight settle against the (by now healthy)
    // database, so no drain outlives the test that armed it.
    await new Promise((resolve) => setTimeout(resolve, 200));
  });

  afterAll(async () => {
    for (const client of [testState.sql, testState.coordinationSql]) {
      if (client) await (client as postgres.Sql).end();
    }
    try {
      await started?.container.stop();
    } catch {
      // The outage already stopped the container; a second stop is bookkeeping.
    }
    if (databaseUrlOriginal === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = databaseUrlOriginal;
    }
  });

  it("logs exactly one full stack trace across a multi-poll outage and a recovery line when the database returns", async () => {
    vi.resetModules();
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { register } = await import("@/instrumentation");
      await register();
      // The startup drain is the healthy baseline; give the local query its
      // moment so the outage begins from a settled worker.
      await new Promise((resolve) => setTimeout(resolve, 200));

      // The outage: nothing reaches the database from here until the start.
      // docker CLI rather than the testcontainers handle, because stop() there
      // removes the container, and the recovery below has to start the SAME
      // one back up with its port mapping intact.
      await exec("docker", ["stop", started.container.getId()]);

      // First the full trace the bound allows, then two further polls beyond
      // it: three polls' worth of failures must have arrived for the "not one
      // per poll" claim to mean anything.
      await waitFor(() => drainFailureLines(logged).length >= 1, "the first drain failure to be logged");
      const ticksAtFirstFailure = testState.ticks;
      await waitFor(
        () => testState.ticks >= ticksAtFirstFailure + 2,
        "two further polls to run during the outage",
      );

      expect(drainFailureLines(logged)).toHaveLength(1);
      // The one allowed failure is the site's full report: message plus the
      // error object, exactly as the unbounded site printed it.
      expect(drainFailureLines(logged)[0]![1]).toBeInstanceOf(Error);

      // The database returns; the next poll that gets through is the recovery.
      await exec("docker", ["start", started.container.getId()]);
      await waitForDatabaseAnswers(databaseUrl);
      await waitFor(() => recoveryLines(logged).length >= 1, "the recovery line to be logged");

      const recovery = String(recoveryLines(logged)[0]![0]);
      const match = /^recovered: reconciliation-drain after (\d+) failures over (\d+) s$/.exec(recovery);
      expect(match).not.toBeNull();
      // At minimum the first failure plus the two further polls.
      expect(Number(match![1])).toBeGreaterThanOrEqual(3);
      expect(Number(match![2])).toBeGreaterThanOrEqual(5);
      // The bound held to the end: still one full trace for the whole outage.
      expect(drainFailureLines(logged)).toHaveLength(1);
    } finally {
      vi.unstubAllEnvs();
      logged.mockRestore();
    }
  });
});

/**
 * Waits for an observable event, checking on a short cadence and naming what
 * never happened when the deadline passes. The deadline is generous against
 * the five-second poll; the assertions themselves count observed events.
 */
async function waitFor(
  ready: () => boolean | Promise<boolean>,
  what: string,
  deadlineMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!(await ready())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${deadlineMs} ms waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/** Waits until the database answers a probe again after its restart. */
async function waitForDatabaseAnswers(url: string): Promise<void> {
  const sql = postgres(url, { max: 1, connect_timeout: 1 });
  try {
    await waitFor(
      () => sql`select 1`.then(() => true).catch(() => false),
      "the restarted database to answer a probe",
    );
  } finally {
    await sql.end({ timeout: 0 });
  }
}
