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
 * is bounded, and each arm drains its backlog before proceeding. Receipt and
 * run cursors advance across batches, and child scans advance with server
 * cursors. Each run batch locks one fixed set of expired runs and deletes their changes first
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
  result.processedReceipts = await pruneReceipts(sql, "PROCESSED", RECEIPT_PROCESSED_RETENTION_DAYS);
  result.failedReceipts = await pruneReceipts(sql, "FAILED", RECEIPT_FAILED_RETENTION_DAYS);
  result.abandonedPendingReceipts = await pruneReceipts(sql, "PENDING", RECEIPT_PENDING_RETENTION_DAYS);

  // Advance past each fixed run set rather than rescanning retained prefixes.
  let runCursor: string | undefined;
  for (;;) {
    const batch = await sql.begin(async (tx) => {
      const runs = await tx<{ id: string }[]>`
        select id from reconciliation_runs
        where status in ('COMPLETED', 'FAILED')
          and completed_at < now() - ${RUN_TERMINAL_RETENTION_DAYS} * interval '1 day'
          ${runCursor === undefined ? tx`` : tx`and id > ${runCursor}`}
        order by id limit ${RETENTION_PRUNE_BATCH_SIZE} for update
      `;
      if (runs.length === 0) return { runs: 0, changes: 0, lastId: undefined };
      const ids = runs.map((run) => run.id);
      let changes = 0;
      // Each cursor advances its actual scan, even for a large run whose
      // children make a sequential scan cheaper than the FK index. Fetching
      // bounded IDs avoids restarting a scan over retained or deleted tuples.
      for (const run of runs) {
        await tx`declare retention_changes_cursor no scroll cursor for
          select id from reconciliation_changes where reconciliation_run_id = ${run.id}`;
        for (;;) {
          // FETCH's count grammar accepts an integer literal, not a parameter.
          const rows = await tx.unsafe<{ id: string }[]>(
            `fetch forward ${RETENTION_PRUNE_BATCH_SIZE} from retention_changes_cursor`,
          );
          if (rows.length === 0) break;
          const deleted = await tx`delete from reconciliation_changes
            where reconciliation_run_id = ${run.id} and id in ${tx(rows.map((row) => row.id))}`;
          changes += deleted.count;
        }
        await tx`close retention_changes_cursor`;
      }
      const deleted = await tx`delete from reconciliation_runs where id in ${tx(ids)}`;
      return { runs: deleted.count, changes, lastId: runs.at(-1)!.id };
    });
    result.expiredRuns += batch.runs;
    result.changesOfExpiredRuns += batch.changes;
    if (batch.runs === 0) break;
    runCursor = batch.lastId;
  }

  return result;
}

/** One bounded cursor pass per state, with receipt claim guards held under row locks. */
async function pruneReceipts(
  sql: SqlClient,
  state: "PROCESSED" | "FAILED" | "PENDING",
  retentionDays: number,
): Promise<number> {
  let cursor: string | undefined;
  let count = 0;
  for (;;) {
    const batch = await sql.begin(async (tx) => {
      const age = state === "PENDING"
        ? tx`received_at < now() - ${retentionDays} * interval '1 day'
            and coalesce(lease_expires_at, received_at) < now()`
        : tx`processed_at < now() - ${retentionDays} * interval '1 day'`;
      const receipts = await tx<{ id: string }[]>`
        select id from webhook_deliveries
        where processing_state = ${state}::webhook_processing_state and ${age}
          ${cursor === undefined ? tx`` : tx`and id > ${cursor}`}
        order by id limit ${RETENTION_PRUNE_BATCH_SIZE} for update
      `;
      if (receipts.length === 0) return { count: 0, lastId: undefined };
      const deleted = await tx`delete from webhook_deliveries where id in ${tx(receipts.map((row) => row.id))}`;
      return { count: deleted.count, lastId: receipts.at(-1)!.id };
    });
    count += batch.count;
    if (batch.count === 0) return count;
    cursor = batch.lastId;
  }
}
