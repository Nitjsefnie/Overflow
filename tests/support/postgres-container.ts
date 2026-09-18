import { randomBytes } from "node:crypto";
import { inject } from "vitest";
import { GenericContainer, Wait, type StartedTestContainer, type StoppedTestContainer, type WaitStrategy } from "testcontainers";
import postgres from "postgres";

export interface PostgresContainerOptions {
  database: string;
  user: string;
  password: string;
  /** Optional shell scripts copied into /docker-entrypoint-initdb.d/ before start. Test fixtures only. */
  initScripts?: ReadonlyArray<{ name: string; content: string }>;
}

export interface StartedPostgres {
  container: StartedTestContainer;
  /** postgresql://user:password@host:mappedPort/database */
  databaseUrl: string;
}

/**
 * The connection facts for the ONE postgres server every DB suite in a run
 * shares (issue 626). tests/support/global-setup.ts starts that container in
 * the main process; these facts are what crosses into each worker, so they
 * carry the container's id too — a worker never holds the container object
 * itself, and the id is how the facade forwards getId() (backup-restore execs
 * pg_dump and pg_restore through it).
 */
export interface SharedPostgresFacts {
  host: string;
  port: number;
  adminUser: string;
  adminPassword: string;
  containerId: string;
}

/**
 * What global setup provides instead of facts when the shared container could
 * not start (no Docker, and so on). A message string, not an Error instance:
 * the provided context is JSON-serialised on its way to the workers, and an
 * Error would arrive as `{}`.
 */
export interface ParkedSharedPostgresFailure {
  error: string;
}

declare module "vitest" {
  interface ProvidedContext {
    sharedPostgres: SharedPostgresFacts | ParkedSharedPostgresFailure | undefined;
  }
}

const SHARED_POSTGRES_KEY = "sharedPostgres";

/**
 * What the shared path has provisioned in THIS worker since the last reset:
 * one entry per startPostgresContainer call. vitest.setup.ts clears it at
 * each file's start (workers are reused across files under isolate:false)
 * and audits it in the file's afterAll — worker processes are reaped before
 * globalSetup teardown runs, so a worker-held leaked socket is only ever
 * visible to a probe that runs while the file's worker is alive.
 */
const provisionedShared: { role: string; database: string }[] = [];

/** The roles provisioned since the last reset, in provision order. */
export function provisionedSharedRoles(): readonly string[] {
  return provisionedShared.map((provision) => provision.role);
}

/** Forgets everything provisioned so far; the next file must audit only its own. */
export function resetSharedProvisions(): void {
  provisionedShared.splice(0);
}

/**
 * Throws when any role provisioned since the last reset still holds a client
 * backend on the shared server. vitest.setup.ts runs this in every file's
 * afterAll, so a suite that skipped closeSql() or client end() fails its own
 * file, loudly, in a real run. The audit's own connection is the admin's and
 * drops out of every query on the usename filter.
 */
export async function assertNoSharedProvisionSurvivors(): Promise<void> {
  const roles = provisionedSharedRoles();
  if (roles.length === 0) {
    return;
  }
  const facts = sharedPostgresFacts();
  const admin = postgres(
    `postgresql://${encodeURIComponent(facts.adminUser)}:${encodeURIComponent(facts.adminPassword)}@${facts.host}:${facts.port}/postgres`,
    { max: 1 },
  );
  try {
    const survivors: { usename: string; datname: string | null }[] = [];
    for (const role of roles) {
      survivors.push(...await admin<{ usename: string; datname: string | null }[]>`
        select usename, datname
        from pg_stat_activity
        where backend_type = 'client backend' and usename = ${role}
      `);
    }
    if (survivors.length > 0) {
      const summary = survivors.map((row) => `${row.usename}/${row.datname ?? "(no database)"}`).join(", ");
      throw new Error(`postgres survivor audit found ${survivors.length} connection(s) still held by this file's shared-postgres role(s) (${summary}): the suite skipped closeSql() or client end(), and its pool would hand the next file the previous suite's database`);
    }
  } finally {
    await admin.end();
  }
}

/**
 * Pinned by digest (issue 461) so every DB suite runs the same postgres bytes.
 * The tag stays for readability; the digest is what Docker actually pulls.
 */
