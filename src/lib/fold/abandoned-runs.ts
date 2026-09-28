import type { SqlClient } from "@/lib/db/types";
import { reclaimCoordinationConnection, repositoryLockNamespace } from "@/lib/fold/postgres-store";

export const ABANDONED_RUN_MESSAGE = "Reconciliation abandoned because the process running it ended before the run finished.";

export async function finalizeAbandonedRuns(
  sql: SqlClient,
  coordinationSql: SqlClient = sql,
): Promise<{ finalized: number; skippedLocked: number }> {
  const repositories = await sql<{ repository_id: string }[]>`
    select distinct repository_id from reconciliation_runs
    where status = 'PENDING' and repository_id is not null
  `;
  let finalized = 0;
  let skippedLocked = 0;

  for (const { repository_id: repositoryId } of repositories) {
    const connection = await coordinationSql.reserve();
    let locked = false;
    // An unanswered try-lock may already have taken the lock on the server.
    let lockMayStillBeHeld = true;
    let owningSession: { pid: number; backendStart: string } | undefined;
    try {
      const [lock] = await connection<{ acquired: boolean; pid: number; backend_start: string }[]>`
        select pg_try_advisory_lock(hashtextextended(${repositoryId}, ${repositoryLockNamespace})) as acquired,
          pg_backend_pid() as pid,
          (select backend_start::text from pg_stat_activity where pid = pg_backend_pid()) as backend_start
      `;
      locked = lock?.acquired === true;
      lockMayStillBeHeld = locked;
      if (!locked) {
        skippedLocked += 1;
        continue;
      }
      owningSession = { pid: lock.pid, backendStart: lock.backend_start };
      const updated = await connection<{ id: string }[]>`
        update reconciliation_runs
        set status = 'FAILED', completed_at = now(), error_message = ${ABANDONED_RUN_MESSAGE}
        where repository_id = ${repositoryId} and status = 'PENDING'
        returning id
      `;
      finalized += updated.length;
    } finally {
      if (locked && owningSession !== undefined) {
        let released = false;
        let sessionChanged = false;
        try {
          const [unlock] = await connection<{ released: boolean; same_session: boolean }[]>`
            select case
                when pg_backend_pid() = ${owningSession.pid}
                  and (select backend_start from pg_stat_activity where pid = pg_backend_pid())
                    = ${owningSession.backendStart}::text::timestamptz
                then pg_advisory_unlock(hashtextextended(${repositoryId}, ${repositoryLockNamespace}))
                else false
              end as released,
              pg_backend_pid() = ${owningSession.pid}
                and (select backend_start from pg_stat_activity where pid = pg_backend_pid())
                  = ${owningSession.backendStart}::text::timestamptz as same_session
          `;
          released = unlock?.released === true;
          sessionChanged = unlock?.same_session === false;
        } catch (error) {
          console.warn(`Abandoned reconciliation run unlock failed for repository ${repositoryId}`, error);
        }
        lockMayStillBeHeld = !released && !sessionChanged;
      }
      if (!lockMayStillBeHeld
        || await reclaimCoordinationConnection(connection, repositoryId, owningSession)) {
        connection.release();
      }
      if (lockMayStillBeHeld) {
        throw new Error("Unable to release abandoned reconciliation run lock.");
      }
    }
  }

  if (finalized > 0) {
    console.info("Finalized abandoned reconciliation runs", { finalized, skippedLocked });
  }
  return { finalized, skippedLocked };
}
