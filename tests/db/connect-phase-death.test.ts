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
 * The delay the client is given in the case that ends it between attempts, and the window that
 * case then watches. The window is deliberately LONGER than the delay — an uncancelled retry has
 * had two and a half times its own delay to arrive by the end of it, so the window can tell a
 * cancelled retry from one that was merely outrun. A window shorter than the delay cannot, and
 * saying so was the defect in this file's first version of that case.
 */
const retryDelaySeconds = 1;
const cancelWindowMs = 2500;

/**
 * The interval the other two absence assertions in this file watch. Both of them follow a
 * settled shutdown against a client whose `backoff` answers `promptSeconds`, so a build that
 * wrongly rearmed would connect thirty times sooner than this window ends.
 *
 * It is evidence and not proof, and the difference matters in both directions. A timer fires late
 * but never early, so on a loaded box the rearm this window exists to catch moves *out* of it and
 * reads as a false green — unlike the spacing case, where the window is a small fraction of a
 * five-second wait and load moves the observation the safe way. Absence has no other observable
 * form; lengthening the window buys a linear improvement for linear run time, and the case that
 * has to be certain (the cancelled retry, above) buys that certainty with a window longer than
 * the delay instead.
 */
const quietWindowMs = 300;

/** Spacing for the cases that want the next attempt promptly; only its smallness matters. */
const promptSeconds = 0.01;

/**
 * `connect_timeout` for the one case that has to reach it: the client is left holding a handshake
 * no peer will ever answer, and this is how long that case is willing to sit there. Short only to
 * keep the case quick; nothing is asserted about the duration.
 */
const handshakeTimeoutSeconds = 2;

let container: StartedTestContainer | undefined;
let databaseUrl: string;

interface DeathProxy {
  port: number;
  /** One per TCP connection accepted, so one per connect attempt the client has made. */
  accepted: number;
  /**
   * `forward` relays real protocol traffic to the container; `acceptclose` accepts a connection
   * and sends a clean FIN once the client has spoken, which is what a pooler, a TCP load
   * balancer, a Kubernetes service or any non-postgres listener does while the backend is gone;
   * `hold` accepts and never answers, which is the peer the issue's `connect_timeout` contrast
   * measured.
   */
  mode: "forward" | "acceptclose" | "hold";
  /** Set once: FIN the client's socket instead of relaying its next chunk. */
  killOnNextData: boolean;
  /** Called synchronously after that FIN is queued, before the client can observe the close. */
  onKill: (() => void) | null;
  /**
   * Called with the running accept count once this connection's behaviour has been fixed, so a
   * case can choose what the NEXT attempt meets without racing the attempt it is watching.
   */
  onAccept: ((accepted: number) => void) | null;
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
    onAccept: null,
  } as DeathProxy;

  const server = net.createServer((client) => {
    proxy.accepted += 1;
    sockets.add(client);
    client.on("error", () => undefined);
    client.on("close", () => sockets.delete(client));

    // Read before the hook runs, so a hook that changes the mode changes it for the next attempt
    // and never for this one.
    const mode = proxy.mode;
    proxy.onAccept?.(proxy.accepted);

    if (mode === "hold") {
      // Accepted and never answered: the client's socket stays open with its StartupMessage
      // unanswered until its own connect_timeout gives up on it.
      client.on("data", () => undefined);
      return;
    }

    if (mode === "acceptclose") {
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
function clientThrough(
  proxyPort: number,
  backoff: (attempt: number) => number,
  connectTimeoutSeconds?: number,
) {
  const target = new URL(databaseUrl);
  target.host = `127.0.0.1:${proxyPort}`;
  // max: 1 so exactly one connection is ever in play and the proxy's accept count is unambiguous.
  // connect_timeout is left at the library's default unless a case needs to reach it.
  return postgres(target.toString(), {
    max: 1,
    backoff,
    ...(connectTimeoutSeconds === undefined ? {} : { connect_timeout: connectTimeoutSeconds }),
  });
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
 * Not covered, and not claimed. Two things, both with their own tracker issues and neither fixed
 * from here. Overflow issue 223 is the pool handing this connection queued work through
 * `onclose` after the shutdown settled, which starts a fresh connect with `ending` cleared;
 * `tests/db/shutdown-backlog-drain.test.ts` covers the half of that the drain in `end()` closes,
 * and the re-arm itself is not reached once the backlog is empty but is not guarded against
 * either. And the cancel below reaches only a retry a *close* scheduled: the pool's own
 * `connection.connect(query)` discards the handle `reconnect()` hands back, so a shutdown
 * arriving inside that scheduled window still waits it out. Widening the cancel to cover it
 * would reject a freshly dispatched query that every build serves today, which the last case in
 * this file exists to prevent.
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
      return retryDelaySeconds;
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
      // therefore a settle that did not wait for it, whatever the clock says.
      await expect(shutdown).resolves.toBeUndefined();
      expect(proxy.accepted).toBe(acceptedBeforeShutdown);

      // The query the connection was opened for is rejected rather than left pending, and it is
      // rejected by the shutdown itself: `terminate()` is what the client now takes, so the code
      // is the one that path always uses.
      await expect(opening).resolves.toBe("CONNECTION_DESTROYED");
      expect(observed).toEqual(["opening query rejected", "shutdown settled"]);

      // Cancelled, not merely outrun — which is a stronger claim than the settle being quick, and
      // needs a window LONGER than the delay rather than a fraction of it. The retry was one
      // second out; two and a half seconds later a client that had not cancelled it has connected
      // (the peer counts it) and been closed on again (its backoff is asked for another delay).
      // Both records are checked, because a build that rearmed without asking for a delay would
      // still show up in the first.
      await new Promise((resolve) => setTimeout(resolve, cancelWindowMs));
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

  it("still waits out a live handshake when a shutdown arrives, even after an earlier retry", async () => {
    const target = new URL(databaseUrl);
    const proxy = await startDeathProxy({ host: target.hostname, port: Number(target.port) });
    // The peer closes the first attempt and then holds the second one open in silence, so the
    // client is mid-handshake -- socket alive, StartupMessage sent -- with a spent retry behind
    // it. A build that recognised the between-retries state by a handle it never cleared would
    // see this connection as idle and terminate it; this one has to leave it to connect_timeout,
    // which is also the issue's own blackhole contrast and must not regress.
    const sql = clientThrough(proxy.port, () => promptSeconds, handshakeTimeoutSeconds);

    try {
      const opening = sql`select 1 as value`.then(() => "resolved", (error: { code?: string }) => error.code);
      proxy.mode = "acceptclose";
      proxy.onAccept = (accepted) => {
        if (accepted === 1) proxy.mode = "hold";
      };

      // The second attempt has been accepted, so the retry has fired and its handle is spent.
      await until(() => proxy.accepted >= 2);
      const shutdown = sql.end();

      // The distinguishing record is the code, not the delay: a terminated handshake rejects with
      // CONNECTION_DESTROYED, one left to time out with CONNECT_TIMEOUT. Awaited unbounded.
      await expect(opening).resolves.toBe("CONNECT_TIMEOUT");
      await expect(shutdown).resolves.toBeUndefined();
      // And the timeout ends the client rather than starting another round.
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
