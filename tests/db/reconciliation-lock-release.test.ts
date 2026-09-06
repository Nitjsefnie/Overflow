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
/** Its targeted unlock is denied, so the reclaim falls to `pg_advisory_unlock_all()`. */
const unlockAllRepositoryId = "repository-reclaimed-by-unlock-all";
/** Both unlock functions are denied, so the reclaim falls to `DISCARD ALL`. */
const discardAllRepositoryId = "repository-reclaimed-by-discard-all";
/** A repository the fixtures never touch, reconciled through a pool that has already reclaimed. */
const untouchedRepositoryId = "repository-that-never-failed";

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
  unlockAll: FailedUnlockRecord;
  discardAll: FailedUnlockRecord;
  poolProbe: Outcome;
  untouchedRepository: Outcome;
  reservationAfterDiscard: Outcome;
  laterCoordination: Outcome[];
}

let container: StartedTestContainer | undefined;
let admin: Sql | undefined;
let workSql: Sql | undefined;
let unlockAllSql: Sql | undefined;
let discardAllSql: Sql | undefined;
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
    // One coordination client per fixture, so each one's backend can be named on both sides of
    // its failed call without the other fixture's traffic moving it.
    unlockAllSql = postgres(restrictedUrl, { max: 10 });
    discardAllSql = postgres(restrictedUrl, { max: 10 });
    // Later coordinators run on their own connections. A session advisory lock is re-entrant, so
    // a coordinator reserving the very session that leaked the lock would take it again and
    // report success while the lock is still held.
    laterCoordinationSql = postgres(restrictedUrl, { max: 10 });

    const interactions: string[] = [];

    // Fixture one: the statement `withRepositoryReconciliation` runs cannot execute, while the
    // session it runs on stays alive and can still be asked to drop its advisory locks.
    await admin.unsafe("revoke execute on function pg_catalog.pg_advisory_unlock(bigint) from public");
    const unlockAll = await reconcileThroughFailingUnlock(
      unlockAllSql,
      workSql,
      unlockAllRepositoryId,
      interactions,
    );

    // Fixture two: no advisory-unlock function is callable at all. `DISCARD ALL` is a utility
    // statement rather than a function call, so no revoked grant can reach it.
    await admin.unsafe("revoke execute on function pg_catalog.pg_advisory_unlock_all() from public");
    const discardAll = await reconcileThroughFailingUnlock(
      discardAllSql,
      workSql,
      discardAllRepositoryId,
      interactions,
    );

    // From here nothing but a lock left behind can still be wrong: both fixtures are gone.
    await admin.unsafe("grant execute on function pg_catalog.pg_advisory_unlock(bigint) to public");
    await admin.unsafe("grant execute on function pg_catalog.pg_advisory_unlock_all() to public");

    const poolProbe = await outcomeOf(
      unlockAllSql<{ ok: number }[]>`select 1::integer as ok`.then((rows) => [...rows]),
    );
    const untouchedRepository = await outcomeOf(
      new PostgresFoldStore(workSql, undefined, unlockAllSql)
        .withRepositoryReconciliation(untouchedRepositoryId, async () => {
          interactions.push("untouched-work-ran");
          return "reconciled-elsewhere";
        }),
    );
    const reservationAfterDiscard = await outcomeOf(
      discardAllSql.reserve().then((reserved) => {
        reserved.release();
        return "reserved";
      }),
    );

    // Concurrently, so one refused coordinator cannot push this hook past its timeout by waiting
    // out the 60-second lock deadline behind another. Resolution is the proof the lock is gone;
    // each callback's return value is what the caller receives, so a resolved value is proof the
    // callback ran.
    const laterStore = new PostgresFoldStore(workSql, undefined, laterCoordinationSql);
    const laterCoordination = await Promise.all(
      [unlockAllRepositoryId, discardAllRepositoryId].map((id) => outcomeOf(
        laterStore.withRepositoryReconciliation(id, async () => `reconciled-again-${id}`),
      )),
    );

    record = {
      interactions,
      unlockAll,
      discardAll,
      poolProbe,
      untouchedRepository,
      reservationAfterDiscard,
      laterCoordination,
    };
  });

  afterAll(async () => {
    await workSql?.end();
    await unlockAllSql?.end();
    await discardAllSql?.end();
    await laterCoordinationSql?.end();
    await admin?.end();
    await container?.stop();
  });

  it("still runs the caller's work and still rejects the call", () => {
    expect(record.unlockAll.outcome.rejection).toBe(coordinationFailure);
    expect(record.discardAll.outcome.rejection).toBe(coordinationFailure);
    expect(record.interactions).toEqual([
      `work-ran-for-${unlockAllRepositoryId}`,
      `work-ran-for-${discardAllRepositoryId}`,
      "untouched-work-ran",
    ]);
  });

  it("gives the lock back through pg_advisory_unlock_all(), keeping the session", () => {
    expect(record.unlockAll.remainingLocks).toEqual([]);
    expect(record.unlockAll.backendPidAfter).toBe(record.unlockAll.backendPidBefore);
  });

  it("gives the lock back through DISCARD ALL when no unlock function is callable", () => {
    expect(record.discardAll.remainingLocks).toEqual([]);
    expect(record.discardAll.backendPidAfter).toBe(record.discardAll.backendPidBefore);
  });

  it("keeps both coordination pools serving queries and handing out reservations", () => {
    expect(record.poolProbe.rejection).toBeUndefined();
    expect(record.poolProbe.resolved).toEqual([{ ok: 1 }]);
    expect(record.untouchedRepository.rejection).toBeUndefined();
    expect(record.untouchedRepository.resolved).toBe("reconciled-elsewhere");
    expect(record.reservationAfterDiscard.rejection).toBeUndefined();
    expect(record.reservationAfterDiscard.resolved).toBe("reserved");
  });

  it("lets a later coordinator for either repository run its work", () => {
    expect(record.laterCoordination.map((outcome) => outcome.rejection)).toEqual([
      undefined,
      undefined,
    ]);
    expect(record.laterCoordination.map((outcome) => outcome.resolved)).toEqual([
      `reconciled-again-${unlockAllRepositoryId}`,
      `reconciled-again-${discardAllRepositoryId}`,
    ]);
  });
});

/**
 * Drives one reconciliation whose unlock cannot confirm, reading the coordination client's backend
 * on either side of it. Asking for the pid first leaves exactly one connection open, which is the
 * one the reservation then takes, so the two reads name the same session unless it ended: a client
 * that answers from the same backend kept its session, and one that answers from another did not.
 *
 * The locks are read once rather than waited on. Both stages that reach a database here release
 * the lock on a session that stays alive, so the release has happened by the time the statement
 * that did it has answered.
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
  const remainingLocks = await advisoryLocksFor(id);

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
