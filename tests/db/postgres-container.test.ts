import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import { getContainerRuntimeClient, Wait, type StartedTestContainer, type WaitStrategy } from "testcontainers";
import { postgresWaitStrategy, startPostgresContainer } from "../support/postgres-container";

const database = "overflow_wait_test";
const postgresPortInHex = ":1538";
const listenState = "0A";
const dockerStreamHeaderLength = 8;

/** `Wait.forListeningPorts()` is the only route to its class: testcontainers does not export it. */
const listeningPortsStrategyClass = Wait.forListeningPorts().constructor as new () => WaitStrategy;

interface StartupRecord {
  listeningEntries: string[];
  logs: string;
  queryRows: unknown;
  queryFailure: string | undefined;
}

let container: StartedTestContainer | undefined;
let sql: Sql | undefined;
let record: StartupRecord;

describe("the shared postgres container is reachable over TCP the instant it resolves", () => {
  beforeAll(async () => {
    // The init script holds the entrypoint's temporary Unix-socket-only server open. A wait
    // strategy that reaches postgres over that socket resolves inside this window, while nothing
    // listens on TCP 5432 yet; the sleep is the fixture that opens the window, not an assertion.
    const started = await startPostgresContainer({
      database,
      user: database,
      password: database,
      initScripts: [{ name: "00-hold-init-phase.sh", content: "#!/bin/sh\nsleep 3\n" }],
    });
    container = started.container;
    sql = postgres(started.databaseUrl, { max: 1 });

    const [procNetTcp, logs, query] = await Promise.all([
      started.container.exec(["sh", "-c", "cat /proc/net/tcp /proc/net/tcp6"]),
      readContainerLogs(started.container.getId()),
      sql`select 1 as value`.then(
        (rows) => ({ rows: [...rows] as unknown, failure: undefined }),
        (error: unknown) => ({ rows: undefined, failure: String(error) }),
      ),
    ]);

    record = {
      listeningEntries: listeningEntriesOnPostgresPort(procNetTcp.output),
      logs,
      queryRows: query.rows,
      queryFailure: query.failure,
    };
  });

  afterAll(async () => {
    await sql?.end();
    await container?.stop();
  });

  it("already has a listening socket on port 5432 inside the container", () => {
    expect(record.listeningEntries).not.toHaveLength(0);
  });

  it("has already finished the entrypoint init phase", () => {
    expect(record.logs).toContain("PostgreSQL init process complete");
  });

  it("answers a query from the client every database suite uses", () => {
    expect(record.queryFailure).toBeUndefined();
    expect(record.queryRows).toEqual([{ value: 1 }]);
  });

  // Either limb alone gets this fixture past the three assertions above, so the behavioural test
  // cannot tell whether both are still there. This pins the pair itself.
  it("waits on a listening port and on a pg_isready handshake forced over TCP", () => {
    const limbs = limbsOf(postgresWaitStrategy({ database, user: database }));

    expect(limbs).toBeInstanceOf(Array);
    expect(limbs?.filter((limb) => limb instanceof listeningPortsStrategyClass)).toHaveLength(1);

    const commands = (limbs ?? []).flatMap((limb) => {
      const { command } = limb as unknown as { command?: unknown };

      return typeof command === "string" ? [command] : [];
    });

    expect(commands).toHaveLength(1);
    expect(commands[0]).toContain("pg_isready");
    expect(commands[0]).toContain("--host 127.0.0.1");
  });
});

/** The members a composite wait strategy waits on, or undefined when it is not a composite. */
function limbsOf(strategy: WaitStrategy): WaitStrategy[] | undefined {
  return (strategy as unknown as { waitStrategies?: WaitStrategy[] }).waitStrategies;
}

/** Local listeners on 5432 (hex 1538) in the `/proc/net/tcp` and `/proc/net/tcp6` tables. */
function listeningEntriesOnPostgresPort(procNetTcp: string): string[] {
  const entries: string[] = [];

  for (const line of procNetTcp.split("\n")) {
    const [, localAddress, , state] = line.trim().split(/\s+/);
    if (localAddress?.endsWith(postgresPortInHex) && state === listenState) {
      entries.push(`${localAddress} ${state}`);
    }
  }

  return entries;
}

/** A snapshot of everything the container has logged so far — never a follow stream. */
async function readContainerLogs(containerId: string): Promise<string> {
  const client = await getContainerRuntimeClient();
  const logs = await client.container.getById(containerId).logs({ follow: false, stdout: true, stderr: true });

  return demultiplexDockerStream(logs);
}

/**
 * Docker multiplexes stdout and stderr into a single stream of frames: an eight-byte header
 * carrying the source stream, three reserved zero bytes and a big-endian payload length, then the
 * payload. Matching against the raw buffer would miss any line a frame boundary splits in two.
 */
function demultiplexDockerStream(stream: Buffer): string {
  const payloads: Buffer[] = [];
  let offset = 0;

  while (offset < stream.length) {
    const header = stream.subarray(offset, offset + dockerStreamHeaderLength);

    if (header.length < dockerStreamHeaderLength || header[0] > 2 || header.readUIntBE(1, 3) !== 0) {
      throw new Error(`Not a multiplexed docker stream frame at byte ${offset}`);
    }

    const payloadStart = offset + dockerStreamHeaderLength;
    const payloadEnd = payloadStart + header.readUInt32BE(4);

    if (payloadEnd > stream.length) {
      throw new Error(`Truncated docker stream frame at byte ${offset}`);
    }

    payloads.push(stream.subarray(payloadStart, payloadEnd));
    offset = payloadEnd;
  }

  return Buffer.concat(payloads).toString("utf8");
}
