import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
let store: PostgresFoldStore;
let repositoryId: string;
const originalDatabaseUrl = process.env.DATABASE_URL;
const first = new Date("2026-09-01T10:00:00.123Z");
const later = new Date("2026-09-01T10:00:01.456Z");
const earlier = new Date("2026-09-01T09:00:00.000Z");
const runAfter = new Date("2099-01-01T00:00:00Z");

describe("durable repository re-derivation requests", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "rederivation_test", user: "rederivation_test", password: "rederivation_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
    store = new PostgresFoldStore(sql);
    const [sponsor] = await sql`
      insert into users (github_user_id, github_login) values (70000, 'rederivation-sponsor') returning id
    `;
    const [repository] = await sql`
      insert into registered_repositories (
        github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
      ) values (70001, 'example/rederivation', ${sponsor.id}, 'PUBLIC', 70002, ${sql.json(validDifficultyScheme())})
      returning id
    `;
    repositoryId = repository.id;
  });

  beforeEach(async () => {
    await sql`delete from repository_reconciliation_jobs`;
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("creates one pending job with the request's reason and timestamp", async () => {
    await store.requestRepositoryRederivation(repositoryId, first);
    expect(await rows()).toEqual([expect.objectContaining({
      reason: "REDERIVATION", state: "PENDING", rederivation_requested_at: first,
      attempt_count: 0, follow_up_requested: false, lease_token: null, lease_expires_at: null,
    })]);
  });

  it("preserves pending backoff, attempts, reason and an existing follow-up", async () => {
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    await sql`update repository_reconciliation_jobs
      set attempt_count = 3, run_after = ${runAfter}, follow_up_requested = true`;
    const [before] = await rows();
    await store.requestRepositoryRederivation(repositoryId, first);
    expect(await rows()).toEqual([{ ...before, rederivation_requested_at: first }]);
  });

  it("requests the same follow-up as an ordinary enqueue while retaining the active lease", async () => {
    await store.enqueueReconciliationJob(repositoryId, "REGISTRATION");
    await claim();
    const [before] = await rows();
    await store.requestRepositoryRederivation(repositoryId, first);
    expect(await rows()).toEqual([{ ...before, follow_up_requested: true, rederivation_requested_at: first }]);
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    expect(await rows()).toEqual([{ ...before, follow_up_requested: true, rederivation_requested_at: first }]);
  });

  it("moves a request forward but never backwards", async () => {
    await store.requestRepositoryRederivation(repositoryId, first);
    await store.requestRepositoryRederivation(repositoryId, later);
    expect((await rows())[0].rederivation_requested_at).toEqual(later);
    await store.requestRepositoryRederivation(repositoryId, earlier);
    expect((await rows())[0].rederivation_requested_at).toEqual(later);
  });

  it.each(["WEBHOOK", "REGISTRATION", "SWEEP"] as const)("keeps a request across an ordinary %s enqueue", async (reason) => {
    await store.requestRepositoryRederivation(repositoryId, first);
    const [before] = await rows();
    await store.enqueueReconciliationJob(repositoryId, reason);
    expect(await rows()).toEqual([before]);
  });

  it("returns the outstanding timestamp at claim time", async () => {
    await store.requestRepositoryRederivation(repositoryId, first);
    expect(await claim()).toMatchObject({ rederivationRequestedAt: first });
  });

  it("clears a captured request when an ordinary event requires a follow-up", async () => {
    await store.requestRepositoryRederivation(repositoryId, first);
    const job = await claim();
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    expect(await store.completeReconciliationJob(job.id, job.leaseToken, first)).toBe(true);
    expect(await rows()).toEqual([expect.objectContaining({
      state: "PENDING", rederivation_requested_at: null, follow_up_requested: false,
      lease_token: null, lease_expires_at: null,
    })]);
  });

  it.each([first, null])("preserves a newer mid-fold request when completion captured %s", async (captured) => {
    if (captured) await store.requestRepositoryRederivation(repositoryId, captured);
    else await store.enqueueReconciliationJob(repositoryId, "SWEEP");
    const job = await claim();
    await store.requestRepositoryRederivation(repositoryId, later);
    expect(await store.completeReconciliationJob(job.id, job.leaseToken, captured)).toBe(true);
    expect(await rows()).toEqual([expect.objectContaining({
      state: "PENDING", rederivation_requested_at: later, follow_up_requested: false,
    })]);
    expect(await claim()).toMatchObject({ rederivationRequestedAt: later });
  });

  it("retains an uncaptured request even without an ordinary follow-up flag", async () => {
    await store.requestRepositoryRederivation(repositoryId, later);
    const job = await claim();
    expect(await store.completeReconciliationJob(job.id, job.leaseToken, first)).toBe(true);
    expect(await rows()).toEqual([expect.objectContaining({ state: "PENDING", rederivation_requested_at: later })]);
  });

  it("discharges a captured request by deleting a job with no follow-up", async () => {
    await store.requestRepositoryRederivation(repositoryId, first);
    const job = await claim();
    expect(job.rederivationRequestedAt).toEqual(first);
    expect(await store.completeReconciliationJob(job.id, job.leaseToken, job.rederivationRequestedAt)).toBe(true);
    expect(await rows()).toEqual([]);
  });

  it.each(["retry", "defer", "fail"] as const)("leaves the request standing on %s", async (outcome) => {
    await store.requestRepositoryRederivation(repositoryId, first);
    const job = await claim();
    const released = outcome === "retry"
      ? await store.retryReconciliationJob(job.id, job.leaseToken, runAfter)
      : outcome === "defer"
        ? await store.deferReconciliationJob(job.id, job.leaseToken, runAfter)
        : await store.failReconciliationJob(job.id, job.leaseToken);
    expect(released).toBe(true);
    expect((await rows())[0]).toMatchObject({
      state: outcome === "fail" ? "FAILED" : "PENDING", rederivation_requested_at: first,
      lease_token: null, lease_expires_at: null,
    });
  });

  it("revives a failed job using the ordinary enqueue policy and keeps failure evidence", async () => {
    await store.enqueueReconciliationJob(repositoryId, "SWEEP");
    const job = await claim();
    await store.failReconciliationJob(job.id, job.leaseToken);
    const [failed] = await rows();
    await store.requestRepositoryRederivation(repositoryId, first);
    expect((await rows())[0]).toMatchObject({
      state: "PENDING", attempt_count: 0, reason: "SWEEP", rederivation_requested_at: first,
      last_failure_at: failed.last_failure_at, lease_token: null, lease_expires_at: null,
    });
    const [due] = await sql`select run_after <= now() as due from repository_reconciliation_jobs`;
    expect(due.due).toBe(true);
  });
});

function rows() {
  return sql`select * from repository_reconciliation_jobs where repository_id = ${repositoryId}`;
}

async function claim() {
  const job = await store.claimNextReconciliationJob();
  if (!job) throw new Error("Expected a claimable job");
  return job;
}
