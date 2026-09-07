import { afterEach, describe, expect, it, vi } from "vitest";
import type { ClaimedReconciliationJob } from "@/lib/fold/reconciliation-jobs";
import {
  drainReconciliationJobs,
  RECONCILIATION_RETRY_DELAYS_MS,
  RECONCILIATION_LEASE_RENEWAL_INTERVAL_MS,
  RECONCILIATION_WORKER_POLL_INTERVAL_MS,
  runNextReconciliationJob,
  startReconciliationWorker,
  type ReconciliationWorkerStore,
} from "@/lib/fold/reconciliation-worker";

const heldSignals = new Set<() => void>();
afterEach(() => {
  // Runner cleanup also executes on timeout, when the test's finally is still
  // awaiting an operation. Restore globals and release every held signal.
  if (vi.isFakeTimers()) vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const release of heldSignals) release();
});

// The lines the worker prints when it could not arm the recurring tick, or could
// not read the caller's interval. Asserted whole because each is reported
// instead of being fatal, so the residual state it names is all an operator gets.
const UNARMED_POLL_MESSAGE =
  "Reconciliation worker poll was not armed; no further drains will run until the process restarts";
const DEFAULTED_INTERVAL_MESSAGE =
  "Reconciliation worker poll interval could not be read; the recurring tick is armed at the default interval instead";
const DEFAULTED_CONCURRENCY_MESSAGE =
  "Reconciliation worker concurrency could not be used; drains use the default concurrency instead";

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

