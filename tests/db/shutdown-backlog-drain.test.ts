import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";

const database = "overflow_shutdown_backlog";

/**
 * How long the client is willing to wait for a handshake nobody will answer. It is what makes the
 * ordering case's connection unable to finish ending; only its being longer than everything else
 * that case does matters, and nothing is asserted about the duration.
 */
const unansweredHandshakeSeconds = 3;

let container: StartedTestContainer | undefined;
let databaseUrl: string;

/** What a promise did, as a string, so a list of outcomes can be asserted in one comparison. */
function outcome(promise: Promise<unknown>): Promise<string> {
  return promise.then(
    (value) => `settled:${JSON.stringify(value)}`,
    (error: { code?: string }) => `rejected:${error.code}`,
  );
}

/**
 * Records what a promise did, in the order it happened, and hands back the outcome string. The
 * ordering case asserts on this list rather than on a clock: the question it answers is whether
 * the backlog was disposed of before or after the shutdown waited on its connections.
 */
function record(promise: Promise<unknown>, name: string, into: string[]): Promise<string> {
  return outcome(promise).then((result) => {
    into.push(`${name} ${result.startsWith("rejected") ? "rejected" : "settled"}`);
    return result;
  });
}

/**
 * A listener that accepts a connection and never answers it — no postgres behind it at all,
 * because a client that never finishes its handshake never needs one. It is what a restarting
 * server, a pooler with no backend, or a firewall that swallows the reply looks like.
 */
