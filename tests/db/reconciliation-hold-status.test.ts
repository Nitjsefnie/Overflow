import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { pruneExpiredMaintenanceRows } from "@/lib/retention/prune";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let store: PostgresFoldStore;
let repositoryId: string;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "reconciliation_hold", user: "reconciliation_hold" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
  ({ store, repositoryId } = await materializeRepositoryFixture(sql));
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.OVERFLOW_DATABASE_URL;
  else process.env.OVERFLOW_DATABASE_URL = originalDatabaseUrl;
});

describe("durable reconciliation budget holds", () => {
  // Losing the budget identity, message, completion time or pending-only guard breaks these reads.
  it.each([
    ["GRAPHQL_BUDGET", "Reconciliation held for GraphQL budget."],
    ["SWEEP_REQUEST_BUDGET", "Reconciliation held for the sweep request budget."],
  ] as const)("records a pending run held by %s without publishing costs", async (heldBy, message) => {
    const runId = await store.beginRun(repositoryId);
    const otherRunId = await store.beginRun(repositoryId);
    await store.holdRun(runId, message, heldBy);
    const read = () => sql`
      select status, held_by, error_message, completed_at,
        graphql_cost, graphql_cost_sponsor_id, graphql_observed_responses, graphql_unmeasured_responses
      from reconciliation_runs where id = ${runId}
    `;
    const rows = await read();
    expect(rows).toEqual([{
      status: "HELD", held_by: heldBy, error_message: message, completed_at: expect.any(Date),
      graphql_cost: null, graphql_cost_sponsor_id: null,
      graphql_observed_responses: null, graphql_unmeasured_responses: null,
    }]);
    expect(await sql`select status, held_by, completed_at from reconciliation_runs where id = ${otherRunId}`)
      .toEqual([{ status: "PENDING", held_by: null, completed_at: null }]);
    await store.holdRun(runId, "late hold", heldBy === "GRAPHQL_BUDGET" ? "SWEEP_REQUEST_BUDGET" : "GRAPHQL_BUDGET");
    await store.failRun(runId, "late failure");
    await store.completeRun(runId);
    expect(await read()).toEqual(rows);
  });

  it("keeps failRun's generic FAILED outcome for another run", async () => {
    const runId = await store.beginRun(repositoryId);
    await store.failRun(runId, "upstream error text");
    expect(await sql`select status, error_message, completed_at from reconciliation_runs where id = ${runId}`)
      .toEqual([{ status: "FAILED", error_message: "Reconciliation failed.", completed_at: expect.any(Date) }]);
  });

  // Removing HELD from the terminal predicate must leave the expired row behind and fail this test.
  it("prunes expired HELD runs with their changes while retaining recent and undated holds", async () => {
    const [expired] = await sql<{ id: string }[]>`
      insert into reconciliation_runs (status, held_by, completed_at)
      values ('HELD', 'GRAPHQL_BUDGET', now() - interval '91 days') returning id
    `;
    const [recent] = await sql<{ id: string }[]>`
      insert into reconciliation_runs (status, held_by, completed_at)
      values ('HELD', 'SWEEP_REQUEST_BUDGET', now() - interval '89 days') returning id
    `;
    const [undated] = await sql<{ id: string }[]>`
      insert into reconciliation_runs (status, held_by) values ('HELD', 'GRAPHQL_BUDGET') returning id
    `;
    const [change] = await sql<{ id: string }[]>`
      insert into reconciliation_changes (reconciliation_run_id, entity_kind, change_kind)
      values (${expired.id}, 'SETTLEMENT', 'ADD') returning id
    `;
    expect(await pruneExpiredMaintenanceRows(sql)).toMatchObject({ expiredRuns: 1, changesOfExpiredRuns: 1 });
    expect(await sql`select id from reconciliation_runs where id = ${expired.id}`).toEqual([]);
    expect(await sql`select id from reconciliation_changes where id = ${change.id}`).toEqual([]);
    expect(await sql`select id from reconciliation_runs where id in (${recent.id}, ${undated.id})`).toHaveLength(2);
  });
});