describe("reconciliation lease heartbeat", () => {
  it("passes one absolute claim deadline to every renewal", async () => {
    const { store } = createFakeStore({ jobs: [job()] });
    const renew = vi.spyOn(store, "renewReconciliationJobLease");
    const timer = createRenewalTimer();
    const fold = signal();
    let time = Date.parse("2030-01-01T12:00:00Z");
    const running = runNextReconciliationJob({
      store, reconcile: () => fold.promise, now: () => new Date(time), ...timer.dependencies,
    });
    try {
      await timer.armed;
      for (const elapsed of [5_000, 599_999]) {
        time = Date.parse("2030-01-01T12:00:00Z") + elapsed;
        await timer.tick();
      }
      expect(renew.mock.calls).toEqual([
        ["job-1", "lease-1", new Date("2030-01-01T12:10:00Z")],
        ["job-1", "lease-1", new Date("2030-01-01T12:10:00Z")],
      ]);
    } finally {
      fold.resolve();
      await running;
    }
  });

  it("cancels at the cap while a renewal is still in flight", async () => {
    const { store } = createFakeStore({ jobs: [job()] });
    const timer = createRenewalTimer();
    const fold = signal();
    const entered = signal();
    const release = signal();
    let time = Date.parse("2030-01-01T12:00:00Z");
    store.renewReconciliationJobLease = async () => {
      entered.resolve();
      await release.promise;
      return true;
    };
    const running = runNextReconciliationJob({
      store, reconcile: () => fold.promise, now: () => new Date(time), ...timer.dependencies,
    });
    let pending: Promise<void> | undefined;
    try {
      await timer.armed;
      pending = timer.tick();
      await entered.promise;
      time += 600_000;
      await timer.tick();
      expect(timer.cancellations).toBe(1);
    } finally {
      release.resolve();
      fold.resolve();
      await pending;
      await running;
    }
    expect(timer.cancellations).toBe(1);
  });

  it("cancels setup even when its scheduler delivers synchronously at the cap", async () => {
    const { store } = createFakeStore({ jobs: [job()] });
    let time = Date.parse("2030-01-01T12:00:00Z");
    const cancel = vi.fn();
    let tick: Promise<void> | undefined;
    const running = runNextReconciliationJob({
      store, reconcile: async () => {}, now: () => new Date(time),
      scheduleLeaseRenewal(callback) {
        time += 600_000;
        tick = callback();
        return cancel;
      },
    });
    await expect(running).resolves.toBe("RECONCILED");
    await tick;
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("stops renewing ten minutes after the claim even while the fold stays pending", async () => {
    const { store, calls } = createFakeStore({ jobs: [job()] });
    const timer = createRenewalTimer();
    const fold = signal();
    const claimedAt = Date.parse("2030-01-01T12:00:00Z");
    let time = claimedAt;
    const running = runNextReconciliationJob({
      store,
      reconcile: () => fold.promise,
      now: () => new Date(time),
      ...timer.dependencies,
    });
    await timer.armed;

    try {
      time = claimedAt + 5_000;
      await timer.tick();
      time = claimedAt + 10 * 60_000;
      await timer.tick();
      time += 5_000;
      await timer.tick();
      expect(calls).toEqual([
        { method: "claim", args: [] },
        { method: "renew", args: ["job-1", "lease-1"] },
      ]);
      expect(timer.cancellations).toBe(1);
    } finally {
      fold.resolve();
      await running;
    }
    expect(timer.cancellations).toBe(1);
  });

  it("continues renewing immediately before the ten-minute cap", async () => {
    const { store, calls } = createFakeStore({ jobs: [job()] });
    const timer = createRenewalTimer();
    const fold = signal();
    const claimedAt = Date.parse("2030-01-01T12:00:00Z");
    let time = claimedAt;
    const running = runNextReconciliationJob({
      store,
      reconcile: () => fold.promise,
      now: () => new Date(time),
      ...timer.dependencies,
    });
    await timer.armed;

    try {
      for (const elapsed of [5_000, 5 * 60_000, 10 * 60_000 - 1]) {
        time = claimedAt + elapsed;
        await timer.tick();
      }
      expect(calls).toEqual([
        { method: "claim", args: [] },
        { method: "renew", args: ["job-1", "lease-1"] },
        { method: "renew", args: ["job-1", "lease-1"] },
        { method: "renew", args: ["job-1", "lease-1"] },
      ]);
      expect(timer.cancellations).toBe(0);
    } finally {
      fold.resolve();
      await running;
    }
    expect(timer.cancellations).toBe(1);
  });

  it("renews the claimed lease every five seconds while the fold is in flight", async () => {
    const { store, calls } = createFakeStore({ jobs: [job()] });
    const timer = createRenewalTimer();
    const fold = signal();
    const running = runNextReconciliationJob({
      store,
      reconcile: () => fold.promise,
      ...timer.dependencies,
    });
    await timer.armed;

    try {
      expect(timer.intervalMs).toBe(5_000);
      expect(timer.intervalMs).toBe(RECONCILIATION_LEASE_RENEWAL_INTERVAL_MS);
      await timer.tick();
      await timer.tick();
      expect(calls).toEqual([
        { method: "claim", args: [] },
        { method: "renew", args: ["job-1", "lease-1"] },
        { method: "renew", args: ["job-1", "lease-1"] },
      ]);
    } finally {
      fold.resolve();
      await running;
    }
  });

  it.each([
    { path: "reconciled", writer: "completeReconciliationJob", outcome: "RECONCILED", attempt: 1 },
    { path: "deferred", writer: "deferReconciliationJob", outcome: "DEFERRED", attempt: 1 },
    { path: "fold threw and retried", writer: "retryReconciliationJob", outcome: "RETRY_SCHEDULED", attempt: 1 },
    { path: "fold threw and failed", writer: "failReconciliationJob", outcome: "FAILED", attempt: 5 },
  ] as const)("renews through the $path outcome write and stops exactly once", async ({ writer, outcome, attempt }) => {
    const { store, calls } = createFakeStore({ jobs: [job({ attemptCount: attempt })] });
    const timer = createRenewalTimer();
    const fold = signal();
    const write = signal();
    const enteredWrite = signal();
    const original = store[writer].bind(store);
    store[writer] = async (id: string, token: string, runAfter?: Date) => {
      enteredWrite.resolve();
      await write.promise;
      return Reflect.apply(original, store, [id, token, runAfter]);
    };
    const running = runNextReconciliationJob({
      store,
      ...timer.dependencies,
      onFailure: () => {},
      reconcile: async () => {
        await fold.promise;
        if (outcome === "DEFERRED") return { skipped: true };
        if (outcome !== "RECONCILED") throw new Error("fold failed");
      },
    });
    try {
      await timer.armed;
      await timer.tick();
      expect(timer.cancellations).toBe(0);
      fold.resolve();
      await enteredWrite.promise;
      await timer.tick();
      expect(timer.cancellations).toBe(0);
      expect(calls.filter(({ method }) => method === "renew")).toHaveLength(2);
      write.resolve();
      await expect(running).resolves.toBe(outcome);
      expect(calls.at(-1)?.method).toBe(writer.replace("ReconciliationJob", ""));
      expect(timer.cancellations).toBe(1);
      const completedCalls = [...calls];
      await timer.tick();
      expect(calls).toEqual(completedCalls);
      expect(timer.cancellations).toBe(1);
    } finally {
      fold.resolve();
      write.resolve();
      await running;
    }
  });

  it.each([
    { writer: "completeReconciliationJob", outcome: "RECONCILED", attempt: 1 },
    { writer: "deferReconciliationJob", outcome: "DEFERRED", attempt: 1 },
    { writer: "retryReconciliationJob", outcome: "RETRY_SCHEDULED", attempt: 1 },
    { writer: "failReconciliationJob", outcome: "FAILED", attempt: 5 },
  ] as const)("stops exactly once when $writer throws", async ({ writer, outcome, attempt }) => {
    const { store, calls } = createFakeStore({ jobs: [job({ attemptCount: attempt })] });
    const timer = createRenewalTimer();
    const failure = new Error("outcome write failed");
    store[writer] = async () => { throw failure; };
    await expect(runNextReconciliationJob({
      store,
      ...timer.dependencies,
      onFailure: () => {},
      reconcile: async () => {
        if (outcome === "DEFERRED") return { skipped: true };
        if (outcome !== "RECONCILED") throw new Error("fold failed");
      },
    })).rejects.toBe(failure);
    expect(timer.cancellations).toBe(1);
    const completedCalls = [...calls];
    await timer.tick();
    expect(calls).toEqual(completedCalls);
    expect(timer.cancellations).toBe(1);
  });

  it("reports a rejected renewal, keeps renewing, and preserves the fold outcome", async () => {
    const { store, calls } = createFakeStore({ jobs: [job()] });
    const timer = createRenewalTimer();
    const fold = signal();
    const failure = new Error("renewal database hiccup");
    const renew = store.renewReconciliationJobLease.bind(store);
    let attempts = 0;
    store.renewReconciliationJobLease = async (id, token, deadline) => {
      await renew(id, token, deadline);
      if (++attempts === 1) throw failure;
      return true;
    };
    const rejections = watchUnhandledRejections();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const running = runNextReconciliationJob({ store, reconcile: () => fold.promise, ...timer.dependencies });
    try {
      await timer.armed;
      await timer.tick();
      await timer.tick();
      expect(calls.filter(({ method }) => method === "renew")).toHaveLength(2);
      await surfaceUnhandledRejections();
      expect(rejections.recorded).toEqual([]);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]?.slice(1)).toEqual(["job-1", failure]);
      expect(timer.cancellations).toBe(0);
      fold.resolve();
      await expect(running).resolves.toBe("RECONCILED");
      expect(calls.at(-1)).toEqual({ method: "complete", args: ["job-1", "lease-1"] });
      expect(timer.cancellations).toBe(1);
    } finally {
      fold.resolve();
      await running;
      logged.mockRestore();
      rejections.stop();
    }
  });

  it("stops on a lost lease and still attempts the guarded outcome write", async () => {
    const { store, calls } = createFakeStore({ jobs: [job()] });
    const timer = createRenewalTimer();
    const fold = signal();
    const renew = store.renewReconciliationJobLease.bind(store);
    store.renewReconciliationJobLease = async (id, token, deadline) => { await renew(id, token, deadline); return false; };
    const complete = store.completeReconciliationJob.bind(store);
    store.completeReconciliationJob = async (id, token) => { await complete(id, token); return false; };
    const running = runNextReconciliationJob({ store, reconcile: () => fold.promise, ...timer.dependencies });
    try {
      await timer.armed;
      await timer.tick();
      expect(timer.cancellations).toBe(1);
      await timer.tick();
      expect(calls.filter(({ method }) => method === "renew")).toHaveLength(1);
      fold.resolve();
      await expect(running).resolves.toBe("RECONCILED");
      expect(calls.at(-1)).toEqual({ method: "complete", args: ["job-1", "lease-1"] });
      expect(timer.cancellations).toBe(1);
    } finally {
      fold.resolve();
      await running;
    }
  });

  it("wires the default renewal callback, unrefs its timer, and clears it on completion", async () => {
    const { store, calls } = createFakeStore({ jobs: [job()] });
    const fold = signal();
    const entered = signal();
    let fire!: () => void;
    const unref = vi.fn();
    const timer = { unref } as unknown as ReturnType<typeof setInterval>;
    const schedule = vi.spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void) => {
      fire = callback;
      return timer;
    }) as typeof setInterval);
    const cancel = vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
    const running = runNextReconciliationJob({ store, reconcile: async () => { entered.resolve(); await fold.promise; } });
    try {
      await entered.promise;
      expect(schedule).toHaveBeenCalledWith(expect.any(Function), 5_000);
      expect(unref).toHaveBeenCalledTimes(1);
      fire();
      expect(calls.filter(({ method }) => method === "renew")).toEqual([
        { method: "renew", args: ["job-1", "lease-1"] },
      ]);
      fold.resolve();
      await expect(running).resolves.toBe("RECONCILED");
      expect(cancel.mock.calls).toEqual([[timer]]);
    } finally {
      fold.resolve();
      await running;
      schedule.mockRestore();
      cancel.mockRestore();
    }
  });

  it.each(["accessor", "throw", "reject", "uncallable"] as const)(
    "contains a scheduler %s failure without changing the outcome",
    async (mode) => {
      const { store } = createFakeStore({ jobs: [job()] });
      const failure = new Error("scheduler failed");
      const dependencies = {
        store, reconcile: async () => {},
        get scheduleLeaseRenewal() {
          if (mode === "accessor") throw failure;
          if (mode === "uncallable") return "broken" as never;
          return function (this: unknown) {
            expect(this).toBe(dependencies);
            if (mode === "reject") return Promise.reject(failure);
            throw failure;
          };
        },
      };
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      const rejections = watchUnhandledRejections();
      try {
        await expect(runNextReconciliationJob(dependencies)).resolves.toBe("RECONCILED");
        await surfaceUnhandledRejections();
        expect(rejections.recorded).toEqual([]);
        expect(logged).toHaveBeenCalledTimes(1);
        expect(logged.mock.calls[0]?.slice(1)).toEqual(["job-1", mode === "uncallable" ? undefined : failure]);
      } finally {
        logged.mockRestore();
        rejections.stop();
      }
    },
  );

  it.each(["throw", "reject"] as const)("contains a cancellation %s failure", async (mode) => {
    const { store } = createFakeStore({ jobs: [job()] });
    const failure = new Error("cancellation failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const rejections = watchUnhandledRejections();
    try {
      await expect(runNextReconciliationJob({
        store, reconcile: async () => {},
        scheduleLeaseRenewal: () => () => {
          if (mode === "reject") return Promise.reject(failure);
          throw failure;
        },
      })).resolves.toBe("RECONCILED");
      await surfaceUnhandledRejections();
      expect(rejections.recorded).toEqual([]);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]?.slice(1)).toEqual(["job-1", failure]);
    } finally {
      logged.mockRestore();
      rejections.stop();
    }
  });

  it("cancels a custom scheduler's own timer without a separate cancellation injection", async () => {
    vi.useFakeTimers();
    const { store } = createFakeStore({ jobs: [job()] });
    try {
      await expect(runNextReconciliationJob({
        store, reconcile: async () => {},
        scheduleLeaseRenewal(callback, everyMs) {
          const timer = setInterval(callback, everyMs);
          return () => clearInterval(timer);
        },
      })).resolves.toBe("RECONCILED");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it("cancels asynchronous setup that produces a timer after the outcome write", async () => {
    vi.useFakeTimers();
    const { store } = createFakeStore({ jobs: [job()] });
    const setup = signal();
    const written = signal();
    const complete = store.completeReconciliationJob.bind(store);
    store.completeReconciliationJob = async (id, token) => {
      const result = await complete(id, token);
      written.resolve();
      return result;
    };
    const running = runNextReconciliationJob({
      store, reconcile: async () => {},
      async scheduleLeaseRenewal(callback, everyMs) {
        await setup.promise;
        const timer = setInterval(callback, everyMs);
        return () => clearInterval(timer);
      },
    });
    try {
      await written.promise;
      setup.resolve();
      await expect(running).resolves.toBe("RECONCILED");
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      setup.resolve();
      await running;
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it.each([
    { rejects: false, stopFirst: false }, { rejects: true, stopFirst: false },
    { rejects: false, stopFirst: true }, { rejects: true, stopFirst: true },
  ])("bounds renewal concurrency (rejects=$rejects, stopFirst=$stopFirst)", async ({ rejects, stopFirst }) => {
    const { store, calls } = createFakeStore({ jobs: [job()] });
    const timer = createRenewalTimer();
    const fold = signal();
    const enteredFold = signal();
    const enteredRenewal = signal();
    const releaseRenewal = signal();
    const renew = store.renewReconciliationJobLease.bind(store);
    let attempts = 0;
    const failure = new Error("held renewal failed");
    store.renewReconciliationJobLease = async (id, token, deadline) => {
      await renew(id, token, deadline);
      attempts += 1;
      enteredRenewal.resolve();
      if (attempts === 1) {
        await releaseRenewal.promise;
        if (rejects) throw failure;
      }
      return true;
    };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const running = runNextReconciliationJob({
      store, ...timer.dependencies,
      reconcile: async () => { enteredFold.resolve(); await fold.promise; },
    });
    let pendingTick: Promise<void> | undefined;
    try {
      await enteredFold.promise;
      pendingTick = timer.tick();
      await enteredRenewal.promise;
      await timer.tick();
      await timer.tick();
      expect(calls.filter(({ method }) => method === "renew")).toHaveLength(1);
      if (stopFirst) {
        fold.resolve();
        await running;
        expect(timer.cancellations).toBe(1);
      }
      releaseRenewal.resolve();
      await pendingTick;
      await timer.tick();
      expect(calls.filter(({ method }) => method === "renew")).toHaveLength(stopFirst ? 1 : 2);
      expect(logged).toHaveBeenCalledTimes(rejects ? 1 : 0);
      if (rejects) expect(logged.mock.calls[0]?.slice(1)).toEqual(["job-1", failure]);
    } finally {
      releaseRenewal.resolve();
      fold.resolve();
      await pendingTick;
      await running;
      logged.mockRestore();
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
  it("runs the default scheduler at the real poll interval", async () => {
    vi.useFakeTimers();
    let started = 0;

    startReconciliationWorker({
      drain: async () => { started += 1; },
      concurrency: 1,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(started).toBe(1);
    await vi.advanceTimersByTimeAsync(RECONCILIATION_WORKER_POLL_INTERVAL_MS - 1);
    expect(started).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(started).toBe(2);
    await vi.advanceTimersByTimeAsync(RECONCILIATION_WORKER_POLL_INTERVAL_MS);
    expect(started).toBe(3);
  });

  it("drains once on start and again on every tick at capacity one", async () => {
    const timer = createTimer();
    let drains = 0;

    startReconciliationWorker({
      drain: async () => {
        drains += 1;
      },
      schedule: timer.schedule,
      concurrency: 1,
    });
    await timer.settle();

    expect(drains).toBe(1);
    expect(timer.intervalMs).toBe(RECONCILIATION_WORKER_POLL_INTERVAL_MS);

    await timer.tick();
    expect(drains).toBe(2);

    await timer.tick();
    expect(drains).toBe(3);
  });

  it("claims a newly due repository on a later poll while another fold is held (issue 202)", async () => {
    const timer = createTimer();
    const held = signal();
    const pending = [job({ id: "job-b", repositoryId: "repo-b" })];
    const claims: Array<{ phase: string; repositoryId: string | null }> = [];
    const { store } = createFakeStore();
    let phase = "startup";
    let bFolding = false;

    startReconciliationWorker({
      drain: () => drainReconciliationJobs({
        store: {
          ...store,
          claimNextReconciliationJob: async () => {
            const claimed = pending.shift() ?? null;
            claims.push({ phase, repositoryId: claimed?.repositoryId ?? null });
            return claimed;
          },
        },
        reconcile: async (repositoryId) => {
          if (repositoryId === "repo-b") {
            bFolding = true;
            await held.promise;
            bFolding = false;
          }
        },
        scheduleLeaseRenewal: () => () => {},
      }),
      schedule: timer.schedule,
    });
    await timer.settle();
    expect(bFolding).toBe(true);
    expect(claims).toContainEqual({ phase: "startup", repositoryId: "repo-b" });

    phase = "early poll";
    await timer.tick();
    // The idle drain completes before A becomes due; the later pickup must
    // come from recurring admission, not the first overlap at startup.
    phase = "later poll";
    pending.push(job({ id: "job-a", repositoryId: "repo-a" }));
    await timer.tick();
    expect(claims).toContainEqual({ phase: "later poll", repositoryId: "repo-a" });
    expect(claims).toContainEqual({ phase: "early poll", repositoryId: null });
    expect(bFolding).toBe(true);
  });

  it.each([undefined, 1, 2, 6])("fills startup to concurrency %s and drops ticks at capacity", async (concurrency) => {
    const timer = createTimer();
    const held = signal();
    let started = 0;
    const capacity = concurrency ?? 4;

    startReconciliationWorker({
      drain: async () => {
        started += 1;
        await held.promise;
      },
      schedule: timer.schedule,
      concurrency,
    });
    expect(started).toBe(capacity);
    await timer.tick();
    await timer.tick();
    expect(started).toBe(capacity);
  });

  it("fills only the slots freed since the last tick", async () => {
    const timer = createTimer();
    const held = Array.from({ length: 4 }, () => signal());
    const replacements = signal();
    let started = 0;

    startReconciliationWorker({
      drain: async () => {
        const index = started++;
        await (held[index] ?? replacements).promise;
      },
      schedule: timer.schedule,
    });
    expect(started).toBe(4);
    held[0].resolve();
    held[2].resolve();
    await timer.settle();
    expect(started).toBe(4);
    await timer.tick();
    expect(started).toBe(6);
    await timer.tick();
    expect(started).toBe(6);
  });

  it("snapshots free slots so a synchronously throwing drain terminates each fill", async () => {
    const timer = createTimer();
    const failure = new Error("synchronous store failure");
    const reported: unknown[] = [];
    let attempted = 0;

    startReconciliationWorker({
      drain: () => { attempted += 1; throw failure; },
      schedule: timer.schedule,
      onFailure: (error) => { reported.push(error); },
    });
    // One protected startup attempt, then one bounded fill of four free slots.
    expect(attempted).toBe(5);
    expect(reported).toEqual(Array(5).fill(failure));
    expect(timer.intervalMs).toBe(RECONCILIATION_WORKER_POLL_INTERVAL_MS);
    await timer.tick();
    expect(attempted).toBe(9);
    expect(reported).toEqual(Array(9).fill(failure));
  });

  it.each(["resolves", "rejects"] as const)("releases exactly one slot when a drain %s", async (outcome) => {
    const timer = createTimer();
    const first = signal();
    const others = signal();
    const failure = new Error("drain failed");
    const reported: unknown[] = [];
    let started = 0;

    startReconciliationWorker({
      drain: async () => {
        started += 1;
        if (started === 1) {
          await first.promise;
          if (outcome === "rejects") throw failure;
        } else {
          await others.promise;
        }
      },
      schedule: timer.schedule,
      concurrency: 2,
      onFailure: (error) => { reported.push(error); },
    });
    await timer.tick();
    expect(started).toBe(2);
    await timer.tick();
    expect(started).toBe(2);

    first.resolve();
    await timer.settle();
    expect(reported).toEqual(outcome === "rejects" ? [failure] : []);
    // Completing a drain releases its slot; admission still waits for a tick.
    expect(started).toBe(2);
    await timer.tick();
    expect(started).toBe(3);
    await timer.tick();
    expect(started).toBe(3);
  });

  it.each(["throwing accessor", "not callable", "synchronous throw", "non-promise"] as const)(
    "repairs a hostile drain (%s) without leaking or over-releasing a slot",
    async (kind) => {
      const timer = createTimer();
      const held = signal();
      const failure = new Error("drain is not wired yet");
      const reported: unknown[] = [];
      let repaired = false;
      let started = 0;

      startReconciliationWorker({
        get drain(): unknown {
          if (repaired) return async () => { started += 1; await held.promise; };
          if (kind === "throwing accessor") throw failure;
          if (kind === "not callable") return "not a function";
          if (kind === "synchronous throw") return () => { throw failure; };
          return () => undefined;
        },
        concurrency: 1,
        schedule: timer.schedule,
        onFailure: (error: unknown) => { reported.push(error); },
      } as unknown as Parameters<typeof startReconciliationWorker>[0]);
      await timer.settle();
      expect(started).toBe(0);
      if (kind === "non-promise") expect(reported).toEqual([]);
      else if (kind === "not callable") expect(reported[0]).toBeInstanceOf(TypeError);
      else expect(reported).toContain(failure);

      repaired = true;
      await timer.tick();
      expect(started).toBe(1);
      await timer.tick();
      expect(started).toBe(1);
    },
  );

  it("contains a throwing concurrency accessor and keeps the default capacity and poll", async () => {
    const timer = createTimer();
    const held = signal();
    const unreadable = new Error("the concurrency is not wired up yet");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let started = 0;

    startReconciliationWorker({
      drain: async () => { started += 1; await held.promise; },
      schedule: timer.schedule,
      get concurrency(): number { throw unreadable; },
    });
    expect(started).toBe(4);
    expect(timer.intervalMs).toBe(RECONCILIATION_WORKER_POLL_INTERVAL_MS);
    expect(logged.mock.calls).toEqual([[DEFAULTED_CONCURRENCY_MESSAGE, unreadable]]);
    for (let tick = 0; tick < 4; tick += 1) await timer.tick();
    expect(started).toBe(4);
  });

  it("runs the startup drain before reading concurrency, interval or scheduler", async () => {
    const timer = createTimer();
    const held = signal();
    const order: string[] = [];

    startReconciliationWorker({
      drain: async () => { order.push("drained"); await held.promise; },
      get concurrency() { order.push("read concurrency"); return 1; },
      get intervalMs() { order.push("read interval"); return 250; },
      get schedule() { order.push("read scheduler"); return timer.schedule; },
    });
    expect(order).toEqual(["drained", "read concurrency", "read interval", "read scheduler"]);
    await timer.tick();
    expect(order).toEqual(["drained", "read concurrency", "read interval", "read scheduler"]);
  });

  it.each([
    ["number 0", 0],
    ["number -1", -1],
    ["number 1.5", 1.5],
    ["number NaN", NaN],
    ["number Infinity", Infinity],
    ['string "2"', "2"],
  ])("reports invalid concurrency %s and uses the default capacity", async (_label, concurrency) => {
    const timer = createTimer();
    const held = signal();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let started = 0;

    startReconciliationWorker({
      drain: async () => { started += 1; await held.promise; },
      schedule: timer.schedule,
      concurrency,
    } as unknown as Parameters<typeof startReconciliationWorker>[0]);
    expect(logged.mock.calls).toEqual([[DEFAULTED_CONCURRENCY_MESSAGE, concurrency]]);
    for (let tick = 0; tick < 4; tick += 1) await timer.tick();
    expect(started).toBe(4);
  });

  it.each([
    ["data", null],
    ["data", undefined],
    ["accessor", null],
    ["accessor", undefined],
  ] as const)("uses the default capacity silently for nullish concurrency (%s: %s)", async (kind, concurrency) => {
    const timer = createTimer();
    const held = signal();
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let started = 0;

    const schedule = {
      drain: async () => { started += 1; await held.promise; },
      schedule: timer.schedule,
    };
    Object.defineProperty(schedule, "concurrency",
      kind === "accessor" ? { get: () => concurrency } : { value: concurrency });
    startReconciliationWorker(schedule);
    expect(started).toBe(4);
    for (let tick = 0; tick < 4; tick += 1) await timer.tick();
    expect(started).toBe(4);
    expect(logged).not.toHaveBeenCalled();
  });

  it("keeps the concurrency fallback report when its reason cannot be printed", async () => {
    const timer = createTimer();
    const held = signal();
    const unreadable = new Error("unprintable concurrency failure");
    const logged = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      if (args.length === 2) throw new Error("cannot print reason");
    });
    let started = 0;

    startReconciliationWorker({
      drain: async () => { started += 1; await held.promise; },
      schedule: timer.schedule,
      get concurrency(): number { throw unreadable; },
    });
    expect(logged.mock.calls).toEqual([
      [DEFAULTED_CONCURRENCY_MESSAGE, unreadable],
      [DEFAULTED_CONCURRENCY_MESSAGE],
    ]);
    for (let tick = 0; tick < 4; tick += 1) await timer.tick();
    expect(started).toBe(4);
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
        concurrency: 1,
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
        concurrency: 1,
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
        concurrency: 1,
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
      concurrency: 1,
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
    }) as unknown as typeof setInterval);

    try {
      startReconciliationWorker({
        concurrency: 1,
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
      concurrency: 1,
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
        concurrency: 1,
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
        concurrency: 1,
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
        concurrency: 1,
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
        concurrency: 1,
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
        concurrency: 1,
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
        concurrency: 1,
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
    // Interaction recorder only: PostgreSQL tests prove ownership/state guards;
    // this fake deliberately does not model lease ownership or row lifecycle.
    renewReconciliationJobLease: async (jobId, leaseToken) => {
      record("renew", [jobId, leaseToken]);
      return true;
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

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = () => { heldSignals.delete(resolve); settle(); };
  });
  heldSignals.add(resolve);
  return { promise, resolve };
}

function createRenewalTimer() {
  let fire: (() => Promise<void>) | undefined;
  let intervalMs: number | undefined;
  let cancellations = 0;
  const armed = signal();
  return {
    dependencies: {
      scheduleLeaseRenewal(callback: () => Promise<void>, everyMs: number) {
        fire = callback;
        intervalMs = everyMs;
        armed.resolve();
        return () => { cancellations += 1; };
      },
    },
    armed: armed.promise,
    get intervalMs() { return intervalMs; },
    get cancellations() { return cancellations; },
    async tick() {
      // Retain the callback to simulate a queued tick after stop; await the real
      // renewal operation rather than a timer delay that guesses when it settled.
      if (fire === undefined) throw new Error("Renewal timer was not armed");
      await fire();
    },
  };
}

/** Yield only when Node must get a turn to emit an unhandledRejection event. */
async function surfaceUnhandledRejections(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}
