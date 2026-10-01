import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import type { Sql } from "postgres";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import {
  RECEIPT_FAILED_RETENTION_DAYS,
  RECEIPT_PENDING_RETENTION_DAYS,
  RECEIPT_PROCESSED_RETENTION_DAYS,
  RUN_TERMINAL_RETENTION_DAYS,
  pruneExpiredMaintenanceRows,
} from "@/lib/retention/prune";
import { startPostgresContainer } from "../support/postgres-container";

/**
 * The retention prune's contract against a real database (issue 901): each
 * arm deletes exactly its own rows, nothing else, and reports what it
 * deleted. Seeds carry explicit timestamps relative to now(), so the
 * predicates' age gates and the live-lease guard are exercised on both
 * sides of every boundary.
 */

let sql: Sql;
let container: StartedTestContainer;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "retention_prune", user: "retention_prune", password: "retention_prune" });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("retention prune", () => {
  it("publishes the retention windows it implements", () => {
    expect(RECEIPT_PROCESSED_RETENTION_DAYS).toBe(30);
    expect(RECEIPT_FAILED_RETENTION_DAYS).toBe(90);
    expect(RECEIPT_PENDING_RETENTION_DAYS).toBe(90);
    expect(RUN_TERMINAL_RETENTION_DAYS).toBe(90);
  });

  it("prunes a PROCESSED receipt past its window and keeps a recent one", async () => {
    await resetMaintenanceTables();
    const prunable = await seedReceipt({
      processingState: "PROCESSED",
      processedDaysAgo: RECEIPT_PROCESSED_RETENTION_DAYS + 1,
    });
    const recent = await seedReceipt({
      processingState: "PROCESSED",
      processedDaysAgo: RECEIPT_PROCESSED_RETENTION_DAYS - 1,
    });

    await expect(pruneExpiredMaintenanceRows(sql)).resolves.toEqual({
      processedReceipts: 1,
      failedReceipts: 0,
      abandonedPendingReceipts: 0,
      expiredRuns: 0,
      changesOfExpiredRuns: 0,
    });
    expect(await receiptExists(prunable)).toBe(false);
    expect(await receiptExists(recent)).toBe(true);
  });

  it("keeps FAILED receipts longer than PROCESSED ones", async () => {
    await resetMaintenanceTables();
    const expired = await seedReceipt({
      processingState: "FAILED",
      processedDaysAgo: RECEIPT_FAILED_RETENTION_DAYS + 1,
    });
    const recent = await seedReceipt({
      processingState: "FAILED",
      processedDaysAgo: RECEIPT_FAILED_RETENTION_DAYS - 1,
    });

    await expect(pruneExpiredMaintenanceRows(sql)).resolves.toEqual({
      processedReceipts: 0,
      failedReceipts: 1,
      abandonedPendingReceipts: 0,
      expiredRuns: 0,
      changesOfExpiredRuns: 0,
    });
    expect(await receiptExists(expired)).toBe(false);
    expect(await receiptExists(recent)).toBe(true);
  });

  it("prunes an abandoned PENDING receipt only when its lease has expired too", async () => {
    await resetMaintenanceTables();
    const abandoned = await seedReceipt({
      processingState: "PENDING",
      receivedDaysAgo: RECEIPT_PENDING_RETENTION_DAYS + 1,
      leaseExpiresInHours: -1,
    });
    const liveLease = await seedReceipt({
      processingState: "PENDING",
      receivedDaysAgo: RECEIPT_PENDING_RETENTION_DAYS + 1,
      leaseExpiresInHours: 1,
    });
    // Below the window: survives on the age gate alone, whatever its lease
    // expired an hour ago — the shape a real ten-day-old PENDING row has,
    // since a claim's five-minute lease never lasts that long.
    const fresh = await seedReceipt({
      processingState: "PENDING",
      receivedDaysAgo: 10,
    });

    await expect(pruneExpiredMaintenanceRows(sql)).resolves.toEqual({
      processedReceipts: 0,
      failedReceipts: 0,
      abandonedPendingReceipts: 1,
      expiredRuns: 0,
      changesOfExpiredRuns: 0,
    });
    expect(await receiptExists(abandoned)).toBe(false);
    expect(await receiptExists(liveLease)).toBe(true);
    expect(await receiptExists(fresh)).toBe(true);
  });

  it("prunes terminal runs past their window with their change rows, and never a PENDING run", async () => {
    await resetMaintenanceTables();
    const completedExpired = await seedRun({ status: "COMPLETED", completedDaysAgo: RUN_TERMINAL_RETENTION_DAYS + 1 });
    const completedRecent = await seedRun({ status: "COMPLETED", completedDaysAgo: RUN_TERMINAL_RETENTION_DAYS - 1 });
    const failedExpired = await seedRun({ status: "FAILED", completedDaysAgo: RUN_TERMINAL_RETENTION_DAYS + 1 });
    // A terminal status without a completion timestamp is not a state the
    // application writes, but the predicate must still refuse it: the prune
    // deletes nothing the age gate has not measured.
    const failedWithoutCompletion = await seedRun({ status: "FAILED" });
    const pendingAncient = await seedRun({ status: "PENDING", startedDaysAgo: 200 });
    // PENDING with a completion timestamp is not a state the application
    // writes either, but the schema allows it (no check constraint on
    // reconciliation_runs), and it is exactly the row only the status filter
    // refuses: with completed_at set, the age gate alone would pass it, so
    // this seed is what kills a status list that grew a 'PENDING'.
    const pendingWithCompletion = await seedRun({ status: "PENDING", completedDaysAgo: 200 });

    const changeOfCompletedExpired = await seedChange(completedExpired);
    const changeOfFailedExpired = await seedChange(failedExpired);
    // Old itself, but its run is not expired, so it survives — the change
    // rows' own age is never the predicate.
    const changeOfRecentRun = await seedChange(completedRecent, { createdDaysAgo: 200 });
    const changeOfPendingRun = await seedChange(pendingAncient);
    const changeOfPendingWithCompletion = await seedChange(pendingWithCompletion, { createdDaysAgo: 200 });

    await expect(pruneExpiredMaintenanceRows(sql)).resolves.toEqual({
      processedReceipts: 0,
      failedReceipts: 0,
      abandonedPendingReceipts: 0,
      expiredRuns: 2,
      changesOfExpiredRuns: 2,
    });
    expect(await runExists(completedExpired)).toBe(false);
    expect(await runExists(failedExpired)).toBe(false);
    expect(await runExists(completedRecent)).toBe(true);
    expect(await runExists(failedWithoutCompletion)).toBe(true);
    expect(await runExists(pendingAncient)).toBe(true);
    expect(await runExists(pendingWithCompletion)).toBe(true);
    expect(await changeExists(changeOfCompletedExpired)).toBe(false);
    expect(await changeExists(changeOfFailedExpired)).toBe(false);
    expect(await changeExists(changeOfRecentRun)).toBe(true);
    expect(await changeExists(changeOfPendingRun)).toBe(true);
    expect(await changeExists(changeOfPendingWithCompletion)).toBe(true);
  });

  it("deletes nothing on the second pass and reports zeros", async () => {
    await resetMaintenanceTables();
    const processed = await seedReceipt({ processingState: "PROCESSED", processedDaysAgo: 31 });
    const failed = await seedReceipt({ processingState: "FAILED", processedDaysAgo: 91 });
    const pending = await seedReceipt({ processingState: "PENDING", receivedDaysAgo: 91, leaseExpiresInHours: -1 });
    const run = await seedRun({ status: "COMPLETED", completedDaysAgo: 91 });
    const change = await seedChange(run);

    await expect(pruneExpiredMaintenanceRows(sql)).resolves.toEqual({
      processedReceipts: 1,
      failedReceipts: 1,
      abandonedPendingReceipts: 1,
      expiredRuns: 1,
      changesOfExpiredRuns: 1,
    });
    await expect(pruneExpiredMaintenanceRows(sql)).resolves.toEqual({
      processedReceipts: 0,
      failedReceipts: 0,
      abandonedPendingReceipts: 0,
      expiredRuns: 0,
      changesOfExpiredRuns: 0,
    });
    expect(await receiptExists(processed)).toBe(false);
    expect(await receiptExists(failed)).toBe(false);
    expect(await receiptExists(pending)).toBe(false);
    expect(await runExists(run)).toBe(false);
    expect(await changeExists(change)).toBe(false);
  });
});

