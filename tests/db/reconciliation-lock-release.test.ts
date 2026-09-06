import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { startPostgresContainer } from "../support/postgres-container";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";

/** The namespace `PostgresFoldStore` hashes a repository id into for its coordination lock. */
const repositoryLockNamespace = 684029183;
const coordinationFailure = "Unable to coordinate repository reconciliation.";
/** A non-superuser: a superuser bypasses the EXECUTE checks these fixtures revoke. */
const restrictedRole = "reconciler";
/** Its unlock fails, but the session can still be asked to drop every advisory lock it holds. */
const recoverableRepositoryId = "repository-whose-unlock-fails";
/** Nothing on its session will give the lock back, so the session itself has to end. */
const doomedRepositoryId = "repository-whose-session-must-end";
/** A repository the fixtures never touch, reconciled through the pool that lost a connection. */
const untouchedRepositoryId = "repository-that-never-failed";
/**
 * How long we are willing to watch a terminated backend finish releasing its locks. A backend
 * releases its session locks as it exits, which can land just after the client has seen the FATAL
 * that ended the statement asking for the termination, so a single read races that exit. This is
 * only a looking budget: the assertion is on the locks that remain, and a lock on a session handed
 * back to the pool is never given up however long we look.
 */
const lockSettlingBudgetMs = 15_000;

interface HeldAdvisoryLock {
  granted: boolean;
  state: string | null;
}

interface Outcome {
  resolved?: unknown;
  rejection?: string;
}

interface FailedUnlockRecord {
  outcome: Outcome;
  remainingLocks: HeldAdvisoryLock[];
  /** The backend serving the coordination client before and after the failed call. */
  backendPidBefore: number;
  backendPidAfter: number;
}

interface ReconciliationRecord {
  interactions: string[];
  recoverable: FailedUnlockRecord;
  doomed: FailedUnlockRecord;
  poolProbe: Outcome;
  untouchedRepository: Outcome;
  reserveAfterTermination: Outcome;
  laterCoordination: Outcome[];
}

let container: StartedTestContainer | undefined;
let admin: Sql | undefined;
let workSql: Sql | undefined;
let coordinationSql: Sql | undefined;
let terminatingCoordinationSql: Sql | undefined;
let laterCoordinationSql: Sql | undefined;
let record: ReconciliationRecord;

describe("a reconciliation whose advisory unlock fails", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "overflow_lock_release_test",
      user: "overflow_lock_release_test",
      password: "overflow_lock_release_test",
    });
    container = started.container;
    admin = postgres(started.databaseUrl, { max: 2 });

    await admin.unsafe(`create role ${restrictedRole} login password '${restrictedRole}'`);

    const restrictedUrl = asRestrictedRole(started.databaseUrl);
    workSql = postgres(restrictedUrl, { max: 10 });
    coordinationSql = postgres(restrictedUrl, { max: 10 });
    // The doomed repository's coordination connection gets terminated, which is why this scenario
    // gets a client of its own: postgres.js will not settle an ordinary `end()` on it afterwards
    // (see afterAll), and the other clients are closed the ordinary way.
    terminatingCoordinationSql = postgres(restrictedUrl, { max: 10 });
    // Later coordinators run on their own connections. A session advisory lock is re-entrant, so
    // a coordinator reserving the very session that leaked the lock would take it again and
    // report success while the lock is still held.
    laterCoordinationSql = postgres(restrictedUrl, { max: 10 });

    const interactions: string[] = [];

    // Fixture one: the statement `withRepositoryReconciliation` runs cannot execute, while the
    // session it runs on stays alive and can still be asked to drop its advisory locks.
    await admin.unsafe("revoke execute on function pg_catalog.pg_advisory_unlock(bigint) from public");
    const recoverable = await reconcileThroughFailingUnlock(
      coordinationSql,
      workSql,
      recoverableRepositoryId,
      interactions,
    );

    // Fixture two: nothing the session can run will give the lock back.
    await admin.unsafe("revoke execute on function pg_catalog.pg_advisory_unlock_all() from public");
    const doomed = await reconcileThroughFailingUnlock(
      terminatingCoordinationSql,
      workSql,
      doomedRepositoryId,
      interactions,
    );

    // From here nothing but a lock left behind can still be wrong: both fixtures are gone.
    await admin.unsafe("grant execute on function pg_catalog.pg_advisory_unlock(bigint) to public");
    await admin.unsafe("grant execute on function pg_catalog.pg_advisory_unlock_all() to public");

    const poolProbe = await outcomeOf(
      coordinationSql<{ ok: number }[]>`select 1::integer as ok`.then((rows) => [...rows]),
    );
    const untouchedRepository = await outcomeOf(
      new PostgresFoldStore(workSql, undefined, coordinationSql)
        .withRepositoryReconciliation(untouchedRepositoryId, async () => {
          interactions.push("untouched-work-ran");
          return "reconciled-elsewhere";
        }),
    );
    const reserveAfterTermination = await outcomeOf(
      terminatingCoordinationSql.reserve().then((reserved) => {
        reserved.release();
        return "reserved";
      }),
    );

    const laterStore = new PostgresFoldStore(workSql, undefined, laterCoordinationSql);
    const laterCoordination: Outcome[] = [];
    for (const id of [recoverableRepositoryId, doomedRepositoryId]) {
      laterCoordination.push(await outcomeOf(
        laterStore.withRepositoryReconciliation(id, async () => {
          interactions.push(`later-work-ran-for-${id}`);
          return `reconciled-again-${id}`;
        }),
      ));
    }

    record = {
      interactions,
      recoverable,
      doomed,
      poolProbe,
      untouchedRepository,
      reserveAfterTermination,
      laterCoordination,
    };
  }, 600_000);

  afterAll(async () => {
    await workSql?.end();
    await coordinationSql?.end();
    // Forced, because postgres.js (3.4.9) does not clear a connection's in-flight query when that
    // query dies with the socket, and `Connection.end()` waits for a connection with a query still
    // in flight, so an ordinary `end()` on this client never settles.
    await terminatingCoordinationSql?.end({ timeout: 0 });
    await laterCoordinationSql?.end();
    await admin?.end();
    await container?.stop();
  });

  it("still runs the caller's work and still rejects the call", () => {
    expect(record.recoverable.outcome.rejection).toBe(coordinationFailure);
    expect(record.doomed.outcome.rejection).toBe(coordinationFailure);
    expect(record.interactions.slice(0, 2)).toEqual([
      `work-ran-for-${recoverableRepositoryId}`,
      `work-ran-for-${doomedRepositoryId}`,
    ]);
  });

  it("gives the lock back on a session it keeps, when that session can still drop it", () => {
    expect(record.recoverable.remainingLocks).toEqual([]);
    expect(record.recoverable.backendPidAfter).toBe(record.recoverable.backendPidBefore);
  });

  it("ends the session when nothing on it will give the lock back", () => {
    expect(record.doomed.remainingLocks).toEqual([]);
    expect(record.doomed.backendPidAfter).not.toBe(record.doomed.backendPidBefore);
  });

  it("keeps both coordination pools serving queries and handing out reservations", () => {
    expect(record.poolProbe.rejection).toBeUndefined();
    expect(record.poolProbe.resolved).toEqual([{ ok: 1 }]);
    expect(record.untouchedRepository.rejection).toBeUndefined();
    expect(record.untouchedRepository.resolved).toBe("reconciled-elsewhere");
    expect(record.reserveAfterTermination.rejection).toBeUndefined();
    expect(record.reserveAfterTermination.resolved).toBe("reserved");
  });

  it("lets a later coordinator for either repository run its work", () => {
    expect(record.laterCoordination.map((outcome) => outcome.rejection)).toEqual([
      undefined,
      undefined,
    ]);
    expect(record.laterCoordination.map((outcome) => outcome.resolved)).toEqual([
      `reconciled-again-${recoverableRepositoryId}`,
      `reconciled-again-${doomedRepositoryId}`,
    ]);
    expect(record.interactions).toEqual([
      `work-ran-for-${recoverableRepositoryId}`,
      `work-ran-for-${doomedRepositoryId}`,
      "untouched-work-ran",
      `later-work-ran-for-${recoverableRepositoryId}`,
      `later-work-ran-for-${doomedRepositoryId}`,
    ]);
  });
});

