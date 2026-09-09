import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubGraphqlClient } from "@/lib/github/graphql";
import { createGitHubGraphqlBudgetStore, gitHubGraphqlBudget } from "@/lib/github/rate-limit-budget";
import { runNextReconciliationJob, drainReconciliationJobs, type ReconciliationWorkerStore } from "@/lib/fold/reconciliation-worker";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { reconcileRepositoryAsSponsor } from "@/lib/fold/reconcile-as-sponsor";
import type { ReconciliationGateway, ReconciliationRepository, ReconciliationStore } from "@/lib/fold/reconcile";

describe("reconciling a repository as its sponsor", () => {
  it("folds a deactivated repository whose sponsor has no token left", async () => {
    // The path the worker used to burn every attempt on. A repository deactivated
    // while it held a job needs no GitHub read at all — the fold short-circuits to
    // a clean no-delta run — so resolving the sponsor's token before that decision
    // turned a job that completes instantly into five failures and a FAILED row
    // the sweep will not revive, because the sweep only enqueues active ones.
    const harness = createHarness({ active: false, accessToken: null });

    await expect(
      reconcileRepositoryAsSponsor(harness.store, "repo-1", harness.createGateway),
    ).resolves.toMatchObject({ repositoryId: "repo-1", skipped: false, adds: 0, changes: 0, removals: 0 });

    expect(harness.calls).toEqual(["getRepository", "beginRun", "completeRun", "setReconciliationCooldown"]);
    // No token was resolved and no gateway was built, because nothing needed one.
    expect(harness.gatewaysBuilt).toEqual([]);
  });

  it("builds the gateway from the sponsor's token for an active repository", async () => {
    const harness = createHarness({ active: true, accessToken: "sponsor-token" });

    await expect(
      reconcileRepositoryAsSponsor(harness.store, "repo-1", harness.createGateway),
    ).resolves.toMatchObject({ repositoryId: "repo-1" });

    expect(harness.gatewaysBuilt).toEqual(["sponsor-token"]);
    expect(harness.calls).toContain("getGitHubAccessToken");
  });

  it("requests authoritative issue hydration through the sponsor gateway on a cold pass", async () => {
    const harness = createHarness({ active: true, accessToken: "sponsor-token" });
    const listIssues = vi.fn().mockResolvedValue([]);
    harness.store.findUsersByGitHubUserIds = async () => [];
    harness.store.materialize = async () => ({ adds: 0, changes: 0, removals: 0 });
    await reconcileRepositoryAsSponsor(harness.store, "repo-1", () => ({
      getIssue: async () => null,
      getPullRequestClosingIssues: async () => [],
      getRepositoryById: async () => ({
        id: 4242, owner: "example", ownerType: "USER", name: "repository", fullName: "example/repository",
        visibility: "PUBLIC", url: "https://github.com/example/repository", canAdminister: true,
      }),
      listIssues, getPullRequestReviews: async () => [], getPullRequestDiff: async () => "",
    }));
    expect(listIssues).toHaveBeenCalledWith({ owner: "example", name: "repository" }, {
      timelineCriticalLabels: new Set(Array.from({ length: 10 }, (_, index) => `delivered/${index + 1}`)),
      timelineWatchedLabels: new Set(["S", "M", "L"]),
    });
  });

  it("refuses an active repository whose sponsor has no token", async () => {
    const harness = createHarness({ active: true, accessToken: null });

    await expect(
      reconcileRepositoryAsSponsor(harness.store, "repo-1", harness.createGateway),
    ).rejects.toThrow(/Unable to reconcile repository/i);

    expect(harness.gatewaysBuilt).toEqual([]);
  });

  it("refuses a repository that is not registered at all", async () => {
    const harness = createHarness({ active: true, accessToken: "sponsor-token", repository: null });

    await expect(
      reconcileRepositoryAsSponsor(harness.store, "repo-1", harness.createGateway),
    ).rejects.toThrow(/not found/i);
  });
});

