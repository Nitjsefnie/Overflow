import { randomBytes } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import { runNextReconciliationJob } from "@/lib/fold/reconciliation-worker";
import { PostgresSponsorSweepRoundStore } from "@/lib/fold/sponsor-sweep-round-store";
import { PostgresRepositorySizeStore } from "@/lib/fold/repository-size";
import { SweepBudgetSpent } from "@/lib/fold/sweep-request-budget";
import { sweepReconciliations } from "@/lib/fold/sweep";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { verifiedRepositoryAt } from "../support/verified-repository";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
let container: StartedTestContainer;
const original = process.env.OVERFLOW_DATABASE_URL;
const at = new Date("2030-01-01T00:00:00Z");
beforeAll(async () => {
  const started = await startPostgresContainer({ database: "authority", user: "authority" });
  container = started.container; process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql(); await runMigrations();
});
beforeEach(async () => { await sql`delete from repository_reconciliation_jobs`; });
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await closeSql(); await container?.stop();
  if (original === undefined) delete process.env.OVERFLOW_DATABASE_URL; else process.env.OVERFLOW_DATABASE_URL = original;
});

async function fixture() {
  const f = await materializeRepositoryFixture(sql);
  const repository = (await f.store.getRepository(f.repositoryId))!;
  f.store.getGitHubAccessToken = async () => randomBytes(24).toString("hex");
  const walks: Array<string | undefined> = [];
  const state = { onVerify: async () => {} };
  const verify = verifiedRepositoryAt(repository.ownerName);
  const github: ReconciliationGateway = {
    getRepositoryById: async (id) => { await state.onVerify(); return verify(id); },
    listIssues: async (_repository, options) => { walks.push(options?.since); return []; },
    getIssue: async () => null, getPullRequestClosingIssues: async () => [],
    getPullRequestReviews: async () => [], getPullRequestDiff: async () => "",
  };
  const dependencies = { store: f.store, github, now: () => at, onBudgetChange: () => {} };
  const run = () => runNextReconciliationJob({ store: f.store, now: () => at,
    scheduleLeaseRenewal: () => () => {}, onFailure: () => {},
    reconcile: (id, options) => reconcileRepository(dependencies, id, options) });
  const enqueue = (reason: "SWEEP" | "WEBHOOK") => f.store.enqueueReconciliationJob(f.repositoryId, reason);
  return { ...f, walks, state, run, enqueue, dependencies };
}

