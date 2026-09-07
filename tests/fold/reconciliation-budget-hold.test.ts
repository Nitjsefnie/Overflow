import { afterEach, describe, expect, it, vi } from "vitest";
import { createReconciliationBudgetGate } from "@/lib/fold/reconciliation-budget";
import {
  drainReconciliationJobs,
  runNextReconciliationJob,
  type ReconciliationWorkerDependencies,
  type ReconciliationWorkerStore,
} from "@/lib/fold/reconciliation-worker";
import * as budgets from "@/lib/github/rate-limit-budget";

const now = new Date("2026-09-07T10:00:00Z");
const resetAt = new Date("2026-09-07T11:00:00Z");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/fold/reconciliation-worker");
  vi.doUnmock("@/lib/fold/sweep");
  vi.doUnmock("@/lib/fold/postgres-store");
  vi.doUnmock("@/lib/fold/reconcile-as-sponsor");
});

function reading(remaining: number, observedAt = now): budgets.GitHubGraphqlBudgetReading {
  return { remaining, limit: 5000, cost: 1, resetAt, observedAt };
}

function fixture(remaining?: number) {
  const budgetStore = budgets.createGitHubGraphqlBudgetStore();
  if (remaining !== undefined) budgetStore.record(reading(remaining));
  const store = {
    claimNextReconciliationJob: vi.fn(async () => ({
      id: "job-1", repositoryId: "repository-1", reason: "SWEEP" as const,
      attemptCount: 1, leaseToken: "lease-1",
    })),
    renewReconciliationJobLease: vi.fn(async () => true),
    completeReconciliationJob: vi.fn(async () => true),
    deferReconciliationJob: vi.fn(async () => true),
    retryReconciliationJob: vi.fn(async () => true),
    failReconciliationJob: vi.fn(async () => true),
    getReconciliationCooldown: vi.fn(async () => null),
  } satisfies ReconciliationWorkerStore;
  const reconcile = vi.fn<ReconciliationWorkerDependencies["reconcile"]>(async () => {});
  const onBudgetChange = vi.fn();
  const dependencies: ReconciliationWorkerDependencies = {
    store, reconcile, onBudgetChange,
    now: () => now,
    scheduleLeaseRenewal: () => () => {},
    budget: createReconciliationBudgetGate({ store: budgetStore, reserve: 500 }),
  };
  return { budgetStore, store, reconcile, onBudgetChange, dependencies };
}

