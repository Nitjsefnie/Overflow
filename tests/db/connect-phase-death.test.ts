import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";

const database = "overflow_connect_phase_death";

/**
 * What the client is told to wait before its next attempt once something has closed on it. Long
 * compared with the quiet window below, so an attempt that is scheduled rather than issued back
 * to back is observable without ever waiting for it; short compared with the per-test timeout, so
 * the shutdown at the end of that case does not spend the suite's budget.
 */
const spacingSeconds = 5;

/**
 * The only interval this file asserts across, and the only assertion here of the shape "this had
 * not happened yet". A timer can fire late but never early, so a loaded box moves the observation
 * the safe way, and the behaviour it separates from is unbounded rather than marginal: the report
 * this file comes from measured 32,605 connect attempts in 90 seconds with no delay between them.
 */
const quietWindowMs = 300;

/** Spacing for the cases that want the next attempt promptly; only its smallness matters. */
const promptSeconds = 0.01;

let container: StartedTestContainer | undefined;
let databaseUrl: string;

interface DeathProxy {
  port: number;
  /** One per TCP connection accepted, so one per connect attempt the client has made. */
  accepted: number;
  /**
   * `forward` relays real protocol traffic to the container; `acceptclose` accepts a connection
   * and sends a clean FIN once the client has spoken, which is what a pooler, a TCP load
   * balancer, a Kubernetes service or any non-postgres listener does while the backend is gone.
   */
  mode: "forward" | "acceptclose";
  /** Set once: FIN the client's socket instead of relaying its next chunk. */
  killOnNextData: boolean;
  /** Called synchronously after that FIN is queued, before the client can observe the close. */
  onKill: (() => void) | null;
  close(): Promise<void>;
}

/**
 * A local proxy in front of the container, so the moment of death is deterministic and so what
 * the unreachable server does *afterwards* can be chosen per case. Adapted from the probe on the
 * report; the accept counter is the record the spacing case asserts on, in place of elapsed time.
 */
