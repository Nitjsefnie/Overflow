import { afterAll, beforeAll, expect, it } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import type { Sql } from "postgres";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { pruneExpiredMaintenanceRows } from "@/lib/retention/prune";
import { startPostgresContainer } from "../support/postgres-container";
import { observeRetentionSql } from "../support/retention-probe";

let sql: Sql;
let container: StartedTestContainer;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "retention_traversal", user: "retention_traversal" });
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

it("examines changes linearly across interleaved history and multiple run batches", async () => {
  const observations: number[] = [];
  const runObservations: number[] = [];
  for (const expired of [100, 200]) {
    await sql`truncate reconciliation_changes, reconciliation_runs`;
    // Runtime-built ordered UUIDs make retained and expired history alternate.
    await sql`insert into reconciliation_runs (id, status, completed_at)
      select lpad(to_hex(n), 32, '0')::uuid, 'COMPLETED',
        now() - case when n % 2 = 1 then interval '120 days' else interval '10 days' end
      from generate_series(1, ${expired * 2}) n`;
    await sql`insert into reconciliation_changes (id, reconciliation_run_id, entity_kind, change_kind)
      select lpad(to_hex(n * 20 + m), 32, '0')::uuid, lpad(to_hex(n), 32, '0')::uuid, 'SETTLEMENT', 'ADD'
      from generate_series(1, ${expired * 2}) n cross join generate_series(1, 20) m`;
    await sql`analyze reconciliation_changes`;
    await sql`analyze reconciliation_runs`;
    const probe = observeRetentionSql(sql, { measureChanges: true, observeSelections: true });
    const result = await pruneExpiredMaintenanceRows(probe.client);
    const examined = probe.candidates.reduce((sum, plan) => sum + plan.examined, 0);
    const runExamined = probe.selections.reduce((sum, query) => sum + query.examined, 0);
    const deleteSharedHits = probe.candidates.reduce((sum, plan) => sum + plan.deleteSharedHits, 0);
    process.stdout.write(`RETENTION_TRAVERSAL ${JSON.stringify({ expired, deleted: result.changesOfExpiredRuns,
      examined, runExamined, deleteSharedHits, probes: probe.candidates.length })}\n`);
    expect(result.expiredRuns).toBe(expired);
    expect(result.changesOfExpiredRuns).toBe(expired * 20);
    observations.push(examined);
    runObservations.push(runExamined);
    expect(probe.candidates.some((query) => query.source === "fetch" && query.examined > 0)).toBe(true);
    expect(examined).toBeGreaterThanOrEqual(result.changesOfExpiredRuns);
    expect(runExamined).toBeGreaterThanOrEqual(result.expiredRuns);
    // Twenty changes/run: examine those rows, without rewalking retained prefixes.
    expect.soft(examined).toBeLessThanOrEqual(expired * 40);
    expect.soft(runExamined).toBeLessThanOrEqual(expired * 4);
  }
  expect.soft(observations[1]).toBeLessThanOrEqual(observations[0] * 2);
  expect.soft(runObservations[1]).toBeLessThanOrEqual(runObservations[0] * 2);
});

it("advances receipt selection past retained UUID prefixes", async () => {
  await sql`truncate webhook_deliveries, reconciliation_changes, reconciliation_runs`;
  await sql`insert into webhook_deliveries
    (id, provider, registration_id, delivery_key, execution_id, event_name, processing_state, processed_at)
    select lpad(to_hex(n), 32, '0')::uuid, 'github', gen_random_uuid(),
      'receipt-' || n, 'execution-' || n, 'push', 'PROCESSED',
      now() - case when n % 2 = 1 then interval '31 days' else interval '10 days' end
    from generate_series(1, 2000) n`;
  await sql`analyze webhook_deliveries`;
  const probe = observeRetentionSql(sql, { observeSelections: true });
  expect((await pruneExpiredMaintenanceRows(probe.client)).processedReceipts).toBe(1000);
  const selections = probe.selections.filter((query) => query.table === "webhook_deliveries");
  const examined = selections.reduce((sum, query) => sum + query.examined, 0);
  process.stdout.write(`RETENTION_RECEIPT_TRAVERSAL ${JSON.stringify({ examined, probes: selections.length })}\n`);
  expect(selections.length).toBeGreaterThan(10);
  expect(examined).toBeGreaterThanOrEqual(1000);
  // At most three complete state-specific passes over these 2,000 rows.
  expect(examined).toBeLessThanOrEqual(6000);
});

it("advances within a large run even when its children require a sequential scan", async () => {
  const examined: number[] = [];
  for (const changes of [4000, 8000]) {
    await sql`truncate reconciliation_changes, reconciliation_runs`;
    await sql`insert into reconciliation_runs (id, status, completed_at)
      select lpad(to_hex(n), 32, '0')::uuid, 'COMPLETED',
        now() - case when n = 1 then interval '120 days' else interval '10 days' end
      from generate_series(1, 2) n`;
    await sql`insert into reconciliation_changes (id, reconciliation_run_id, entity_kind, change_kind)
      select lpad(to_hex(n), 32, '0')::uuid, lpad(to_hex(1 + (n % 2)), 32, '0')::uuid,
        'SETTLEMENT', 'ADD' from generate_series(1, ${changes}) n`;
    await sql`analyze reconciliation_changes`;
    const probe = observeRetentionSql(sql, { measureChanges: true });
    const result = await pruneExpiredMaintenanceRows(probe.client);
    const rows = probe.candidates.reduce((sum, plan) => sum + plan.examined, 0);
    process.stdout.write(`RETENTION_LARGE_RUN ${JSON.stringify({ changes, deleted: result.changesOfExpiredRuns, examined: rows })}\n`);
    expect(result.changesOfExpiredRuns).toBe(changes / 2);
    expect(probe.candidates.some((query) => query.source === "fetch" && query.examined > 0)).toBe(true);
    expect(rows).toBeGreaterThanOrEqual(result.changesOfExpiredRuns);
    examined.push(rows);
    expect.soft(rows).toBeLessThanOrEqual(changes);
  }
  expect.soft(examined[1]).toBeLessThanOrEqual(examined[0] * 2);
});