/** Each test starts from a known-empty state, so counts are its own. */
async function resetMaintenanceTables(): Promise<void> {
  await sql`truncate table webhook_deliveries, reconciliation_changes, reconciliation_runs`;
}

const REGISTRATION_ID = randomUUID();
let receiptSequence = 0;

interface ReceiptSeed {
  processingState: "PENDING" | "PROCESSED" | "FAILED";
  receivedDaysAgo?: number;
  processedDaysAgo?: number;
  /** PENDING only; production rows always carry one. Default: expired an hour ago. */
  leaseExpiresInHours?: number;
}

/**
 * Seeds one scoped receipt in the shape production writes. A PENDING row
 * always carries a lease token and a lease_expires_at (migration 005's
 * webhook_deliveries_processing_lease_check refuses anything else), so the
 * live-lease guard's coalesce branch for a missing lease is a defense the
 * schema does not let a real row exercise; a terminal row carries neither.
 */
async function seedReceipt(seed: ReceiptSeed): Promise<string> {
  const deliveryKey = `retention-${(receiptSequence += 1)}`;
  const pending = seed.processingState === "PENDING";
  const [row] = await sql<{ id: string }[]>`
    insert into webhook_deliveries (
      provider, registration_id, delivery_key, execution_id, event_name,
      processing_state, received_at, processed_at,
      processing_lease_token, lease_expires_at
    )
    values (
      'github', ${REGISTRATION_ID}, ${deliveryKey}, ${`exec-${deliveryKey}`}, 'push',
      ${seed.processingState}::webhook_processing_state,
      now() - (${seed.receivedDaysAgo ?? 0} * interval '1 day'),
      ${seed.processedDaysAgo === undefined ? null : sql`now() - (${seed.processedDaysAgo} * interval '1 day')`},
      ${pending ? randomUUID() : null},
      ${pending ? sql`now() + (${seed.leaseExpiresInHours ?? -1} * interval '1 hour')` : null}
    )
    returning id
  `;
  return row!.id;
}