async function startDeathProxy(target: { host: string; port: number }): Promise<DeathProxy> {
  const sockets = new Set<net.Socket>();
  const proxy = {
    port: 0,
    accepted: 0,
    mode: "forward",
    killOnNextData: false,
    onKill: null,
  } as DeathProxy;

  const server = net.createServer((client) => {
    proxy.accepted += 1;
    sockets.add(client);
    client.on("error", () => undefined);
    client.on("close", () => sockets.delete(client));

    if (proxy.mode === "acceptclose") {
      // Waiting for the client's StartupMessage before the FIN keeps this a connect-phase death
      // rather than a connection that was never really made: the attempt got as far as writing.
      client.once("data", () => client.end());
      return;
    }

    const upstream = net.connect(target);
    sockets.add(upstream);
    upstream.on("error", () => client.destroy());
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.end();
    });
    upstream.on("data", (chunk) => client.write(chunk));
    client.on("close", () => upstream.destroy());
    client.on("data", (chunk) => {
      if (!proxy.killOnNextData) {
        upstream.write(chunk);
        return;
      }
      // A clean FIN, not a reset: the client's socket closes with `hadError === false`, which is
      // the arm of the close path this file is about. A reset takes the error route instead, and
      // that one already settles a pending shutdown today.
      proxy.killOnNextData = false;
      upstream.destroy();
      client.end();
      proxy.onKill?.();
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  proxy.port = (server.address() as net.AddressInfo).port;
  proxy.close = async () => {
    for (const socket of [...sockets]) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  };

  return proxy;
}

/** A client of its own per case, reaching the container only through that case's proxy. */
function clientThrough(proxyPort: number, backoff: (attempt: number) => number) {
  const target = new URL(databaseUrl);
  target.host = `127.0.0.1:${proxyPort}`;
  // max: 1 so exactly one connection is ever in play and the proxy's accept count is unambiguous.
  return postgres(target.toString(), { max: 1, backoff });
}

/** Unbounded by design: the per-test timeout is the failure mechanism, not a margin asserted here. */
async function until(condition: () => boolean) {
  while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * A socket that dies while its connection is still opening — before the startup handshake has
 * finished, while postgres.js still holds the query that opened it as `initial`.
 *
 * The close path returns early for that state, so everything below the return is skipped: the
 * settle a pending `end()` needs, and the `closedTime`/retry-counter/`delay` bookkeeping the next
 * attempt is scheduled from. Both halves are held here — a shutdown that overlaps a connect-phase
 * death settles and stops the client, and one that does not overlap leaves the client retrying on
 * a schedule with an advancing attempt number instead of retrying flat out.
 *
 * The library client is driven directly rather than through `closeSql()`: the defect is in the
 * patched dependency, and the wrapper adds nothing to the evidence. `closeSql()` is awaited by
 * `scripts/migrate.ts`, `scripts/reconcile.ts` and this suite; the service has no shutdown handler
 * that reaches it, and nothing here should be read as covering one.
 */
describe("a connection whose socket dies while it is still opening", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database, user: database, password: database });
    container = started.container;
    databaseUrl = started.databaseUrl;
  });

  afterAll(async () => {
    await container?.stop();
  });

  it("settles a shutdown registered during the connect phase when every retry is accepted and closed", async () => {
    const target = new URL(databaseUrl);
    const proxy = await startDeathProxy({ host: target.hostname, port: Number(target.port) });
    const sql = clientThrough(proxy.port, () => promptSeconds);
    // Both halves record themselves as they settle, so the order below is the order that happened.
    const observed: string[] = [];
    let shutdown: Promise<void> | undefined;

    try {
      // Handlers attached in the expression that creates it: this rejects while the test is
      // awaiting the shutdown, and an unattached rejection there would be an unhandled one.
      const opening = sql`select 1 as value`.then(
        () => {
          observed.push("opening query resolved");
          return "resolved";
        },
        (error: { code?: string }) => {
          observed.push("opening query rejected");
          return error.code;
        },
      );

      proxy.onKill = () => {
        // From here on the peer accepts every attempt and closes it without speaking the protocol,
        // so nothing that would clear `initial` — an error event, a protocol message, a completed
        // handshake — ever arrives again. The shutdown is registered inside this callback, before
        // the client can observe the close, which is the interleaving the report measured.
        proxy.mode = "acceptclose";
        shutdown = sql.end();
        void shutdown.then(
          () => observed.push("shutdown settled"),
          () => observed.push("shutdown rejected"),
        );
      };
      proxy.killOnNextData = true;

      // The assertion this case exists for, awaited unbounded: without the fix nothing settles it
      // and the per-test timeout is what fails.
      await until(() => shutdown !== undefined);
      await expect(shutdown).resolves.toBeUndefined();
      await expect(opening).resolves.toBe("CONNECTION_CLOSED");
      expect(observed).toEqual(["opening query rejected", "shutdown settled"]);

      // Settling is only half of it: a settle that left the retry loop armed would still hold the
      // event loop open. One attempt was accepted, and no further attempt follows the shutdown.
      expect(proxy.accepted).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, quietWindowMs));
      expect(proxy.accepted).toBe(1);
    } finally {
      await sql.end();
      await proxy.close();
    }
  }, 120_000);

  it("rejects the opening query and stops when a shutdown is pending, even though the server comes straight back", async () => {
    const target = new URL(databaseUrl);
    const proxy = await startDeathProxy({ host: target.hostname, port: Number(target.port) });
    const sql = clientThrough(proxy.port, () => promptSeconds);

    try {
      const opening = sql`select 1 as value`.then(() => "resolved", (error: { code?: string }) => error.code);
      let shutdown: Promise<void> | undefined;
      proxy.onKill = () => {
        // The proxy stays in forward mode: the server is reachable again immediately, so a client
        // that retried here would complete the query. The deliberate choice is that it does not.
        // A query whose socket died is rejected rather than replayed at every other point in this
        // library, and retrying while ending is exactly the armed timer the case above forbids.
        shutdown = sql.end();
      };
      proxy.killOnNextData = true;

      await until(() => shutdown !== undefined);
      await expect(shutdown).resolves.toBeUndefined();
      await expect(opening).resolves.toBe("CONNECTION_CLOSED");
      // The record that no retry was made, rather than that none was made in time.
      expect(proxy.accepted).toBe(1);
    } finally {
      await sql.end();
      await proxy.close();
    }
  }, 120_000);

  it("keeps retrying on a schedule, with an advancing attempt number, when no shutdown is pending", async () => {
    const target = new URL(databaseUrl);
    const proxy = await startDeathProxy({ host: target.hostname, port: Number(target.port) });
    // The attempt numbers the client asks for are the record this case asserts on. The first
    // answer is prompt so a second attempt is observable at once; every later answer is the long
    // spacing, which is what the quiet window below is measured against.
    const attemptsAsked: number[] = [];
    const sql = clientThrough(proxy.port, (attempt) => {
      attemptsAsked.push(attempt);
      return attempt === 1 ? promptSeconds : spacingSeconds;
    });

    try {
      const opening = sql`select 1 as value`.then(() => "resolved", (error: { code?: string }) => error.code);
      proxy.onKill = () => {
        proxy.mode = "acceptclose";
      };
      proxy.killOnNextData = true;

      // Unbounded: two closes have to have happened before there is anything to assert. Without
      // the fix the delay is never computed at all, so this list stays empty and the loop below
      // runs until the per-test timeout — while the accept count climbs into the thousands.
      await until(() => attemptsAsked.length >= 2);

      // Attempt 1 and then attempt 2, not attempt 0 forever: the counter the spacing is derived
      // from advances. This pins the retry counter with no timing in it at all.
      expect(attemptsAsked).toEqual([1, 2]);
      expect(proxy.accepted).toBe(2);

      // The second close asked for `spacingSeconds`, so the third attempt is that far away. The
      // interval waited here is a small fraction of it, and back-to-back retries would have filled
      // it with hundreds of connections.
      await new Promise((resolve) => setTimeout(resolve, quietWindowMs));
      expect(proxy.accepted).toBe(2);
      expect(attemptsAsked).toEqual([1, 2]);

      // A shutdown that arrives between attempts, rather than during one, settles at the close of
      // the attempt already scheduled. Awaited unbounded, and it is also this case's cleanup.
      await expect(sql.end()).resolves.toBeUndefined();
      await expect(opening).resolves.toBe("CONNECTION_CLOSED");
    } finally {
      await sql.end();
      await proxy.close();
    }
  }, 120_000);

  it("completes the opening query on the retry when the server comes back and no shutdown is pending", async () => {
    const target = new URL(databaseUrl);
    const proxy = await startDeathProxy({ host: target.hostname, port: Number(target.port) });
    const sql = clientThrough(proxy.port, () => promptSeconds);

    try {
      const opening = sql`select 1 as value`;
      // Nothing ends here, and the proxy stays in forward mode: the retry reaches the server and
      // the query that opened the connection is served by it. A fix that rejected an opening query
      // on every connect-phase death, rather than only on one a shutdown is waiting behind, would
      // fail here.
      proxy.killOnNextData = true;

      await expect(opening).resolves.toEqual([{ value: 1 }]);
      expect(proxy.accepted).toBe(2);
    } finally {
      await sql.end();
      await proxy.close();
    }
  }, 120_000);
});
