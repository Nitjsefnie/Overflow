import { describe, expect, it, vi } from "vitest";
import type { ClaimedReconciliationJob } from "@/lib/fold/reconciliation-jobs";
import {
  drainReconciliationJobs,
  RECONCILIATION_RETRY_DELAYS_MS,
  RECONCILIATION_WORKER_POLL_INTERVAL_MS,
  runNextReconciliationJob,
  startReconciliationWorker,
  type ReconciliationWorkerStore,
} from "@/lib/fold/reconciliation-worker";

// The lines the worker prints when it could not arm the recurring tick, or could
// not read the caller's interval. Asserted whole because each is reported
// instead of being fatal, so the residual state it names is all an operator gets.
const UNARMED_POLL_MESSAGE =
  "Reconciliation worker poll was not armed; no further drains will run until the process restarts";
const DEFAULTED_INTERVAL_MESSAGE =
  "Reconciliation worker poll interval could not be read; the recurring tick is armed at the default interval instead";

describe("running the next reconciliation job", () => {
  it("reports an idle queue without reconciling anything", async () => {
    const { store, calls } = createFakeStore();

    await expect(
      runNextReconciliationJob({
        store,
        reconcile: async () => {
          throw new Error("nothing should be reconciled");
        },
      }),
    ).resolves.toBe("IDLE");

    expect(calls).toEqual([{ method: "claim", args: [] }]);
  });

  it("completes the job it claimed once the fold succeeds", async () => {
    const { store, calls } = createFakeStore({ jobs: [job()] });
    const reconciled: string[] = [];

    await expect(
      runNextReconciliationJob({
        store,
        reconcile: async (repositoryId) => {
          reconciled.push(repositoryId);
        },
      }),
    ).resolves.toBe("RECONCILED");

    expect(reconciled).toEqual(["repo-a"]);
    expect(calls).toEqual([
      { method: "claim", args: [] },
      { method: "complete", args: ["job-1", "lease-1"] },
    ]);
  });

  it("defers to the cooldown the store reports and consumes no attempt", async () => {
    const { store, calls } = createFakeStore({
      jobs: [job()],
      cooldown: new Date("2030-01-02T03:30:00.000Z"),
    });

    await expect(
      runNextReconciliationJob({
        store,
        now: () => new Date("2030-01-02T03:04:05.678Z"),
        reconcile: async () => ({ skipped: true }),
      }),
    ).resolves.toBe("DEFERRED");

    expect(calls).toEqual([
      { method: "claim", args: [] },
      { method: "cooldown", args: ["repo-a"] },
      { method: "defer", args: ["job-1", "lease-1", new Date("2030-01-02T03:30:00.000Z")] },
    ]);
  });

  it("defers by the first retry delay when the repository has no cooldown", async () => {
    const { store, calls } = createFakeStore({ jobs: [job()], cooldown: null });

    await expect(
      runNextReconciliationJob({
        store,
        now: () => new Date("2030-01-02T03:04:05.678Z"),
        reconcile: async () => ({ skipped: true }),
      }),
    ).resolves.toBe("DEFERRED");

    expect(calls.at(-1)).toEqual({
      method: "defer",
      args: ["job-1", "lease-1", new Date("2030-01-02T03:05:05.678Z")],
    });
  });

  it("defers by the first retry delay when the reported cooldown lapses exactly now", async () => {
    const { store, calls } = createFakeStore({
      jobs: [job()],
      cooldown: new Date("2030-01-02T03:04:05.678Z"),
    });

    await expect(
      runNextReconciliationJob({
        store,
        now: () => new Date("2030-01-02T03:04:05.678Z"),
        reconcile: async () => ({ skipped: true }),
      }),
    ).resolves.toBe("DEFERRED");

    expect(calls.at(-1)).toEqual({
      method: "defer",
      args: ["job-1", "lease-1", new Date("2030-01-02T03:05:05.678Z")],
    });
  });

  it("defers by the first retry delay when the reported cooldown lapsed before now", async () => {
    // Deferring to a cooldown already behind the clock would make the job due
    // the moment it was deferred, and the poll loop would spin on it.
    const { store, calls } = createFakeStore({
      jobs: [job()],
      cooldown: new Date("2030-01-02T02:04:05.678Z"),
    });

    await expect(
      runNextReconciliationJob({
        store,
        now: () => new Date("2030-01-02T03:04:05.678Z"),
        reconcile: async () => ({ skipped: true }),
      }),
    ).resolves.toBe("DEFERRED");

    expect(calls.at(-1)).toEqual({
      method: "defer",
      args: ["job-1", "lease-1", new Date("2030-01-02T03:05:05.678Z")],
    });
  });

  it("schedules each retry at the delay that attempt has earned", async () => {
    const expectedRunAfter = [
      "2030-01-02T03:05:05.678Z",
      "2030-01-02T03:09:05.678Z",
      "2030-01-02T03:19:05.678Z",
      "2030-01-02T04:04:05.678Z",
    ];

    for (const [index, runAfter] of expectedRunAfter.entries()) {
      const attemptCount = index + 1;
      const { store, calls } = createFakeStore({ jobs: [job({ attemptCount })] });
      const failure = new Error("GitHub is unreachable");
      const reported: { repositoryId: string; error: unknown }[] = [];

      await expect(
        runNextReconciliationJob({
          store,
          now: () => new Date("2030-01-02T03:04:05.678Z"),
          reconcile: async () => {
            throw failure;
          },
          onFailure: (repositoryId, error) => {
            reported.push({ repositoryId, error });
          },
        }),
      ).resolves.toBe("RETRY_SCHEDULED");

      expect(reported).toEqual([{ repositoryId: "repo-a", error: failure }]);
      expect(calls).toEqual([
        { method: "claim", args: [] },
        { method: "retry", args: ["job-1", "lease-1", new Date(runAfter)] },
      ]);
    }
  });

  it("fails the job on the attempt after the last retry delay", async () => {
    const { store, calls } = createFakeStore({ jobs: [job({ attemptCount: 5 })] });
    const failure = new Error("GitHub is unreachable");
    const reported: unknown[] = [];

    await expect(
      runNextReconciliationJob({
        store,
        now: () => new Date("2030-01-02T03:04:05.678Z"),
        reconcile: async () => {
          throw failure;
        },
        onFailure: (_repositoryId, error) => {
          reported.push(error);
        },
      }),
    ).resolves.toBe("FAILED");

    expect(reported).toEqual([failure]);
    expect(calls).toEqual([
      { method: "claim", args: [] },
      { method: "fail", args: ["job-1", "lease-1"] },
    ]);
  });

  it("records the retry even when the failure reporter itself throws", async () => {
    const { store, calls } = createFakeStore({ jobs: [job()] });

    await expect(
      runNextReconciliationJob({
        store,
        now: () => new Date("2030-01-02T03:04:05.678Z"),
        reconcile: async () => {
          throw new Error("GitHub is unreachable");
        },
        onFailure: () => {
          throw new Error("the reporter is broken too");
        },
      }),
    ).resolves.toBe("RETRY_SCHEDULED");

    expect(calls.at(-1)).toEqual({
      method: "retry",
      args: ["job-1", "lease-1", new Date("2030-01-02T03:05:05.678Z")],
    });
  });

  it("reports a fold that throws on the console when no reporter is attached", async () => {
    const { store, calls } = createFakeStore({ jobs: [job()] });
    const unfolded = new Error("GitHub is unreachable");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(
        runNextReconciliationJob({
          store,
          now: () => new Date("2030-01-02T03:04:05.678Z"),
          reconcile: async () => {
            throw unfolded;
          },
        }),
      ).resolves.toBe("RETRY_SCHEDULED");

      expect(calls.at(-1)).toEqual({
        method: "retry",
        args: ["job-1", "lease-1", new Date("2030-01-02T03:05:05.678Z")],
      });
      expect(logged.mock.calls).toEqual([
        ["Reconciliation failed for repository", "repo-a", unfolded],
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it("treats a failure reporter whose retrieval throws as no reporter at all", async () => {
    const { store, calls } = createFakeStore({ jobs: [job()] });
    const unfolded = new Error("GitHub is unreachable");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // A lazily wired reporter: the accessor throws until its collector is
    // configured, and reading the member is the first thing the worker does with
    // it. Guarding only the call leaves this one to escape.
    const dependencies = {
      store,
      now: () => new Date("2030-01-02T03:04:05.678Z"),
      reconcile: async () => {
        throw unfolded;
      },
      get onFailure(): (repositoryId: string, error: unknown) => void {
        throw new Error("the reporter is not wired up yet");
      },
    };

    try {
      await expect(runNextReconciliationJob(dependencies)).resolves.toBe("RETRY_SCHEDULED");

      expect(calls.at(-1)).toEqual({
        method: "retry",
        args: ["job-1", "lease-1", new Date("2030-01-02T03:05:05.678Z")],
      });
      expect(logged.mock.calls).toEqual([
        ["Reconciliation failed for repository", "repo-a", unfolded],
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it("records the retry when the failure reporter rejects instead of throwing", async () => {
    const { store, calls } = createFakeStore({ jobs: [job()] });
    const unfolded = new Error("GitHub is unreachable");
    const rejections = watchUnhandledRejections();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const reports: string[] = [];

    try {
      await expect(
        runNextReconciliationJob({
          store,
          now: () => new Date("2030-01-02T03:04:05.678Z"),
          reconcile: async () => {
            throw unfolded;
          },
          // The ordinary shape of a reporter that ships the failure somewhere:
          // async, and able to reject. A `try` around the call cannot see that
          // rejection, and the returned promise is not the worker's to discard.
          onFailure: async (repositoryId) => {
            reports.push(repositoryId);
            throw new Error("shipping the report failed");
          },
        }),
      ).resolves.toBe("RETRY_SCHEDULED");

      expect(reports).toEqual(["repo-a"]);
      expect(calls.at(-1)).toEqual({
        method: "retry",
        args: ["job-1", "lease-1", new Date("2030-01-02T03:05:05.678Z")],
      });
      await settle();
      await settle();
      expect(rejections.recorded).toEqual([]);
      expect(logged.mock.calls).toEqual([
        ["Reconciliation failed for repository", "repo-a", unfolded],
      ]);
    } finally {
      logged.mockRestore();
      rejections.stop();
    }
  });
});

describe("draining the reconciliation queue", () => {
  it("keeps working jobs until the queue reports itself idle", async () => {
    const { store, calls } = createFakeStore({
      jobs: [
        job({ id: "job-1", repositoryId: "repo-a" }),
        job({ id: "job-2", repositoryId: "repo-b" }),
        job({ id: "job-3", repositoryId: "repo-c" }),
      ],
      cooldown: null,
    });

    await expect(
      drainReconciliationJobs({
        store,
        now: () => new Date("2030-01-02T03:04:05.678Z"),
        reconcile: async (repositoryId) => {
          if (repositoryId === "repo-b") {
            return { skipped: true };
          }
          if (repositoryId === "repo-c") {
            throw new Error("GitHub is unreachable");
          }
        },
      }),
    ).resolves.toEqual(["RECONCILED", "DEFERRED", "RETRY_SCHEDULED"]);

    expect(calls.filter((call) => call.method === "claim")).toHaveLength(4);
  });

  it("stops at the job bound it was given", async () => {
    const { store, calls } = createFakeStore({ jobs: moreJobsThanAnyDrainTakes() });

    await expect(
      drainReconciliationJobs(
        { store, reconcile: async () => {} },
        { maxJobs: 3 },
      ),
    ).resolves.toEqual(["RECONCILED", "RECONCILED", "RECONCILED"]);

    expect(calls.filter((call) => call.method === "claim")).toHaveLength(3);
  });

  it("stops after fifty jobs when no bound is given", async () => {
    const { store, calls } = createFakeStore({ jobs: moreJobsThanAnyDrainTakes() });

    await expect(
      drainReconciliationJobs({ store, reconcile: async () => {} }),
    ).resolves.toHaveLength(50);

    expect(calls.filter((call) => call.method === "claim")).toHaveLength(50);
  });
});

describe("the scheduled reconciliation worker", () => {
  it("drains once on start and again on every tick", async () => {
    const timer = createTimer();
    let drains = 0;

    startReconciliationWorker({
      drain: async () => {
        drains += 1;
      },
      schedule: timer.schedule,
    });
    await timer.settle();

    expect(drains).toBe(1);
    expect(timer.intervalMs).toBe(RECONCILIATION_WORKER_POLL_INTERVAL_MS);

    await timer.tick();
    expect(drains).toBe(2);

    await timer.tick();
    expect(drains).toBe(3);
  });

  it("drops a tick that arrives while the previous drain is still running", async () => {
    const timer = createTimer();
    let started = 0;
    let release: (() => void) | undefined;

    startReconciliationWorker({
      drain: async () => {
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

  it("contains an intervalMs accessor that throws and arms the default cadence", async () => {
    // intervalMs is an injection seam like the callables around it, so reading it
    // can throw where a lazily wired member is not ready yet. What failed is a
    // tuning number, not the mechanism, so the tick is armed at this module's own
    // cadence rather than abandoned.
    const timer = createTimer();
    const unreadable = new Error("the interval is not wired up yet");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let drains = 0;

    try {
      startReconciliationWorker({
        drain: async () => {
          drains += 1;
        },
        schedule: timer.schedule,
        get intervalMs(): number {
          throw unreadable;
        },
      });
      await timer.settle();

      expect(drains).toBe(1);
      expect(timer.intervalMs).toBe(RECONCILIATION_WORKER_POLL_INTERVAL_MS);
      expect(logged.mock.calls).toEqual([[DEFAULTED_INTERVAL_MESSAGE, unreadable]]);

      await timer.tick();
      expect(drains).toBe(2);
    } finally {
      logged.mockRestore();
    }
  });

  it("runs the startup drain before it reads intervalMs", async () => {
    // The startup drain is what picks up the jobs enqueued while the server was
    // down, so nothing read to arm the recurring tick may cost it.
    const timer = createTimer();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const order: string[] = [];

    try {
      startReconciliationWorker({
        drain: async () => {
          order.push("drained");
        },
        schedule: timer.schedule,
        get intervalMs(): number {
          order.push("read interval");
          throw new Error("the interval is not wired up yet");
        },
      });
      await timer.settle();

      expect(order).toEqual(["drained", "read interval"]);
    } finally {
      logged.mockRestore();
    }
  });

  it("treats a scheduler whose retrieval throws as unusable and arms nothing", async () => {
    // A broken mechanism is not a tuning number: substituting the default here
    // would arm a real poll nobody asked for and hide the defect, so nothing is
    // armed and the line says the drains have stopped.
    const unusable = new Error("the scheduler is not wired up yet");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let drains = 0;

    try {
      startReconciliationWorker({
        drain: async () => {
          drains += 1;
        },
        get schedule(): (callback: () => void, everyMs: number) => void {
          throw unusable;
        },
      });
      await settle();

      // The startup drain still ran; only the recurring tick was lost.
      expect(drains).toBe(1);
      expect(logged.mock.calls).toEqual([[UNARMED_POLL_MESSAGE, unusable]]);
    } finally {
      logged.mockRestore();
    }
  });

  it("arms nothing and reports when the scheduler is not callable", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const schedule = {
      drain: async () => {},
      schedule: "every five seconds",
    } as unknown as Parameters<typeof startReconciliationWorker>[0];

    try {
      startReconciliationWorker(schedule);
      await settle();

      // Nothing failed — the member simply held a value that cannot be called —
      // so the line stands alone rather than carrying a reason.
      expect(logged.mock.calls).toEqual([[UNARMED_POLL_MESSAGE]]);
    } finally {
      logged.mockRestore();
    }
  });

  it("installs the default poll when the scheduler is null", async () => {
    // An untyped caller can hand over null where the optional member expresses
    // only undefined; a nullish member is no scheduler at all, not a broken one.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const timers: Array<{ unrefed: boolean }> = [];
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((() => {
      const timer = { unrefed: false };
      timers.push(timer);
      return { unref: () => { timer.unrefed = true; } } as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);

    try {
      startReconciliationWorker({
        drain: async () => {},
        schedule: null,
      } as unknown as Parameters<typeof startReconciliationWorker>[0]);
      await settle();

      expect(timers).toEqual([{ unrefed: true }]);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      setIntervalSpy.mockRestore();
      logged.mockRestore();
    }
  });

  it("honours an interval the caller chooses", async () => {
    const timer = createTimer();

    startReconciliationWorker({
      drain: async () => {},
      schedule: timer.schedule,
      intervalMs: 250,
    });
    await timer.settle();

    expect(timer.intervalMs).toBe(250);
  });

  it("reports a drain that rejects instead of letting the rejection escape", async () => {
    const rejections = watchUnhandledRejections();
    try {
      const timer = createTimer();
      const failure = new Error("PostgreSQL is unreachable");
      const reported: unknown[] = [];

      startReconciliationWorker({
        drain: async () => {
          throw failure;
        },
        schedule: timer.schedule,
        onFailure: (error) => {
          reported.push(error);
        },
      });
      await timer.settle();
      await timer.settle();

      expect(reported).toEqual([failure]);
      expect(rejections.recorded).toEqual([]);
    } finally {
      rejections.stop();
    }
  });

  it("reports a drain that rejects on the console when no reporter is attached", async () => {
    const rejections = watchUnhandledRejections();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const undrained = new Error("PostgreSQL is unreachable");
    try {
      const timer = createTimer();
      let drains = 0;

      startReconciliationWorker({
        drain: async () => {
          drains += 1;
          throw undrained;
        },
        schedule: timer.schedule,
      });
      await timer.settle();
      await timer.settle();

      // Counted so the empty rejection list stands for a drain that really ran
      // and really rejected, rather than for a drain that never happened.
      expect(drains).toBe(1);
      expect(rejections.recorded).toEqual([]);
      expect(logged.mock.calls).toEqual([
        ["Reconciliation worker could not drain the job queue", undrained],
      ]);
    } finally {
      logged.mockRestore();
      rejections.stop();
    }
  });

  it("treats a drain reporter whose retrieval throws as no reporter at all", async () => {
    const rejections = watchUnhandledRejections();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const undrained = new Error("PostgreSQL is unreachable");
    try {
      const timer = createTimer();
      const drains: string[] = [];
      // The same lazily wired reporter, on the schedule this time: reading the
      // member throws, which no guard around the call can contain.
      const schedule = {
        drain: async () => {
          drains.push("drained");
          throw undrained;
        },
        schedule: timer.schedule,
        get onFailure(): (error: unknown) => void {
          throw new Error("the reporter is not wired up yet");
        },
      };

      startReconciliationWorker(schedule);
      await timer.settle();
      await timer.settle();

      expect(rejections.recorded).toEqual([]);
      expect(logged.mock.calls).toEqual([
        ["Reconciliation worker could not drain the job queue", undrained],
      ]);

      // A reporter that could not even be read must still leave the worker able
      // to drain again.
      await timer.tick();
      await timer.settle();
      expect(drains).toEqual(["drained", "drained"]);
      expect(rejections.recorded).toEqual([]);
    } finally {
      logged.mockRestore();
      rejections.stop();
    }
  });

  it("contains a drain reporter that rejects rather than throwing", async () => {
    const rejections = watchUnhandledRejections();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const undrained = new Error("PostgreSQL is unreachable");
    try {
      const timer = createTimer();
      const reports: unknown[] = [];

      startReconciliationWorker({
        drain: async () => {
          throw undrained;
        },
        schedule: timer.schedule,
        onFailure: async (error) => {
          reports.push(error);
          throw new Error("shipping the report failed");
        },
      });
      await timer.settle();
      await timer.settle();
      await settle();

      expect(reports).toEqual([undrained]);
      expect(rejections.recorded).toEqual([]);
      expect(logged.mock.calls).toEqual([
        ["Reconciliation worker could not drain the job queue", undrained],
      ]);
    } finally {
      logged.mockRestore();
      rejections.stop();
    }
  });

  it("keeps a failure reporter that throws from escaping the drain", async () => {
    const rejections = watchUnhandledRejections();
    try {
      const timer = createTimer();
      const drains: string[] = [];

      startReconciliationWorker({
        drain: async () => {
          drains.push("drained");
          throw new Error("PostgreSQL is unreachable");
        },
        schedule: timer.schedule,
        onFailure: () => {
          throw new Error("the reporter is broken too");
        },
      });
      await timer.settle();
      await timer.settle();
      expect(rejections.recorded).toEqual([]);

      // A reporter that threw must still leave the worker able to drain again.
      await timer.tick();
      await timer.settle();
      expect(drains).toEqual(["drained", "drained"]);
      expect(rejections.recorded).toEqual([]);
    } finally {
      rejections.stop();
    }
  });

  it("drains again on the next tick after a drain rejected", async () => {
    const rejections = watchUnhandledRejections();
    try {
      const timer = createTimer();
      const drains: string[] = [];
      let failing = true;

      startReconciliationWorker({
        drain: async () => {
          if (failing) {
            failing = false;
            drains.push("rejected");
            throw new Error("PostgreSQL is unreachable");
          }
          drains.push("drained");
        },
        schedule: timer.schedule,
        onFailure: () => {},
      });
      await timer.settle();
      expect(drains).toEqual(["rejected"]);

      await timer.tick();
      expect(drains).toEqual(["rejected", "drained"]);
    } finally {
      rejections.stop();
    }
  });

  it("polls every five seconds, because a webhook now waits out this poll", () => {
    expect(RECONCILIATION_WORKER_POLL_INTERVAL_MS).toBe(5_000);
  });

  it("backs off over one minute, five, fifteen and an hour", () => {
    expect(RECONCILIATION_RETRY_DELAYS_MS).toEqual([60_000, 300_000, 900_000, 3_600_000]);
  });
});

function job(overrides: Partial<ClaimedReconciliationJob> = {}): ClaimedReconciliationJob {
  return {
    id: "job-1",
    repositoryId: "repo-a",
    reason: "WEBHOOK",
    attemptCount: 1,
    leaseToken: "lease-1",
    ...overrides,
  };
}

function moreJobsThanAnyDrainTakes(): ClaimedReconciliationJob[] {
  return Array.from({ length: 200 }, (_value, index) =>
    job({ id: `job-${index + 1}`, repositoryId: `repo-${index + 1}` }),
  );
}

function createFakeStore(
  options: { jobs?: ClaimedReconciliationJob[]; cooldown?: Date | null } = {},
) {
  const calls: { method: string; args: unknown[] }[] = [];
  const pending = [...(options.jobs ?? [])];
  const record = (method: string, args: unknown[]) => {
    calls.push({ method, args });
  };

  const store: ReconciliationWorkerStore = {
    claimNextReconciliationJob: async () => {
      record("claim", []);
      return pending.shift() ?? null;
    },
    completeReconciliationJob: async (jobId, leaseToken) => {
      record("complete", [jobId, leaseToken]);
      return true;
    },
    deferReconciliationJob: async (jobId, leaseToken, runAfter) => {
      record("defer", [jobId, leaseToken, runAfter]);
      return true;
    },
    retryReconciliationJob: async (jobId, leaseToken, runAfter) => {
      record("retry", [jobId, leaseToken, runAfter]);
      return true;
    },
    failReconciliationJob: async (jobId, leaseToken) => {
      record("fail", [jobId, leaseToken]);
      return true;
    },
    getReconciliationCooldown: async (repositoryId) => {
      record("cooldown", [repositoryId]);
      return options.cooldown ?? null;
    },
  };

  return { store, calls };
}

/** Lets a floating promise settle, for the cases that have no timer to settle. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

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

/**
 * Records the rejections Node would otherwise have thrown on.
 *
 * Node's default for an unhandled rejection is to throw, which would take the
 * server down, so the tests below need to see the ones that got away rather
 * than only the ones the worker reported.
 */
function watchUnhandledRejections() {
  const recorded: unknown[] = [];
  const listener = (reason: unknown) => {
    recorded.push(reason);
  };
  process.on("unhandledRejection", listener);

  return {
    recorded,
    stop() {
      process.off("unhandledRejection", listener);
    },
  };
}
