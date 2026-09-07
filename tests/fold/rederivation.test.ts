import { afterEach, describe, expect, it, vi } from "vitest";
import { FOLD_REVISION } from "@/lib/fold/fold-revision";
import { reconcileRepository, type ReconciliationDependencies, type ReconciliationStore } from "@/lib/fold/reconcile";
import { reconcileRepositoryAsSponsor } from "@/lib/fold/reconcile-as-sponsor";
import { createReconciliationBudgetGate } from "@/lib/fold/reconciliation-budget";
import { createGitHubGraphqlBudgetStore } from "@/lib/github/rate-limit-budget";
import { runNextReconciliationJob, type ReconciliationWorkerDependencies } from "@/lib/fold/reconciliation-worker";
import { validDifficultyScheme } from "../support/difficulty-scheme";

const now = new Date("2030-01-02T10:00:00Z");
const heldUntil = new Date("2030-01-02T11:00:00Z");
const requestedAt = new Date("2030-01-02T09:00:00.123Z");

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.doUnmock("@/lib/fold/postgres-store");
  vi.doUnmock("@/lib/fold/reconciliation-worker");
  vi.doUnmock("@/lib/fold/sweep");
});

describe("repository re-derivation", () => {
  it.each([
    { stale: true, options: undefined, expected: true },
    { stale: false, options: { rederive: true }, expected: true },
    { stale: false, options: undefined, expected: false },
    { stale: true, options: { rederive: false }, expected: true },
  ])("records rederivation=$expected with stale=$stale and options=$options", async ({ stale, options, expected }) => {
    const { fold, store } = fixture();
    store.hasDerivedRowsBelowFoldRevision.mockResolvedValue(stale);
    await reconcileRepository(fold, "repo-1", options);
    expect(store.beginRun).toHaveBeenCalledExactlyOnceWith("repo-1", { rederivation: expected });
    if (options?.rederive === true) {
      expect(store.hasDerivedRowsBelowFoldRevision).not.toHaveBeenCalled();
    } else {
      expect(store.hasDerivedRowsBelowFoldRevision).toHaveBeenCalledExactlyOnceWith("repo-1", FOLD_REVISION);
    }
    expect(store.materialize).toHaveBeenCalledOnce();
  });

  it.each([requestedAt, null])("passes the claimed request %s to the fold and completion", async (request) => {
    const { worker, store } = fixture(request);
    expect(await runNextReconciliationJob(worker)).toBe("RECONCILED");
    expect(worker.reconcile).toHaveBeenCalledExactlyOnceWith("repo-1", { rederive: request !== null });
    expect(store.completeReconciliationJob).toHaveBeenCalledExactlyOnceWith("job-1", "lease-1", request);
    expect(store.beginRun).toHaveBeenCalledExactlyOnceWith("repo-1", { rederivation: request !== null });
  });

  it.each(["cooldown", "budget"] as const)("preserves a request through a %s hold without starting or checking staleness", async (hold) => {
    const { worker, store, fold, budgetStore } = fixture(requestedAt);
    if (hold === "cooldown") store.getReconciliationCooldown.mockResolvedValue(heldUntil);
    else budgetStore.record("sponsor-1", { remaining: 1, limit: 5000, cost: 1, observedAt: now, resetAt: heldUntil });

    // An ordinary call must not query stale rows either; explicit requests would
    // short-circuit that query even if its computation were before admission.
    expect(await reconcileRepository(fold, "repo-1")).toEqual({
      repositoryId: "repo-1", runId: null, skipped: true,
      ...(hold === "budget" ? { budgetHeldUntil: heldUntil } : {}),
      adds: 0, changes: 0, removals: 0, added: 0, changed: 0, removed: 0,
    });
    expect(await runNextReconciliationJob(worker)).toBe(hold === "budget" ? "BUDGET_HELD" : "DEFERRED");
    expect(worker.reconcile).toHaveBeenCalledExactlyOnceWith("repo-1", { rederive: true });
    expect(store.beginRun).not.toHaveBeenCalled();
    expect(store.hasDerivedRowsBelowFoldRevision).not.toHaveBeenCalled();
    expect(store.deferReconciliationJob).toHaveBeenCalledExactlyOnceWith("job-1", "lease-1", heldUntil);
    expect(store.completeReconciliationJob).not.toHaveBeenCalled();
    expect(store.retryReconciliationJob).not.toHaveBeenCalled();
    expect(store.failReconciliationJob).not.toHaveBeenCalled();
  });

  it.each([
    { attemptCount: 1, outcome: "RETRY_SCHEDULED", method: "retryReconciliationJob" },
    { attemptCount: 5, outcome: "FAILED", method: "failReconciliationJob" },
  ] as const)("retains the request on $outcome", async ({ attemptCount, outcome, method }) => {
    const { worker, store } = fixture(requestedAt, attemptCount);
    worker.reconcile.mockRejectedValue(new Error("GitHub unavailable"));
    expect(await runNextReconciliationJob(worker)).toBe(outcome);
    expect(worker.reconcile).toHaveBeenCalledExactlyOnceWith("repo-1", { rederive: true });
    expect(store[method]).toHaveBeenCalledOnce();
    expect(store.completeReconciliationJob).not.toHaveBeenCalled();
    expect(store.deferReconciliationJob).not.toHaveBeenCalled();
  });

  it("forwards an explicit request through the sponsor helper", async () => {
    const { store, fold } = fixture();
    await reconcileRepositoryAsSponsor(store, "repo-1", () => fold.github, { rederive: true });
    expect(store.beginRun).toHaveBeenCalledExactlyOnceWith("repo-1", { rederivation: true });
  });

  it("records a requested re-derivation through the production worker wiring", async () => {
    const { store } = fixture(requestedAt);
    // Inactive repositories complete without a real GitHub client or token.
    const repository = await store.getRepository("repo-1");
    store.getRepository.mockResolvedValue({ ...repository!, active: false });
    const startWorker = vi.fn();
    vi.doMock("@/lib/fold/postgres-store", () => ({ PostgresFoldStore: class { constructor() { return store; } } }));
    vi.doMock("@/lib/fold/reconciliation-worker", async (importActual) => ({
      ...await importActual<typeof import("@/lib/fold/reconciliation-worker")>(),
      startReconciliationWorker: startWorker,
    }));
    vi.doMock("@/lib/fold/sweep", () => ({ shouldStartReconciliationBackground: () => true, startReconciliationSweep: vi.fn() }));
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { register } = await import("@/instrumentation");
    await register();
    await startWorker.mock.calls[0][0].drain();
    expect(store.beginRun).toHaveBeenCalledExactlyOnceWith("repo-1", { rederivation: true });
    expect(store.completeReconciliationJob).toHaveBeenCalledExactlyOnceWith("job-1", "lease-1", requestedAt);
  });
});

