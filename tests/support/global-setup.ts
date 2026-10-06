import { randomBytes } from "node:crypto";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { POSTGRES_IMAGE, postgresWaitStrategy, publishPostgresOnLoopback, startedPostgresEndpoint, type ParkedSharedPostgresFailure, type SharedPostgresFacts } from "./postgres-container";

/**
 * Vitest globalSetup for the ONE postgres container every DB suite in a run
 * shares (issue 626): setup() starts it once and provides its connection
 * facts, teardown() stops it. Local facts use the IPv4 loopback literal and
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
 * The surface of the root vitest instance this file needs. provide() is typed
 * through the ProvidedContext augmentation in postgres-container.ts.
 */
interface GlobalSetupVitest {
  provide(key: "sharedPostgres", value: SharedPostgresFacts | ParkedSharedPostgresFailure): void;
}

let container: StartedTestContainer | undefined;

export async function setup(vitest: GlobalSetupVitest): Promise<void> {
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