function createHarness(options: {
  active: boolean;
  accessToken: string | null;
  repository?: ReconciliationRepository | null;
}) {
  const calls: string[] = [];
  const gatewaysBuilt: string[] = [];
  const repository: ReconciliationRepository | null =
    options.repository === undefined
      ? {
          id: "repo-1",
          githubRepositoryId: 4_242,
          ownerName: "example/repository",
          registeredAt: "2030-01-02T03:04:05.678Z",
          active: options.active,
          sponsor: {
            id: "sponsor-1",
            githubUserId: 9_001,
            githubLogin: "sponsor",
            enforcementState: "ACTIVE",
          },
          difficultyScheme: validDifficultyScheme(),
          difficultySchemeVersions: [],
        }
      : options.repository;

  const store = {
    assessReconciliationFairness: vi.fn<ReconciliationStore["assessReconciliationFairness"]>(async ({ now }) => ({
      state: "ADMITTED", holdUntil: null, usage: { debt: 0, measuredAt: now, ratePerSecond: 0 },
    })),
    getReconciliationEvidence: async () => null,
    getDirtyReconciliationSubjects: async () => [],
    withRepositoryReconciliation: async <T>(_repositoryId: string, work: () => Promise<T>) => work(),
    getRepository: async () => {
      calls.push("getRepository");
      return repository;
    },
    getReconciliationCooldown: async () => null,
    setReconciliationCooldown: async () => {
      calls.push("setReconciliationCooldown");
    },
    getGitHubAccessToken: async () => {
      calls.push("getGitHubAccessToken");
      return options.accessToken;
    },
    hasDerivedRowsBelowFoldRevision: async () => false,
    beginRun: async () => {
      calls.push("beginRun");
      return "run-1";
    },
    completeRun: async () => {
      calls.push("completeRun");
    },
    failRun: async () => {
      calls.push("failRun");
    },
    materializeRepositoryFold: async () => ({ adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0 }),
    markRepositoryUnavailable: async () => {
      calls.push("markRepositoryUnavailable");
    },
    recordVerifiedRepositoryIdentity: async () => {
      calls.push("recordVerifiedRepositoryIdentity");
    },
  } as unknown as ReconciliationStore;

  const createGateway = (accessToken: string): ReconciliationGateway => {
    gatewaysBuilt.push(accessToken);
    return {
      getRepositoryById: async () => null,
      getIssue: async () => null,
      getPullRequestClosingIssues: async () => [],
      listIssues: async () => [],
      getPullRequestReviews: async () => [],
      getPullRequestDiff: async () => "",
    };
  };

  return { store, createGateway, calls, gatewaysBuilt };
}

const budgetKey = Symbol.for("overflow.github.graphql-budget");
const previousBudget = Object.getOwnPropertyDescriptor(globalThis, budgetKey);
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (previousBudget) Object.defineProperty(globalThis, budgetKey, previousBudget);
  else Reflect.deleteProperty(globalThis, budgetKey);
});

