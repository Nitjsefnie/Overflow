import { AsyncLocalStorage } from "node:async_hooks";
import { getCoordinationSql, redactPostgresError } from "@/lib/db/client";
import type { SqlClient, TransactionClient } from "@/lib/db/types";
import { waitForRepositoryLockRetry } from "@/lib/fold/repository-lock-retry";

const repositoryLockWaitDeadlineMs = 60_000;
export const repositoryLockNamespace = 684029183;
const repositoryCoordinationFailure = "Unable to coordinate repository reconciliation.";

/**
 * Reports a coordination statement that did not do its job.
 *
 * Every one of these is swallowed — the caller only ever sees `repositoryCoordinationFailure` —
 * so without this line an operator sees a refused reconciliation with no reason for it, while the
 * coordination pool quietly loses connections.
 */
function warnCoordinationStatementFailed(
  repositoryId: string,
  statement: string,
  cause: unknown,
): void {
  console.warn(
    `Reconciliation coordination for repository ${repositoryId}: ${statement} failed.`,
    cause,
  );
}

/**
 * Takes back every session-level lock a reserved coordination connection may still hold, and
 * answers whether the connection is fit to serve another caller.
 *
 * Three stages, each reached only because the one before it did not answer:
 *
 * 1. `pg_advisory_unlock_all()`, a different function from the targeted unlock that just failed,
 *    so whatever stopped that one need not stop this one. The release is guarded by the owning
 *    session's identity in the same statement: a row answers only for the session that took the
 *    lock, so a connection the pool has since handed to another reservation cannot be made to
 *    drop locks it now holds for somebody else — and an unknown session (no identity to compare,
 *    e.g. when the unlock itself never answered) is filtered out the same way.
 * 2. `DISCARD ALL`, which releases every session-level advisory lock as part of its definition.
 *    It is a utility statement rather than a function call, so `REVOKE EXECUTE` cannot reach it.
 *    It also resets the session's prepared statements; postgres.js re-prepares on
 *    `FetchPreparedStatement`, so the connection keeps answering afterwards. Reached only when
 *    stage 1 threw, which is the denied-on-our-own-session path.
 * 3. `pg_terminate_backend(pg_backend_pid())`, which drops the locks along with the session.
 *    Terminating the session a statement runs on makes that statement fail — the server sends a
 *    FATAL and closes the socket — so the rejection is the expected shape of success.
 *
 * A session that answers stage 1 or stage 2 holds no advisory lock and still works, so it is fit
 * to release. A session the stage-1 guard filtered out is not ours: `false` without a warning,
 * and the caller must never release it. After stage 3 it is not ours either, and the caller must
 * never release it: postgres.js returns a closed connection to the pool on its own and reconnects
 * it on next use, whereas `release()` would push a session that may still hold the lock onto the
 * pool's open queue.
 *
 * `EXECUTE` on `pg_terminate_backend` is revocable like any other function's, so stage 3 can be
 * denied as well. Nothing is left to try then: the lock stays granted on a live session and the
 * connection is retired unreleased, costing the coordination pool a connection until the process
 * restarts. The warnings this function emits are the only trace of it.
 */
export async function reclaimCoordinationConnection(
  connection: Awaited<ReturnType<SqlClient["reserve"]>>,
  repositoryId: string,
  owningSession: { pid: number; backendStart: string } | undefined,
): Promise<boolean> {
  if (owningSession === undefined) {
    // The session identity is unknown — the take itself never answered — so no statement that
    // can release locks may run on this connection at all.
    return false;
  }
  try {
    const [unlockedAll] = await connection<{ unlocked: null }[]>`
      select pg_advisory_unlock_all() as unlocked
      where pg_backend_pid() = ${owningSession.pid}
        and (select backend_start from pg_stat_activity where pid = pg_backend_pid())
          = ${owningSession.backendStart}::text::timestamptz
    `;
    // A void function answers with one all-null row; the driver may collapse it to null. Either
    // way the row's PRESENCE is the answer: the guard matched, so this session is the one that
    // took the lock and the release has happened. No row: the guard filtered this session out.
    if (unlockedAll !== undefined) {
      return true;
    }
    return false;
  } catch (cause) {
    warnCoordinationStatementFailed(repositoryId, "pg_advisory_unlock_all", cause);
  }

  try {
    await connection.unsafe("discard all");
    return true;
  } catch (cause) {
    warnCoordinationStatementFailed(repositoryId, "DISCARD ALL", cause);
  }

  try {
    await connection`select pg_terminate_backend(pg_backend_pid())`;
  } catch (cause) {
    // Success and denial look the same from here — both arrive as a rejection — so the cause is
    // reported rather than judged.
    console.warn(
      `Reconciliation coordination for repository ${repositoryId}: asked the session still holding `
      + "the repository lock to end, and retired the connection without releasing it.",
      cause,
    );
  }

  return false;
}