function fixture(request: Date | null = null, attemptCount = 1) {
  const store = {
    withRepositoryReconciliation: async <T>(_id: string, work: () => Promise<T>) => work(),
    getRepository: vi.fn<ReconciliationStore["getRepository"]>(async () => ({
      id: "repo-1", githubRepositoryId: 4242, ownerName: "octo/repo", active: true,
      registeredAt: "2026-01-01T00:00:00Z", difficultyScheme: validDifficultyScheme(),
      sponsor: { id: "sponsor-1", githubUserId: 1, githubLogin: "octo", enforcementState: "ACTIVE" },
    })),
    getReconciliationCooldown: vi.fn<ReconciliationStore["getReconciliationCooldown"]>(async () => null),
    setReconciliationCooldown: vi.fn(async () => {}),
    getGitHubAccessToken: async () => "fixture-token",
    findUsersByGitHubUserIds: async () => [],
    hasDerivedRowsBelowFoldRevision: vi.fn(async () => false),
    beginRun: vi.fn(async () => "run-1"), completeRun: vi.fn(async () => {}),
    materialize: vi.fn(async () => ({ adds: 0, changes: 0, removals: 0 })),
    failRun: vi.fn(async () => {}), recordVerifiedRepositoryIdentity: async () => {}, markRepositoryUnavailable: async () => {},
    claimNextReconciliationJob: vi.fn<ReconciliationWorkerDependencies["store"]["claimNextReconciliationJob"]>()
      .mockResolvedValueOnce({ id: "job-1", repositoryId: "repo-1", reason: "SWEEP", attemptCount,
        leaseToken: "lease-1", rederivationRequestedAt: request }).mockResolvedValue(null),
    renewReconciliationJobLease: vi.fn(async () => true),
    completeReconciliationJob: vi.fn(async () => true), deferReconciliationJob: vi.fn(async () => true),
    retryReconciliationJob: vi.fn(async () => true), failReconciliationJob: vi.fn(async () => true),
  };
  const budgetStore = createGitHubGraphqlBudgetStore();
  const fold: ReconciliationDependencies = {
    store, now: () => now, onBudgetChange: () => {},
    budget: createReconciliationBudgetGate({ store: budgetStore, reserve: 500 }),
    github: {
      getRepositoryById: async () => ({ id: 4242, owner: "octo", name: "repo", fullName: "octo/repo",
        ownerType: "USER", visibility: "PUBLIC", url: "https://github.com/octo/repo", canAdminister: true }),
      listIssues: async () => [], getPullRequestReviews: async () => [], getPullRequestDiff: async () => "",
    },
  };
  const worker = {
    store, now: () => now, onFailure: () => {}, scheduleLeaseRenewal: () => () => {},
    reconcile: vi.fn<ReconciliationWorkerDependencies["reconcile"]>((id, options) => reconcileRepository(fold, id, options)),
  };
  return { store, fold, worker, budgetStore };
}
