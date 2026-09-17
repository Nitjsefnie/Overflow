import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForgeCredentialRejectedError } from "@/lib/forge/gateway";
import type { ReconciliationDependencies, ReconciliationRepository } from "@/lib/fold/reconcile";
import type { ReconciliationJobReason } from "@/lib/fold/reconciliation-jobs";
import type { ReconciliationWorkerDependencies, ReconciliationWorkerSchedule } from "@/lib/fold/reconciliation-worker";
import type { ReconciliationSweepSchedule } from "@/lib/fold/sweep";
import { validDifficultyScheme } from "../support/difficulty-scheme";

/**
 * `register()` type-checks whether or not it starts anything, so what this pins
 * is that the server's instrumentation hook actually arms both halves of
 * reconciliation, and that the sweep enqueues under its own reason.
 */

const { enqueued, startSweep, startWorker, sweep, drain, resolveToken, markRejected } = vi.hoisted(() => ({
  enqueued: [] as { repositoryId: string; reason: string }[],
  startSweep: vi.fn(),
  startWorker: vi.fn(),
  sweep: vi.fn(),
  drain: vi.fn(),
  resolveToken: vi.fn(),
  markRejected: vi.fn(),
}));

vi.mock("@/lib/fold/reconciliation-worker", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/fold/reconciliation-worker")>()),
  startReconciliationWorker: startWorker,
  drainReconciliationJobs: drain,
}));
vi.mock("@/lib/fold/sweep", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/fold/sweep")>()),
  startReconciliationSweep: startSweep,
  sweepReconciliations: sweep,
}));
vi.mock("@/lib/db/client", () => ({ getSql: () => vi.fn() }));
vi.mock("@/lib/forge/postgres-identities-store", () => ({
  PostgresForgeIdentityStore: class {
    getForgeToken = resolveToken;
    markTokenRejected = markRejected;
  },
}));
// Replace fold traversal with one read; the sponsor wrapper, GitLab gateway,
// HTTP error mapping, and production rejection callback remain real.
vi.mock("@/lib/fold/reconcile", () => ({
  reconcileRepository: async ({ github }: ReconciliationDependencies) => {
    await github.getPullRequestDiff({ owner: "group", name: "project" }, 7);
    return {};
  },
}));
vi.mock("@/lib/fold/postgres-store", () => ({
  PostgresFoldStore: class {
    async getRepository(repositoryId: string): Promise<ReconciliationRepository | null> {
      if (repositoryId !== "repository-1") return null;
      return {
        id: repositoryId,
        githubRepositoryId: 1,
        ownerName: "group/project",
        active: true,
        registeredAt: "2026-09-01T00:00:00.000Z",
        sponsor: { id: "sponsor-1", githubUserId: 1, githubLogin: "sponsor", enforcementState: "ACTIVE" },
        difficultyScheme: validDifficultyScheme(),
        difficultySchemeVersions: [],
        provider: "gitlab",
        instanceUrl: "https://gitlab.example.com",
      };
    }
    async enqueueReconciliationJob(repositoryId: string, reason: ReconciliationJobReason) {
      enqueued.push({ repositoryId, reason });
    }
  },
}));

beforeEach(() => {
  // register() must import this file's worker/sweep doubles, never a cached
  // consumer that captured another file's mocks or real background schedulers.
  vi.resetModules();
  enqueued.length = 0;
  startSweep.mockReset();
  startWorker.mockReset();
  sweep.mockReset();
  drain.mockReset().mockImplementation(async (dependencies: ReconciliationWorkerDependencies) => {
    await dependencies.reconcile("repository-1", { rederive: false });
    return [];
  });
  resolveToken.mockReset().mockResolvedValue({ token: "token-a", identityId: "identity-a" });
  markRejected.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(() => { vi.resetModules(); });

describe("server instrumentation", () => {
  it("starts the worker and the sweep, and sweeps under the sweep's own reason", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "");
    const { register } = await import("@/instrumentation");

    await register();

    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(startSweep).toHaveBeenCalledTimes(1);

    // The reason is only reachable through the dependencies the hook builds, so
    // the sweep it wired is run and its enqueue called the way the sweep calls it.
    const schedule = startSweep.mock.calls[0]![0] as ReconciliationSweepSchedule;
    await schedule.runSweep();
    const dependencies = sweep.mock.calls[0]![0] as { enqueue(id: string): Promise<unknown> };
    await dependencies.enqueue("repository-1");

    expect(enqueued).toEqual([{ repositoryId: "repository-1", reason: "SWEEP" }]);
  });

  it("marks the supplying identity with its sponsor when the worker's GitLab read returns 401", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "");
    const requests: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return new Response("denied", { status: 401 });
    });
    const { register } = await import("@/instrumentation");
    await register();

    const schedule = startWorker.mock.calls[0]![0] as ReconciliationWorkerSchedule;
    await expect(schedule.drain()).rejects.toBeInstanceOf(ForgeCredentialRejectedError);

    expect(requests).toHaveLength(1);
    expect(requests[0]!.headers.get("authorization")).toBe("Bearer token-a");
    expect(resolveToken).toHaveBeenCalledExactlyOnceWith("sponsor-1", "https://gitlab.example.com");
    expect(markRejected).toHaveBeenCalledExactlyOnceWith("sponsor-1", "identity-a");
  });
});
