import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReconciliationJobReason } from "@/lib/fold/reconciliation-jobs";
import type { ReconciliationSweepSchedule } from "@/lib/fold/sweep";

/**
 * `register()` type-checks whether or not it starts anything, so what this pins
 * is that the server's instrumentation hook actually arms both halves of
 * reconciliation, and that the sweep enqueues under its own reason.
 */

const { enqueued, startSweep, startWorker, sweep } = vi.hoisted(() => ({
  enqueued: [] as { repositoryId: string; reason: string }[],
  startSweep: vi.fn(),
  startWorker: vi.fn(),
  sweep: vi.fn(),
}));

vi.mock("@/lib/fold/reconciliation-worker", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/fold/reconciliation-worker")>()),
  startReconciliationWorker: startWorker,
}));
vi.mock("@/lib/fold/sweep", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/fold/sweep")>()),
  startReconciliationSweep: startSweep,
  sweepReconciliations: sweep,
}));
vi.mock("@/lib/db/client", () => ({ getSql: () => vi.fn() }));
vi.mock("@/lib/fold/postgres-store", () => ({
  PostgresFoldStore: class {
    async enqueueReconciliationJob(repositoryId: string, reason: ReconciliationJobReason) {
      enqueued.push({ repositoryId, reason });
    }
  },
}));

beforeEach(() => {
  enqueued.length = 0;
  startSweep.mockReset();
  startWorker.mockReset();
  sweep.mockReset();
});

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
});
