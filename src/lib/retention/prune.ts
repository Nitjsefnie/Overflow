import type { SqlClient } from "@/lib/db/types";

/** How long a PROCESSED webhook receipt is kept after processing ended. */
export const RECEIPT_PROCESSED_RETENTION_DAYS = 30;
/** Failed receipts are kept longer: they are the visible record of what failed. */
export const RECEIPT_FAILED_RETENTION_DAYS = 90;
/** Abandoned PENDING receipts kept to the same horizon as failed ones. */
export const RECEIPT_PENDING_RETENTION_DAYS = 90;
/** Terminal run history kept to the same horizon as failed receipts. */
export const RUN_TERMINAL_RETENTION_DAYS = 90;
/** Maximum rows deleted by any one statement in the retention sweep. */
export const RETENTION_PRUNE_BATCH_SIZE = 100;

export interface RetentionPruneResult {
  /** webhook_deliveries PROCESSED rows deleted. */
  processedReceipts: number;
  /** webhook_deliveries FAILED rows deleted. */
  failedReceipts: number;
  /** webhook_deliveries PENDING rows with an expired lease, deleted. */
  abandonedPendingReceipts: number;
  /** reconciliation_runs COMPLETED/FAILED rows past the window, deleted. */
  expiredRuns: number;
  /** The reconciliation_changes rows of those runs, deleted first. */
  changesOfExpiredRuns: number;
}

/**
 * Deletes the operational metadata whose growth is otherwise unbounded
 * (issue 901): webhook delivery receipts and reconciliation run history.
 *
 * Fail-closed at every predicate: each arm enumerates the exact state and
 * age it deletes, and anything outside the enumeration is never touched. In
 * particular — PENDING runs are never deleted at any age, a PENDING receipt
 * whose lease is still live is never deleted, and a change row is deleted
 * only through its run's expiry, never by its own age.
 *
 * Idempotent: a second pass on unchanged data deletes nothing. Every delete
 * is bounded, and each arm drains its backlog before proceeding. Each run
 * batch locks one fixed set of expired runs and deletes their changes first
 * in the same transaction, so a boundary crossing cannot split membership
 * and a failed run delete rolls back that batch's change deletions.
 */
export async function pruneExpiredMaintenanceRows(sql: SqlClient): Promise<RetentionPruneResult> {
  const result: RetentionPruneResult = {
    processedReceipts: 0, failedReceipts: 0, abandonedPendingReceipts: 0,
    expiredRuns: 0, changesOfExpiredRuns: 0,
  };

  // Receipt dedup reads only PROCESSED rows; a pruned late redelivery
  // reprocesses safely because reconciliation is idempotent from the forge.
  for (;;) {
    const deleted = await sql`
      delete from webhook_deliveries where id in (
        select id from webhook_deliveries
        where processing_state = 'PROCESSED'
          and processed_at < now() - ${RECEIPT_PROCESSED_RETENTION_DAYS} * interval '1 day'
        order by id limit ${RETENTION_PRUNE_BATCH_SIZE} for update
      )
    `;
    result.processedReceipts += deleted.count;
    if (deleted.count === 0) break;
  }

  for (;;) {
    const deleted = await sql`
      delete from webhook_deliveries where id in (
        select id from webhook_deliveries
        where processing_state = 'FAILED'
          and processed_at < now() - ${RECEIPT_FAILED_RETENTION_DAYS} * interval '1 day'
        order by id limit ${RETENTION_PRUNE_BATCH_SIZE} for update
      )
    `;
    result.failedReceipts += deleted.count;
    if (deleted.count === 0) break;
  }

  // A live lease always protects a PENDING receipt, regardless of its age.
  for (;;) {
    const deleted = await sql`
      delete from webhook_deliveries where id in (
        select id from webhook_deliveries
        where processing_state = 'PENDING'
          and received_at < now() - ${RECEIPT_PENDING_RETENTION_DAYS} * interval '1 day'
          and coalesce(lease_expires_at, received_at) < now()
        order by id limit ${RETENTION_PRUNE_BATCH_SIZE} for update
      )
    `;
    result.abandonedPendingReceipts += deleted.count;
    if (deleted.count === 0) break;
  }

  for (;;) {
    const batch = await sql.begin(async (tx) => {
      const runs = await tx<{ id: string }[]>`
        select id from reconciliation_runs
        where status in ('COMPLETED', 'FAILED')
          and completed_at < now() - ${RUN_TERMINAL_RETENTION_DAYS} * interval '1 day'
        order by id limit ${RETENTION_PRUNE_BATCH_SIZE} for update
      `;
      if (runs.length === 0) return { runs: 0, changes: 0 };
      const ids = runs.map((run) => run.id);
      let changes = 0;
      // A single run can have more changes than the batch bound. Delete only
      // this fixed run set's changes, in bounded statements, before its runs.
      for (;;) {
        const deleted = await tx`
          delete from reconciliation_changes where id in (
            select id from reconciliation_changes
            where reconciliation_run_id in ${tx(ids)}
            order by id limit ${RETENTION_PRUNE_BATCH_SIZE}
          )
        `;
        changes += deleted.count;
        if (deleted.count === 0) break;
      }
      const deleted = await tx`delete from reconciliation_runs where id in ${tx(ids)}`;
      return { runs: deleted.count, changes };
    });
    result.expiredRuns += batch.runs;
    result.changesOfExpiredRuns += batch.changes;
    if (batch.runs === 0) break;
  }

  return result;
}
