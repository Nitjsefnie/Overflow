import { randomBytes } from "node:crypto";
import { readFileSync, writeSync } from "node:fs";
import { createServer, isIP } from "node:net";
import { inject } from "vitest";
import { GenericContainer, Wait, getContainerRuntimeClient, type StartedTestContainer, type StoppedTestContainer, type WaitStrategy } from "testcontainers";
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
  /** postgresql://user:password@host:mappedPort/database, with IPv6 hosts bracketed. */
  databaseUrl: string;
}

/**
 * The connection facts for the ONE postgres server every DB suite in a run
 * shares (issue 626). tests/support/global-setup.ts starts that container in
 * the main process; these facts are what crosses into each worker, so they
 * carry the container's id too — a worker never holds the container object
 * itself, and the id is how the facade forwards getId() (backup-restore execs
 * pg_dump and pg_restore through it). For a local Docker runtime, host is an
 * IP literal whose family matches the published port, so Node cannot fall
 * back to a different address family on that port.
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
// POSTGRES_IMAGE exposes only 5432 inside the container. Docker's userland-proxy
// adds a second TCP leg whose local port is pg_stat_activity.client_port.
const CONTAINER_POSTGRES_PORT = 5432;
type DockerPortBinding = { HostIp: string; HostPort: string };

/** Selects the literal matching Docker's published port for a local runtime. */
export function selectPostgresEndpoint(runtimeHost: string, bindings: readonly DockerPortBinding[] | null | undefined, mappedPort: number): { host: string; port: number } {
  if (runtimeHost !== "localhost" && runtimeHost !== "127.0.0.1" && runtimeHost !== "::1") {
    return { host: runtimeHost, port: mappedPort };
  }
  const usable = (bindings ?? []).filter(({ HostPort }) => {
    const port = Number(HostPort);
    return Number.isInteger(port) && port > 0 && port <= 65535;
  });
  if (usable.length === 0) {
    throw new Error(`no usable host-port binding for container port ${CONTAINER_POSTGRES_PORT}/tcp`);
  }
  const ipv4 = usable.find(({ HostIp }) => HostIp === "0.0.0.0" || HostIp === "127.0.0.1");
  const ipv6 = usable.find(({ HostIp }) => HostIp === "::" || HostIp === "::1");
  const dualStack = usable.length === 1 && usable[0].HostIp === "" ? usable[0] : undefined;
  const selected = ipv4 ?? ipv6 ?? dualStack;
  if (selected === undefined) {
    throw new Error(`no usable host-port binding for container port ${CONTAINER_POSTGRES_PORT}/tcp`);
  }
  return { host: selected === ipv6 ? "::1" : "127.0.0.1", port: Number(selected.HostPort) };
}

/** Inspect the started container rather than pairing a mapped port with an unrelated host family. */
export async function startedPostgresEndpoint(started: StartedTestContainer): Promise<{ host: string; port: number }> {
  const client = await getContainerRuntimeClient();
  const inspected = await client.container.inspect(client.container.getById(started.getId()));
  return selectPostgresEndpoint(started.getHost(), inspected.NetworkSettings.Ports?.[`${CONTAINER_POSTGRES_PORT}/tcp`], started.getMappedPort(CONTAINER_POSTGRES_PORT));
}

function urlHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

interface PostgresConnectionUrlOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  clientMinMessagesWarning?: boolean;
}

