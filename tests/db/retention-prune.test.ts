import { randomBytes, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import postgres, { type Sql } from "postgres";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import {
  RECEIPT_FAILED_RETENTION_DAYS,
  RECEIPT_PENDING_RETENTION_DAYS,
  RECEIPT_PROCESSED_RETENTION_DAYS,
  RUN_TERMINAL_RETENTION_DAYS,
  WORK_MAIL_DAILY_RETENTION_DAYS,
  pruneExpiredMaintenanceRows,
} from "@/lib/retention/prune";
import { CONFIRMATION_CAP_WINDOW_HOURS } from "@/lib/accounts/work-mail-store";
import { observeRetentionSql } from "../support/retention-probe";
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
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "retention_prune", user: "retention_prune", password: "retention_prune" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.OVERFLOW_DATABASE_URL;
  else process.env.OVERFLOW_DATABASE_URL = originalDatabaseUrl;
});

describe("retention prune", () => {
  it("publishes the retention windows it implements", () => {
    expect(RECEIPT_PROCESSED_RETENTION_DAYS).toBe(30);
    expect(RECEIPT_FAILED_RETENTION_DAYS).toBe(90);
    expect(RECEIPT_PENDING_RETENTION_DAYS).toBe(90);
    expect(RUN_TERMINAL_RETENTION_DAYS).toBe(90);
    expect(CONFIRMATION_CAP_WINDOW_HOURS).toBe(24);
    expect(WORK_MAIL_DAILY_RETENTION_DAYS).toBe(2);
  });

  it("prunes a pending work-mail address once its confirmation expired, never a live or confirmed one", async () => {
    await resetMaintenanceTables();
    const expired = await seedSubscription({ expiresInMinutes: -1 });
    const live = await seedSubscription({ expiresInMinutes: 1 });
    const confirmed = await seedSubscription({ confirmed: true });
    // Confirmation clears the expiry, so this shape is never written; only the confirmed limb refuses it.
    const confirmedWithLapsedExpiry = await seedSubscription({ confirmed: true, expiresInMinutes: -1 });

    expect(await pruneExpiredMaintenanceRows(sql)).toEqual({
      processedReceipts: 0, failedReceipts: 0, abandonedPendingReceipts: 0, expiredRuns: 0, changesOfExpiredRuns: 0,
      expiredWorkMailAddresses: 1, expiredWorkMailConfirmations: 0, expiredWorkMailDays: 0,
    });
    expect(await subscriptionExists(expired)).toBe(false);
    expect(await subscriptionExists(live)).toBe(true);
    expect(await subscriptionExists(confirmed)).toBe(true);
    expect(await subscriptionExists(confirmedWithLapsedExpiry)).toBe(true);
  });

  it("prunes confirmation history once it leaves the cap window, never a row the cap still counts", async () => {
    await resetMaintenanceTables();
    const user = await seedUser();
    const lapsed = await seedConfirmation(user, { ageMinutes: CONFIRMATION_CAP_WINDOW_HOURS * 60 + 1 });
    const counted = await seedConfirmation(user, { ageMinutes: CONFIRMATION_CAP_WINDOW_HOURS * 60 - 1 });

    expect(await pruneExpiredMaintenanceRows(sql)).toEqual({
      processedReceipts: 0, failedReceipts: 0, abandonedPendingReceipts: 0, expiredRuns: 0, changesOfExpiredRuns: 0,
      expiredWorkMailAddresses: 0, expiredWorkMailConfirmations: 1, expiredWorkMailDays: 0,
    });
    expect(await confirmationExists(lapsed)).toBe(false);
    expect(await confirmationExists(counted)).toBe(true);
  });

  it("keeps the daily counters of the last two UTC days whatever the session time zone", async () => {
    // At any instant at least one of UTC+14 and UTC-12 is on another local date than UTC.
    for (const zone of ["Pacific/Kiritimati", "Etc/GMT+12"]) {
      await resetMaintenanceTables();
      await sql`insert into contributor_work_mail_daily (utc_day, sent)
        select (now() at time zone 'UTC')::date - back, 1 from generate_series(0, 4) back`;
      const zoned = postgres(process.env.OVERFLOW_DATABASE_URL!, { max: 1, connection: { TimeZone: zone } });
      try {
        expect(await pruneExpiredMaintenanceRows(zoned)).toEqual({
          processedReceipts: 0, failedReceipts: 0, abandonedPendingReceipts: 0, expiredRuns: 0, changesOfExpiredRuns: 0,
          expiredWorkMailAddresses: 0, expiredWorkMailConfirmations: 0, expiredWorkMailDays: 2,
        });
      } finally {
        await zoned.end();
      }
      const kept = await sql<{ back: number }[]>`
        select (now() at time zone 'UTC')::date - utc_day as back from contributor_work_mail_daily order by back`;
      expect(kept.map((row) => row.back), zone).toEqual([0, 1, 2]);
    }
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
      expiredWorkMailAddresses: 0,
      expiredWorkMailConfirmations: 0,
      expiredWorkMailDays: 0,
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
      expiredWorkMailAddresses: 0,
      expiredWorkMailConfirmations: 0,
      expiredWorkMailDays: 0,
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
      expiredWorkMailAddresses: 0,
      expiredWorkMailConfirmations: 0,
      expiredWorkMailDays: 0,
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
      expiredWorkMailAddresses: 0,
      expiredWorkMailConfirmations: 0,
      expiredWorkMailDays: 0,
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

  it("bounds every delete and drains a backlog larger than one batch in one call", async () => {
    await resetMaintenanceTables();
    await sql`create table prune_batches (table_name text, deleted integer)`;
    await sql`create function record_prune_batch() returns trigger language plpgsql as $$
      begin
        insert into prune_batches select TG_TABLE_NAME, count(*) from deleted_rows;
        return null;
      end
    $$`;
    for (const table of PRUNED_TABLES) {
      await sql.unsafe(`create trigger record_prune_batch after delete on ${table}
        referencing old table as deleted_rows for each statement execute function record_prune_batch()`);
    }
    try {
      await sql`
        insert into webhook_deliveries (provider, registration_id, delivery_key, execution_id,
          event_name, processing_state, received_at, processed_at, processing_lease_token, lease_expires_at)
        select 'github', ${REGISTRATION_ID}, state || n, state || n, 'push',
          state::webhook_processing_state, now() - interval '120 days',
          case when state <> 'PENDING' then now() - interval '120 days' end,
          case when state = 'PENDING' then gen_random_uuid() end,
          case when state = 'PENDING' then now() - interval '1 hour' end
        from unnest(array['PROCESSED', 'FAILED', 'PENDING']) state cross join generate_series(1, 205) n
      `;
      await sql`insert into reconciliation_runs (status, completed_at)
        select 'COMPLETED', now() - interval '120 days' from generate_series(1, 205)`;
      await sql`insert into reconciliation_changes (reconciliation_run_id, entity_kind, change_kind)
        select id, 'SETTLEMENT', 'ADD' from reconciliation_runs cross join generate_series(1, 3)`;
      // One run itself exceeds two change batches; a per-run DELETE still
      // needs its own bound, independently of the number of selected runs.
      await sql`insert into reconciliation_changes (reconciliation_run_id, entity_kind, change_kind)
        select run.id, 'SETTLEMENT', 'ADD' from
          (select id from reconciliation_runs order by id limit 1) run cross join generate_series(1, 205)`;
      const owner = await seedUser();
      await sql`insert into users (github_user_id, github_login)
        select 8_900_000 + n, 'prune-backlog-' || n from generate_series(1, 205) n`;
      await sql`insert into contributor_work_mail_subscriptions (user_id, address, confirm_token_hash, confirm_expires_at)
        select id, github_login || '@example.test', sha256(github_login::bytea), now() - interval '1 hour'
        from users where github_login like 'prune-backlog-%'`;
      await sql`insert into contributor_work_mail_confirmations (user_id, address_digest, sent_at)
        select ${owner}, sha256(n::text::bytea), now() - interval '2 days' from generate_series(1, 205) n`;
      await sql`insert into contributor_work_mail_daily (utc_day, sent)
        select (now() at time zone 'UTC')::date - 2 - n, 1 from generate_series(1, 205) n`;
      expect(await pruneExpiredMaintenanceRows(sql)).toEqual({
        processedReceipts: 205, failedReceipts: 205, abandonedPendingReceipts: 205,
        expiredRuns: 205, changesOfExpiredRuns: 820,
        expiredWorkMailAddresses: 205, expiredWorkMailConfirmations: 205, expiredWorkMailDays: 205,
      });
      const batches = await sql<{ table_name: string; deleted: number }[]>`select * from prune_batches`;
      expect(batches.length).toBeGreaterThan(5);
      expect(batches.every((batch) => batch.deleted <= 100)).toBe(true);
      expect(await pruneExpiredMaintenanceRows(sql)).toEqual({
        processedReceipts: 0, failedReceipts: 0, abandonedPendingReceipts: 0,
        expiredRuns: 0, changesOfExpiredRuns: 0,
        expiredWorkMailAddresses: 0, expiredWorkMailConfirmations: 0, expiredWorkMailDays: 0,
      });
    } finally {
      for (const table of PRUNED_TABLES) {
        await sql.unsafe(`drop trigger record_prune_batch on ${table}`);
      }
      await sql`drop function record_prune_batch()`;
      await sql`drop table prune_batches`;
    }
  });

  it("uses a fixed run set when another run expires between the two deletes", async () => {
    await resetMaintenanceTables();
    const ids = [randomUUID(), randomUUID()].sort();
    const expired = ids[0]!;
    const crossing = ids[1]!;
    // Make the boundary crossing lie ahead of the advancing cursor.
    await sql`insert into reconciliation_runs (id, status, completed_at) values
      (${expired}, 'COMPLETED', now() - interval '120 days'),
      (${crossing}, 'COMPLETED', now() - interval '10 days')`;
    await seedChange(expired);
    await seedChange(crossing);
    // Force the boundary deterministically, without sleeping or timing: the
    // changes DELETE makes the previously recent run newly eligible.
    await sql`create function expire_next_run() returns trigger language plpgsql as $$
      begin
        update reconciliation_runs set completed_at = now() - interval '120 days'
        where completed_at > now() - interval '90 days';
        return null;
      end
    $$`;
    await sql`create trigger expire_next_run after delete on reconciliation_changes
      for each statement execute function expire_next_run()`;
    try {
      expect(await pruneExpiredMaintenanceRows(sql)).toEqual({
        processedReceipts: 0, failedReceipts: 0, abandonedPendingReceipts: 0,
        expiredRuns: 2, changesOfExpiredRuns: 2,
        expiredWorkMailAddresses: 0, expiredWorkMailConfirmations: 0, expiredWorkMailDays: 0,
      });
      expect(await runExists(crossing)).toBe(false);
    } finally {
      await sql`drop trigger expire_next_run on reconciliation_changes`;
      await sql`drop function expire_next_run()`;
    }
  });

  it("rolls back a run batch's changes if deleting its runs fails", async () => {
    await resetMaintenanceTables();
    const run = await seedRun({ status: "COMPLETED", completedDaysAgo: 120 });
    const change = await seedChange(run);
    await sql`create function refuse_pruned_run() returns trigger language plpgsql as $$
      begin raise exception 'test refuses run deletion'; end
    $$`;
    await sql`create trigger refuse_pruned_run before delete on reconciliation_runs
      for each row execute function refuse_pruned_run()`;
    try {
      await expect(pruneExpiredMaintenanceRows(sql)).rejects.toThrow("test refuses run deletion");
      expect(await runExists(run)).toBe(true);
      expect(await changeExists(change)).toBe(true);
    } finally {
      await sql`drop trigger refuse_pruned_run on reconciliation_runs`;
      await sql`drop function refuse_pruned_run()`;
    }
  });

  it("never materialises returned rows from any of its delete arms", async () => {
    await resetMaintenanceTables();
    await seedReceipt({ processingState: "PROCESSED", processedDaysAgo: 31 });
    await seedReceipt({ processingState: "FAILED", processedDaysAgo: 91 });
    await seedReceipt({ processingState: "PENDING", receivedDaysAgo: 91, leaseExpiresInHours: -1 });
    await seedChange(await seedRun({ status: "COMPLETED", completedDaysAgo: 91 }));
    await seedEveryWorkMailArm();
    const probe = observeRetentionSql(sql);
    expect(await pruneExpiredMaintenanceRows(probe.client)).toEqual({
      processedReceipts: 1, failedReceipts: 1, abandonedPendingReceipts: 1,
      expiredRuns: 1, changesOfExpiredRuns: 1,
      expiredWorkMailAddresses: 1, expiredWorkMailConfirmations: 1, expiredWorkMailDays: 1,
    });
    expect(probe.deletes.filter((query) => query.deleted > 0)).toHaveLength(8);
    const materialised = probe.deletes.map((query) => query.returned);
    process.stdout.write(`RETENTION_RETURNED_ROWS ${JSON.stringify(materialised)}\n`);
    expect(materialised.every((count) => count === 0)).toBe(true);
  });

  it("deletes nothing on the second pass and reports zeros", async () => {
    await resetMaintenanceTables();
    const processed = await seedReceipt({ processingState: "PROCESSED", processedDaysAgo: 31 });
    const failed = await seedReceipt({ processingState: "FAILED", processedDaysAgo: 91 });
    const pending = await seedReceipt({ processingState: "PENDING", receivedDaysAgo: 91, leaseExpiresInHours: -1 });
    const run = await seedRun({ status: "COMPLETED", completedDaysAgo: 91 });
    const change = await seedChange(run);
    await seedEveryWorkMailArm();

    await expect(pruneExpiredMaintenanceRows(sql)).resolves.toEqual({
      processedReceipts: 1,
      failedReceipts: 1,
      abandonedPendingReceipts: 1,
      expiredRuns: 1,
      changesOfExpiredRuns: 1,
      expiredWorkMailAddresses: 1,
      expiredWorkMailConfirmations: 1,
      expiredWorkMailDays: 1,
    });
    await expect(pruneExpiredMaintenanceRows(sql)).resolves.toEqual({
      processedReceipts: 0,
      failedReceipts: 0,
      abandonedPendingReceipts: 0,
      expiredRuns: 0,
      changesOfExpiredRuns: 0,
      expiredWorkMailAddresses: 0,
      expiredWorkMailConfirmations: 0,
      expiredWorkMailDays: 0,
    });
    expect(await receiptExists(processed)).toBe(false);
    expect(await receiptExists(failed)).toBe(false);
    expect(await receiptExists(pending)).toBe(false);
    expect(await runExists(run)).toBe(false);
    expect(await changeExists(change)).toBe(false);
  });
});

const PRUNED_TABLES = [
  "webhook_deliveries", "reconciliation_changes", "reconciliation_runs",
  "contributor_work_mail_subscriptions", "contributor_work_mail_confirmations", "contributor_work_mail_daily",
];

/** Each test starts from a known-empty state, so counts are its own. */
async function resetMaintenanceTables(): Promise<void> {
  await sql.unsafe(`truncate table ${PRUNED_TABLES.join(", ")}`);
}

let userSequence = 0;

async function seedUser(): Promise<string> {
  userSequence += 1;
  const [row] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (${8_800_000 + userSequence}, ${`prune-${userSequence}`}) returning id`;
  return row!.id;
}

/** A pending row carries a token hash and an expiry; a confirmed one keeps the expiry only when seeded. */
async function seedSubscription(seed: { confirmed?: boolean; expiresInMinutes?: number }): Promise<string> {
  const minutes = seed.expiresInMinutes;
  const [row] = await sql<{ id: string }[]>`
    insert into contributor_work_mail_subscriptions (user_id, address, confirm_token_hash, confirm_expires_at, confirmed_at)
    values (${await seedUser()}, ${`prune-${userSequence}@example.test`}, ${minutes === undefined ? null : randomBytes(32)},
            ${minutes === undefined ? null : sql`now() + (${minutes} * interval '1 minute')`},
            ${seed.confirmed ? sql`now()` : null})
    returning id
  `;
  return row!.id;
}

async function seedConfirmation(userId: string, seed: { ageMinutes: number }): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into contributor_work_mail_confirmations (user_id, address_digest, sent_at)
    values (${userId}, ${randomBytes(32)}, now() - (${seed.ageMinutes} * interval '1 minute'))
    returning id
  `;
  return row!.id;
}

/** One prunable row per work-mail arm. */
async function seedEveryWorkMailArm(): Promise<void> {
  await seedSubscription({ expiresInMinutes: -1 });
  await seedConfirmation(await seedUser(), { ageMinutes: CONFIRMATION_CAP_WINDOW_HOURS * 60 + 1 });
  await sql`insert into contributor_work_mail_daily (utc_day, sent) values ((now() at time zone 'UTC')::date - 3, 1)`;
}

async function subscriptionExists(id: string): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`
    select exists (select 1 from contributor_work_mail_subscriptions where id = ${id}) as exists`;
  return row!.exists;
}

async function confirmationExists(id: string): Promise<boolean> {
  const [row] = await sql<{ exists: boolean }[]>`
    select exists (select 1 from contributor_work_mail_confirmations where id = ${id}) as exists`;
  return row!.exists;
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
  status: "PENDING" | "COMPLETED" | "FAILED" | "HELD";
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
