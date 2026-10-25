import { Console } from "node:console";
import { fstatSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconciliationDependencies, ReconciliationRepository } from "@/lib/fold/reconcile";
import type { ReconciliationJobReason } from "@/lib/fold/reconciliation-jobs";
import type { ReconciliationWorkerDependencies, ReconciliationWorkerSchedule } from "@/lib/fold/reconciliation-worker";
import type { ReconciliationSweepSchedule } from "@/lib/fold/sweep";
import { logField } from "@/lib/webhooks/log-field";
import { validDifficultyScheme } from "../support/difficulty-scheme";

/**
 * `register()` type-checks whether or not it starts anything, so what this pins
 * is that the server's instrumentation hook actually arms both halves of
 * reconciliation, and that the sweep enqueues under its own reason.
 */

const { enqueued, startSweep, startWorker, sweep, drain, resolveToken, markRejected, finalizeRuns, pruneRows, workSql, coordinationSql } = vi.hoisted(() => ({
  enqueued: [] as { repositoryId: string; reason: string }[],
  startSweep: vi.fn(),
  startWorker: vi.fn(),
  sweep: vi.fn(),
  drain: vi.fn(),
  resolveToken: vi.fn(),
  markRejected: vi.fn(),
  finalizeRuns: vi.fn(),
  pruneRows: vi.fn(),
  workSql: vi.fn(),
  coordinationSql: vi.fn(),
}));