export function postgresConnectionUrl({ host, port, user, password, database, clientMinMessagesWarning = false }: PostgresConnectionUrlOptions): string {
  const query = clientMinMessagesWarning ? "?client_min_messages=warning" : "";
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${urlHost(host)}:${port}/${database}${query}`;
}

type SurvivorAuditBranch = "calibrated" | "strict";
let survivorAuditBranchLogged = false;
let lastSurvivorAuditBranch: SurvivorAuditBranch | undefined;

export function lastSharedSurvivorAuditBranch(): SurvivorAuditBranch | undefined {
  return lastSurvivorAuditBranch;
}

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

export interface ClientTcpSocket {
  localPort: number;
  remotePort: number;
  state: number;
}

/** A null table means neither proc table could be read. */
export function readClientTcpSockets(): readonly ClientTcpSocket[] | null {
  let readable = false;
  const sockets: ClientTcpSocket[] = [];
  for (const path of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let contents: string;
    try {
      contents = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    readable = true;
    for (const line of contents.split("\n").slice(1)) {
      const fields = line.trim().split(/\s+/);
      if (fields.length < 4) continue;
      const localPort = Number.parseInt(fields[1].slice(fields[1].lastIndexOf(":") + 1), 16);
      const remotePort = Number.parseInt(fields[2].slice(fields[2].lastIndexOf(":") + 1), 16);
      const state = Number.parseInt(fields[3], 16);
      sockets.push({ localPort, remotePort, state });
    }
  }
  return readable ? sockets : null;
}

/** A live pool can hand the next file its database only while its TCP socket is still established. */
export function clientSocketIsEstablished(clientPort: number | null, serverPort: number, sockets: readonly ClientTcpSocket[] | null): boolean {
  if (clientPort === null || sockets === null) return true;
  return sockets.some((socket) =>
    socket.localPort === clientPort
    && (socket.remotePort === serverPort || socket.remotePort === CONTAINER_POSTGRES_PORT)
    && socket.state === 0x01);
}

export interface SharedActivityRow {
  usename: string;
  datname: string | null;
  client_port: number | null;
}

function sharedAuditCanRefine(adminPort: number | null, serverPort: number, sockets: readonly ClientTcpSocket[] | null): boolean {
  return adminPort !== null && sockets !== null && clientSocketIsEstablished(adminPort, serverPort, sockets);
}

export function sharedAuditSurvivors(rows: readonly SharedActivityRow[], adminPort: number | null, serverPort: number, sockets: readonly ClientTcpSocket[] | null): SharedActivityRow[] {
  // Rootless Docker, remote DOCKER_HOST, or DNAT may make the backend's peer
  // invisible here even when /proc is readable. Use our own live admin socket
  // to prove the table covers this topology before trusting absent role sockets.
  if (!sharedAuditCanRefine(adminPort, serverPort, sockets)) {
    return [...rows];
  }
  return rows.filter((row) => clientSocketIsEstablished(row.client_port, serverPort, sockets));
}

/**
 * Throws when any role provisioned since the last reset still holds a client
 * backend on the shared server. vitest.setup.ts runs this in every file's
 * afterAll, so a suite that skipped closeSql() or client end() fails its own
 * file, loudly, in a real run. The audit's own connection is the admin's and
 * drops out of every query on the usename filter. Docker's proxy makes two
 * TCP legs, so the server-reported client port can lead to container port 5432.
 */
export async function assertNoSharedProvisionSurvivors(): Promise<void> {
  const roles = provisionedSharedRoles();
  if (roles.length === 0) {
    return;
  }
  const facts = sharedPostgresFacts();
  const admin = postgres(
    postgresConnectionUrl({ host: facts.host, port: facts.port, user: facts.adminUser, password: facts.adminPassword, database: "postgres" }),
    { max: 1 },
  );
  try {
    const ownRows = await admin<{ client_port: number | null }[]>`
      select client_port from pg_stat_activity where pid = pg_backend_pid()
    `;
    const adminPort = ownRows[0]?.client_port ?? null;
    const sockets = readClientTcpSockets();
    const branch: SurvivorAuditBranch = sharedAuditCanRefine(adminPort, facts.port, sockets) ? "calibrated" : "strict";
    lastSurvivorAuditBranch = branch;
    if (!survivorAuditBranchLogged) {
      writeSync(2, branch === "calibrated"
        ? "survivor audit: calibrated refinement active\n"
        : "survivor audit: strict fallback (socket table cannot see this topology)\n");
      survivorAuditBranchLogged = true;
    }
    const survivors: { usename: string; datname: string | null }[] = [];
    for (const role of roles) {
      const rows = await admin<SharedActivityRow[]>`
        select usename, datname, client_port
        from pg_stat_activity
        where backend_type = 'client backend' and usename = ${role}
      `;
      survivors.push(...sharedAuditSurvivors(rows, adminPort, facts.port, sockets));
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
    return startPrivatePostgres(options);
  }
  return startOnSharedServer({ database, user, password });
}

/** Docker preserves explicit host port bindings when the same container restarts. */
async function pickPrivateHostPort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "0.0.0.0", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("could not determine the private postgres host port"));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

const PRIVATE_POSTGRES_ATTEMPT_LABEL = "overflow.private-postgres.attempt";

/** A failed start can leave a created container behind, even before fixture copying finishes. */
async function removeFailedPrivateContainers(attemptId: string): Promise<void> {
  try {
    const client = await getContainerRuntimeClient();
    const containers = await client.container.dockerode.listContainers({
      all: true,
      filters: { label: [`${PRIVATE_POSTGRES_ATTEMPT_LABEL}=${attemptId}`] },
    });
    for (const container of containers) {
      try {
        await client.container.getById(container.Id).remove({ force: true, v: true });
      } catch {
        // Cleanup is best-effort; keep the original start error.
      }
    }
  } catch {
    // Cleanup is best-effort; keep the original start error.
  }
}

/**
 * The initScripts fixtures must run during the entrypoint's first boot, so
 * these suites get a container of their own, exactly as every suite did
 * before the shared server existed (issue 626 left them unchanged).
 */
async function startPrivatePostgres(options: PostgresContainerOptions): Promise<StartedPostgres> {
  const { database, user, password, initScripts = [] } = options;

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const hostPort = await pickPrivateHostPort();
    const attemptId = randomBytes(16).toString("hex");
    let container = new GenericContainer(POSTGRES_IMAGE)
      .withLabels({ [PRIVATE_POSTGRES_ATTEMPT_LABEL]: attemptId })
      .withEnvironment({
        POSTGRES_DB: database,
        POSTGRES_PASSWORD: password,
        POSTGRES_USER: user,
      })
      .withExposedPorts({ container: 5432, host: hostPort })
      .withWaitStrategy(postgresWaitStrategy({ database, user }));

    for (const { name: scriptName, content } of initScripts) {
      container = container.withCopyContentToContainer([
        { content, target: `/docker-entrypoint-initdb.d/${scriptName}`, mode: 0o755 },
      ]);
    }

    try {
      const started = await container.start();
      const endpoint = await startedPostgresEndpoint(started);
      return {
        container: started,
        databaseUrl: postgresConnectionUrl({ ...endpoint, user, password, database, clientMinMessagesWarning: true }),
      };
    } catch (error) {
      await removeFailedPrivateContainers(attemptId);
      if (!(error instanceof Error && /userland proxy:.*address already in use/i.test(error.message)) || attempt === 3) {
        throw error;
      }
    }
  }

  throw new Error("private postgres port retry limit exceeded");
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
    postgresConnectionUrl({ host: shared.host, port: shared.port, user: shared.adminUser, password: shared.adminPassword, database: "postgres" }),
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
    databaseUrl: postgresConnectionUrl({ host: shared.host, port: shared.port, user: role, password, database: databaseName, clientMinMessagesWarning: true }),
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
