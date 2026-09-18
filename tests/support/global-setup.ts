import { GenericContainer, type StartedTestContainer } from "testcontainers";
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

export async function teardown(): Promise<void> {
  await container?.stop();
}
