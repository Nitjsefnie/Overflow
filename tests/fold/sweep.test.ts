import { describe, expect, it } from "vitest";
import {
  RECONCILIATION_SWEEP_INTERVAL_MS,
  shouldStartReconciliationSweep,
  startReconciliationSweep,
  sweepReconciliations,
} from "@/lib/fold/sweep";

describe("scheduled reconciliation sweep", () => {
  it("counts a cooldown discovered under the repository lock as skipped", async () => {
    await expect(sweepReconciliations({
      listActiveRepositoryIds: async () => ["repo-a"],
      getReconciliationCooldown: async () => null,
      reconcile: async () => ({ skipped: true }),
    })).resolves.toEqual({ attempted: 0, reconciled: 0, failed: 0, skipped: 1 });
  });

  it("reconciles every active repository", async () => {
    const reconciled: string[] = [];

    await expect(
      sweepReconciliations({
        listActiveRepositoryIds: async () => ["repo-a", "repo-b", "repo-c"],
        getReconciliationCooldown: async () => null,
        reconcile: async (repositoryId) => {
          reconciled.push(repositoryId);
        },
      }),
    ).resolves.toEqual({ attempted: 3, reconciled: 3, failed: 0, skipped: 0 });

    expect(reconciled).toEqual(["repo-a", "repo-b", "repo-c"]);
  });

  it("continues the sweep when one repository fails", async () => {
    const reconciled: string[] = [];
    const failures: string[] = [];

    await expect(
      sweepReconciliations({
        listActiveRepositoryIds: async () => ["repo-a", "repo-b", "repo-c"],
        getReconciliationCooldown: async () => null,
        reconcile: async (repositoryId) => {
          if (repositoryId === "repo-b") {
            throw new Error("GitHub reconciliation failed");
          }
          reconciled.push(repositoryId);
        },
        onFailure: (repositoryId) => {
          failures.push(repositoryId);
        },
      }),
    ).resolves.toEqual({ attempted: 3, reconciled: 2, failed: 1, skipped: 0 });

    expect(reconciled).toEqual(["repo-a", "repo-c"]);
    expect(failures).toEqual(["repo-b"]);
  });

  it("reconciles one repository at a time", async () => {
    let inFlight = 0;
    let peak = 0;

    await sweepReconciliations({
      listActiveRepositoryIds: async () => ["repo-a", "repo-b", "repo-c"],
      getReconciliationCooldown: async () => null,
      reconcile: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
      },
    });

    expect(peak).toBe(1);
  });

  it("returns an empty summary when nothing is registered", async () => {
    await expect(
      sweepReconciliations({
        listActiveRepositoryIds: async () => [],
        getReconciliationCooldown: async () => null,
        reconcile: async () => {
          throw new Error("should not be reconciled");
        },
      }),
    ).resolves.toEqual({ attempted: 0, reconciled: 0, failed: 0, skipped: 0 });
  });

  it("sweeps once on start and again on every interval", async () => {
    const timer = createTimer();
    let sweeps = 0;

    startReconciliationSweep({
      runSweep: async () => {
        sweeps += 1;
      },
      schedule: timer.schedule,
    });
    await timer.settle();

    expect(sweeps).toBe(1);
    expect(timer.intervalMs).toBe(RECONCILIATION_SWEEP_INTERVAL_MS);

    await timer.tick();
    expect(sweeps).toBe(2);

    await timer.tick();
    expect(sweeps).toBe(3);
  });

  it("skips a scheduled sweep while the previous one is still running", async () => {
    const timer = createTimer();
    let started = 0;
    let release: (() => void) | undefined;

    startReconciliationSweep({
      runSweep: async () => {
        started += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
      schedule: timer.schedule,
    });
    await timer.settle();
    expect(started).toBe(1);

    await timer.tick();
    expect(started).toBe(1);

    release?.();
    await timer.settle();

    await timer.tick();
    expect(started).toBe(2);
  });

  it("sweeps every six hours", () => {
    expect(RECONCILIATION_SWEEP_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
  });

  it("starts only in the Node.js server runtime", () => {
    expect(shouldStartReconciliationSweep({ NEXT_RUNTIME: "nodejs" })).toBe(true);
    expect(shouldStartReconciliationSweep({ NEXT_RUNTIME: "edge" })).toBe(false);
    expect(shouldStartReconciliationSweep({})).toBe(false);
  });

  it("does not start during a production build", () => {
    expect(
      shouldStartReconciliationSweep({
        NEXT_RUNTIME: "nodejs",
        NEXT_PHASE: "phase-production-build",
      }),
    ).toBe(false);
  });

  it("can be turned off explicitly", () => {
    expect(
      shouldStartReconciliationSweep({
        NEXT_RUNTIME: "nodejs",
        OVERFLOW_DISABLE_RECONCILIATION_SWEEP: "1",
      }),
    ).toBe(false);
  });
});

function createTimer() {
  let fire: (() => void) | undefined;
  let intervalMs: number | undefined;

  return {
    schedule(callback: () => void, everyMs: number) {
      fire = callback;
      intervalMs = everyMs;
    },
    get intervalMs() {
      return intervalMs;
    },
    async tick() {
      fire?.();
      await this.settle();
    },
    async settle() {
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
}