export const POSTGRES_IMAGE = "postgres:17-alpine@sha256:18cfe3ef5e6815560c98237d6216d1e5119702fb0f3894c8785dd58b8bbe5d73";

/**
 * The official postgres entrypoint runs initialisation against a temporary server bound to a Unix
 * socket only, so a wait strategy that reaches postgres over that socket passes while nothing is
 * listening on TCP 5432 yet. `forListeningPorts` holds until a real listener exists, and
 * `pg_isready --host 127.0.0.1` is forced over TCP, exiting nonzero until connections are accepted.
 */
export function postgresWaitStrategy({ database, user }: Pick<PostgresContainerOptions, "database" | "user">): WaitStrategy {
  return Wait.forAll([
    Wait.forListeningPorts(),
    Wait.forSuccessfulCommand(`pg_isready --host 127.0.0.1 --username ${user} --dbname ${database}`),
  ]);
}

export async function startPostgresContainer(options: PostgresContainerOptions): Promise<StartedPostgres> {
  const { database, user, password, initScripts = [] } = options;

  if (initScripts.length > 0) {
    return startPrivatePostgres({ database, user, password, initScripts });
  }

  return startOnSharedServer({ database, user, password });
}

/**
 * The initScripts fixtures must run during the entrypoint's first boot, so
 * these suites get a container of their own, exactly as every suite did
 * before the shared server existed (issue 626 left them unchanged).
 */
async function startPrivatePostgres(options: PostgresContainerOptions): Promise<StartedPostgres> {
  const { database, user, password, initScripts = [] } = options;

  let container = new GenericContainer(POSTGRES_IMAGE)
    .withEnvironment({
      POSTGRES_DB: database,
      POSTGRES_PASSWORD: password,
      POSTGRES_USER: user,
    })
    .withExposedPorts(5432)
    .withWaitStrategy(postgresWaitStrategy({ database, user }));

  for (const { name, content } of initScripts) {
    container = container.withCopyContentToContainer([
      { content, target: `/docker-entrypoint-initdb.d/${name}`, mode: 0o755 },
    ]);
  }

  const started = await container.start();

  return {
    container: started,
    databaseUrl: `postgresql://${user}:${password}@${started.getHost()}:${started.getMappedPort(5432)}/${database}?client_min_messages=warning`,
  };
}

/**
 * The shared path: one server per run (started by tests/support/global-setup.ts),
 * one role and database per call. The role stays SUPERUSER, mirroring the
 * POSTGRES_USER of a private container; the privilege that is load-bearing is
 * CREATEDB — tests/db/backup-restore.test.ts has the suite role create and
 * drop scratch databases. (The CREATE EXTENSION in 001_initial.sql does not
 * need it: pgcrypto is TRUSTED since PG13 and installs without superuser.)
 */
async function startOnSharedServer(options: Pick<PostgresContainerOptions, "database" | "user" | "password">): Promise<StartedPostgres> {
  const { database, user, password } = options;
  const shared = sharedPostgresFacts();
  const suffix = randomBytes(4).toString("hex");
  const role = `${user}_${suffix}`;
  const databaseName = `${database}_${suffix}`;

  // The postgres maintenance database always exists, whatever POSTGRES_DB the
  // shared container was booted with.
  const admin = postgres(
    `postgresql://${encodeURIComponent(shared.adminUser)}:${encodeURIComponent(shared.adminPassword)}@${shared.host}:${shared.port}/postgres`,
    { max: 1 },
  );
  try {
    // Utility statements take no bind parameters, so identifiers and the
    // password literal go in with explicit quoting.
    await admin.unsafe(`create role ${quoteIdentifier(role)} superuser login password ${quoteLiteral(password)}`);
    await admin.unsafe(`create database ${quoteIdentifier(databaseName)} owner ${quoteIdentifier(role)}`);
  } finally {
    await admin.end();
  }

  // Registered only after the DDL succeeded, so the audit never probes for a
  // role that was never created.
  provisionedShared.push({ role, database: databaseName });

  return {
    container: sharedServerFacade(shared),
    databaseUrl: `postgresql://${encodeURIComponent(role)}:${encodeURIComponent(password)}@${shared.host}:${shared.port}/${databaseName}?client_min_messages=warning`,
  };
}

