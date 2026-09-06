import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
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
/** Every stage before the terminate is denied, so the session itself has to end. */
const terminatedRepositoryId = "repository-whose-session-must-end";
/** A repository the fixtures never touch, reconciled through a pool that has already reclaimed. */
const untouchedRepositoryId = "repository-that-never-failed";
/** Coordinated through the pool that just lost a session to a termination. */
const afterTerminationRepositoryId = "repository-coordinated-after-a-termination";
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

interface TerminatedSessionRecord {
  outcome: Outcome;
  remainingLocks: HeldAdvisoryLock[];
  /** The backend that held the repository lock, read on the reserved connection itself. */
  heldBackendPid: number | undefined;
  /** The backend the client answers from once the reclaim is done with it. */
  backendPidAfter: number;
  releases: number;
  warnings: string[];
  poolProbe: Outcome;
  afterTermination: Outcome;
}

interface ReconciliationRecord {
  interactions: string[];
  unlockAll: FailedUnlockRecord;
  discardAll: FailedUnlockRecord;
  terminated: TerminatedSessionRecord;
  poolProbe: Outcome;
  untouchedRepository: Outcome;
  reservationAfterDiscard: Outcome;
  laterCoordination: Outcome[];
}

const failingRepositoryIds = [
  unlockAllRepositoryId,
  discardAllRepositoryId,
  terminatedRepositoryId,
];

