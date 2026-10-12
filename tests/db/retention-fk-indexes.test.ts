import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import type { Sql } from "postgres";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { pruneExpiredMaintenanceRows } from "@/lib/retention/prune";
import { observeRetentionSql } from "../support/retention-probe";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
let container: StartedTestContainer;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "retention_indexes", user: "retention_indexes" });
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

it("serves the expired-run FK check through the run index while the real prune drains history", async () => {
  await sql`insert into reconciliation_runs (status, completed_at)
    select 'COMPLETED', now() - case when n <= 100 then interval '120 days' else interval '10 days' end from generate_series(1, 200) n`;
  await sql`insert into reconciliation_changes (reconciliation_run_id, entity_kind, change_kind)
    select id, 'SETTLEMENT', 'ADD' from reconciliation_runs cross join generate_series(1, 20)`;
  await sql`analyze reconciliation_changes`;
  if (process.env.RETENTION_DROP_RUN_INDEX === "1") {
    await sql`drop index reconciliation_changes_run_idx`;
  }
  const probe = observeRetentionSql(sql, {
    observeRunFk: true,
    disableTransactionIndexes: process.env.RETENTION_FORCE_SEQ_FK === "1",
  });
  const result = await pruneExpiredMaintenanceRows(probe.client);
  const seq = probe.fk.reduce((sum, batch) => sum + batch.seq, 0);
  const idx = probe.fk.reduce((sum, batch) => sum + batch.idx, 0);
  process.stdout.write(`RETENTION_REAL_FK ${JSON.stringify({ seq, idx, deletes: probe.fk.length })}\n`);
  expect(probe.fk.reduce((sum, batch) => sum + batch.deleted, 0)).toBe(100);
  expect(seq).toBe(0);
  expect(idx).toBeGreaterThanOrEqual(100);
  expect(result.expiredRuns).toBe(100);
  expect(result.changesOfExpiredRuns).toBe(2000);
});

it("deletes a PR without sequential FK scans and uses the links primary key", async () => {
  const [user] = await sql`insert into users (github_user_id, github_login) values (1, 'index-user') returning id`;
  const [repo] = await sql`insert into registered_repositories
    (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
    values (1, 'index/repo', ${user.id}, 'PUBLIC', 1, ${sql.json(validDifficultyScheme())}::jsonb) returning id`;
  await sql`insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state,
    opening_label, opening_comparison_points, opening_reserve_points)
    select n, ${repo.id}, n, 'issue', '', 'https://example.invalid', 'OPEN', 'size/M', 5, 5
    from generate_series(1, 600) n`;
  await sql`insert into pull_requests (github_pull_request_id, repository_id, pull_request_number,
    title, body, url, state)
    select n, ${repo.id}, n, 'PR', '', 'https://example.invalid', 'OPEN' from generate_series(1, 601) n`;
  await sql`insert into unwritable_closures (issue_id, pull_request_id, kind, reason)
    select i.id, p.id, 'SETTLEMENT_EVIDENCE_REJECTED', 'test evidence'
    from issues i join pull_requests p on p.pull_request_number = i.issue_number`;
  await sql`insert into pull_request_issues (issue_id, pull_request_id, repository_id)
    select i.id, p.id, ${repo.id} from issues i join pull_requests p on p.pull_request_number = i.issue_number`;
  const [run] = await sql`insert into reconciliation_runs default values returning id`;
  await sql`insert into reconciliation_changes (reconciliation_run_id, pull_request_id, entity_kind, change_kind)
    select ${run.id}, id, 'SETTLEMENT', 'ADD' from pull_requests
    where pull_request_number <= 600`;
  await sql`analyze reconciliation_changes`;
  await sql`analyze unwritable_closures`;
  await sql`analyze pull_request_issues`;
  const [target] = await sql`select id from pull_requests where pull_request_number = 601`;
  const links = await sql`explain (format json) select 1 from only pull_request_issues x
    where pull_request_id = ${target.id} and repository_id = ${repo.id} for key share of x`;
  expect(JSON.stringify(links)).toContain("pull_request_issues_pkey");
  await sql.begin(async (tx) => {
    const before = await tx`select relname, seq_scan, idx_scan from pg_stat_xact_user_tables
      where relname in ('reconciliation_changes', 'unwritable_closures', 'pull_request_issues')`;
    expect((await tx`delete from pull_requests where id = ${target.id}`).count).toBe(1);
    const after = await tx`select relname, seq_scan, idx_scan from pg_stat_xact_user_tables
      where relname in ('reconciliation_changes', 'unwritable_closures', 'pull_request_issues')`;
    for (const row of after) {
      const prior = before.find((entry) => entry.relname === row.relname)!;
      expect(Number(row.seq_scan) - Number(prior.seq_scan), row.relname).toBe(0);
      expect(Number(row.idx_scan) - Number(prior.idx_scan), row.relname).toBeGreaterThan(0);
    }
  });
  // A disjoint key also rules out a plan chosen only because it matches all rows.
  const changes = await sql`explain (format json) select 1 from only reconciliation_changes x
    where pull_request_id = ${randomUUID()} for key share of x`;
  expect(JSON.stringify(changes)).toContain("reconciliation_changes_pull_request_idx");
});