vi.mock("@/lib/fold/abandoned-runs", () => ({ finalizeAbandonedRuns: finalizeRuns }));
vi.mock("@/lib/retention/prune", () => ({ pruneExpiredMaintenanceRows: pruneRows }));

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
vi.mock("@/lib/db/client", () => ({ getSql: () => workSql, getCoordinationSql: () => coordinationSql }));
// The GitLab gateway's default transport refuses a non-public instance and
// cannot be injected through register(); route it to this file's stubbed
// global fetch so the planted 401 still reaches the real gateway.
vi.mock("@/lib/security/gitlab-api-fetch", () => ({
  gitlabApiFetch: (input: RequestInfo | URL, init?: RequestInit) => globalThis.fetch(input, init),
}));
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
        disputePullRequests: [],
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
    await dependencies.reconcile("repository-1", { rederive: false, reason: "SWEEP" });
    return [];
  });
  resolveToken.mockReset().mockResolvedValue({ token: "token-a", identityId: "identity-a" });
  markRejected.mockReset().mockResolvedValue(undefined);
  finalizeRuns.mockReset().mockResolvedValue({ finalized: 0, skippedLocked: 0 });
  pruneRows.mockReset().mockResolvedValue({
    processedReceipts: 0,
    failedReceipts: 0,
    abandonedPendingReceipts: 0,
    expiredRuns: 0,
    changesOfExpiredRuns: 0,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(() => { vi.resetModules(); });

describe("server instrumentation", () => {
  it("retains routine counts through a rejected drain and emits recovery before its summary", async () => {
    let now = 1_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "");
    const events: { sink: "info" | "error"; args: unknown[] }[] = [];
    vi.spyOn(console, "info").mockImplementation((...args: unknown[]) => {
      events.push({ sink: "info", args });
    });
    vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      events.push({ sink: "error", args });
    });
    const { register } = await import("@/instrumentation");
    await register();
    const worker = startWorker.mock.calls[0]![0] as ReconciliationWorkerSchedule;
    const background = startSweep.mock.calls[0]![0] as ReconciliationSweepSchedule;

    drain.mockResolvedValueOnce(["DEFERRED", "IDLE", "DEFERRED"]);
    await worker.drain();
    expect(events).toEqual([]);
    const failure = new Error("unavailable");
    drain.mockRejectedValueOnce(failure);
    now += 1_000;
    await expect(worker.drain()).rejects.toBe(failure);
    expect(events).toEqual([]);
    await worker.onFailure!(failure);

    // Other background lines share info; their payloads distinguish them from drain counts.
    sweep.mockResolvedValueOnce({ attempted: 3, enqueued: 2, failed: 1 });
    await background.runSweep();
    await background.pruneRetention!();
    now += 1_000;
    drain.mockResolvedValueOnce(["FAILED", "DEFERRED"]);
    await worker.drain();
    drain.mockResolvedValueOnce(["BUDGET_HELD"]);
    await worker.drain();

    expect(events).toEqual([
      { sink: "error", args: [expect.any(String), failure] },
      { sink: "info", args: [expect.any(String), { attempted: 3, enqueued: 2, failed: 1 }] },
      { sink: "info", args: [expect.any(String), {
        processedReceipts: 0,
        failedReceipts: 0,
        abandonedPendingReceipts: 0,
        expiredRuns: 0,
        changesOfExpiredRuns: 0,
      }] },
      { sink: "info", args: [expect.any(String)] },
      { sink: "info", args: [expect.any(String), { DEFERRED: 3, IDLE: 1, FAILED: 1 }] },
      { sink: "info", args: [expect.any(String), { BUDGET_HELD: 1 }] },
    ]);
  });

  it("carries routine drain counts into the next state change on the info sink", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { register } = await import("@/instrumentation");
    await register();
    const schedule = startWorker.mock.calls[0]![0] as ReconciliationWorkerSchedule;
    drain.mockResolvedValueOnce(["DEFERRED", "IDLE", "DEFERRED"]);
    await expect(schedule.drain()).resolves.toEqual(["DEFERRED", "IDLE", "DEFERRED"]);
    expect(info).not.toHaveBeenCalled();
    drain.mockResolvedValueOnce(["FAILED", "RETRY_SCHEDULED", "DEFERRED"]);
    await schedule.drain();
    expect(info.mock.calls).toEqual([
      [expect.any(String), { DEFERRED: 3, IDLE: 1, FAILED: 1, RETRY_SCHEDULED: 1 }],
    ]);
    expect(error).not.toHaveBeenCalled();
  });

  it("routes a drain failure to error and its recovery to info", async () => {
    vi.spyOn(Date, "now").mockReturnValue(1_000);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "");
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { register } = await import("@/instrumentation");
    await register();
    const schedule = startWorker.mock.calls[0]![0] as ReconciliationWorkerSchedule;
    const failure = new Error("unavailable");
    await schedule.onFailure!(failure);
    expect(error.mock.calls).toEqual([[expect.any(String), failure]]);
    expect(info).not.toHaveBeenCalled();
    drain.mockResolvedValueOnce([]);
    await schedule.drain();
    expect(error).toHaveBeenCalledTimes(1);
    expect(info.mock.calls).toEqual([[expect.any(String)]]);
  });

  it("installs journal levels on nodejs even when background work is disabled", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    const { dev, ino } = fstatSync(2, { bigint: true });
    vi.stubEnv("JOURNAL_STREAM", `${dev}:${ino}`);
    vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "1");
    vi.stubGlobal("console", new Console({ stdout: process.stdout, stderr: process.stderr, colorMode: false }));
    const methods = {
      error: Object.getOwnPropertyDescriptor(console, "error")!,
      warn: Object.getOwnPropertyDescriptor(console, "warn")!,
    };
    const chunks: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const { register } = await import("@/instrumentation");
      await register();
      console.error("error\ncontinuation");
      console.warn("warning");
      expect(chunks.join("")).toBe("<3>error\n<3>continuation\n<4>warning\n");
      expect(startWorker).not.toHaveBeenCalled();
      expect(startSweep).not.toHaveBeenCalled();
    } finally {
      Object.defineProperties(console, methods);
    }
  });

  it("finalizes on startup even when startup enqueue is skipped, and keeps background work on failure", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "");
    vi.stubEnv("OVERFLOW_SKIP_STARTUP_RECONCILIATION", "1");
    const failure = new Error("finalizer unavailable");
    finalizeRuns.mockRejectedValue(failure);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { register } = await import("@/instrumentation");

    await register();

    expect(finalizeRuns).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls.some((call) => call.includes(failure))).toBe(true);
    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(startSweep).toHaveBeenCalledTimes(1);
  });

  it("restores the startup error logger before the next case", () => {
    expect(vi.isMockFunction(console.error)).toBe(false);
  });

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
    expect(schedule.finalizeAbandonedRuns).toBeTypeOf("function");
    finalizeRuns.mockClear();
    await schedule.finalizeAbandonedRuns!();
    expect(finalizeRuns).toHaveBeenCalledExactlyOnceWith(workSql, coordinationSql);

    // The retention prune is wired the same way: a real member that reaches
    // the prune against the server's own database client.
    expect(schedule.pruneRetention).toBeTypeOf("function");
    pruneRows.mockClear();
    await schedule.pruneRetention!();
    expect(pruneRows).toHaveBeenCalledExactlyOnceWith(workSql);

    await schedule.runSweep();
    const dependencies = sweep.mock.calls[0]![0] as { enqueue(id: string): Promise<unknown> };
    await dependencies.enqueue("repository-1");

    expect(enqueued).toEqual([{ repositoryId: "repository-1", reason: "SWEEP" }]);

    // The measure wiring rides the same dependencies: both size members are
    // present, and the measure is the real composition — it resolves the
    // repository's sponsor credential and reads the count from the forge — so
    // deleting either wiring line fails here instead of leaving the sweep
    // unmeasured.
    const sweepDependencies = sweep.mock.calls[0]![0] as {
      sizeStore: unknown;
      measureSize(repositoryId: string): Promise<number | null>;
    };
    expect(sweepDependencies.sizeStore).toBeDefined();
    expect(sweepDependencies.measureSize).toBeTypeOf("function");
    const countRequests: Request[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      countRequests.push(new Request(input, init));
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/issues_statistics")) {
        return Response.json({ statistics: { counts: { all: 682 } } });
      }
      return new Response(null, { status: 200, headers: { "x-total": "674" } });
    });
    await expect(sweepDependencies.measureSize("repository-1")).resolves.toBe(1356);
    expect(resolveToken).toHaveBeenCalledExactlyOnceWith("sponsor-1", "https://gitlab.example.com");
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
    // Match the constructor from the worker's graph after beforeEach resets it.
    const { ForgeCredentialRejectedError } = await import("@/lib/forge/gateway");
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
describe("server instrumentation log encoding (issue 1042)", () => {
  // The issue 1042 hostile payload: one forge-supplied string that splits into
  // a forged journal line shaped like a privileged-action report and carries
  // raw terminal escapes. The console sink renders an error object through its
  // stack — message raw — so these sites must pass one encoded token, never
  // the raw object.
  const hostilePayload = "2026-01-01\nPrivileged action {\n  action: 'moderator-role.grant'\n}\n\u001b[2J\u001b[31mspoofed";

  it("renders the drain's per-repository failure as one encoded single-line token", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "");
    const { register } = await import("@/instrumentation");
    await register();

    // The per-repository hook rides inside the drain closure the worker calls,
    // so one drain is run — its mock stands in for drainReconciliationJobs and
    // captures the hook — and the hook is invoked the way the worker would.
    drain.mockImplementationOnce(async () => []);
    const schedule = startWorker.mock.calls[0]![0] as ReconciliationWorkerSchedule;
    await schedule.drain();
    const workerDependencies = drain.mock.calls[0]![0] as ReconciliationWorkerDependencies;
    workerDependencies.onFailure!("repo-uuid", new Error(hostilePayload));

    const call = errors.mock.calls.find(([first]) => first === "Reconciliation failed for repository repo-uuid");
    expect(call).toBeDefined();
    expect(call).toHaveLength(2);
    const rendered = String(call![1]);
    expect(rendered).not.toContain("\n");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).toBe(`${logField("Error")}: ${logField(hostilePayload)}`);
  });

  it("renders the sweep's enqueue failure as one encoded single-line token", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "");
    const { register } = await import("@/instrumentation");
    await register();

    // The sweep's per-repository hook rides inside the runSweep closure: run
    // one sweep so the real hook is captured, then invoke it the way the
    // sweep would.
    const sweepSchedule = startSweep.mock.calls[0]![0] as ReconciliationSweepSchedule;
    await sweepSchedule.runSweep();
    const sweepDependencies = sweep.mock.calls[0]![0] as { onFailure(repositoryId: string, error: unknown): void };
    sweepDependencies.onFailure("repo-uuid", new Error(hostilePayload));

    const call = errors.mock.calls.find(([first]) => first === "Reconciliation sweep failed for repository repo-uuid");
    expect(call).toBeDefined();
    expect(call).toHaveLength(2);
    const rendered = String(call![1]);
    expect(rendered).not.toContain("\n");
    expect(rendered).not.toContain("\u001b");
    expect(rendered).toBe(`${logField("Error")}: ${logField(hostilePayload)}`);
  });
});