/**
 * The provided facts, or the parked failure global setup left in their place.
 * Exported as the pure decision so the parked-error pin does not have to mock
 * "vitest" — a mock that stopped working once vitest.setup.ts imported this
 * module into every worker ahead of any per-file mock registration.
 */
export function resolveSharedPostgresFacts(provided: SharedPostgresFacts | ParkedSharedPostgresFailure | undefined): SharedPostgresFacts {
  if (provided === undefined) {
    throw new Error("no shared postgres was provided for this run; is tests/support/global-setup.ts registered as the vitest globalSetup?");
  }
  if ("error" in provided) {
    throw new Error(provided.error);
  }
  return provided;
}

function sharedPostgresFacts(): SharedPostgresFacts {
  return resolveSharedPostgresFacts(inject(SHARED_POSTGRES_KEY));
}

/**
 * A StartedTestContainer view of the shared server. stop() is a no-op —
 * stopping "your postgres" on the shared server must not kill the server out
 * from under every other suite in the run — and so is async disposal, which
 * would stop the container too. Every other member a suite uses forwards from
 * the shared facts: getHost/getMappedPort serve reserve-stranded's upstream
 * config, getId serves backup-restore's docker exec. Members that manipulate
 * the container itself (restart, commit, exec, logs, copies) have no meaning
 * for a server shared by a whole run; they throw, loudly, instead of pretending.
 */
function sharedServerFacade(shared: SharedPostgresFacts): StartedTestContainer {
  const unsupported = (member: string): never => {
    throw new Error(`the shared postgres facade does not support ${member}(): a server shared by the whole run is not a suite's container to manipulate; pass initScripts to startPostgresContainer for a container of your own`);
  };
  // Under this file's TS lib (es2022) the async-disposal symbol cannot be
  // named; Node's Symbol.asyncDispose at runtime is the same symbol
  // testcontainers declares. Disposal would stop the container — exactly what
  // the facade must not do — so it is neutralised like stop().
  const asyncDispose = (Symbol as unknown as { asyncDispose?: symbol }).asyncDispose;
  const stoppedFacade: StoppedTestContainer = {
    getId: () => shared.containerId,
    copyArchiveFromContainer: () => unsupported("copyArchiveFromContainer on the stopped facade"),
  };
  const facade = {
    stop: () => Promise.resolve(stoppedFacade),
    restart: () => unsupported("restart"),
    commit: () => unsupported("commit"),
    getHost: () => shared.host,
    getHostname: () => shared.containerId.slice(0, 12),
    getFirstMappedPort: () => shared.port,
    getMappedPort: (port: number) => {
      if (port !== 5432) {
        // The real container exposes only 5432; testcontainers throws the
        // same way for a port with no mapping.
        throw new Error(`port ${port} is not mapped by the shared postgres container`);
      }
      return shared.port;
    },
    getName: () => unsupported("getName"),
    getLabels: () => unsupported("getLabels"),
    getId: () => shared.containerId,
    getNetworkNames: () => unsupported("getNetworkNames"),
    getNetworkId: () => unsupported("getNetworkId"),
    getIpAddress: () => unsupported("getIpAddress"),
    copyArchiveFromContainer: () => unsupported("copyArchiveFromContainer"),
    copyArchiveToContainer: () => Promise.resolve(unsupported("copyArchiveToContainer")),
    copyDirectoriesToContainer: () => Promise.resolve(unsupported("copyDirectoriesToContainer")),
    copyFilesToContainer: () => Promise.resolve(unsupported("copyFilesToContainer")),
    copyContentToContainer: () => Promise.resolve(unsupported("copyContentToContainer")),
    exec: () => Promise.resolve(unsupported("exec")),
    logs: () => Promise.resolve(unsupported("logs")),
  };

  // The wide cast covers the unnameable disposal member only; every named
  // member above is type-checked against its own explicit signature.
  const withDisposal = { ...facade, ...(asyncDispose === undefined ? {} : { [asyncDispose]: () => Promise.resolve() }) };
  return withDisposal as unknown as StartedTestContainer;
}

function quoteIdentifier(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
