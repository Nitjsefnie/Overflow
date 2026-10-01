import type { SqlClient } from "@/lib/db/types";

/** How long a PROCESSED webhook receipt is kept after processing ended. */
export const RECEIPT_PROCESSED_RETENTION_DAYS = 30;
/** Failed receipts are kept longer: they are the visible record of what failed. */
export const RECEIPT_FAILED_RETENTION_DAYS = 90;
/** Abandoned PENDING receipts kept to the same horizon as failed ones. */
export const RECEIPT_PENDING_RETENTION_DAYS = 90;
/** Terminal run history kept to the same horizon as failed receipts. */
export const RUN_TERMINAL_RETENTION_DAYS = 90;

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
 * Idempotent: a second pass on unchanged data deletes nothing. The two run
 * statements are deliberately separate — the FK has no cascade, so the
 * changes must go first; and a crash between them leaves changes deleted
 * while the run survives to the next tick, which is consistent either way.
 *
 * Batching is not required at this scale: steady state is on the order of
 * 2.6k receipts and a handful of runs per six-hour tick, and even the first
 * run's backlog is one small statement.
 */
export async function pruneExpiredMaintenanceRows(sql: SqlClient): Promise<RetentionPruneResult> {
  // PROCESSED receipts: dedup reads only PROCESSED rows, and a pruned
  // receipt's late redelivery reprocesses safely — reconciliation is
  // idempotent from the forge source of truth.
  const processed = await sql`
    delete from webhook_deliveries
    where processing_state = 'PROCESSED'
      and processed_at < now() - ${RECEIPT_PROCESSED_RETENTION_DAYS} * interval '1 day'
    returning id
  `;

  // FAILED receipts: kept longer than PROCESSED ones, as the record of what
  // failed and when.
  const failed = await sql`
    delete from webhook_deliveries
    where processing_state = 'FAILED'
      and processed_at < now() - ${RECEIPT_FAILED_RETENTION_DAYS} * interval '1 day'
    returning id
  `;

  // Abandoned PENDING receipts: old, and not held by a live lease. The
  // coalesce is the live-lease guard: a PENDING row whose lease_expires_at
  // lies in the future is never pruned regardless of age, because a late
  // redelivery's claim upsert can still resume it; a row with no lease at
  // all falls back to received_at.
  const abandonedPending = await sql`
    delete from webhook_deliveries
    where processing_state = 'PENDING'
      and received_at < now() - ${RECEIPT_PENDING_RETENTION_DAYS} * interval '1 day'
      and coalesce(lease_expires_at, received_at) < now()
    returning id
  `;

  // Change rows go first: the FK from reconciliation_changes to
  // reconciliation_runs has no cascade, so the runs cannot go while their
  // changes remain. A change row is deleted ONLY through its run's expiry —
  // its own age is never a predicate, so a change of a surviving run
  // survives however old it is.
  const changesOfExpiredRuns = await sql`
    delete from reconciliation_changes
    where reconciliation_run_id in (
      select id from reconciliation_runs
      where status in ('COMPLETED', 'FAILED')
        and completed_at < now() - ${RUN_TERMINAL_RETENTION_DAYS} * interval '1 day'
    )
    returning id
  `;

  // Then the runs, under the identical predicate as the statement above, so
  // the pair deletes changes and runs for exactly the same set: whatever the
  // first statement measured, the second deletes. PENDING runs never match,
  // at any age, and completed_at NULL never matches either.
  const expiredRuns = await sql`
    delete from reconciliation_runs
    where status in ('COMPLETED', 'FAILED')
      and completed_at < now() - ${RUN_TERMINAL_RETENTION_DAYS} * interval '1 day'
    returning id
  `;

  return {
    processedReceipts: processed.length,
    failedReceipts: failed.length,
    abandonedPendingReceipts: abandonedPending.length,
    expiredRuns: expiredRuns.length,
    changesOfExpiredRuns: changesOfExpiredRuns.length,
  };
}