describe("reconciliation budget holds", () => {
  it("holds below the reserve before claiming or reconciling", async () => {
    const { dependencies, store, reconcile } = fixture(499);
    await expect(runNextReconciliationJob(dependencies)).resolves.toBe("BUDGET_HELD");
    expect(store.claimNextReconciliationJob).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(store.retryReconciliationJob).not.toHaveBeenCalled();
  });

  it("claims and reconciles at exactly the reserve", async () => {
    const { dependencies, store, reconcile } = fixture(500);
    await expect(runNextReconciliationJob(dependencies)).resolves.toBe("RECONCILED");
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith("repository-1");
    expect(store.completeReconciliationJob).toHaveBeenCalledWith("job-1", "lease-1");
  });

  it("claims when there has been no budget reading", async () => {
    const { dependencies, store } = fixture();
    await expect(runNextReconciliationJob(dependencies)).resolves.toBe("RECONCILED");
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(1);
  });

  it("releases a hold exactly at resetAt", async () => {
    const { dependencies, store, onBudgetChange } = fixture(0);
    await expect(runNextReconciliationJob(dependencies)).resolves.toBe("BUDGET_HELD");
    dependencies.now = () => resetAt;
    await expect(runNextReconciliationJob(dependencies)).resolves.toBe("RECONCILED");
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(1);
    expect(onBudgetChange).toHaveBeenLastCalledWith(expect.objectContaining({
      state: "UNKNOWN", changed: true,
    }));
  });

  it("keeps existing callers working without a gate", async () => {
    const { dependencies, store } = fixture(0);
    delete dependencies.budget;
    await expect(runNextReconciliationJob(dependencies)).resolves.toBe("RECONCILED");
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(1);
  });

  it("reports only entering and leaving a hold across fresh drains", async () => {
    const { dependencies, budgetStore, store, onBudgetChange } = fixture(499);
    for (let poll = 0; poll < 3; poll += 1) {
      dependencies.budget = createReconciliationBudgetGate({ store: budgetStore, reserve: 500 });
      await expect(drainReconciliationJobs(dependencies, { maxJobs: 1 })).resolves.toEqual(["BUDGET_HELD"]);
    }
    expect(onBudgetChange).toHaveBeenCalledTimes(1);
    expect(onBudgetChange).toHaveBeenLastCalledWith({
      state: "BELOW_RESERVE", reading: reading(499), reserve: 500, changed: true,
    });
    expect(store.claimNextReconciliationJob).not.toHaveBeenCalled();

    budgetStore.record(reading(1000, new Date("2026-09-07T10:01:00Z")));
    dependencies.now = () => new Date("2026-09-07T10:01:00Z");
    dependencies.budget = createReconciliationBudgetGate({ store: budgetStore, reserve: 500 });
    await expect(drainReconciliationJobs(dependencies, { maxJobs: 1 })).resolves.toEqual(["RECONCILED"]);
    await expect(drainReconciliationJobs(dependencies, { maxJobs: 1 })).resolves.toEqual(["RECONCILED"]);
    expect(onBudgetChange).toHaveBeenCalledTimes(2);
    expect(onBudgetChange).toHaveBeenLastCalledWith(expect.objectContaining({
      state: "AVAILABLE", changed: true,
    }));
  });

  it("contains and reports a throwing transition hook", async () => {
    const { dependencies, store } = fixture(499);
    const failure = new Error("reporter unavailable");
    dependencies.onBudgetChange = () => { throw failure; };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runNextReconciliationJob(dependencies)).resolves.toBe("BUDGET_HELD");
    expect(store.claimNextReconciliationJob).not.toHaveBeenCalled();
    expect(logged).toHaveBeenCalledWith(expect.any(String), failure);
  });

  it("allows an omitted transition hook", async () => {
    const { dependencies } = fixture(499);
    delete dependencies.onBudgetChange;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runNextReconciliationJob(dependencies)).resolves.toBe("BUDGET_HELD");
    expect(logged).not.toHaveBeenCalled();
  });

  it("stops a held drain after one check and includes the hold outcome", async () => {
    const { dependencies, store, reconcile } = fixture(499);
    const check = vi.spyOn(dependencies.budget!, "check");
    await expect(drainReconciliationJobs(dependencies)).resolves.toEqual(["BUDGET_HELD"]);
    expect(check).toHaveBeenCalledExactlyOnceWith(now);
    expect(store.claimNextReconciliationJob).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("stops before another claim when budget falls during the preceding fold", async () => {
    const { dependencies, budgetStore, store, reconcile } = fixture(500);
    reconcile.mockImplementation(async () => {
      budgetStore.record(reading(499, new Date("2026-09-07T10:01:00Z")));
    });
    await expect(drainReconciliationJobs(dependencies)).resolves.toEqual(["RECONCILED", "BUDGET_HELD"]);
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("defaults to the shared budget and configured reserve", async () => {
    const { dependencies, budgetStore, store } = fixture(600);
    vi.spyOn(budgets, "gitHubGraphqlBudget").mockReturnValue(budgetStore);
    vi.stubEnv("GITHUB_GRAPHQL_BUDGET_RESERVE", "700");
    dependencies.budget = createReconciliationBudgetGate();
    await expect(runNextReconciliationJob(dependencies)).resolves.toBe("BUDGET_HELD");
    expect(store.claimNextReconciliationJob).not.toHaveBeenCalled();
    expect(budgetStore.readState()).toBe("BELOW_RESERVE");
  });

  it("wires transition logs without logging every held drain", async () => {
    const { budgetStore } = fixture();
    vi.spyOn(budgets, "gitHubGraphqlBudget").mockReturnValue(budgetStore);
    vi.stubEnv("GITHUB_GRAPHQL_BUDGET_RESERVE", "500");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "");
    const startWorker = vi.fn();
    const drain = vi.fn<typeof drainReconciliationJobs>(async () => ["BUDGET_HELD"]);
    vi.doMock("@/lib/fold/reconciliation-worker", () => ({
      startReconciliationWorker: startWorker, drainReconciliationJobs: drain,
    }));
    vi.doMock("@/lib/fold/sweep", () => ({
      shouldStartReconciliationBackground: () => true,
      startReconciliationSweep: vi.fn(), sweepReconciliations: vi.fn(),
    }));
    vi.doMock("@/lib/fold/postgres-store", () => ({ PostgresFoldStore: class {} }));
    vi.doMock("@/lib/fold/reconcile-as-sponsor", () => ({ reconcileRepositoryAsSponsor: vi.fn() }));
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const informed = vi.spyOn(console, "info").mockImplementation(() => {});
    const { register } = await import("@/instrumentation");
    await register();
    const schedule = startWorker.mock.calls[0][0] as { drain(): Promise<unknown> };
    await schedule.drain();
    await schedule.drain();
    expect(informed).not.toHaveBeenCalled();

    const wired = drain.mock.calls[0][0] as ReconciliationWorkerDependencies;
    wired.onBudgetChange!(wired.budget!.check(now));
    expect(informed).not.toHaveBeenCalled();
    budgetStore.record(reading(499));
    const held = wired.budget!.check(now);
    expect(held).toMatchObject({ state: "BELOW_RESERVE", reserve: 500 });
    wired.onBudgetChange!(held);
    expect(warned).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      remaining: 499, reserve: 500, resetAt,
    });
    wired.onBudgetChange!(wired.budget!.check(resetAt));
    expect(informed).toHaveBeenCalledTimes(1);
  });
});
