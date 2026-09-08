import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import type { FoldResult } from "@/lib/fold/repository-fold";
import type { ReconciliationCostCharge } from "@/lib/fold/reconciliation-fairness";
import type { GitHubGraphqlBudgetAssessment } from "@/lib/github/rate-limit-budget";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
let container: StartedTestContainer;
const originalDatabaseUrl = process.env.DATABASE_URL;
const at = new Date("2026-09-08T10:00:00Z");
const budget: GitHubGraphqlBudgetAssessment = { state: "AVAILABLE", reserve: 500,
  reading: { remaining: 6500, limit: 10000, cost: 7,
    resetAt: new Date("2026-09-08T11:00:00Z"), observedAt: at } };

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "cost", user: "cost", password: "cost" });
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

describe("durable reconciliation cost", () => {
  it("charges a completed fold once and preserves it across a store restart", async () => {
    const f = await materializeRepositoryFixture(sql);
    const repository = (await f.store.getRepository(f.repositoryId))!;
    const sponsorId = repository.sponsor.id;
    const runId = await f.store.beginRun(f.repositoryId);
    const input = { repositoryId: f.repositoryId, runId, fold: f.fold,
      cost: { sponsorId, completedAt: at, observedCost: 17, observedResponses: 4, unmeasuredResponses: 0 } };
    await f.store.withRepositoryReconciliation(f.repositoryId, () => f.store.materialize(input));
    expect(await sql`select graphql_cost::float8 as cost, graphql_cost_sponsor_id as sponsor_id,
      graphql_observed_responses, graphql_unmeasured_responses, status from reconciliation_runs where id = ${runId}`)
      .toEqual([{ cost: 17, sponsor_id: sponsorId, graphql_observed_responses: 4, graphql_unmeasured_responses: 0, status: "COMPLETED" }]);
    const restarted = new PostgresFoldStore(sql);
    const result = await restarted.withRepositoryReconciliation(f.repositoryId, () => restarted.assessReconciliationFairness({
      repositoryId: f.repositoryId, sponsorId, now: at,
      budget: { state: "UNKNOWN", reading: null, reserve: 500 },
    }));
    expect(result.usage.debt).toBe(17);
    await expect(f.store.withRepositoryReconciliation(f.repositoryId, () => f.store.materialize(input)))
      .rejects.toThrow("Reconciliation cost publication requires a pending run.");
    expect(await sql`select debt from repository_reconciliation_usage where repository_id = ${f.repositoryId} and sponsor_id = ${sponsorId}`)
      .toEqual([{ debt: 17 }]);
    // The fixture's separate baseline run did not collect any response observations.
    expect(await sql`select graphql_cost from reconciliation_runs where id = ${f.runId}`).toEqual([{ graphql_cost: null }]);
  });

  it("persists held rechecks with the old interval's decay and pauses debt on UNKNOWN", async () => {
    const f = await materializeRepositoryFixture(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    await sql`insert into repository_reconciliation_usage (repository_id, sponsor_id, debt, measured_at, rate_per_second)
      values (${f.repositoryId}, ${sponsorId}, 100, '2026-09-08T09:59:30Z', 1)`;
    const held = await f.store.withRepositoryReconciliation(f.repositoryId, () => f.store.assessReconciliationFairness({
      repositoryId: f.repositoryId, sponsorId, budget, now: at,
    }));
    expect(held).toEqual({ state: "HELD", holdUntil: new Date("2026-09-08T10:00:12Z"),
      usage: { debt: 70, measuredAt: at, ratePerSecond: 5 / 3 } });
    expect(await sql`select debt, measured_at, rate_per_second from repository_reconciliation_usage
      where repository_id = ${f.repositoryId} and sponsor_id = ${sponsorId}`)
      .toEqual([{ debt: 70, measured_at: at, rate_per_second: 5 / 3 }]);
    const later = new Date("2026-09-08T10:00:06Z");
    const unknown = { state: "UNKNOWN", reading: null, reserve: 500 } as const;
    const admitted = await f.store.withRepositoryReconciliation(f.repositoryId, () => f.store.assessReconciliationFairness({
      repositoryId: f.repositoryId, sponsorId, budget: unknown, now: later,
    }));
    expect(admitted).toEqual({ state: "ADMITTED", holdUntil: null, usage: { debt: 60, measuredAt: later, ratePerSecond: 0 } });
    const restarted = new PostgresFoldStore(sql);
    expect((await restarted.withRepositoryReconciliation(f.repositoryId, () => restarted.assessReconciliationFairness({
      repositoryId: f.repositoryId, sponsorId, budget: unknown, now: new Date("2026-09-08T10:00:36Z"),
    }))).usage.debt).toBe(60);
    expect(await sql`select id from reconciliation_runs where repository_id = ${f.repositoryId}`).toEqual([{ id: f.runId }]);
  });

  it("fences cold admission and persists a row without requiring a token or a run", async () => {
    const f = await materializeRepositoryFixture(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    const input = { repositoryId: f.repositoryId, sponsorId, budget, now: at };
    await expect(f.store.assessReconciliationFairness(input)).rejects.toThrow();
    expect(await sql`select debt from repository_reconciliation_usage where repository_id = ${f.repositoryId}`).toEqual([]);
    expect(await f.store.withRepositoryReconciliation(f.repositoryId, () => f.store.assessReconciliationFairness(input)))
      .toEqual({ state: "ADMITTED", holdUntil: null, usage: { debt: 0, measuredAt: at, ratePerSecond: 5 / 3 } });
    expect(await sql`select debt, measured_at, rate_per_second from repository_reconciliation_usage where repository_id = ${f.repositoryId}`)
      .toEqual([{ debt: 0, measured_at: at, rate_per_second: 5 / 3 }]);
  });

  it("does not persist a synthetic timestamp or rate when the admission clock is invalid", async () => {
    const f = await materializeRepositoryFixture(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    const check = () => f.store.withRepositoryReconciliation(f.repositoryId, () => f.store.assessReconciliationFairness({
      repositoryId: f.repositoryId, sponsorId, budget, now: new Date("invalid"),
    }));
    expect((await check()).usage).toEqual({ debt: 0, measuredAt: new Date(0), ratePerSecond: 0 });
    expect(await sql`select debt from repository_reconciliation_usage where repository_id = ${f.repositoryId}`).toEqual([]);
    await sql`insert into repository_reconciliation_usage (repository_id, sponsor_id, debt, measured_at, rate_per_second)
      values (${f.repositoryId}, ${sponsorId}, 50, ${at}, 1)`;
    expect((await check()).usage).toEqual({ debt: 50, measuredAt: at, ratePerSecond: 0 });
    expect(await sql`select debt, measured_at, rate_per_second from repository_reconciliation_usage where repository_id = ${f.repositoryId}`)
      .toEqual([{ debt: 50, measured_at: at, rate_per_second: 1 }]);
  });

  it.each([
    { observedCost: -1 }, { observedCost: 1.5 }, { observedCost: Infinity }, { observedCost: NaN },
    { observedCost: Number.MAX_SAFE_INTEGER + 1 }, { completedAt: new Date("invalid") },
    { observedResponses: -1 }, { observedResponses: 1.5 }, { observedResponses: Number.MAX_SAFE_INTEGER + 1 },
    { unmeasuredResponses: -1 }, { unmeasuredResponses: Infinity }, { unmeasuredResponses: 1.5 },
    { observedCost: null }, { observedResponses: 0 },
  ] satisfies Partial<ReconciliationCostCharge>[])("rejects invalid observations before publication: %j", async (invalid) => {
    const f = await materializeRepositoryFixture(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    const runId = await f.store.beginRun(f.repositoryId);
    await expect(f.store.withRepositoryReconciliation(f.repositoryId, () => f.store.materialize({
      repositoryId: f.repositoryId, runId,
      fold: { ...f.fold, issues: f.fold.issues.map((issue) => ({ ...issue, title: "not committed" })) },
      // This is stale and must not supersede validation of the charge.
      synchronization: { expectedVersion: 1, scanStartedAt: at, full: true, issues: [], pullRequests: [], dirtySubjects: [] },
      cost: { sponsorId, completedAt: at, observedCost: 17, observedResponses: 4, unmeasuredResponses: 0, ...invalid },
    }))).rejects.toThrow("Invalid reconciliation cost observation.");
    expect(await sql`select status, graphql_cost from reconciliation_runs where id = ${runId}`)
      .toEqual([{ status: "PENDING", graphql_cost: null }]);
    expect(await sql`select debt from repository_reconciliation_usage where repository_id = ${f.repositoryId}`).toEqual([]);
    expect(await f.store.getReconciliationEvidence(f.repositoryId)).toBeNull();
  });

  it.each(["cost accounting", "run completion"])("rolls back usage and publication when %s fails", async (failure) => {
    const f = await materializeRepositoryFixture(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    const runId = await f.store.beginRun(f.repositoryId);
    const cooldown = new Date("2026-09-08T11:00:00Z");
    await f.store.withRepositoryReconciliation(f.repositoryId, () => f.store.setReconciliationCooldown(f.repositoryId, cooldown));
    const table = failure === "cost accounting" ? "repository_reconciliation_usage" : "reconciliation_runs";
    await sql`create function reject_cost_test_write() returns trigger language plpgsql as $$
      begin raise exception 'injected cost failure'; end $$`;
    if (failure === "cost accounting") {
      await sql`create trigger reject_cost_test_write before insert or update on repository_reconciliation_usage
        for each row execute function reject_cost_test_write()`;
    } else {
      await sql`create trigger reject_cost_test_write before update of status on reconciliation_runs
        for each row execute function reject_cost_test_write()`;
    }
    try {
      await expect(f.store.withRepositoryReconciliation(f.repositoryId, () => f.store.materialize({
        repositoryId: f.repositoryId, runId,
        fold: { ...f.fold, issues: f.fold.issues.map((issue) => ({ ...issue, title: "not committed" })) },
        synchronization: { expectedVersion: null, scanStartedAt: at, full: true, issues: [], pullRequests: [], dirtySubjects: [] },
        cost: { sponsorId, completedAt: at, observedCost: 17, observedResponses: 4, unmeasuredResponses: 0 },
      }))).rejects.toThrow("injected cost failure");
    } finally {
      await sql`drop trigger reject_cost_test_write on ${sql(table)}`;
      await sql`drop function reject_cost_test_write()`;
    }
    expect(await sql`select debt from repository_reconciliation_usage where repository_id = ${f.repositoryId}`).toEqual([]);
    expect(await sql`select status, graphql_cost from reconciliation_runs where id = ${runId}`)
      .toEqual([{ status: "PENDING", graphql_cost: null }]);
    expect(await sql`select title from issues where repository_id = ${f.repositoryId} order by issue_number`)
      .toEqual([{ title: "Revision fixture" }, { title: "Revision fixture" }, { title: "Revision fixture" }]);
    expect(await f.store.getReconciliationEvidence(f.repositoryId)).toBeNull();
    expect(await f.store.getReconciliationCooldown(f.repositoryId)).toEqual(cooldown);
  });

  it("rolls back charging when the completed transition updates no run", async () => {
    const f = await materializeRepositoryFixture(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    const runId = await f.store.beginRun(f.repositoryId);
    await sql`create function skip_cost_test_completion() returns trigger language plpgsql as $$
      begin return null; end $$`;
    await sql`create trigger skip_cost_test_completion before update of status on reconciliation_runs
      for each row execute function skip_cost_test_completion()`;
    try {
      await expect(f.store.withRepositoryReconciliation(f.repositoryId, () => f.store.materialize({
        repositoryId: f.repositoryId, runId, fold: f.fold,
        cost: { sponsorId, completedAt: at, observedCost: 17, observedResponses: 4, unmeasuredResponses: 0 },
      }))).rejects.toThrow("Reconciliation cost publication requires a pending run.");
    } finally {
      await sql`drop trigger skip_cost_test_completion on reconciliation_runs`;
      await sql`drop function skip_cost_test_completion()`;
    }
    expect(await sql`select debt from repository_reconciliation_usage where repository_id = ${f.repositoryId}`).toEqual([]);
    expect(await sql`select status, graphql_cost from reconciliation_runs where id = ${runId}`)
      .toEqual([{ status: "PENDING", graphql_cost: null }]);
  });

  it.each(["debt", "rate_per_second"] as const)("rejects invalid durable %s", async (column) => {
    const f = await materializeRepositoryFixture(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    for (const invalid of ["-1", "Infinity", "-Infinity", "NaN"]) {
      await expect(sql`insert into repository_reconciliation_usage (repository_id, sponsor_id, debt, measured_at, rate_per_second)
        values (${f.repositoryId}, ${sponsorId}, ${column === "debt" ? invalid : "0"}::float8, ${at},
          ${column === "rate_per_second" ? invalid : "0"}::float8)`).rejects.toThrow(/check constraint/);
    }
  });

  it("rejects nonfinite durable timestamps", async () => {
    const f = await materializeRepositoryFixture(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    for (const invalid of ["infinity", "-infinity"]) {
      await expect(sql`insert into repository_reconciliation_usage (repository_id, sponsor_id, debt, measured_at, rate_per_second)
        values (${f.repositoryId}, ${sponsorId}, 0, ${invalid}::text::timestamptz, 0)`).rejects.toThrow(/check constraint/);
    }
  });

  it("rejects invalid costs and inconsistent audit observation shapes in SQL", async () => {
    const f = await materializeRepositoryFixture(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    for (const invalid of [-1, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(sql`update reconciliation_runs set graphql_cost = ${invalid}, graphql_cost_sponsor_id = ${sponsorId},
        graphql_observed_responses = 1, graphql_unmeasured_responses = 0 where id = ${f.runId}`).rejects.toThrow(/check constraint/);
    }
    for (const [cost, observed, unmeasured, sponsor] of [
      [null, 1, 0, sponsorId], [0, 0, 0, sponsorId], [7, -1, 0, sponsorId], [7, 1, -1, sponsorId],
      [7, null, 0, sponsorId], [7, 1, null, sponsorId], [7, 1, 0, null], [null, null, null, sponsorId],
    ] as const) {
      await expect(sql`update reconciliation_runs set graphql_cost = ${cost}, graphql_cost_sponsor_id = ${sponsor},
        graphql_observed_responses = ${observed}, graphql_unmeasured_responses = ${unmeasured} where id = ${f.runId}`)
        .rejects.toThrow(/check constraint/);
    }
  });

  it.each(["missing", "foreign", "failed", "completed", "already audited"])("refuses a %s run before synchronization", async (state) => {
    const f = await materializeRepositoryFixture(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    const runRepository = state === "foreign" ? (await materializeRepositoryFixture(sql)).repositoryId : f.repositoryId;
    const runId = state === "missing" ? randomUUID() : await f.store.beginRun(runRepository);
    if (state === "failed") await f.store.failRun(runId, "failure");
    if (state === "completed") await f.store.completeRun(runId);
    if (state === "already audited") {
      await sql`update reconciliation_runs set graphql_cost = 7, graphql_cost_sponsor_id = ${sponsorId},
        graphql_observed_responses = 1, graphql_unmeasured_responses = 0 where id = ${runId}`;
    }
    const before = await sql`select * from reconciliation_runs where id = ${runId}`;
    await expect(f.store.withRepositoryReconciliation(f.repositoryId, () => f.store.materialize({
      repositoryId: f.repositoryId, runId, fold: f.fold,
      synchronization: { expectedVersion: 1, scanStartedAt: at, full: true, issues: [], pullRequests: [], dirtySubjects: [] },
      cost: { sponsorId, completedAt: at, observedCost: 17, observedResponses: 4, unmeasuredResponses: 0 },
    }))).rejects.toThrow("Reconciliation cost publication requires a pending run.");
    expect(await sql`select * from reconciliation_runs where id = ${runId}`).toEqual(before);
    expect(await sql`select debt from repository_reconciliation_usage where repository_id = ${f.repositoryId}`).toEqual([]);
    expect(await f.store.getReconciliationEvidence(f.repositoryId)).toBeNull();
  });

  it("allocates from active registrations of only the requested sponsor, including cold peers", async () => {
    const one = await materializeRepositoryFixture(sql);
    const two = await materializeRepositoryFixture(sql);
    const sponsorId = (await one.store.getRepository(one.repositoryId))!.sponsor.id;
    const otherSponsorId = (await two.store.getRepository(two.repositoryId))!.sponsor.id;
    await sql`update registered_repositories set sponsor_id = ${sponsorId} where id = ${two.repositoryId}`;
    await sql`insert into repository_reconciliation_usage (repository_id, sponsor_id, debt, measured_at, rate_per_second)
      values (${one.repositoryId}, ${sponsorId}, 7, ${at}, 0)`;
    const assess = (f: typeof one) => f.store.withRepositoryReconciliation(f.repositoryId, () => f.store.assessReconciliationFairness({
      repositoryId: f.repositoryId, sponsorId, budget, now: at,
    }));
    expect((await assess(one)).usage).toEqual({ debt: 7, measuredAt: at, ratePerSecond: 5 / 6 });
    expect((await assess(two)).usage).toEqual({ debt: 0, measuredAt: at, ratePerSecond: 5 / 6 });
    await publishCost(two, sponsorId, 11);
    expect((await assess(two)).usage).toEqual({ debt: 11, measuredAt: at, ratePerSecond: 5 / 6 });
    await sql`update registered_repositories set active = false where id = ${two.repositoryId}`;
    expect((await assess(one)).usage).toEqual({ debt: 7, measuredAt: at, ratePerSecond: 5 / 3 });
    await sql`update registered_repositories set active = true, sponsor_id = ${otherSponsorId} where id = ${two.repositoryId}`;
    expect((await assess(one)).usage).toEqual({ debt: 7, measuredAt: at, ratePerSecond: 5 / 3 });
    await sql`update registered_repositories set active = false where id = ${two.repositoryId}`;
    expect((await assess(one)).usage).toEqual({ debt: 7, measuredAt: at, ratePerSecond: 5 / 3 });
  });

  it("adds concurrent completed runs for one repository without losing either charge", async () => {
    const f = await materializeRepositoryFixture(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    const runIds = await Promise.all([publishCost(f, sponsorId, 7), publishCost(f, sponsorId, 11)]);
    expect(await sql`select debt, rate_per_second from repository_reconciliation_usage
      where sponsor_id = ${sponsorId} and repository_id = ${f.repositoryId}`).toEqual([{ debt: 18, rate_per_second: 0 }]);
    expect(await sql`select graphql_cost::float8 as cost, status from reconciliation_runs
      where id = any(${sql.array(runIds)}::uuid[]) order by graphql_cost`)
      .toEqual([{ cost: 7, status: "COMPLETED" }, { cost: 11, status: "COMPLETED" }]);
  });

  it("keeps concurrent charges to distinct repositories under one sponsor separate", async () => {
    const one = await materializeRepositoryFixture(sql);
    const two = await materializeRepositoryFixture(sql);
    const sponsorId = (await one.store.getRepository(one.repositoryId))!.sponsor.id;
    await sql`update registered_repositories set sponsor_id = ${sponsorId} where id = ${two.repositoryId}`;
    await Promise.all([publishCost(one, sponsorId, 7), publishCost(two, sponsorId, 11)]);
    expect(await sql`select repository_id, debt from repository_reconciliation_usage where sponsor_id = ${sponsorId} order by debt`)
      .toEqual([{ repository_id: one.repositoryId, debt: 7 }, { repository_id: two.repositoryId, debt: 11 }]);
  });

  it("allows exactly one concurrent publisher of the same run before stale synchronization can replay", async () => {
    const f = await materializeRepositoryFixture(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    const runId = await f.store.beginRun(f.repositoryId);
    const input = { repositoryId: f.repositoryId, runId, fold: f.fold,
      synchronization: { expectedVersion: null, scanStartedAt: at, full: true, issues: [], pullRequests: [], dirtySubjects: [] },
      cost: { sponsorId, completedAt: at, observedCost: 7, observedResponses: 1, unmeasuredResponses: 0 } };
    const contenders = [new PostgresFoldStore(sql), new PostgresFoldStore(sql)];
    const outcomes = await Promise.allSettled(contenders.map((store) => store.withRepositoryReconciliation(f.repositoryId, () => store.materialize(input))));
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason.message).toBe("Reconciliation cost publication requires a pending run.");
    expect(await sql`select debt from repository_reconciliation_usage where repository_id = ${f.repositoryId}`).toEqual([{ debt: 7 }]);
    expect(await f.store.getReconciliationEvidence(f.repositoryId)).toMatchObject({ version: 1, checkpoint: at });
    expect(await sql`select graphql_cost::float8 as cost, graphql_cost_sponsor_id as sponsor_id from reconciliation_runs where id = ${runId}`)
      .toEqual([{ cost: 7, sponsor_id: sponsorId }]);
  });

  it("retains old sponsorship charges and starts the new sponsor cold", async () => {
    const f = await materializeRepositoryFixture(sql);
    const other = await materializeRepositoryFixture(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    const newSponsorId = (await other.store.getRepository(other.repositoryId))!.sponsor.id;
    const runId = await publishCost(f, sponsorId, 17);
    await sql`update registered_repositories set sponsor_id = ${newSponsorId} where id = ${f.repositoryId}`;
    expect((await f.store.withRepositoryReconciliation(f.repositoryId, () => f.store.assessReconciliationFairness({
      repositoryId: f.repositoryId, sponsorId: newSponsorId, budget, now: at,
    }))).usage).toEqual({ debt: 0, measuredAt: at, ratePerSecond: 5 / 6 });
    expect(await sql`select debt, measured_at, rate_per_second from repository_reconciliation_usage
      where sponsor_id = ${sponsorId} and repository_id = ${f.repositoryId}`)
      .toEqual([{ debt: 17, measured_at: at, rate_per_second: 0 }]);
    expect(await sql`select graphql_cost::float8 as cost, graphql_cost_sponsor_id as sponsor_id from reconciliation_runs where id = ${runId}`)
      .toEqual([{ cost: 17, sponsor_id: sponsorId }]);
  });

  it.each([
    { observedCost: null, observedResponses: 0, unmeasuredResponses: 1 },
    { observedCost: 0, observedResponses: 1, unmeasuredResponses: 0 },
  ])("distinguishes an unknown observation from measured zero: %j", async (observation) => {
    const f = await materializeRepositoryFixture(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    await sql`insert into repository_reconciliation_usage (repository_id, sponsor_id, debt, measured_at, rate_per_second)
      values (${f.repositoryId}, ${sponsorId}, 50, ${at}, 0)`;
    const runId = await publishCost(f, sponsorId, observation.observedCost);
    expect(await sql`select graphql_cost::float8 as cost, graphql_cost_sponsor_id as sponsor_id,
      graphql_observed_responses as observed, graphql_unmeasured_responses as unmeasured from reconciliation_runs where id = ${runId}`)
      .toEqual([{ cost: observation.observedCost, sponsor_id: sponsorId,
        observed: observation.observedResponses, unmeasured: observation.unmeasuredResponses }]);
    expect(await sql`select debt from repository_reconciliation_usage where repository_id = ${f.repositoryId}`).toEqual([{ debt: 50 }]);
  });

  it.each([
    { completedAt: new Date("2026-09-08T10:00:30Z"), debt: 37, measuredAt: new Date("2026-09-08T10:00:30Z") },
    { completedAt: new Date("2026-09-08T09:59:30Z"), debt: 67, measuredAt: at },
  ])("decays completion with the stored rate without rewinding time: %j", async ({ completedAt, debt, measuredAt }) => {
    const f = await materializeRepositoryFixture(sql);
    const sponsorId = (await f.store.getRepository(f.repositoryId))!.sponsor.id;
    await sql`insert into repository_reconciliation_usage (repository_id, sponsor_id, debt, measured_at, rate_per_second)
      values (${f.repositoryId}, ${sponsorId}, 50, ${at}, 1)`;
    await publishCost(f, sponsorId, 17, completedAt);
    expect(await sql`select debt, measured_at, rate_per_second from repository_reconciliation_usage where repository_id = ${f.repositoryId}`)
      .toEqual([{ debt, measured_at: measuredAt, rate_per_second: 1 }]);
  });
});

async function publishCost(
  fixture: { repositoryId: string; fold: FoldResult },
  sponsorId: string,
  observedCost: number | null,
  completedAt = at,
): Promise<string> {
  const store = new PostgresFoldStore(sql);
  const runId = await store.beginRun(fixture.repositoryId);
  await store.withRepositoryReconciliation(fixture.repositoryId, () => store.materialize({
    repositoryId: fixture.repositoryId, fold: fixture.fold, runId,
    cost: { sponsorId, completedAt, observedCost,
      observedResponses: observedCost === null ? 0 : 1, unmeasuredResponses: observedCost === null ? 1 : 0 },
  }));
  return runId;
}
