import { spawnSync } from "node:child_process";
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
  it.each(["sync", "async"])("survives a %s hook when native console inspection and stream access both fail", (mode) => {
    const child = spawnSync(process.execPath, [
      "--experimental-transform-types", "--unhandled-rejections=strict",
      "--import", "./scripts/register-path-aliases.ts", "--input-type=module", "--eval", `
        import { runNextReconciliationJob } from './src/lib/fold/reconciliation-worker.ts';
        import { createReconciliationBudgetGate } from './src/lib/fold/reconciliation-budget.ts';
        import { createGitHubGraphqlBudgetStore } from './src/lib/github/rate-limit-budget.ts';
        const budgetStore = createGitHubGraphqlBudgetStore();
        budgetStore.record({ remaining: 1, limit: 5000, cost: 1,
          observedAt: new Date('2026-09-07T10:00:00Z'), resetAt: new Date('2026-09-07T11:00:00Z') });
        const nativeError = console.error;
        const stderrDescriptor = Object.getOwnPropertyDescriptor(console, '_stderr');
        let inspected = 0, streamAccesses = 0, claimed = 0, reconciled = 0;
        const failure = { [Symbol.for('nodejs.util.inspect.custom')]() {
          inspected++;
          Object.defineProperty(console, '_stderr', { configurable: true, get() {
            streamAccesses++; throw new Error('native console stream unavailable');
          }});
          throw new Error('cannot inspect hook failure');
        }};
        const fail = () => { throw failure; };
        const dependencies = {
          budget: createReconciliationBudgetGate({ store: budgetStore, reserve: 500 }),
          now: () => new Date('2026-09-07T10:00:00Z'),
          store: { async claimNextReconciliationJob() { claimed++; return null; } },
          async reconcile() { reconciled++; },
          onBudgetChange: ${mode === "async" ? "async () => { await Promise.resolve(); fail(); }" : "fail"},
        };
        const outcomes = [await runNextReconciliationJob(dependencies)];
        // Settle the async hook and its reporter, then restore the stream so
        // Node can print any unhandled rejection when this turn ends.
        await Promise.resolve();
        await Promise.resolve();
        Object.defineProperty(console, '_stderr', stderrDescriptor);
        await new Promise(resolve => setImmediate(resolve));
        outcomes.push(await runNextReconciliationJob(dependencies));
        process.stdout.write(JSON.stringify({
          outcomes, inspected, streamAccesses, claimed, reconciled,
          nativeErrorUnchanged: console.error === nativeError,
        }));
      `,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      outcomes: ["BUDGET_HELD", "BUDGET_HELD"],
      inspected: 1, streamAccesses: 1, claimed: 0, reconciled: 0,
      nativeErrorUnchanged: true,
    });
  });

  it.each(["sync", "async"])("survives a %s hook whose rejection breaks native console inspection", (mode) => {
    const child = spawnSync(process.execPath, [
      "--experimental-transform-types", "--unhandled-rejections=strict",
      "--import", "./scripts/register-path-aliases.ts", "--input-type=module", "--eval", `
        import { runNextReconciliationJob } from './src/lib/fold/reconciliation-worker.ts';
        import { createReconciliationBudgetGate } from './src/lib/fold/reconciliation-budget.ts';
        import { createGitHubGraphqlBudgetStore } from './src/lib/github/rate-limit-budget.ts';
        const store = createGitHubGraphqlBudgetStore();
        store.record({ remaining: 1, limit: 5000, cost: 1,
          observedAt: new Date('2026-09-07T10:00:00Z'), resetAt: new Date('2026-09-07T11:00:00Z') });
        let inspected = 0, claimed = 0, reconciled = 0;
        const failure = { [Symbol.for('nodejs.util.inspect.custom')]() {
          inspected++; throw new Error('cannot inspect hook failure');
        }};
        const fail = () => { throw failure; };
        const dependencies = {
          budget: createReconciliationBudgetGate({ store, reserve: 500 }),
          now: () => new Date('2026-09-07T10:00:00Z'),
          store: { async claimNextReconciliationJob() { claimed++; return null; } },
          async reconcile() { reconciled++; },
          onBudgetChange: ${mode === "async" ? "async () => { await Promise.resolve(); fail(); }" : "fail"},
        };
        const outcomes = [await runNextReconciliationJob(dependencies)];
        await new Promise(resolve => setImmediate(resolve));
        outcomes.push(await runNextReconciliationJob(dependencies));
        process.stdout.write(JSON.stringify({ outcomes, inspected, claimed, reconciled }));
      `,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      outcomes: ["BUDGET_HELD", "BUDGET_HELD"], inspected: 1, claimed: 0, reconciled: 0,
    });
    expect(child.stderr).toContain("Reconciliation budget transition hook failed");
  });

  it("contains failure of the primitive-only reporting fallback too", async () => {
    const { dependencies, store, reconcile } = fixture(499);
    dependencies.onBudgetChange = () => { throw new Error("hook failed"); };
    const logged = vi.spyOn(console, "error").mockImplementation(() => { throw new Error("console failed"); });
    await expect(runNextReconciliationJob(dependencies)).resolves.toBe("BUDGET_HELD");
    await expect(runNextReconciliationJob(dependencies)).resolves.toBe("BUDGET_HELD");
    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged.mock.calls[1]).toEqual(["Reconciliation budget transition hook failed"]);
    expect(store.claimNextReconciliationJob).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each(["budget getter", "check getter", "check call", "state getter"])(
    "continues consecutive polls after an unreadable %s",
    async (boundary) => {
      const { dependencies, store, reconcile } = fixture();
      const fault = vi.fn(() => { throw new Error(boundary); });
      if (boundary === "budget getter") Object.defineProperty(dependencies, "budget", { get: fault });
      if (boundary === "check getter") Object.defineProperty(dependencies.budget!, "check", { get: fault });
      if (boundary === "check call") dependencies.budget = { check: fault };
      if (boundary === "state getter") dependencies.budget = {
        check: () => Object.defineProperty({
          state: "UNKNOWN" as const, reading: null, reserve: 500, changed: false,
        }, "state", { get: fault }),
      };
      for (let poll = 0; poll < 2; poll += 1) {
        await expect(runNextReconciliationJob(dependencies)).resolves.toBe("RECONCILED");
      }
      expect(fault).toHaveBeenCalledTimes(2);
      expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledTimes(2);
    },
  );

  it("retrieves the budget member once per poll", async () => {
    const { dependencies } = fixture(499);
    const gate = dependencies.budget;
    const acquired = vi.fn(() => gate);
    Object.defineProperty(dependencies, "budget", { get: acquired });
    await expect(runNextReconciliationJob(dependencies)).resolves.toBe("BUDGET_HELD");
    expect(acquired).toHaveBeenCalledTimes(1);
  });

  it.each(["read getter", "read call", "resetAt getter", "remaining getter"])(
    "normalizes an unreadable assessment at %s and continues polls",
    async (boundary) => {
      const { dependencies, budgetStore, store, reconcile, onBudgetChange } = fixture(499);
      const fault = vi.fn(() => { throw new Error(boundary); });
      if (boundary === "read getter") Object.defineProperty(budgetStore, "read", { get: fault });
      if (boundary === "read call") budgetStore.read = fault;
      if (boundary === "resetAt getter" || boundary === "remaining getter") {
        Object.defineProperty(budgetStore.read()!, boundary.split(" ")[0], { get: fault });
      }
      for (let poll = 0; poll < 2; poll += 1) {
        await expect(runNextReconciliationJob(dependencies)).resolves.toBe("RECONCILED");
      }
      expect(fault).toHaveBeenCalledTimes(2);
      expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(onBudgetChange).toHaveBeenCalledExactlyOnceWith({
        state: "UNKNOWN", reading: null, reserve: 500, changed: true,
      });
    },
  );

  it.each(["noteState getter", "noteState call", "changed getter"])(
    "preserves a low assessment when %s fails and continues held polls",
    async (boundary) => {
      const { dependencies, budgetStore, store, reconcile } = fixture(499);
      const fault = vi.fn(() => { throw new Error(boundary); });
      if (boundary === "noteState getter") Object.defineProperty(budgetStore, "noteState", { get: fault });
      if (boundary === "noteState call") budgetStore.noteState = fault;
      if (boundary === "changed getter") dependencies.budget = {
        check: () => Object.defineProperty({
          state: "BELOW_RESERVE" as const, reading: reading(499), reserve: 500, changed: false,
        }, "changed", { get: fault }),
      };
      for (let poll = 0; poll < 2; poll += 1) {
        await expect(runNextReconciliationJob(dependencies)).resolves.toBe("BUDGET_HELD");
      }
      expect(fault).toHaveBeenCalledTimes(2);
      expect(store.claimNextReconciliationJob).not.toHaveBeenCalled();
      expect(reconcile).not.toHaveBeenCalled();
    },
  );

  it.each(["store option", "reserve option", "shared-store default", "reserve default"])(
    "contains factory acquisition failure at %s and retries on the next poll",
    async (boundary) => {
      const { dependencies, store, reconcile } = fixture();
      const fault = vi.fn(() => { throw new Error(boundary); });
      const options = {};
      if (boundary === "store option") Object.defineProperty(options, "store", { get: fault });
      if (boundary === "reserve option") Object.defineProperty(options, "reserve", { get: fault });
      if (boundary === "shared-store default") vi.spyOn(budgets, "gitHubGraphqlBudget").mockImplementation(fault);
      if (boundary === "reserve default") vi.spyOn(budgets, "readGraphqlBudgetReserve").mockImplementation(fault);
      dependencies.budget = createReconciliationBudgetGate(options);
      for (let poll = 0; poll < 2; poll += 1) {
        await expect(runNextReconciliationJob(dependencies)).resolves.toBe("RECONCILED");
      }
      expect(fault).toHaveBeenCalledTimes(2);
      expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledTimes(2);
    },
  );

  it("contains the real shared-store assignment failure during factory acquisition", async () => {
    const key = Symbol.for("overflow.github.graphql-budget");
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    const fault = vi.fn(() => { throw new Error("shared store cannot be assigned"); });
    Object.defineProperty(globalThis, key, { configurable: true, get: () => undefined, set: fault });
    try {
      const { dependencies, store, reconcile } = fixture();
      dependencies.budget = createReconciliationBudgetGate();
      for (let poll = 0; poll < 2; poll += 1) {
        await expect(runNextReconciliationJob(dependencies)).resolves.toBe("RECONCILED");
      }
      expect(fault).toHaveBeenCalledTimes(2);
      expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it("contains acquisition of process.env before reading the default reserve", () => {
    const previous = Object.getOwnPropertyDescriptor(process, "env")!;
    const fault = vi.fn(() => { throw new Error("environment unavailable"); });
    let check;
    try {
      Object.defineProperty(process, "env", { configurable: true, get: fault });
      check = createReconciliationBudgetGate({ store: budgets.createGitHubGraphqlBudgetStore() }).check(now);
    } finally {
      Object.defineProperty(process, "env", previous);
    }
    expect(check).toMatchObject({ state: "UNKNOWN", reading: null });
    expect(fault).toHaveBeenCalledTimes(1);
  });

  it("keeps a queue-store claim failure outside budget containment", async () => {
    const { dependencies, store, reconcile } = fixture();
    const failure = new Error("queue unavailable");
    store.claimNextReconciliationJob.mockRejectedValue(failure);
    await expect(runNextReconciliationJob(dependencies)).rejects.toBe(failure);
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
  });

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
    const { budgetStore, dependencies, store, reconcile } = fixture();
    vi.spyOn(budgets, "gitHubGraphqlBudget").mockReturnValue(budgetStore);
    vi.stubEnv("GITHUB_GRAPHQL_BUDGET_RESERVE", "500");
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "");
    const startWorker = vi.fn();
    const drain = vi.fn<typeof drainReconciliationJobs>(async (wired) => drainReconciliationJobs({
      ...wired, store, reconcile,
      now: dependencies.now,
      scheduleLeaseRenewal: dependencies.scheduleLeaseRenewal,
    }, { maxJobs: 1 }));
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
    await expect(schedule.drain()).resolves.toEqual(["RECONCILED"]);
    expect(informed).toHaveBeenCalledExactlyOnceWith("Reconciliation drain", { RECONCILED: 1 });
    informed.mockClear();
    budgetStore.record(reading(499));
    for (let poll = 0; poll < 3; poll += 1) {
      await expect(schedule.drain()).resolves.toEqual(["BUDGET_HELD"]);
    }
    expect(informed).not.toHaveBeenCalled();
    expect(warned).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      remaining: 499, reserve: 500, resetAt,
    });
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledTimes(1);

    const recoveredAt = new Date("2026-09-07T10:01:00Z");
    budgetStore.record(reading(700, recoveredAt));
    dependencies.now = () => recoveredAt;
    for (let poll = 0; poll < 3; poll += 1) {
      await expect(schedule.drain()).resolves.toEqual(["RECONCILED"]);
    }
    expect(informed.mock.calls.filter(([message]) =>
      message === "Reconciliation GraphQL budget hold cleared",
    )).toEqual([["Reconciliation GraphQL budget hold cleared", { state: "AVAILABLE" }]]);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(4);
    expect(reconcile).toHaveBeenCalledTimes(4);
  });
});