let container: StartedTestContainer | undefined;
let admin: Sql | undefined;
let workSql: Sql | undefined;
let unlockAllSql: Sql | undefined;
let discardAllSql: Sql | undefined;
let terminatingSql: Sql | undefined;
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
    // its failed call without the other fixtures' traffic moving it.
    unlockAllSql = postgres(restrictedUrl, { max: 10 });
    discardAllSql = postgres(restrictedUrl, { max: 10 });
    terminatingSql = postgres(restrictedUrl, { max: 10 });
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

    // From here nothing but a lock left behind can still be wrong: both grant fixtures are gone.
    await admin.unsafe("grant execute on function pg_catalog.pg_advisory_unlock(bigint) to public");
    await admin.unsafe("grant execute on function pg_catalog.pg_advisory_unlock_all() to public");

    // Fixture three drives the terminate stage against a real session. It cannot be reached by
    // revoking anything, because `DISCARD ALL` answers whatever the grants say, so the three
    // statements the reclaim tries first are refused in front of a real reserved connection
    // instead. Everything else, including the termination, reaches the database.
    const terminated = await reconcileThroughTerminatedSession(
      terminatingSql,
      workSql,
      interactions,
    );

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
      failingRepositoryIds.map((id) => outcomeOf(
        laterStore.withRepositoryReconciliation(id, async () => `reconciled-again-${id}`),
      )),
    );

    record = {
      interactions,
      unlockAll,
      discardAll,
      terminated,
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
    // Forced, because postgres.js (3.4.9) does not clear a connection's in-flight query when that
    // query dies with the socket, and `Connection.end()` waits for a connection with a query still
    // in flight, so an ordinary `end()` on the client whose session was terminated never settles.
    // Filed as Overflow issue 150; this is the only client in the repository that meets it.
    await terminatingSql?.end({ timeout: 0 });
    await laterCoordinationSql?.end();
    await admin?.end();
    await container?.stop();
  });

  it("still runs the caller's work and still rejects the call", () => {
    expect(record.unlockAll.outcome.rejection).toBe(coordinationFailure);
    expect(record.discardAll.outcome.rejection).toBe(coordinationFailure);
    expect(record.terminated.outcome.rejection).toBe(coordinationFailure);
    expect(record.interactions).toEqual([
      `work-ran-for-${unlockAllRepositoryId}`,
      `work-ran-for-${discardAllRepositoryId}`,
      `work-ran-for-${terminatedRepositoryId}`,
      // The terminate fixture checks its own pool before the shared probes run.
      "after-termination-work-ran",
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

  it("ends the real session when nothing before the terminate will give the lock back", () => {
    expect(record.terminated.remainingLocks).toEqual([]);
    expect(record.terminated.heldBackendPid).toEqual(expect.any(Number));
    expect(record.terminated.backendPidAfter).not.toBe(record.terminated.heldBackendPid);
  });

  it("never hands a terminated connection back to the pool", () => {
    expect(record.terminated.releases).toBe(0);
  });

  it("reports the termination against the repository", () => {
    expect(record.terminated.warnings).toHaveLength(4);
    expect(record.terminated.warnings.every((warning) => (
      warning.includes(terminatedRepositoryId)
    ))).toBe(true);
    expect(record.terminated.warnings[3]).toContain("without releasing it");
  });

  it("keeps the pool that lost a session serving queries and coordinating", () => {
    expect(record.terminated.poolProbe.rejection).toBeUndefined();
    expect(record.terminated.poolProbe.resolved).toEqual([{ ok: 1 }]);
    expect(record.terminated.afterTermination.rejection).toBeUndefined();
    expect(record.terminated.afterTermination.resolved).toBe("reconciled-after-termination");
  });

  it("keeps both reclaimed coordination pools serving queries and handing out reservations", () => {
    expect(record.poolProbe.rejection).toBeUndefined();
    expect(record.poolProbe.resolved).toEqual([{ ok: 1 }]);
    expect(record.untouchedRepository.rejection).toBeUndefined();
    expect(record.untouchedRepository.resolved).toBe("reconciled-elsewhere");
    expect(record.reservationAfterDiscard.rejection).toBeUndefined();
    expect(record.reservationAfterDiscard.resolved).toBe("reserved");
  });

  it("lets a later coordinator for any of the three repositories run its work", () => {
    expect(record.laterCoordination.map((outcome) => outcome.rejection)).toEqual([
      undefined,
      undefined,
      undefined,
    ]);
    expect(record.laterCoordination.map((outcome) => outcome.resolved)).toEqual(
      failingRepositoryIds.map((id) => `reconciled-again-${id}`),
    );
  });
});

/**
 * Drives one reconciliation whose unlock cannot confirm, reading the coordination client's backend
 * on either side of it. Asking for the pid first leaves exactly one connection open, which is the
 * one the reservation then takes, so the two reads name the same session unless it ended: a client
 * that answers from the same backend kept its session, and one that answers from another did not.
 *
 * The locks are read once rather than waited on. Both stages this drives release the lock on a
 * session that stays alive, so the release has happened by the time the statement that did it has
 * answered.
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

/** Drives the one reconciliation that has to end its session, against a real database. */
async function reconcileThroughTerminatedSession(
  coordination: Sql,
  workClient: Sql,
  interactions: string[],
): Promise<TerminatedSessionRecord> {
  const { coordinationSql, state } = terminateOnlyCoordination(coordination);
  const warnings: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => {
    warnings.push(args.map((arg) => (arg instanceof Error ? arg.message : String(arg))).join(" "));
  });
  let outcome: Outcome;
  try {
    outcome = await outcomeOf(
      new PostgresFoldStore(workClient, undefined, coordinationSql)
        .withRepositoryReconciliation(terminatedRepositoryId, async () => {
          interactions.push(`work-ran-for-${terminatedRepositoryId}`);
          return "reconciled";
        }),
    );
  } finally {
    warn.mockRestore();
  }

  const remainingLocks = await advisoryLocksSettlingFor(terminatedRepositoryId, lockSettlingBudgetMs);
  const poolProbe = await outcomeOf(
    coordination<{ ok: number }[]>`select 1::integer as ok`.then((rows) => [...rows]),
  );
  const afterTermination = await outcomeOf(
    new PostgresFoldStore(workClient, undefined, coordination)
      .withRepositoryReconciliation(afterTerminationRepositoryId, async () => {
        interactions.push("after-termination-work-ran");
        return "reconciled-after-termination";
      }),
  );

  return {
    outcome,
    remainingLocks,
    heldBackendPid: state.heldBackendPid,
    backendPidAfter: await backendPidOf(coordination),
    releases: state.releases,
    warnings,
    poolProbe,
    afterTermination,
  };
}

/**
 * A coordination client that hands the store a thin wrapper around a **real** reserved connection.
 * Every statement reaches the database except the three the reclaim tries before terminating,
 * which are refused here instead.
 *
 * The refusal has to happen at this layer: `DISCARD ALL` is a utility statement, so no revoked
 * grant can deny it, and revoking `EXECUTE` on `pg_terminate_backend` would take the terminate out
 * with it. Denying in front of the connection is what leaves the terminate stage — and only the
 * terminate stage — running against a live session.
 */
function terminateOnlyCoordination(client: Sql): {
  coordinationSql: Sql;
  state: { heldBackendPid: number | undefined; releases: number };
} {
  const state: { heldBackendPid: number | undefined; releases: number } = {
    heldBackendPid: undefined,
    releases: 0,
  };
  const coordinationSql = {
    reserve: async () => {
      const reserved = await client.reserve();
      // Read on the reserved connection itself, so this is the session that will take the lock.
      const [row] = await reserved<{ pid: number }[]>`select pg_backend_pid()::integer as pid`;
      state.heldBackendPid = row?.pid;

      const passthrough = reserved as unknown as (
        strings: TemplateStringsArray,
        ...values: unknown[]
      ) => Promise<unknown>;
      const wrapper = ((strings: TemplateStringsArray, ...values: unknown[]) => (
        refusedBeforeTerminate(Array.from(strings).join(" "))
          ? Promise.reject(new Error("refused by the fixture in front of the connection"))
          : passthrough(strings, ...values)
      )) as unknown as Awaited<ReturnType<Sql["reserve"]>>;
      wrapper.unsafe = ((statement: string) => (
        refusedBeforeTerminate(statement)
          ? Promise.reject(new Error("refused by the fixture in front of the connection"))
          : reserved.unsafe(statement)
      )) as typeof wrapper.unsafe;
      wrapper.release = () => {
        state.releases += 1;
        reserved.release();
      };

      return wrapper;
    },
  } as unknown as Sql;

  return { coordinationSql, state };
}

/** The three statements the reclaim tries before it resorts to ending the session. */
function refusedBeforeTerminate(statement: string): boolean {
  const text = statement.replace(/\s+/gu, " ").toLowerCase();

  return text.includes("pg_advisory_unlock(")
    || text.includes("pg_advisory_unlock_all")
    || text.includes("discard all");
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
