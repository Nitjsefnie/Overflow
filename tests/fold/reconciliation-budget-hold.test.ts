import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReconciliationBudgetGate } from "@/lib/fold/reconciliation-budget";
import { reconcileRepository, type ReconciliationDependencies } from "@/lib/fold/reconcile";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import {
  drainReconciliationJobs,
  runNextReconciliationJob,
  type ReconciliationWorkerDependencies,
  type ReconciliationWorkerStore,
} from "@/lib/fold/reconciliation-worker";
import * as budgets from "@/lib/github/rate-limit-budget";
import { GitHubGateway } from "@/lib/github/client";

const now = new Date("2026-09-07T10:00:00Z");
const resetAt = new Date("2026-09-07T11:00:00Z");
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs();
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
  if (remaining !== undefined) budgetStore.record("sponsor-1", reading(remaining));
  const store = {
    claimNextReconciliationJob: vi.fn(async () => ({
      id: "job-1", repositoryId: "repository-1", reason: "SWEEP" as const,
      attemptCount: 1, leaseToken: "lease-1", rederivationRequestedAt: null,
    })),
    renewReconciliationJobLease: vi.fn(async () => true),
    completeReconciliationJob: vi.fn<ReconciliationWorkerStore["completeReconciliationJob"]>(async () => true),
    deferReconciliationJob: vi.fn(async () => true),
    retryReconciliationJob: vi.fn(async () => true),
    failReconciliationJob: vi.fn(async () => true),
    getReconciliationCooldown: vi.fn(async () => null),
  } satisfies ReconciliationWorkerStore;
  // This spy observes admitted GitHub work; every test goes through the real fold.
  const reconcile = vi.fn<ReconciliationDependencies["github"]["getRepositoryById"]>(async () => null);
  const onBudgetChange = vi.fn();
  const fold: ReconciliationDependencies = {
    store: {
      withRepositoryReconciliation: async (_id, work) => work(),
      getRepository: async () => ({ id: "repository-1", githubRepositoryId: 4242, ownerName: "octo/overflow",
        registeredAt: "2026-09-07T09:00:00Z", active: true, difficultyScheme: validDifficultyScheme(),
        sponsor: { id: "sponsor-1", githubUserId: 1, githubLogin: "octo", enforcementState: "ACTIVE" } }),
      getReconciliationCooldown: async () => null,
      setReconciliationCooldown: async () => {},
      getGitHubAccessToken: async () => "test-token",
      beginRun: vi.fn(async () => "run-1"), completeRun: async () => {},
      findUsersByGitHubUserIds: async () => [],
      materialize: async () => ({ adds: 0, changes: 0, removals: 0 }),
      failRun: async () => {}, recordVerifiedRepositoryIdentity: async () => {}, markRepositoryUnavailable: async () => {},
    },
    github: { getRepositoryById: reconcile, listIssues: async () => [],
      getPullRequestReviews: async () => [], getPullRequestDiff: async () => "" },
    onBudgetChange, now: () => now,
    budget: createReconciliationBudgetGate({ store: budgetStore, reserve: 500 }),
  };
  const worker: ReconciliationWorkerDependencies = {
    store, reconcile: (id) => reconcileRepository(fold, id),
    now: () => fold.now!(), scheduleLeaseRenewal: () => () => {},
  };
  return { budgetStore, store, reconcile, onBudgetChange, fold, worker };
}

