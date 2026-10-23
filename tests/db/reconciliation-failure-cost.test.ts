import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;
beforeAll(async () => {
  const started = await startPostgresContainer({ database: "reconciliation_failure_cost", user: "reconciliation_failure_cost" });
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

// Omitting a cost field or splitting it from the terminal transition breaks these row reads.
describe("failed and held reconciliation cost", () => {
  it.each(["FAILED", "HELD"] as const)("records observed spend in the same %s transition", async (status) => {
    const { store, repositoryId } = await materializeRepositoryFixture(sql);
    const sponsorId = (await store.getRepository(repositoryId))!.sponsor.id;
    const runId = await store.beginRun(repositoryId);
    const otherRunId = await store.beginRun(repositoryId);
    const cost = { sponsorId, observedCost: 17, observedResponses: 4, unmeasuredResponses: 2 };
    // An AFTER trigger rejects a terminal transition lacking its cost: a later UPDATE cannot repair it.
    await sql`create function require_terminal_cost() returns trigger language plpgsql as $$
      begin
        if new.status in ('FAILED', 'HELD') and new.graphql_cost is null then
          raise exception 'terminal transition lost cost';
        end if;
        return new;
      end $$`;
    await sql`create trigger require_terminal_cost after update on reconciliation_runs
      for each row execute function require_terminal_cost()`;
    try {
      if (status === "FAILED") await store.failRun(runId, "private upstream error", cost);
      else await store.holdRun(runId, "Reconciliation held for GraphQL budget.", "GRAPHQL_BUDGET", cost);
    } finally {
      await sql`drop trigger require_terminal_cost on reconciliation_runs`;
      await sql`drop function require_terminal_cost()`;
    }
    const read = () => sql`select status, completed_at, error_message, held_by,
      graphql_cost::float8 as cost, graphql_cost_sponsor_id as sponsor_id,
      graphql_observed_responses as observed, graphql_unmeasured_responses as unmeasured
      from reconciliation_runs where id = ${runId}`;
    const rows = await read();
    expect(rows).toEqual([{
      status, completed_at: expect.any(Date),
      error_message: status === "FAILED" ? "Reconciliation failed." : "Reconciliation held for GraphQL budget.",
      held_by: status === "HELD" ? "GRAPHQL_BUDGET" : null,
      cost: 17, sponsor_id: sponsorId, observed: 4, unmeasured: 2,
    }]);
    expect(await sql`select status, graphql_cost_sponsor_id from reconciliation_runs where id = ${otherRunId}`)
      .toEqual([{ status: "PENDING", graphql_cost_sponsor_id: null }]);
    await store.failRun(runId, "late failure", { ...cost, observedCost: 99 });
    await store.holdRun(runId, "late hold", "SWEEP_REQUEST_BUDGET", { ...cost, observedCost: 99 });
    expect(await read()).toEqual(rows);
  });

  it.each(["FAILED", "HELD"] as const)("retains unmeasured-only counters on %s as allowed by migration 028", async (status) => {
    const { store, repositoryId } = await materializeRepositoryFixture(sql);
    const sponsorId = (await store.getRepository(repositoryId))!.sponsor.id;
    const runId = await store.beginRun(repositoryId);
    const cost = { sponsorId, observedCost: null, observedResponses: 0, unmeasuredResponses: 2 };
    if (status === "FAILED") await store.failRun(runId, "failure", cost);
    else await store.holdRun(runId, "held", "SWEEP_REQUEST_BUDGET", cost);
    expect(await sql`select status, graphql_cost, graphql_cost_sponsor_id,
      graphql_observed_responses, graphql_unmeasured_responses from reconciliation_runs where id = ${runId}`)
      .toEqual([{ status, graphql_cost: null, graphql_cost_sponsor_id: sponsorId,
        graphql_observed_responses: 0, graphql_unmeasured_responses: 2 }]);
  });

  it.each(["FAILED", "HELD"] as const)("keeps all four cost fields null on a zero-response %s", async (status) => {
    const { store, repositoryId } = await materializeRepositoryFixture(sql);
    const sponsorId = (await store.getRepository(repositoryId))!.sponsor.id;
    const runId = await store.beginRun(repositoryId);
    const cost = { sponsorId, observedCost: null, observedResponses: 0, unmeasuredResponses: 0 };
    if (status === "FAILED") await store.failRun(runId, "failure", cost);
    else await store.holdRun(runId, "held", "GRAPHQL_BUDGET", cost);
    expect(await sql`select status, graphql_cost, graphql_cost_sponsor_id,
      graphql_observed_responses, graphql_unmeasured_responses from reconciliation_runs where id = ${runId}`)
      .toEqual([{ status, graphql_cost: null, graphql_cost_sponsor_id: null,
        graphql_observed_responses: null, graphql_unmeasured_responses: null }]);
  });
});
