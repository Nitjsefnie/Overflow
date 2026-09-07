import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";

const database = "overflow_shutdown_backlog";

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
    // the array underneath the drain's own cursor, so this case is the one that would catch it.
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
});
