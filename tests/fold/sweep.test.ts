import { describe, expect, it, vi } from "vitest";
import {
  RECONCILIATION_SWEEP_INTERVAL_MS,
  shouldStartReconciliationSweep,
  startReconciliationSweep,
  sweepReconciliations,
  type ReconciliationSweepSchedule,
} from "@/lib/fold/sweep";

describe("scheduled reconciliation sweep", () => {
  it("counts reconciled, failed, and cooling repositories in one summary", async () => {
    const attempted: string[] = [];
    const failures: string[] = [];
    const now = () => new Date("2030-01-02T03:04:05.678Z");
    await expect(sweepReconciliations({
      listActiveRepositoryIds: async () => ["ready", "cooling", "broken"],
      getReconciliationCooldown: async (id) => id === "cooling" ? new Date("2030-01-02T04:04:05.678Z") : null,
      now,
      reconcile: async (id) => {
        attempted.push(id);
        if (id === "broken") {
          throw new Error("Reconciliation failed");
        }
      },
      onFailure: (id) => { failures.push(id); },
    })).resolves.toEqual({ attempted: 2, reconciled: 1, failed: 1, skipped: 1 });
    expect(attempted).toEqual(["ready", "broken"]);
    expect(failures).toEqual(["broken"]);
  });

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

  it("reports a sweep that rejects and sweeps again on the next interval", async () => {
    const timer = createTimer();
    const failures: unknown[] = [];
    const unreachable = new Error("Active repositories could not be listed");
    let sweeps = 0;

    startReconciliationSweep({
      runSweep: async () => {
        sweeps += 1;
        throw unreachable;
      },
      schedule: timer.schedule,
      onSweepFailure: (error) => {
        failures.push(error);
      },
    });
    await timer.settle();

    expect(sweeps).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBe(unreachable);

    // The running flag must be cleared on rejection too, or every later tick is dropped.
    await timer.tick();
    expect(sweeps).toBe(2);
    expect(failures).toHaveLength(2);
    expect(failures[1]).toBe(unreachable);
  });

  it("reports a sweep that rejects on the console when no callback is supplied", async () => {
    const timer = createTimer();
    const unreachable = new Error("Active repositories could not be listed");
    const reported = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      startReconciliationSweep({
        runSweep: async () => {
          throw unreachable;
        },
        schedule: timer.schedule,
      });
      await timer.settle();

      expect(reported).toHaveBeenCalledTimes(1);
      expect(reported.mock.calls[0]).toContain(unreachable);
    } finally {
      reported.mockRestore();
    }
  });

  it("leaves no unhandled rejection behind when a sweep rejects", async () => {
    const timer = createTimer();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);

    try {
      startReconciliationSweep({
        runSweep: async () => {
          throw new Error("Active repositories could not be listed");
        },
        schedule: timer.schedule,
        onSweepFailure: () => {},
      });
      // One drain is already enough for Node to report a rejection it is going
      // to report; the second only widens the window the listener had to fire in.
      await timer.settle();
      await timer.settle();

      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", listener);
    }
  });

  it("calls a method-form failure hook with its receiver intact", async () => {
    const timer = createTimer();
    const unreachable = new Error("Active repositories could not be listed");
    // Declared as a method that reaches its own object through `this`, which is
    // the form the type's method syntax invites and the sibling per-repository
    // hook already supports.
    const schedule = {
      failures: [] as unknown[],
      runSweep: async () => {
        throw unreachable;
      },
      schedule: timer.schedule,
      onSweepFailure(error: unknown) {
        this.failures.push(error);
      },
    };

    startReconciliationSweep(schedule);
    await timer.settle();

    expect(schedule.failures).toHaveLength(1);
    expect(schedule.failures[0]).toBe(unreachable);
  });

  it("costs neither the process nor the report when the failure hook throws", async () => {
    const timer = createTimer();
    const unreachable = new Error("Active repositories could not be listed");
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let sweeps = 0;
    let reports = 0;

    try {
      startReconciliationSweep({
        runSweep: async () => {
          sweeps += 1;
          throw unreachable;
        },
        schedule: timer.schedule,
        onSweepFailure: () => {
          reports += 1;
          throw new Error("The failure hook itself failed");
        },
      });
      await timer.settle();
      await timer.settle();

      expect(sweeps).toBe(1);
      expect(reports).toBe(1);
      expect(unhandled).toEqual([]);
      // The hook failed, so the sweep failure falls back to the console instead
      // of being lost.
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]).toContain(unreachable);

      // The running flag is cleared even when the hook threw.
      await timer.tick();
      expect(sweeps).toBe(2);
      expect(reports).toBe(2);
      expect(unhandled).toEqual([]);
      expect(logged).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
      process.off("unhandledRejection", listener);
    }
  });

  it("costs neither the process nor the report when the failure hook rejects", async () => {
    const timer = createTimer();
    const unreachable = new Error("Active repositories could not be listed");
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let sweeps = 0;
    let reports = 0;

    try {
      startReconciliationSweep({
        runSweep: async () => {
          sweeps += 1;
          throw unreachable;
        },
        schedule: timer.schedule,
        // The ordinary shape of a reporter that ships the failure somewhere:
        // async, and able to reject. A `try` around the call cannot see that
        // rejection, and the returned promise is not the scheduler's to discard.
        onSweepFailure: async () => {
          reports += 1;
          throw new Error("Shipping the report failed");
        },
      });
      await timer.settle();
      await timer.settle();

      expect(unhandled).toEqual([]);
      expect(sweeps).toBe(1);
      expect(reports).toBe(1);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]).toContain(unreachable);

      await timer.tick();
      expect(sweeps).toBe(2);
      expect(reports).toBe(2);
      expect(unhandled).toEqual([]);
      expect(logged).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
      process.off("unhandledRejection", listener);
    }
  });

  it("reports on the console when the failure hook is null", async () => {
    const timer = createTimer();
    const unreachable = new Error("Active repositories could not be listed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // An untyped caller — a config object, parsed JSON, a JavaScript consumer —
    // can hand over null where the optional member expresses only undefined.
    const schedule = {
      runSweep: async () => {
        throw unreachable;
      },
      schedule: timer.schedule,
      onSweepFailure: null,
    } as unknown as ReconciliationSweepSchedule;

    try {
      startReconciliationSweep(schedule);
      await timer.settle();

      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]).toContain(unreachable);
    } finally {
      logged.mockRestore();
    }
  });

  it("still logs a sweep failure whose reason cannot be printed", async () => {
    const timer = createTimer();
    const unreachable = new Error("Active repositories could not be listed");
    const calls: unknown[][] = [];
    // Printing the reason is what fails here — a custom inspector that throws, a
    // proxy, a getter with a side effect. The line itself has to survive that,
    // and this is the scheduler's own reporting path, not a caller's hook.
    const logged = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      calls.push(args);
      if (args.length > 1) {
        throw new TypeError("This reason cannot be printed");
      }
    });

    try {
      startReconciliationSweep({
        runSweep: async () => {
          throw unreachable;
        },
        schedule: timer.schedule,
      });
      await timer.settle();

      expect(calls).toHaveLength(2);
      expect(calls[0]).toContain(unreachable);
      expect(calls[1]).toHaveLength(1);
    } finally {
      logged.mockRestore();
    }
  });

  it("reports a runSweep that throws before it returns a promise", async () => {
    const timer = createTimer();
    const beforeThePromise = new Error("Active repositories could not be listed");
    const failures: unknown[] = [];
    let sweeps = 0;

    startReconciliationSweep({
      runSweep: () => {
        sweeps += 1;
        throw beforeThePromise;
      },
      schedule: timer.schedule,
      onSweepFailure: (error) => {
        failures.push(error);
      },
    });
    await timer.settle();

    expect(sweeps).toBe(1);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toBe(beforeThePromise);

    await timer.tick();
    expect(sweeps).toBe(2);
    expect(failures).toHaveLength(2);
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