async function startSilentListener(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
    socket.on("data", () => undefined);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  return {
    port: (server.address() as net.AddressInfo).port,
    async close() {
      for (const socket of [...sockets]) socket.destroy();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

/**
 * Work the pool accepted but never handed to a connection, when the client is ended. Overflow
 * issue 223.
 *
 * `handler()` queues a query whenever every connection is busy, and `end()` settles connections
 * rather than that queue. What stock then does with the backlog depends on something the caller
 * cannot see, and neither outcome is the shutdown being over. A connection that finishes its work
 * during the shutdown takes `ending ? terminate()`, and `terminate()` nulls its `ending` — so the
 * socket close that follows reaches `onclose` with the backlog still in the queue and RESURRECTS
 * that connection to serve it, after `sql.end()` has already resolved. Where the server is
 * unreachable instead, the resurrected connection never completes and the same work is never
 * settled at all. Both were observed on the build before this patch: this file's first case was
 * served by a resurrected connection, and its second timed out.
 *
 * `destroy()` — the path `sql.end({ timeout })` reaches when the timer wins — already disposes of
 * the same queue with `CONNECTION_DESTROYED`. The patch gives the ordinary path the same
 * disposition, before the connections are told to end, so the two agree and the queue is empty by
 * the time any `onclose` could read it.
 *
 * The visible change is that a shutdown of a perfectly healthy client now rejects queued work
 * that it used to run behind the caller's back. That is the point: a caller can tell the
 * difference between "your query ran" and "your query never will", and gets neither answer from a
 * promise that settles whenever a resurrected connection happens to reach the server.
 *
 * `closeSql()` is awaited by `scripts/migrate.ts`, `scripts/reconcile.ts` and this suite; the
 * service has no shutdown handler that reaches it, and nothing here should be read as covering
 * one. The library client is driven directly for the same reason as the connect-phase suite: the
 * behaviour under test belongs to the patched dependency.
 */
describe("ending a client that still has queued work", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database, user: database, password: database });
    container = started.container;
    databaseUrl = started.databaseUrl;
  });

  afterAll(async () => {
    await container?.stop();
  });

  it("settles queued queries the shutdown will never dispatch", async () => {
    // One connection, so the second and third queries are certainly queued rather than dispatched.
    const sql = postgres(databaseUrl, { max: 1 });

    // Dispatched explicitly and in order: `execute()` and `end()` each reach their work one
    // microtask later, so queuing all three first is what puts them in the backlog the shutdown
    // then has to dispose of.
    const dispatched = outcome(sql`select 1 as value`.execute());
    const queued = [
      outcome(sql`select 2 as value`.execute()),
      outcome(sql`select 3 as value`.execute()),
    ];

    // Nothing has died and nothing is unreachable: this is an ordinary shutdown of a healthy
    // client, awaited unbounded.
    await expect(sql.end()).resolves.toBeUndefined();

    // The query that reached the connection is served — a shutdown waits for work in flight.
    await expect(dispatched).resolves.toBe('settled:[{"value":1}]');

    // The two that never reached it are rejected rather than run behind the shutdown's back.
    // Without the drain both of these resolve with rows, served by a connection the pool brought
    // back after this `end()` had resolved.
    await expect(Promise.all(queued)).resolves.toEqual([
      "rejected:CONNECTION_DESTROYED",
      "rejected:CONNECTION_DESTROYED",
    ]);
  }, 120_000);

  it("settles a queued reserve() and the work queued behind it", async () => {
    const sql = postgres(databaseUrl, { max: 1 });

    // Occupies the only connection, so both of the next two go to the backlog.
    const dispatched = outcome(sql`select 1 as value`.execute());

    // One microtask, and it is load-bearing. A query reaches the pool a tick after `execute()`,
    // while `reserve()` runs its body synchronously and takes a connection straight out of the
    // closed queue -- so without this yield the RESERVE would own the connection and the query
    // would be the queued one. That is a real interleaving, but it is not the one this case is
    // about, and the assertion that `dispatched` was served is what tells the two apart rather
    // than letting the case pass for the wrong reason.
    await Promise.resolve();

    // A reserve is a pseudo-query in the same queue, and the patch gives it a rejection that
    // removes it from that queue. The drain shifts each entry out before rejecting it, exactly as
    // `destroy()` does, which is what keeps that removal inert -- a shifted entry is no longer
    // found by `indexOf`. A drain that rejected without shifting would have the reserve splice
    // the array underneath the drain's own cursor: this case catches that, but by hanging until
    // the per-test timeout, because the entry behind the reserve is skipped rather than
    // mis-settled. The assertion-shaped failure for that mutation comes from
    // `reserve-contract.test.ts`, whose queued reservation is settled with a code it can name.
    const reservation = outcome(sql.reserve());
    const behindIt = outcome(sql`select 2 as value`.execute());

    await expect(sql.end()).resolves.toBeUndefined();

    await expect(dispatched).resolves.toBe('settled:[{"value":1}]');
    // Both, and in one assertion: the entry queued behind the reserve is the one a corrupted
    // cursor would skip.
    await expect(Promise.all([reservation, behindIt])).resolves.toEqual([
      "rejected:CONNECTION_DESTROYED",
      "rejected:CONNECTION_DESTROYED",
    ]);
  }, 120_000);

  it("disposes of the backlog before waiting for a connection that cannot finish ending", async () => {
    // Nothing answers this listener, so the client's only connection is stuck in a handshake for
    // `unansweredHandshakeSeconds` and its own `end()` cannot settle until then. That is what
    // makes the drain's *order* observable: draining before the connections are told to end
    // settles the backlog now, draining after settles it only once every connection has finished
    // ending -- and where a connection never finishes, never. Every other case in this file uses
    // a reachable server, where both orders look identical.
    const listener = await startSilentListener();
    const sql = postgres({
      host: "127.0.0.1",
      port: listener.port,
      database,
      username: database,
      password: database,
      max: 1,
      connect_timeout: unansweredHandshakeSeconds,
    });
    const observed: string[] = [];

    try {
      const dispatched = record(sql`select 1 as value`.execute(), "dispatched", observed);
      const queued = record(sql`select 2 as value`.execute(), "queued", observed);
      const shutdown = record(sql.end(), "shutdown", observed);

      // Awaited unbounded. The assertion is the list, not the wait: when the backlog is disposed
      // of, the shutdown must still be pending, because the connection it is waiting on is still
      // in a handshake nobody is going to answer.
      await expect(queued).resolves.toBe("rejected:CONNECTION_DESTROYED");
      expect(observed).toEqual(["queued rejected"]);

      // And the rest of the shutdown still happens in its own time: the stuck handshake gives up
      // at its connect_timeout, which is what rejects the dispatched query and settles the
      // shutdown -- after the backlog, not before it.
      await expect(shutdown).resolves.toBe("settled:undefined");
      await expect(dispatched).resolves.toBe("rejected:CONNECT_TIMEOUT");
      expect(observed).toEqual(["queued rejected", "dispatched rejected", "shutdown settled"]);
    } finally {
      await listener.close();
    }
  }, 120_000);

  it("refuses a reservation requested after the shutdown, as it already refuses a query", async () => {
    const sql = postgres(databaseUrl, { max: 1 });

    // Healthy first, so the pool has really opened and closed a connection rather than never
    // having had one.
    await expect(sql`select 1 as value`).resolves.toEqual([{ value: 1 }]);
    await expect(sql.end()).resolves.toBeUndefined();

    // The parity this case exists for, and the half of it that is verified rather than assumed:
    // an ordinary query submitted after the shutdown is refused by `handler()`, which consults
    // the pool's `ending` flag.
    await expect(sql`select 2 as value`).rejects.toMatchObject({ code: "CONNECTION_ENDED" });

    // `reserve()` pushes into the same queue without going through `handler()`, so before the
    // patch it was served: against a reachable server by opening a fresh socket after the
    // shutdown had resolved, and against an unreachable one by waiting for a connection that
    // never comes -- a promise nothing settles, since the drain has already run and runs once.
    // It now answers exactly as the query above does.
    await expect(sql.reserve()).rejects.toMatchObject({ code: "CONNECTION_ENDED" });
  }, 120_000);
});