describe("sponsor quota admission through transport, fold and worker", () => {
  it.each([
    { a: 4200, b: 42, outcome: "RECONCILED" },
    { a: 42, b: 4200, outcome: "BUDGET_HELD" },
  ])("keeps candidate A independent of B ($a / $b)", async ({ a, b, outcome }) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
    vi.stubEnv("GITHUB_GRAPHQL_BUDGET_RESERVE", "500");
    const budget = createGitHubGraphqlBudgetStore();
    Reflect.set(globalThis, budgetKey, budget);
    for (const [owner, remaining, resetAt] of [
      ["sponsor-1", a, "2026-09-07T11:00:00Z"],
      ["sponsor-2", b, "2026-09-07T11:01:00Z"],
    ] as const) {
      const options = { owner, accessToken: "test-token", budget,
        fetch: async () => Response.json({ data: { rateLimit: { remaining, resetAt } } }) };
      await new GitHubGraphqlClient(options).query("query { rateLimit { remaining resetAt } }", {});
    }
    const harness = createHarness({ active: true, accessToken: "sponsor-token" });
    const store = queueStore();
    const dependencies = {
      store,
      reconcile: (id: string, options: { rederive: boolean }) => reconcileRepositoryAsSponsor(harness.store, id, harness.createGateway, options),
      scheduleLeaseRenewal: () => () => {},
    };
    await expect(runNextReconciliationJob(dependencies)).resolves.toBe(outcome);
    expect(store.claimNextReconciliationJob).toHaveBeenCalledTimes(1);
    if (outcome === "BUDGET_HELD") {
      expect(store.deferReconciliationJob).toHaveBeenCalledExactlyOnceWith("job-1", "lease-1", new Date("2026-09-07T11:00:00Z"));
      expect(harness.gatewaysBuilt).toEqual([]);
      expect(harness.calls).not.toContain("beginRun");
      expect(store.completeReconciliationJob).not.toHaveBeenCalled();
    } else {
      expect(harness.gatewaysBuilt).toEqual(["sponsor-token"]);
      expect(store.completeReconciliationJob).toHaveBeenCalledExactlyOnceWith("job-1", "lease-1", 0);
      expect(store.deferReconciliationJob).not.toHaveBeenCalled();
    }
    expect(store.retryReconciliationJob).not.toHaveBeenCalled();
  });
  it("records the default sponsor gateway's low response under its account id and holds the fold", async () => {
    const informed = vi.spyOn(console, "info").mockImplementation(() => {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
    Reflect.set(globalThis, budgetKey, createGitHubGraphqlBudgetStore());
    const harness = createHarness({ active: true, accessToken: "sponsor-token" });
    harness.store.findUsersByGitHubUserIds = async () => [];
    harness.store.materialize = vi.fn(async () => ({ adds: 0, changes: 0, removals: 0 }));
    const request = vi.fn<typeof fetch>(async (input) => String(input).endsWith("/graphql")
      ? Response.json({ data: { rateLimit: { remaining: 42, resetAt: "2026-09-07T11:00:00Z" },
        repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } })
      : Response.json({ id: 4242, name: "repository", full_name: "example/repository", private: false,
        html_url: "https://github.com/example/repository", owner: { login: "example", type: "User" }, permissions: { admin: true } }));
    vi.stubGlobal("fetch", request);
    await expect(reconcileRepositoryAsSponsor(harness.store, "repo-1")).resolves.toMatchObject({
      skipped: true, budgetHeldUntil: new Date("2026-09-07T11:00:00Z"),
    });
    expect(harness.store.materialize).not.toHaveBeenCalled();
    expect(harness.calls).toContain("failRun");
    expect(harness.calls).not.toContain("completeRun");
    expect(request).toHaveBeenCalledTimes(2);
    expect(gitHubGraphqlBudget().owners()).toEqual(["sponsor-1"]);
    expect(gitHubGraphqlBudget().read("sponsor-1")?.remaining).toBe(42);
    expect(informed).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      owner: "sponsor-1", state: "UNKNOWN", remaining: undefined, reserve: 500, resetAt: undefined,
    });
    expect(warned).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      owner: "sponsor-1", state: "BELOW_RESERVE", remaining: 42, reserve: 500,
      resetAt: new Date("2026-09-07T11:00:00Z"),
    });
  });

  it("continues to healthy B after deferring A and admits A at its own reset", async () => {
    const informed = vi.spyOn(console, "info").mockImplementation(() => {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
    vi.stubEnv("GITHUB_GRAPHQL_BUDGET_RESERVE", "500");
    const budget = createGitHubGraphqlBudgetStore();
    const resetAt = new Date("2026-09-07T11:00:00Z");
    budget.record("sponsor-1", { remaining: 42, limit: 5000, cost: 1, resetAt, observedAt: new Date("2026-09-07T10:00:00Z") });
    budget.record("sponsor-2", { remaining: 4200, limit: 5000, cost: 1,
      resetAt: new Date("2026-09-07T12:00:00Z"), observedAt: new Date("2026-09-07T10:00:00Z") });
    Reflect.set(globalThis, budgetKey, budget);
    const a = createHarness({ active: true, accessToken: "a-token" });
    const b = createHarness({ active: true, accessToken: "b-token" });
    const bRepository = (await b.store.getRepository("repo-2"))!;
    bRepository.sponsor.id = "sponsor-2";
    const store = queueStore();
    const job = await store.claimNextReconciliationJob();
    store.claimNextReconciliationJob.mockClear();
    store.claimNextReconciliationJob.mockResolvedValueOnce(job).mockResolvedValueOnce({ ...job,
      id: "job-2", repositoryId: "repo-2", leaseToken: "lease-2" });
    const worker = { store, scheduleLeaseRenewal: () => () => {}, reconcile: (id: string, options: { rederive: boolean }) => {
      const harness = id === "repo-1" ? a : b;
      return reconcileRepositoryAsSponsor(harness.store, id, harness.createGateway, options);
    } };
    await expect(drainReconciliationJobs(worker, { maxJobs: 2 })).resolves.toEqual(["BUDGET_HELD", "RECONCILED"]);
    expect(store.deferReconciliationJob).toHaveBeenCalledExactlyOnceWith("job-1", "lease-1", resetAt);
    expect(store.completeReconciliationJob).toHaveBeenCalledExactlyOnceWith("job-2", "lease-2", 0);
    expect(a.gatewaysBuilt).toEqual([]);
    expect(b.gatewaysBuilt).toEqual(["b-token"]);
    vi.setSystemTime(resetAt);
    await expect(runNextReconciliationJob(worker)).resolves.toBe("RECONCILED");
    expect(a.gatewaysBuilt).toEqual(["a-token"]);
    expect(store.retryReconciliationJob).not.toHaveBeenCalled();
    expect(warned).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      owner: "sponsor-1", state: "BELOW_RESERVE", remaining: 42, reserve: 500, resetAt,
    });
    expect(informed.mock.calls).toEqual([
      [expect.any(String), { owner: "sponsor-2", state: "AVAILABLE", remaining: 4200,
        reserve: 500, resetAt: new Date("2026-09-07T12:00:00Z") }],
      [expect.any(String), { owner: "sponsor-1", state: "UNKNOWN", remaining: 42, reserve: 500, resetAt }],
    ]);
  });

  it("checks direct folds under the repository lock after resolving the sponsor and before beginRun", async () => {
    const informed = vi.spyOn(console, "info").mockImplementation(() => {});
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-07T10:00:00Z"));
    const budget = createGitHubGraphqlBudgetStore();
    budget.record("sponsor-1", { remaining: 42, limit: 5000, cost: 1,
      resetAt: new Date("2026-09-07T11:00:00Z"), observedAt: new Date("2026-09-07T10:00:00Z") });
    Reflect.set(globalThis, budgetKey, budget);
    const harness = createHarness({ active: true, accessToken: "sponsor-token" });
    let locked = false;
    harness.store.withRepositoryReconciliation = async (_id, work) => {
      locked = true;
      try { return await work(); } finally { locked = false; }
    };
    const read = vi.spyOn(budget, "read");
    read.mockImplementation((owner) => {
      expect(locked).toBe(true);
      expect(harness.calls).toEqual(["getRepository"]);
      expect(owner).toBe("sponsor-1");
      return { remaining: 42, limit: 5000, cost: 1, resetAt: new Date("2026-09-07T11:00:00Z"), observedAt: new Date("2026-09-07T10:00:00Z") };
    });
    await expect(reconcileRepositoryAsSponsor(harness.store, "repo-1", harness.createGateway)).resolves.toMatchObject({
      skipped: true, runId: null, budgetHeldUntil: new Date("2026-09-07T11:00:00Z"),
    });
    expect(read).toHaveBeenCalledExactlyOnceWith("sponsor-1");
    expect(harness.calls).toEqual(["getRepository"]);
    expect(harness.gatewaysBuilt).toEqual([]);
    expect(locked).toBe(false);
    expect(warned).toHaveBeenCalledExactlyOnceWith(expect.any(String), {
      owner: "sponsor-1", state: "BELOW_RESERVE", remaining: 42, reserve: 500,
      resetAt: new Date("2026-09-07T11:00:00Z"),
    });
    expect(informed).not.toHaveBeenCalled();
  });

});

function queueStore() {
  return {
    claimNextReconciliationJob: vi.fn(async () => ({ id: "job-1", repositoryId: "repo-1", reason: "SWEEP" as const, attemptCount: 1, leaseToken: "lease-1", rederivationRequestedAt: null, rederivationGeneration: 0 })),
    renewReconciliationJobLease: vi.fn(async () => true),
    completeReconciliationJob: vi.fn<ReconciliationWorkerStore["completeReconciliationJob"]>(async () => true),
    deferReconciliationJob: vi.fn(async () => true),
    retryReconciliationJob: vi.fn(async () => true),
    failReconciliationJob: vi.fn(async () => true),
    getReconciliationCooldown: vi.fn(async () => null),
  } satisfies ReconciliationWorkerStore;
}