export class RepositoryCoordinator {
  private readonly reconciliationOwnership = new AsyncLocalStorage<{
    repositoryId: string;
    pid: number;
    backendStart: string;
    databaseOid: string;
    lockKey: string;
    active: boolean;
    publications: Set<Promise<unknown>>;
  }>();

  public constructor(
    private readonly sql: SqlClient,
    private readonly coordinationSql?: SqlClient,
  ) {}

  /**
   * Takes a coordination connection, giving up once the caller's deadline has
   * passed.
   *
   * An exhausted pool queues a reservation indefinitely, which would silently
   * defeat the lock-wait deadline, so the wait is bounded by whatever time the
   * caller has left. An abandoned reservation still settles later; releasing it
   * then is what keeps a timeout from leaking a connection.
   */
  private async reserveCoordinationConnection(
    remainingMs: number,
  ): Promise<Awaited<ReturnType<SqlClient["reserve"]>>> {
    // Resolved here rather than defaulted at construction: a caller that
    // injects its own client must not be made to configure the process-wide
    // one, which building a coordination client would require.
    const coordinationSql = this.coordinationSql ?? getCoordinationSql();
    const reservation = coordinationSql.reserve();
    let expiry: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        reservation,
        new Promise<never>((_resolve, reject) => {
          expiry = setTimeout(() => reject(new Error("Timed out waiting for a coordination connection.")), remainingMs);
        }),
      ]);
    } catch (error) {
      // Both escape routes end on one handler: the reservation rejecting, and
      // the release of a reservation that arrives too late throwing as it hands
      // the connection back. Either one unhandled would end the process.
      void reservation.then((connection) => { connection.release(); }).catch(() => undefined);
      throw error;
    } finally {
      if (expiry !== undefined) {
        clearTimeout(expiry);
      }
    }
  }

  public async withRepositoryReconciliation<T>(
    repositoryId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + repositoryLockWaitDeadlineMs;
    let attempt = 0;

    while (true) {
      if (attempt > 0 && Date.now() >= deadline) {
        throw new Error(repositoryCoordinationFailure);
      }
      let connection: Awaited<ReturnType<SqlClient["reserve"]>>;
      try {
        connection = await this.reserveCoordinationConnection(deadline - Date.now());
      } catch (cause) {
        throw new Error(repositoryCoordinationFailure, { cause: redactPostgresError(cause) });
      }

      let locked = false;
      let lockMayStillBeHeld = false;
      // The server-session identity that took the lock, for the reclaim's in-statement guard. An
      // unknown session (the take itself failed) is filtered out the same way a foreign one is.
      let owningSession: { pid: number; backendStart: string } | undefined;
      try {
        const [lock] = await connection<{
          acquired: boolean; pid: number; backend_start: string; database_oid: string; lock_key: string;
        }[]>`
          select pg_try_advisory_lock(
            hashtextextended(${repositoryId}, ${repositoryLockNamespace})
          ) as acquired,
          pg_backend_pid() as pid,
          (select backend_start::text from pg_stat_activity where pid = pg_backend_pid()) as backend_start,
          (select oid::text from pg_database where datname = current_database()) as database_oid,
          hashtextextended(${repositoryId}, ${repositoryLockNamespace})::text as lock_key
        `;
        locked = lock?.acquired === true;
        if (locked) {
          const ownership = {
            repositoryId, pid: lock.pid, backendStart: lock.backend_start,
            databaseOid: lock.database_oid, lockKey: lock.lock_key, active: true,
            publications: new Set<Promise<unknown>>(),
          };
          owningSession = { pid: ownership.pid, backendStart: ownership.backendStart };
          try {
            // Keep PostgreSQL's microseconds as text; Date would round away part
            // of the server-session identity. A reconnected reserved handle has
            // no authority from the server session that originally took the lock.
            if (!Number.isInteger(ownership.pid) || !ownership.backendStart
              || !ownership.databaseOid || !ownership.lockKey) {
              throw new Error(repositoryCoordinationFailure);
            }
            return await this.reconciliationOwnership.run(ownership, work);
          } finally {
            ownership.active = false;
            // Revoke new admission, then retain coordination until every started
            // publication has finished COMMIT or ROLLBACK, even if work detached it.
            await Promise.allSettled(ownership.publications);
            let released = false;
            // Whether the session answering the unlock is still the one that took the lock. A
            // reservation never outlives its backend: when the backend dies, the pool takes the
            // connection back and may hand it to the next reservation, so a foreign identity
            // here means the owning backend is gone. For the same repository that next session
            // can hold the very same key, and an ungated pg_advisory_unlock would release it and
            // answer true — so the release itself is gated on the identity, not merely annotated
            // beside it.
            let sessionChanged = false;
            try {
              const [unlock] = await connection<{
                released: boolean; same_session: boolean;
              }[]>`
                select case
                    when pg_backend_pid() = ${ownership.pid}
                      and (select backend_start from pg_stat_activity where pid = pg_backend_pid())
                        = ${ownership.backendStart}::text::timestamptz
                    then pg_advisory_unlock(
                      hashtextextended(${repositoryId}, ${repositoryLockNamespace})
                    )
                    else false
                  end as released,
                  pg_backend_pid() = ${ownership.pid}
                    and (select backend_start from pg_stat_activity where pid = pg_backend_pid())
                      = ${ownership.backendStart}::text::timestamptz as same_session
              `;
              released = unlock?.released === true;
              sessionChanged = unlock?.same_session === false;
              if (!released) {
                warnCoordinationStatementFailed(
                  repositoryId,
                  "pg_advisory_unlock",
                  { released: unlock?.released, sameSession: unlock?.same_session },
                );
              }
            } catch (cause) {
              warnCoordinationStatementFailed(repositoryId, "pg_advisory_unlock", cause);
              released = false;
            }
            if (!released) {
              if (sessionChanged) {
                // The session that took the lock is gone, and PostgreSQL released the lock with
                // it; the connection is already back with the pool. Reclaiming here would run
                // unlock_all, DISCARD ALL or pg_terminate_backend on a session the pool may have
                // handed to another coordinator, releasing that coordinator's lock instead.
              } else {
                // The lock is session-level, so it lives exactly as long as this connection's
                // server session. Handing that session back to the pool would leave the lock
                // granted for the life of the process, refusing every later reconciliation of
                // this repository once its own lock wait ran out.
                lockMayStillBeHeld = true;
              }
              throw new Error(repositoryCoordinationFailure);
            }
          }
        }
      } catch (error) {
        if (locked) {
          throw error;
        }
        throw new Error(repositoryCoordinationFailure, { cause: redactPostgresError(error) });
      } finally {
        // A connection whose session might still hold the repository's lock never goes back into
        // the pool; `reclaimCoordinationConnection` says whether this one is fit to.
        if (!lockMayStillBeHeld
          || await reclaimCoordinationConnection(connection, repositoryId, owningSession)) {
          connection.release();
        }
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(repositoryCoordinationFailure);
      }
      await waitForRepositoryLockRetry(attempt, remainingMs);
      attempt += 1;
    }
  }

  public async withRepositoryPublication<T>(
    repositoryId: string,
    publish: (transaction: TransactionClient) => Promise<T>,
  ): Promise<T> {
    const ownership = this.reconciliationOwnership.getStore();
    if (!ownership?.active || ownership.repositoryId !== repositoryId) {
      throw new Error(repositoryCoordinationFailure);
    }
    const publication = this.sql.begin(async (transaction) => {
      // Admission is ordered with every other publication before any snapshot
      // read. An admitted transaction may finish after session loss, but the
      // successor holds this same row next and therefore publishes last.
      const repositories = await transaction`
        select id from registered_repositories where id = ${repositoryId} for update
      `;
      await transaction`select pg_stat_clear_snapshot()`;
      // The text cast on backendStart also prevents the driver's timestamptz
      // parameter serializer from rounding the value through a JavaScript Date.
      const [admission] = await transaction<{ owned: boolean }[]>`
        select exists (
          select 1 from pg_locks locks join pg_stat_activity backend on backend.pid = locks.pid
          where locks.locktype = 'advisory' and locks.granted and locks.mode = 'ExclusiveLock'
            and locks.database = ${ownership.databaseOid}::oid
            and locks.database = (select oid from pg_database where datname = current_database())
            and locks.classid = ((${ownership.lockKey}::bigint >> 32) & 4294967295)::oid
            and locks.objid = (${ownership.lockKey}::bigint & 4294967295)::oid
            and locks.objsubid = 1 and locks.pid = ${ownership.pid}
            and backend.backend_start = ${ownership.backendStart}::text::timestamptz
            and backend.datid = locks.database
        ) as owned
      `;
      if (repositories.length !== 1 || !ownership.active || admission?.owned !== true) {
        throw new Error(repositoryCoordinationFailure);
      }
      return publish(transaction);
    }) as Promise<T>;
    // The driver's begin promise includes COMMIT; its callback ends earlier.
    // Register synchronously so callback exit cannot miss a queued transaction.
    ownership.publications.add(publication);
    void publication.then(
      () => { ownership.publications.delete(publication); },
      () => { ownership.publications.delete(publication); },
    );
    return publication;
  }

}