describe("reconciliation budget holds under the repository lock", () => {
  it.each(["expired verdict", "exact reset", "unrepresentable default reading"])(
    "admits a due job with an unusable deadline from %s", async (fault) => {
      const { fold, worker, budgetStore, reconcile, onBudgetChange } = fixture(42);
      const reset = fault === "exact reset" ? now : new Date("2026-09-07T09:00:00Z");
      if (fault === "unrepresentable default reading") {
        const hostileDate = new Date(resetAt);
        hostileDate.getTime = vi.fn(() => Number.MAX_VALUE);
        budgetStore.record("sponsor-1", { ...reading(42), resetAt: hostileDate });
        vi.spyOn(budgets, "gitHubGraphqlBudget").mockReturnValue(budgetStore);
        delete fold.budget;
      } else {
        fold.budget = { check: vi.fn(() => ({ owner: "sponsor-1", state: "BELOW_RESERVE" as const,
          reading: { ...reading(42), resetAt: reset }, reserve: 500, changed: true })) };
      }
      // Model due-time selection, lease release and attempt refund. A past hold
      // immediately reclaims this job; an invalid date fails the deferral write.
      let state = "PENDING";
      let runAfter = now;
      let attempts = 0;
      const claim = vi.fn<ReconciliationWorkerStore["claimNextReconciliationJob"]>(async () => {
        if (state !== "PENDING" || runAfter.getTime() > now.getTime()) return null;
        state = "RUNNING";
        attempts++;
        return { id: "job-1", repositoryId: "repository-1", reason: "SWEEP", attemptCount: attempts, leaseToken: "lease-1", rederivationRequestedAt: null };
      });
      const defer = vi.fn<ReconciliationWorkerStore["deferReconciliationJob"]>(async (_id, _lease, deadline) => {
        deadline.toISOString();
        runAfter = deadline;
        state = "PENDING";
        attempts--;
        return true;
      });
      worker.store = { ...worker.store, claimNextReconciliationJob: claim, deferReconciliationJob: defer,
        completeReconciliationJob: vi.fn<ReconciliationWorkerStore["completeReconciliationJob"]>(async () => { state = "COMPLETED"; return true; }) };
      const clock = vi.fn(() => now);
      fold.now = clock;
      await expect(drainReconciliationJobs(worker, { maxJobs: 3 })).resolves.toEqual(["RECONCILED"]);
      expect(state).toBe("COMPLETED");
      expect(attempts).toBe(1);
      expect(defer).not.toHaveBeenCalled();
      expect(reconcile).toHaveBeenCalledTimes(1);
      expect(worker.store.retryReconciliationJob).not.toHaveBeenCalled();
      expect(onBudgetChange).toHaveBeenCalledExactlyOnceWith({
        owner: "sponsor-1", state: "UNKNOWN", reading: null, reserve: 500, changed: true,
      });
    },
  );

  it.each(["null result", "non-callable check"])("contains native admission TypeError from %s in strict Node", (mode) => {
    const child = spawnSync(process.execPath, [
      "--experimental-transform-types", "--unhandled-rejections=strict",
      "--import", "./scripts/register-path-aliases.ts", "--input-type=module", "--eval", `
        import { reconciliationBudgetHoldUntil } from './src/lib/fold/reconciliation-budget.ts';
        let hookCalls = 0, observations = 0;
        const dependencies = {
          budget: { get check() {
            ${mode === "null result" ? "return () => { observations++; return null; };" : "observations++; return 42;"}
          } },
          onBudgetChange() { hookCalls++; },
        };
        const now = () => new Date('2026-09-07T10:00:00Z');
        const outcomes = [reconciliationBudgetHoldUntil(dependencies, 'sponsor-1', now),
          reconciliationBudgetHoldUntil(dependencies, 'sponsor-1', now)];
        await new Promise(resolve => setImmediate(resolve));
        process.stdout.write(JSON.stringify({ outcomes, hookCalls, observations }));
      `,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ outcomes: [null, null], hookCalls: 0, observations: 2 });
  });

  it.each([
    { mode: "sync", brokenStream: false }, { mode: "async", brokenStream: false },
    { mode: "sync", brokenStream: true }, { mode: "async", brokenStream: true },
  ])("preserves admission under $mode hook inspection failure (stream fault: $brokenStream)", ({ mode, brokenStream }) => {
    const child = spawnSync(process.execPath, [
      "--no-warnings", "--experimental-transform-types", "--unhandled-rejections=strict",
      "--import", "./scripts/register-path-aliases.ts", "--input-type=module", "--eval", `
        import { reconciliationBudgetHoldUntil, createReconciliationBudgetGate } from './src/lib/fold/reconciliation-budget.ts';
        import { createGitHubGraphqlBudgetStore } from './src/lib/github/rate-limit-budget.ts';
        const store = createGitHubGraphqlBudgetStore();
        store.record('sponsor-1', { remaining: 1, limit: 5000, cost: 1,
          observedAt: new Date('2026-09-07T10:00:00Z'), resetAt: new Date('2026-09-07T11:00:00Z') });
        const nativeError = console.error;
        const stderrDescriptor = Object.getOwnPropertyDescriptor(console, '_stderr');
        let inspected = 0, streamAccesses = 0;
        const failure = { [Symbol.for('nodejs.util.inspect.custom')]() {
          inspected++;
          if (${brokenStream}) Object.defineProperty(console, '_stderr', { configurable: true, get() {
            streamAccesses++; throw new Error('native console stream unavailable');
          }});
          throw new Error('cannot inspect hook failure');
        }};
        const fail = () => { throw failure; };
        const dependencies = {
          budget: createReconciliationBudgetGate({ store, reserve: 500 }),
          onBudgetChange: ${mode === "async" ? "async () => { await Promise.resolve(); fail(); }" : "fail"},
        };
        const now = () => new Date('2026-09-07T10:00:00Z');
        const outcomes = [reconciliationBudgetHoldUntil(dependencies, 'sponsor-1', now)];
        await Promise.resolve(); await Promise.resolve();
        Object.defineProperty(console, '_stderr', stderrDescriptor);
        await new Promise(resolve => setImmediate(resolve));
        outcomes.push(reconciliationBudgetHoldUntil(dependencies, 'sponsor-1', now));
        process.stdout.write(JSON.stringify({ outcomes, inspected, streamAccesses, nativeErrorUnchanged: console.error === nativeError }));
      `,
    ], { cwd: process.cwd(), encoding: "utf8", timeout: 10_000 });
    expect(child.error).toBeUndefined();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({
      outcomes: [resetAt.toISOString(), resetAt.toISOString()], inspected: 1,
      streamAccesses: brokenStream ? 1 : 0, nativeErrorUnchanged: true,
    });
    if (!brokenStream) {
      expect(child.stderr.trim()).not.toBe("");
      expect(child.stderr.trim().split("\n")).toHaveLength(1);
    }
  });

  it("contains failure of the primitive-only reporting fallback too", async () => {
    const { fold, store, reconcile, worker } = fixture(499);
    fold.onBudgetChange = () => { throw new Error("hook failed"); };
    const logged = vi.spyOn(console, "error").mockImplementation(() => { throw new Error("console failed"); });
    await expect(runNextReconciliationJob(worker)).resolves.toBe("BUDGET_HELD");
    await expect(runNextReconciliationJob(worker)).resolves.toBe("BUDGET_HELD");
    expect(logged).toHaveBeenCalledTimes(2);
    expect(logged.mock.calls[0]).toEqual([expect.any(String), expect.any(Error)]);
    expect(logged.mock.calls[1]).toEqual([expect.any(String)]);
    expect(store.deferReconciliationJob).toHaveBeenCalledWith("job-1", "lease-1", resetAt);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it.each(["budget getter", "check getter", "check call", "state getter"])(
    "continues consecutive polls after an unreadable %s",
    async (boundary) => {
      const { fold, store, reconcile, worker } = fixture();
      const fault = vi.fn(() => { throw new Error(boundary); });
      if (boundary === "budget getter") Object.defineProperty(fold, "budget", { get: fault });
      if (boundary === "check getter") Object.defineProperty(fold.budget!, "check", { get: fault });
      if (boundary === "check call") fold.budget = { check: fault };
      if (boundary === "state getter") fold.budget = {
        check: () => Object.defineProperty({
          owner: "sponsor-1", state: "UNKNOWN" as const, reading: null, reserve: 500, changed: false,
        }, "state", { get: fault }),
      };
      for (let poll = 0; poll < 2; poll += 1) {
        await expect(runNextReconciliationJob(worker)).resolves.toBe("RECONCILED");
      }
      expect(fault).toHaveBeenCalledTimes(2);
      expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledTimes(2);
    },
  );

  it("retrieves the budget member once per poll", async () => {
    const { fold, worker } = fixture(499);
    const gate = fold.budget;
    const acquired = vi.fn(() => gate);
    Object.defineProperty(fold, "budget", { get: acquired });
    await expect(runNextReconciliationJob(worker)).resolves.toBe("BUDGET_HELD");
    expect(acquired).toHaveBeenCalledTimes(1);
  });

  it.each(["read getter", "read call", "resetAt getter", "remaining getter"])(
    "normalizes an unreadable assessment at %s and continues polls",
    async (boundary) => {
      const { budgetStore, store, reconcile, onBudgetChange, worker } = fixture(499);
      const fault = vi.fn(() => { throw new Error(boundary); });
      if (boundary === "read getter") Object.defineProperty(budgetStore, "read", { get: fault });
      if (boundary === "read call") budgetStore.read = fault;
      if (boundary === "resetAt getter" || boundary === "remaining getter") {
        Object.defineProperty(budgetStore.read("sponsor-1")!, boundary.split(" ")[0], { get: fault });
      }
      for (let poll = 0; poll < 2; poll += 1) {
        await expect(runNextReconciliationJob(worker)).resolves.toBe("RECONCILED");
      }
      expect(fault).toHaveBeenCalledTimes(2);
      expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledTimes(2);
      expect(onBudgetChange).toHaveBeenCalledExactlyOnceWith({
        owner: "sponsor-1", state: "UNKNOWN", reading: null, reserve: 500, changed: true,
      });
    },
  );

  it.each(["noteState getter", "noteState call", "changed getter"])(
    "preserves a low assessment when %s fails and continues held polls",
    async (boundary) => {
      const { fold, budgetStore, store, reconcile, worker } = fixture(499);
      const fault = vi.fn(() => { throw new Error(boundary); });
      if (boundary === "noteState getter") Object.defineProperty(budgetStore, "noteState", { get: fault });
      if (boundary === "noteState call") budgetStore.noteState = fault;
      if (boundary === "changed getter") fold.budget = {
        check: () => Object.defineProperty({
          owner: "sponsor-1", state: "BELOW_RESERVE" as const, reading: reading(499), reserve: 500, changed: false,
        }, "changed", { get: fault }),
      };
      for (let poll = 0; poll < 2; poll += 1) {
        await expect(runNextReconciliationJob(worker)).resolves.toBe("BUDGET_HELD");
      }
      expect(fault).toHaveBeenCalledTimes(2);
      expect(store.deferReconciliationJob).toHaveBeenCalledWith("job-1", "lease-1", resetAt);
      expect(reconcile).not.toHaveBeenCalled();
    },
  );

  it.each(["store option", "reserve option", "shared-store default", "reserve default"])(
    "contains factory acquisition failure at %s and retries on the next poll",
    async (boundary) => {
      const { fold, store, reconcile, worker } = fixture();
      const fault = vi.fn(() => { throw new Error(boundary); });
      const options = {};
      if (boundary === "store option") Object.defineProperty(options, "store", { get: fault });
      if (boundary === "reserve option") Object.defineProperty(options, "reserve", { get: fault });
      if (boundary === "shared-store default") vi.spyOn(budgets, "gitHubGraphqlBudget").mockImplementation(fault);
      if (boundary === "reserve default") vi.spyOn(budgets, "readGraphqlBudgetReserve").mockImplementation(fault);
      fold.budget = createReconciliationBudgetGate(options);
      for (let poll = 0; poll < 2; poll += 1) {
        await expect(runNextReconciliationJob(worker)).resolves.toBe("RECONCILED");
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
      const { fold, store, reconcile, worker } = fixture();
      fold.budget = createReconciliationBudgetGate();
      for (let poll = 0; poll < 2; poll += 1) {
        await expect(runNextReconciliationJob(worker)).resolves.toBe("RECONCILED");
      }
      expect(fault).toHaveBeenCalledTimes(2);
      expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(2);
      expect(reconcile).toHaveBeenCalledTimes(2);
    } finally {
      if (previous) Object.defineProperty(globalThis, key, previous);
      else Reflect.deleteProperty(globalThis, key);
    }
  });

  it("reaches GitHub through the real gateway when the shared observer is broken and later recovers", async () => {
    const key = Symbol.for("overflow.github.graphql-budget");
    const previous = Object.getOwnPropertyDescriptor(globalThis, key);
    const fault = vi.fn(() => { throw new Error("shared store cannot be assigned"); });
    Object.defineProperty(globalThis, key, { configurable: true, get: () => undefined, set: fault });
    const request = vi.fn(async () => Response.json({ data: {
      rateLimit: { remaining: 499, limit: 5000, cost: 1, resetAt: resetAt.toISOString() },
      repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } },
    } }));
    try {
      const { fold, store, reconcile, worker } = fixture();
      fold.budget = createReconciliationBudgetGate();
      let gateway: GitHubGateway | undefined;
      const results: unknown[] = [];
      reconcile.mockImplementation(async () => {
        gateway ??= new GitHubGateway({ owner: "sponsor-1", accessToken: "test-token", fetch: request });
        results.push(await gateway.listIssues({ owner: "octo", name: "overflow" }));
        return null;
      });
      await expect(runNextReconciliationJob(worker)).resolves.toBe("RECONCILED");
      expect(request).toHaveBeenCalledTimes(1);
      expect(fault).toHaveBeenCalledTimes(2);

      Reflect.deleteProperty(globalThis, key);
      await expect(runNextReconciliationJob(worker)).resolves.toBe("RECONCILED");
      expect(request).toHaveBeenCalledTimes(2);
      expect(results).toEqual([[], []]);
      expect(budgets.gitHubGraphqlBudget().read("sponsor-1")).toMatchObject({ remaining: 499, resetAt });
      await expect(runNextReconciliationJob(worker)).resolves.toBe("BUDGET_HELD");
      expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(3);
      expect(store.completeReconciliationJob).toHaveBeenCalledTimes(2);
      expect(store.retryReconciliationJob).not.toHaveBeenCalled();
      expect(request).toHaveBeenCalledTimes(2);
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
      check = createReconciliationBudgetGate({ store: budgets.createGitHubGraphqlBudgetStore() }).check("sponsor-1", now);
    } finally {
      Object.defineProperty(process, "env", previous);
    }
    expect(check).toMatchObject({ state: "UNKNOWN", reading: null });
    expect(fault).toHaveBeenCalledTimes(1);
  });

  it("keeps a queue-store claim failure outside budget containment", async () => {
    const { store, reconcile, worker } = fixture();
    const failure = new Error("queue unavailable");
    store.claimNextReconciliationJob.mockRejectedValue(failure);
    await expect(runNextReconciliationJob(worker)).rejects.toBe(failure);
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(1);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("defers a claimed job below the reserve without starting a run or reaching GitHub", async () => {
    const { fold, store, reconcile, worker } = fixture(499);
    await expect(runNextReconciliationJob(worker)).resolves.toBe("BUDGET_HELD");
    expect(store.deferReconciliationJob).toHaveBeenCalledWith("job-1", "lease-1", resetAt);
    expect(reconcile).not.toHaveBeenCalled();
    expect(store.retryReconciliationJob).not.toHaveBeenCalled();
    expect(fold.store.beginRun).not.toHaveBeenCalled();
  });

  it("claims and reconciles at exactly the reserve", async () => {
    const { store, reconcile, worker } = fixture(500);
    await expect(runNextReconciliationJob(worker)).resolves.toBe("RECONCILED");
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenCalledWith(4242);
    expect(store.completeReconciliationJob).toHaveBeenCalledWith("job-1", "lease-1", null);
  });

  it("claims when there has been no budget reading", async () => {
    const { store, worker } = fixture();
    await expect(runNextReconciliationJob(worker)).resolves.toBe("RECONCILED");
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(1);
  });

  it("releases a hold exactly at resetAt", async () => {
    const { fold, store, onBudgetChange, worker } = fixture(0);
    await expect(runNextReconciliationJob(worker)).resolves.toBe("BUDGET_HELD");
    fold.now = () => resetAt;
    await expect(runNextReconciliationJob(worker)).resolves.toBe("RECONCILED");
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(2);
    expect(onBudgetChange).toHaveBeenLastCalledWith(expect.objectContaining({
      state: "UNKNOWN", changed: true,
    }));
  });

  it("holds on a low default observation when no gate is injected", async () => {
    const { fold, store, budgetStore, worker } = fixture(42);
    vi.spyOn(budgets, "gitHubGraphqlBudget").mockReturnValue(budgetStore);
    const read = vi.spyOn(budgetStore, "read");
    delete fold.budget;
    await expect(runNextReconciliationJob(worker)).resolves.toBe("BUDGET_HELD");
    expect(read).toHaveBeenCalledExactlyOnceWith("sponsor-1");
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(1);
    expect(store.deferReconciliationJob).toHaveBeenCalledExactlyOnceWith("job-1", "lease-1", resetAt);
  });

  it("reports only entering and leaving a hold across fresh drains", async () => {
    const { fold, budgetStore, store, onBudgetChange, worker } = fixture(499);
    for (let poll = 0; poll < 3; poll += 1) {
      fold.budget = createReconciliationBudgetGate({ store: budgetStore, reserve: 500 });
      await expect(drainReconciliationJobs(worker, { maxJobs: 1 })).resolves.toEqual(["BUDGET_HELD"]);
    }
    expect(onBudgetChange).toHaveBeenCalledTimes(1);
    expect(onBudgetChange).toHaveBeenLastCalledWith({
      owner: "sponsor-1", state: "BELOW_RESERVE", reading: reading(499), reserve: 500, changed: true,
    });
    expect(store.deferReconciliationJob).toHaveBeenCalledWith("job-1", "lease-1", resetAt);

    budgetStore.record("sponsor-1", { ...reading(1000, new Date("2026-09-07T11:01:00Z")),
      resetAt: new Date("2026-09-07T12:00:00Z") });
    fold.now = () => new Date("2026-09-07T11:01:00Z");
    fold.budget = createReconciliationBudgetGate({ store: budgetStore, reserve: 500 });
    await expect(drainReconciliationJobs(worker, { maxJobs: 1 })).resolves.toEqual(["RECONCILED"]);
    await expect(drainReconciliationJobs(worker, { maxJobs: 1 })).resolves.toEqual(["RECONCILED"]);
    expect(onBudgetChange).toHaveBeenCalledTimes(2);
    expect(onBudgetChange).toHaveBeenLastCalledWith(expect.objectContaining({
      state: "AVAILABLE", changed: true,
    }));
  });

  it("contains and reports a throwing transition hook", async () => {
    const { fold, store, worker } = fixture(499);
    const failure = new Error("reporter unavailable");
    fold.onBudgetChange = () => { throw failure; };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runNextReconciliationJob(worker)).resolves.toBe("BUDGET_HELD");
    expect(store.deferReconciliationJob).toHaveBeenCalledWith("job-1", "lease-1", resetAt);
    expect(logged).toHaveBeenCalledWith(expect.any(String), failure);
  });

  it("allows an omitted transition hook", async () => {
    const { fold, worker } = fixture(499);
    delete fold.onBudgetChange;
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(runNextReconciliationJob(worker)).resolves.toBe("BUDGET_HELD");
    expect(logged).not.toHaveBeenCalled();
  });

  it("continues a drain after a held job and records the deferral", async () => {
    const { fold, worker, store, reconcile } = fixture(499);
    const check = vi.spyOn(fold.budget!, "check");
    await expect(drainReconciliationJobs(worker, { maxJobs: 2 })).resolves.toEqual(["BUDGET_HELD", "BUDGET_HELD"]);
    expect(check).toHaveBeenNthCalledWith(1, "sponsor-1", now);
    expect(check).toHaveBeenCalledTimes(2);
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(2);
    expect(store.deferReconciliationJob).toHaveBeenCalledTimes(2);
    expect(reconcile).not.toHaveBeenCalled();
  });

  it("defers the next claimed repository when its budget falls during the preceding fold", async () => {
    const { fold, worker, budgetStore, store, reconcile } = fixture(500);
    const first = { id: "job-1", repositoryId: "repository-1", reason: "SWEEP" as const,
      attemptCount: 1, leaseToken: "lease-1", rederivationRequestedAt: null };
    store.claimNextReconciliationJob.mockResolvedValueOnce(first).mockResolvedValueOnce({ ...first,
      id: "job-2", repositoryId: "repository-2", leaseToken: "lease-2" });
    const repository = (await fold.store.getRepository("repository-1"))!;
    const getRepository = vi.fn(async (id: string) => ({ ...repository, id,
      githubRepositoryId: id === "repository-1" ? 4242 : 4243 }));
    fold.store.getRepository = getRepository;
    reconcile.mockImplementation(async () => {
      budgetStore.record("sponsor-1", reading(499, new Date("2026-09-07T10:01:00Z")));
      return null;
    });
    await expect(drainReconciliationJobs(worker, { maxJobs: 2 })).resolves.toEqual(["RECONCILED", "BUDGET_HELD"]);
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(2);
    expect(store.deferReconciliationJob).toHaveBeenCalledExactlyOnceWith("job-2", "lease-2", resetAt);
    expect(getRepository).toHaveBeenNthCalledWith(1, "repository-1");
    expect(getRepository).toHaveBeenNthCalledWith(2, "repository-2");
    expect(fold.store.beginRun).toHaveBeenCalledExactlyOnceWith("repository-1");
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it("defaults to the shared budget and configured reserve", async () => {
    const { fold, budgetStore, store, worker } = fixture(600);
    vi.spyOn(budgets, "gitHubGraphqlBudget").mockReturnValue(budgetStore);
    vi.stubEnv("GITHUB_GRAPHQL_BUDGET_RESERVE", "700");
    fold.budget = createReconciliationBudgetGate();
    await expect(runNextReconciliationJob(worker)).resolves.toBe("BUDGET_HELD");
    expect(store.deferReconciliationJob).toHaveBeenCalledWith("job-1", "lease-1", resetAt);
    expect(budgetStore.readState("sponsor-1")).toBe("BELOW_RESERVE");
  });

  it("logs per-owner transitions once while journaling each claimed deferral", async () => {
    const { budgetStore, fold, worker, store } = fixture();
    delete fold.onBudgetChange;
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const informed = vi.spyOn(console, "info").mockImplementation(() => {});
    await expect(runNextReconciliationJob(worker)).resolves.toBe("RECONCILED");
    expect(informed).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      owner: "sponsor-1", state: "UNKNOWN", remaining: undefined, reserve: 500, resetAt: undefined,
    });
    informed.mockClear();
    budgetStore.record("sponsor-1", reading(499));
    for (let pass = 0; pass < 3; pass += 1) {
      await expect(runNextReconciliationJob(worker)).resolves.toBe("BUDGET_HELD");
    }
    expect(warned).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      owner: "sponsor-1", state: "BELOW_RESERVE", remaining: 499, reserve: 500, resetAt,
    });
    expect(informed).not.toHaveBeenCalled();
    expect(store.deferReconciliationJob).toHaveBeenCalledTimes(3);
    fold.now = () => resetAt;
    await expect(runNextReconciliationJob(worker)).resolves.toBe("RECONCILED");
    expect(informed).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      owner: "sponsor-1", state: "UNKNOWN", remaining: 499, reserve: 500, resetAt,
    });
  });
  it("summarizes injected worker outcomes and stays silent for an idle drain", async () => {
    const { fold, worker, store } = fixture(42);
    const startWorker = vi.fn();
    vi.doMock("@/lib/fold/reconciliation-worker", () => ({
      startReconciliationWorker: startWorker,
      drainReconciliationJobs: () => drainReconciliationJobs(worker, { maxJobs: 1 }),
    }));
    vi.doMock("@/lib/fold/sweep", () => ({ shouldStartReconciliationBackground: () => true,
      startReconciliationSweep: vi.fn(), sweepReconciliations: vi.fn() }));
    vi.doMock("@/lib/fold/postgres-store", () => ({ PostgresFoldStore: class {} }));
    vi.doMock("@/lib/fold/reconcile-as-sponsor", () => ({ reconcileRepositoryAsSponsor: vi.fn() }));
    const informed = vi.spyOn(console, "info").mockImplementation(() => {});
    const { register } = await import("@/instrumentation");
    await register();
    const schedule = startWorker.mock.calls[0][0] as { drain(): Promise<unknown> };
    await expect(schedule.drain()).resolves.toEqual(["BUDGET_HELD"]);
    expect(informed).toHaveBeenCalledExactlyOnceWith(expect.any(String), { BUDGET_HELD: 1 });
    expect(store.deferReconciliationJob).toHaveBeenCalledExactlyOnceWith("job-1", "lease-1", resetAt);
    expect(fold.store.beginRun).not.toHaveBeenCalled();
    informed.mockClear();
    worker.store = { ...store, claimNextReconciliationJob: vi.fn(async () => null) };
    await expect(schedule.drain()).resolves.toEqual([]);
    expect(informed).not.toHaveBeenCalled();
  });

});
