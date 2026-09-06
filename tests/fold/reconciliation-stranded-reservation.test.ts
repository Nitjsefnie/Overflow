import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";
import { RECONCILIATION_COORDINATION_POOL_MAX } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";

const queuedRepositoryIds = ["queued-a", "queued-b", "queued-c", "queued-d"] as const;

type QueuedOutcome = { id: string; ran: boolean; outcome: string };

let container: StartedTestContainer | undefined;
let work: Sql | undefined;
let coordination: Sql | undefined;
let observer: Sql | undefined;

/**
 * A coordination connection can die at any moment — a server restart, an administrator
 * terminating a backend, a network blip — and when the coordination pool is at its bound the
 * reconciliations behind it are queued for a connection rather than holding one. This pins what
 * those queued reconciliations get: a connection as soon as the pool has one, never a reservation
 * that is silently dropped and can only end as the lock-wait deadline expiring.
 *
 * The assertion is on what each queued reconciliation *did* — whether its work callback ran and
 * how the call settled — and never on how long it took. A stranded reservation shows up here as a
 * refusal with `ran: false`, which is a named failure rather than a measured one.
 */
describe("a coordination connection that dies while reconciliations are queued behind it", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "stranded_reservation",
      user: "stranded_reservation",
      password: "stranded_reservation",
    });
    container = started.container;
    // No migrations: repository coordination touches advisory locks only, no tables.
    work = postgres(started.databaseUrl, { max: RECONCILIATION_COORDINATION_POOL_MAX });
    coordination = postgres(started.databaseUrl, { max: RECONCILIATION_COORDINATION_POOL_MAX });
    observer = postgres(started.databaseUrl, { max: 3 });
  });

  afterAll(async () => {
    await Promise.all([
      work?.end({ timeout: 0 }),
      coordination?.end({ timeout: 0 }),
      observer?.end({ timeout: 0 }),
    ]);
    await container?.stop();
  });

  it("serves every queued reconciliation once one held backend is terminated", async () => {
    const store = new PostgresFoldStore(work!, undefined, coordination!);

    let releaseHolders!: () => void;
    const held = new Promise<void>((resolve) => { releaseHolders = resolve; });
    let allHoldersStarted!: () => void;
    const everyHolderInsideItsWork = new Promise<void>((resolve) => { allHoldersStarted = resolve; });
    let startedHolders = 0;

    const holders = Array.from({ length: RECONCILIATION_COORDINATION_POOL_MAX }, (_unused, index) =>
      store
        .withRepositoryReconciliation(`holder-${index}`, async () => {
          startedHolders += 1;
          if (startedHolders === RECONCILIATION_COORDINATION_POOL_MAX) {
            allHoldersStarted();
          }
          await held;
        })
        .catch(() => undefined));

    // Every coordination connection is now reserved and parked inside its work callback, so the
    // pool is at its bound and has nothing to hand out.
    await everyHolderInsideItsWork;

    // `reserve()` enqueues its pseudo-query before it yields, so these four are queued on the
    // coordination pool by the time this statement returns — no wait is needed to arrange that.
    const queued = queuedRepositoryIds.map((id) => {
      let ran = false;
      return store
        .withRepositoryReconciliation(id, async () => { ran = true; })
        .then((): QueuedOutcome => ({ id, ran, outcome: "resolved" }))
        .catch((error: Error): QueuedOutcome => ({ id, ran, outcome: `rejected: ${error.message}` }));
    });

    const [victim] = await observer!<{ pid: number }[]>`
      select pid::integer as pid from pg_locks where locktype = 'advisory' and granted limit 1
    `;
    expect(victim?.pid).toEqual(expect.any(Number));
    await observer!`select pg_terminate_backend(${victim!.pid})`;

    // The nine surviving holders keep their connections all the way through this await, so the
    // single replacement for the connection that died serves the queued four on its own: each
    // one's callback returns at once and its release hands the connection to the next.
    const outcomes = await Promise.all(queued);
    releaseHolders();
    await Promise.all(holders);

    expect(outcomes).toEqual(
      queuedRepositoryIds.map((id) => ({ id, ran: true, outcome: "resolved" })),
    );
  });
});
