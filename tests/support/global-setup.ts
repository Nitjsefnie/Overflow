import { GenericContainer, type StartedTestContainer } from "testcontainers";
import postgres from "postgres";
import { POSTGRES_IMAGE, postgresWaitStrategy, type ParkedSharedPostgresFailure, type SharedPostgresFacts } from "./postgres-container";

/**
 * Vitest globalSetup for the ONE postgres container every DB suite in a run
 * shares (issue 626): setup() starts it once and provides its connection
 * facts, teardown() stops it. A suite asks startPostgresContainer, which
 * provisions a per-suite role and database on this server.
 *
 * If the container cannot start (no Docker, and so on), the failure is parked
 * as a message string instead of thrown: non-DB suites must still pass on a
 * Dockerless box, and the failure surfaces only when a DB suite actually asks
 * for a database — the same failure scope the per-suite container had.
 */
const SHARED = {
  database: "overflow_shared",
  user: "overflow_shared",
  password: "overflow_shared",
};

/**
 * The surface of the root vitest instance this file needs. provide() is typed
 * through the ProvidedContext augmentation in postgres-container.ts.
 */
interface GlobalSetupVitest {
  provide(key: "sharedPostgres", value: SharedPostgresFacts | ParkedSharedPostgresFailure): void;
}

let container: StartedTestContainer | undefined;

export async function setup(vitest: GlobalSetupVitest): Promise<void> {
  try {
    const started = await new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_DB: SHARED.database,
        POSTGRES_PASSWORD: SHARED.password,
        POSTGRES_USER: SHARED.user,
      })
      .withExposedPorts(5432)
      .withWaitStrategy(postgresWaitStrategy({ database: SHARED.database, user: SHARED.user }))
      .start();

    container = started;
    vitest.provide("sharedPostgres", {
      host: started.getHost(),
      port: started.getMappedPort(5432),
      adminUser: SHARED.user,
      adminPassword: SHARED.password,
      containerId: started.getId(),
    });
  } catch (error) {
    vitest.provide("sharedPostgres", { error: String(error) });
  }
}

/**
 * One pg_stat_activity aggregate row about a surviving per-suite role: the
 * rows teardown() feeds the verdict, grouped per usename and database.
 */
export interface SurvivorRow {
  usename: string;
  datname: string | null;
  count: number;
}

/**
 * The teardown verdict on the activity rows: undefined when every per-suite
 * role hung up, otherwise the message that fails the run. This is the whole
 * decision, exported pure so the pin lives in postgres-shared.test.ts.
 */
export function survivorVerdict(rows: readonly SurvivorRow[]): string | undefined {
  if (rows.length === 0) {
    return undefined;
  }
  const holders = rows
    .map((row) => `${row.usename}/${row.datname ?? "(no database)"} x${row.count}`)
    .join(", ");
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  return `postgres teardown found ${total} survivor connection(s) held by per-suite roles (${holders}): a suite skipped closeSql() or client end(), and its pool would hand the next file the previous suite's database`;
}

/**
 * Survivor connections left on the shared server by per-suite roles: the
 * client backends of any user but the admin. The run's own admin connections
 * drop out on the usename comparison.
 */
async function survivorRows(): Promise<SurvivorRow[]> {
  if (container === undefined) {
    return [];
  }
  const admin = postgres(
    `postgresql://${encodeURIComponent(SHARED.user)}:${encodeURIComponent(SHARED.password)}@${container.getHost()}:${container.getMappedPort(5432)}/postgres`,
    { max: 1 },
  );
  try {
    return await admin<SurvivorRow[]>`
      select usename, datname, count(*)::integer as count
      from pg_stat_activity
      where backend_type = 'client backend' and usename <> ${SHARED.user}
      group by usename, datname
    `;
  } finally {
    await admin.end();
  }
}

export async function teardown(): Promise<void> {
  if (container === undefined) {
    return;
  }
  let verdict: string | undefined;
  try {
    // Probed before the stop — once the server is gone there is nothing left
    // to ask.
    verdict = survivorVerdict(await survivorRows());
  } finally {
    // Stopped even when the verdict fails the run: a leaked container on the
    // shared daemon would outlive the message reporting it.
    await container.stop();
    container = undefined;
  }
  if (verdict !== undefined) {
    throw new Error(verdict);
  }
}