describe("consuming sweep authorization", () => {
  it("makes a webhook arriving during sweep verification an incremental follow-up", async () => {
    const f = await fixture();
    let verifies = 0;
    f.state.onVerify = async () => { if (++verifies === 1) await f.enqueue("WEBHOOK"); };
    await f.enqueue("SWEEP");
    expect(await f.run()).toBe("RECONCILED");
    expect(await f.run()).toBe("RECONCILED");
    expect(f.walks).toEqual([undefined, "2029-12-31T23:59:00.000Z"]);
    expect(await f.run()).toBe("IDLE");
  });

  it("keeps a webhook arriving after sweep completion incremental", async () => {
    const f = await fixture();
    await f.enqueue("SWEEP"); expect(await f.run()).toBe("RECONCILED");
    await f.enqueue("WEBHOOK"); expect(await f.run()).toBe("RECONCILED");
    expect(f.walks).toEqual([undefined, "2029-12-31T23:59:00.000Z"]);
  });

  it("re-arms a pending webhook follow-up when a fresh paced sweep arrives", async () => {
    const f = await fixture();
    let verifies = 0;
    f.state.onVerify = async () => { if (++verifies === 1) await f.enqueue("WEBHOOK"); };
    await f.enqueue("SWEEP"); expect(await f.run()).toBe("RECONCILED");
    const [before] = await sql`select id, reason from repository_reconciliation_jobs where repository_id = ${f.repositoryId}`;
    expect(before.reason).toBe("WEBHOOK");
    await f.enqueue("SWEEP");
    expect((await sql`select id from repository_reconciliation_jobs where repository_id = ${f.repositoryId}`)[0]!.id).toBe(before.id);
    expect(await f.run()).toBe("RECONCILED");
    expect(f.walks).toEqual([undefined, undefined]);
  });

  it("preserves a newer sweep requested during the running sweep", async () => {
    const f = await fixture();
    let verifies = 0;
    f.state.onVerify = async () => { if (++verifies === 1) await f.enqueue("SWEEP"); };
    await f.enqueue("SWEEP");
    expect(await f.run()).toBe("RECONCILED"); expect(await f.run()).toBe("RECONCILED");
    expect(f.walks).toEqual([undefined, undefined]);
  });

  it("preserves a sweep that upgrades a running incremental job", async () => {
    const f = await fixture();
    await reconcileRepository(f.dependencies, f.repositoryId);
    let verifies = 0;
    f.state.onVerify = async () => { if (++verifies === 1) await f.enqueue("SWEEP"); };
    await f.enqueue("WEBHOOK");
    expect(await f.run()).toBe("RECONCILED"); expect(await f.run()).toBe("RECONCILED");
    expect(f.walks).toEqual([undefined, "2029-12-31T23:59:00.000Z", undefined]);
  });

  it("keeps a diff-only repository's queued webhook job incremental when its sweep slot falls due", async () => {
    const f = await fixture();
    // The sponsor's stored backlog is over the diff-only threshold, so this
    // repository folds diff-only: the sweep offers it no slot, and its queued
    // webhook job keeps its reason instead of being upgraded to the full sweep
    // pass the old slot upgrade forced on it.
    const sizes = new PostgresRepositorySizeStore(sql);
    await sizes.store(f.repositoryId, 1356, at);
    await reconcileRepository(f.dependencies, f.repositoryId);
    await f.enqueue("WEBHOOK");
    await sweepReconciliations({
      listActiveRepositorySponsors: async () => [
        { repositoryId: f.repositoryId, sponsorId: (await f.store.getRepository(f.repositoryId))!.sponsor.id },
      ],
      round: new PostgresSponsorSweepRoundStore(sql),
      sizeStore: sizes,
      enqueue: (repositoryId) => f.store.enqueueReconciliationJob(repositoryId, "SWEEP"),
      now: () => at,
    });
    expect(
      (await sql`select reason from repository_reconciliation_jobs where repository_id = ${f.repositoryId}`)[0]!.reason,
    ).toBe("WEBHOOK");
    expect(await f.run()).toBe("RECONCILED");
    expect(f.walks).toEqual([undefined, "2029-12-31T23:59:00.000Z"]);
    expect(await f.run()).toBe("IDLE");
  });

  it.each(["held", "failed"] as const)("retains unfinished %s sweep authority across a webhook and revival", async (mode) => {
    const f = await fixture();
    vi.spyOn(console, "error").mockImplementation(() => {});
    await f.enqueue("SWEEP");
    if (mode === "failed") await sql`update repository_reconciliation_jobs set attempt_count = 4 where repository_id = ${f.repositoryId}`;
    f.state.onVerify = async () => {
      await f.enqueue("WEBHOOK");
      if (mode === "held") throw new SweepBudgetSpent(new Date("2030-01-01T06:00:00Z"));
      throw new Error("synthetic upstream failure");
    };
    expect(await f.run()).toBe(mode === "held" ? "BUDGET_HELD" : "FAILED");
    expect((await sql`select reason from repository_reconciliation_jobs where repository_id = ${f.repositoryId}`)[0]!.reason).toBe("SWEEP");
    await f.enqueue("WEBHOOK");
    await sql`update repository_reconciliation_jobs set run_after = now() where repository_id = ${f.repositoryId}`;
    f.state.onVerify = async () => {};
    expect(await f.run()).toBe("RECONCILED");
    expect(f.walks).toEqual([undefined]);
  });
});