interface RunSeed {
  status: "PENDING" | "COMPLETED" | "FAILED";
  startedDaysAgo?: number;
  completedDaysAgo?: number;
}

/** Seeds one reconciliation run; completed_at stays null unless seeded. */
async function seedRun(seed: RunSeed): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into reconciliation_runs (status, started_at, completed_at)
    values (
      ${seed.status}::reconciliation_status,
      now() - (${seed.startedDaysAgo ?? 0} * interval '1 day'),
      ${seed.completedDaysAgo === undefined ? null : sql`now() - (${seed.completedDaysAgo} * interval '1 day')`}
    )
    returning id
  `;
  return row!.id;
}

async function seedChange(runId: string, options?: { createdDaysAgo?: number }): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into reconciliation_changes (reconciliation_run_id, entity_kind, change_kind, created_at)
    values (
      ${runId}, 'SETTLEMENT', 'ADD',
      now() - (${options?.createdDaysAgo ?? 0} * interval '1 day')
    )
    returning id
  `;
  return row!.id;
}

async function receiptExists(id: string): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`select exists (select 1 from webhook_deliveries where id = ${id}) as exists`;
  return row!.exists;
}

async function runExists(id: string): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`select exists (select 1 from reconciliation_runs where id = ${id}) as exists`;
  return row!.exists;
}

async function changeExists(id: string): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`select exists (select 1 from reconciliation_changes where id = ${id}) as exists`;
  return row!.exists;
}
