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
 * The spacing for the case that ends a client sitting between attempts. Deliberately far longer
 * than anything that case is willing to wait: a shutdown that settled by riding the next attempt
 * would take this long, so the case cannot pass by being quick.
 */
const longSpacingSeconds = 30;

/**
 * The two intervals asserted across in this file are both this long, and the argument for them
 * differs by use, so both are stated rather than one being borrowed for the other.
 *
 * Where the client has just been told to wait `spacingSeconds` or `longSpacingSeconds` (the
 * spacing case, and the between-attempts shutdown), this window is a small fraction of the wait
 * and a timer can fire late but never early, so a loaded box moves the observation the safe way.
 * That is the permitted shape, and the behaviour it separates from is unbounded rather than
 * marginal: Overflow issue 164 measured 32,605 connect attempts in 90 seconds with no delay
 * between them.
 *
 * Where instead the claim is that nothing is armed at all (after a shutdown has settled), the
 * window is evidence and not proof: a build that wrongly rearmed would schedule its attempt
 * `promptSeconds` out, thirty times shorter than this window, but a box stalled for a third of a
 * second could still let it slip past and read as a false green. Absence has no other observable
 * form, and lengthening the window buys a linear improvement for linear run time.
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
 * the unreachable server does *afterwards* can be chosen per case. Adapted from the probe filed
 * with Overflow issue 164; the accept counter is the record the spacing and shutdown cases assert
 * on, in place of elapsed time.
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
 * finished, while postgres.js still holds the query that opened it as `initial`. Overflow issue
 * 164.
 *
 * The close path returned early for that state, so everything below the return was skipped: the
 * settle a pending `end()` needs, and the `closedTime`/retry-counter/`delay` bookkeeping the next
 * attempt is scheduled from. Three properties are held here — a shutdown that overlaps a
 * connect-phase death settles and stops the client; a shutdown that arrives while the client is
 * merely waiting out a scheduled retry settles then, rather than riding that retry; and with no
 * shutdown at all the client keeps trying on a schedule with an advancing attempt number instead
 * of retrying flat out.
 *
 * Not covered, and not claimed: a shutdown that settles here leaves the pool free to hand this
 * connection queued work through `onclose`, which starts a fresh connect with `ending` cleared,
 * so a client with queries queued behind the opening one can re-enter the loop after `end()` has
 * resolved. That is a separate defect with its own tracker issue.
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
        // the client can observe the close, which is the interleaving Overflow issue 164 measured.
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
      // event loop open. One attempt was accepted, and none follows the shutdown — see the quiet
      // window's docstring for what this does and does not establish.
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
      // No retry was made, and none is armed: a build that settled, rejected and still rearmed
      // would reach the server within `promptSeconds` and be counted inside the window below.
      expect(proxy.accepted).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, quietWindowMs));
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
      // Never settles inside this case; handlers are attached so the rejection the cleanup below
      // produces is never an unhandled one.
      void sql`select 1 as value`.then(() => undefined, () => undefined);
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
    } finally {
      await sql.end();
      await proxy.close();
    }
  }, 120_000);

  it("settles at once when the shutdown arrives between scheduled retries, without waiting for the next one", async () => {
    const target = new URL(databaseUrl);
    const proxy = await startDeathProxy({ host: target.hostname, port: Number(target.port) });
    const attemptsAsked: number[] = [];
    const sql = clientThrough(proxy.port, (attempt) => {
      attemptsAsked.push(attempt);
      return longSpacingSeconds;
    });
    const observed: string[] = [];

    try {
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
        proxy.mode = "acceptclose";
      };
      proxy.killOnNextData = true;

      // The state this case is about, entered by observation rather than by sleeping: the client
      // has been closed on, has asked for its next delay, and is now doing nothing but waiting.
      await until(() => attemptsAsked.length >= 1);
      expect(attemptsAsked).toEqual([1]);
      const acceptedBeforeShutdown = proxy.accepted;
      expect(acceptedBeforeShutdown).toBe(1);

      const shutdown = sql.end();
      void shutdown.then(
        () => observed.push("shutdown settled"),
        () => observed.push("shutdown rejected"),
      );

      // The record that stands in for the settle latency, and the reason this case needs no
      // margin: a shutdown that settles by riding the scheduled retry can only settle after that
      // retry has been made, which the peer would accept and count. An unchanged count is
      // therefore a settle that did not wait for it — and the wait it did not take is
      // `longSpacingSeconds`, far longer than this whole case.
      await expect(shutdown).resolves.toBeUndefined();
      expect(proxy.accepted).toBe(acceptedBeforeShutdown);

      // The query the connection was opened for is rejected rather than left pending, and it is
      // rejected by the shutdown itself: `terminate()` is what the client now takes, so the code
      // is the one that path always uses.
      await expect(opening).resolves.toBe("CONNECTION_DESTROYED");
      expect(observed).toEqual(["opening query rejected", "shutdown settled"]);

      // The scheduled retry was cancelled rather than merely outrun: it was `longSpacingSeconds`
      // away, so nothing may arrive in the window below, and nothing may keep the loop alive.
      await new Promise((resolve) => setTimeout(resolve, quietWindowMs));
      expect(proxy.accepted).toBe(acceptedBeforeShutdown);
      expect(attemptsAsked).toEqual([1]);
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

  it("still serves a query issued in the same tick as the shutdown, with no socket death at all", async () => {
    // No proxy: nothing dies here. A connection the pool has just been handed a query for is also
    // socketless and also holds that query as `initial`, because its first connect is scheduled
    // rather than immediate -- so a shutdown that recognised the waiting-to-retry state by the
    // absence of a socket would reject this query too, where postgres.js completes it. That is
    // the boundary the fix has to stay on the right side of.
    const sql = postgres(databaseUrl, { max: 1 });
    // Dispatched explicitly. A query object on its own is inert until something awaits it, and an
    // inert one is refused outright by the pool once `end()` has been called, which is a different
    // rejection from a different place and would prove nothing about this connection's state.
    // Both `execute()` and `end()` reach their work one microtask later, and this one was queued
    // first, so the connection is holding the query before the shutdown arrives.
    const opening = sql`select 1 as value`.execute();
    const shutdown = sql.end();

    await expect(opening).resolves.toEqual([{ value: 1 }]);
    await expect(shutdown).resolves.toBeUndefined();
  }, 120_000);
});
