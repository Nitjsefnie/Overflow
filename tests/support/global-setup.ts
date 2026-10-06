import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { POSTGRES_IMAGE, postgresWaitStrategy, publishPostgresOnLoopback, startedPostgresEndpoint, type ParkedSharedPostgresFailure, type SharedPostgresFacts } from "./postgres-container";
import { runNeedsSharedPostgres } from "./shared-postgres-need";

/**
 * Vitest globalSetup for the ONE postgres container every DB suite in a run
 * shares (issue 626): setup() starts it once and provides its connection
 * facts, teardown() stops it. Since issue 1070 the start is lazy: setup()
 * resolves the run's test files and starts the server only when one of them
 * imports startPostgresContainer — a run with no database suite starts no
 * container at all. Local facts use the IPv4 loopback literal and
 * its published port, so socket address-family fallback cannot reach another
 * port. IPv6-only publication is rejected because the pinned postgres client
 * cannot parse a bracketed IPv6 URL host.
 * A suite asks startPostgresContainer, which provisions a per-suite role and
 * database on this server.
 *
 * If the container cannot start (no Docker, and so on), the failure is parked
 * as a message string instead of thrown: non-DB suites must still pass on a
 * Dockerless box, and the failure surfaces only when a DB suite actually asks
 * for a database — the same failure scope the per-suite container had.
 */
const SHARED = {
  database: "overflow_shared",
  user: "overflow_shared",
};

/**
 * The surface the globalSetup receives in vitest 5.0.0: TestProject
 * (dist/chunks/index.B89dZ0-N.js, TestProject._initializeGlobalSetup calls
 * globalSetupFile.setup?.(this)), which exposes provide() and the public
 * readonly `vitest` backref to the root instance (plugin.d.BbcoZhuj.d.ts
 * lines 1014-1045). provide() is typed through the ProvidedContext
 * augmentation in postgres-container.ts. filenamePattern is the root
 * instance's own internal field for the CLI filters: start() assigns it from
 * those filters before specifications resolve and before global setups run
 * (dist/chunks/index.B89dZ0-N.js: "@internal" field, assigned in
 * start(filters) prior to runFiles -> initializeGlobalSetup), and
 * getRelevantTestSpecifications is what resolves the file list. start()
 * resolves these same filters on its way to running global setups — a
 * resolution failure would throw there, before setup() — so re-resolving
 * them here cannot hit a filter shape vitest itself has not accepted.
 */
interface GlobalSetupVitest {
  provide(key: "sharedPostgres", value: SharedPostgresFacts | ParkedSharedPostgresFailure): void;
  readonly vitest: {
    readonly filenamePattern?: readonly string[];
    getRelevantTestSpecifications(filters?: readonly string[]): Promise<readonly { moduleId: string }[]>;
  };
}

let container: StartedTestContainer | undefined;

export async function setup(vitest: GlobalSetupVitest): Promise<void> {
  // Lazy start (issue 1070): the run's own file list decides whether the
  // shared server is needed. A run with no file that imports
  // startPostgresContainer starts nothing, provides nothing, and touches no
  // Docker client at all; its DB-less suites cannot ask for the facts, and if
  // one did, resolveSharedPostgresFacts's existing "no shared postgres was
  // provided" error names the misconfiguration loudly.
  const specifications = await vitest.vitest.getRelevantTestSpecifications(vitest.vitest.filenamePattern ?? []);
  if (!runNeedsSharedPostgres(specifications.map((specification) => specification.moduleId), (path) => readFileSync(path, "utf8"))) {
    return;
  }

  // No committed password (issue 1070): a fresh one per run; the facts carry
  // it to every suite that provisions on the server.
  const adminPassword = randomBytes(24).toString("hex");
  try {
    const built = new GenericContainer(POSTGRES_IMAGE)
      .withEnvironment({
        POSTGRES_DB: SHARED.database,
        POSTGRES_PASSWORD: adminPassword,
        POSTGRES_USER: SHARED.user,
      })
      .withExposedPorts(5432)
      .withWaitStrategy(postgresWaitStrategy({ database: SHARED.database, user: SHARED.user }));
    publishPostgresOnLoopback(built, "0");
    const started = await built.start();

    container = started;
    const endpoint = await startedPostgresEndpoint(started);
    vitest.provide("sharedPostgres", {
      host: endpoint.host,
      port: endpoint.port,
      adminUser: SHARED.user,
      adminPassword,
      containerId: started.getId(),
    });
  } catch (error) {
    vitest.provide("sharedPostgres", { error: String(error) });
  }
}

/**
 * Stops the shared container. The survivor audit deliberately does NOT live
 * here: vitest reaps the worker processes before globalSetup teardown runs,
 * so a leaked pool's socket is already closed and its pg_stat_activity row is
 * gone by the time this executes. The audit runs per FILE instead, inside the
 * still-alive worker (vitest.setup.ts afterAll).
 */
export async function teardown(): Promise<void> {
  await container?.stop();
}