/**
 * Drives one reconciliation whose unlock cannot confirm, reading the coordination client's backend
 * on either side of it. Asking for the pid first leaves exactly one connection open, which is the
 * one the reservation then takes, so the two reads name the same session unless it ended: a client
 * that answers from the same backend kept its session, and one that answers from another did not.
 */
async function reconcileThroughFailingUnlock(
  coordination: Sql,
  workClient: Sql,
  id: string,
  interactions: string[],
): Promise<FailedUnlockRecord> {
  const backendPidBefore = await backendPidOf(coordination);
  const store = new PostgresFoldStore(workClient, undefined, coordination);
  const outcome = await outcomeOf(store.withRepositoryReconciliation(id, async () => {
    interactions.push(`work-ran-for-${id}`);
    return "reconciled";
  }));
  const remainingLocks = await advisoryLocksSettlingFor(id, lockSettlingBudgetMs);

  return { outcome, remainingLocks, backendPidBefore, backendPidAfter: await backendPidOf(coordination) };
}

async function backendPidOf(client: Sql): Promise<number> {
  const [row] = await client<{ pid: number }[]>`select pg_backend_pid()::integer as pid`;
  if (row === undefined) {
    throw new Error("The coordination client did not answer with a backend pid.");
  }

  return row.pid;
}

function asRestrictedRole(databaseUrl: string): string {
  const url = new URL(databaseUrl);
  url.username = restrictedRole;
  url.password = restrictedRole;

  return url.toString();
}

async function outcomeOf(work: Promise<unknown>): Promise<Outcome> {
  try {
    return { resolved: await work };
  } catch (error) {
    return { rejection: error instanceof Error ? error.message : String(error) };
  }
}

/** Advisory locks held on this repository's coordination key, read from an observer connection. */
async function advisoryLocksFor(id: string): Promise<HeldAdvisoryLock[]> {
  const observer = admin;
  if (observer === undefined) {
    throw new Error("The observer connection was never opened.");
  }
  const rows = await observer<HeldAdvisoryLock[]>`
    select locks.granted, activity.state
    from pg_locks as locks
    left join pg_stat_activity as activity on activity.pid = locks.pid
    where locks.locktype = 'advisory'
      and locks.classid = ((hashtextextended(${id}, ${repositoryLockNamespace}) >> 32) & 4294967295)::oid
      and locks.objid = (hashtextextended(${id}, ${repositoryLockNamespace}) & 4294967295)::oid
  `;

  return [...rows];
}

/** The locks left on the key once they stop clearing, or the looking budget runs out. */
async function advisoryLocksSettlingFor(id: string, budgetMs: number): Promise<HeldAdvisoryLock[]> {
  const deadline = Date.now() + budgetMs;
  let held = await advisoryLocksFor(id);

  while (held.length > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    held = await advisoryLocksFor(id);
  }

  return held;
}
