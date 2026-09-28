import type { SqlClient } from "@/lib/db/types";
import { repositoryLockNamespace } from "@/lib/fold/postgres-store";

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
    const result = await coordinationSql.begin(async (transaction) => {
      // A transaction lock ends on COMMIT, ROLLBACK, or backend loss. Even if
      // the try-lock answer disappears, this session cannot retain the key.
      const [lock] = await transaction<{ acquired: boolean }[]>`
        select pg_try_advisory_xact_lock(hashtextextended(${repositoryId}, ${repositoryLockNamespace})) as acquired
      `;
      if (typeof lock?.acquired !== "boolean") {
        throw new Error("Could not determine abandoned reconciliation lock state.");
      }
      if (!lock.acquired) return { finalized: 0, skippedLocked: 1 };
      const updated = await transaction<{ id: string }[]>`
        update reconciliation_runs
        set status = 'FAILED', completed_at = now(), error_message = ${ABANDONED_RUN_MESSAGE}
        where repository_id = ${repositoryId} and status = 'PENDING'
        returning id
      `;
      return { finalized: updated.length, skippedLocked: 0 };
    });
    finalized += result.finalized;
    skippedLocked += result.skippedLocked;
  }

  if (finalized > 0) {
    console.info("Finalized abandoned reconciliation runs", { finalized, skippedLocked });
  }
  return { finalized, skippedLocked };
}
