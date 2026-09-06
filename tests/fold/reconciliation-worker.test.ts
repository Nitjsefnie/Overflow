import { describe, expect, it } from "vitest";
import type { ClaimedReconciliationJob } from "@/lib/fold/reconciliation-jobs";
import {
  drainReconciliationJobs,
  RECONCILIATION_RETRY_DELAYS_MS,
  RECONCILIATION_WORKER_POLL_INTERVAL_MS,
  runNextReconciliationJob,
  startReconciliationWorker,
  type ReconciliationWorkerStore,
} from "@/lib/fold/reconciliation-worker";

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

  it("defers by the first retry delay when the reported cooldown has already lapsed", async () => {
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

  it("survives a fold that throws with no failure reporter attached", async () => {
    const { store, calls } = createFakeStore({ jobs: [job()] });

    await expect(
      runNextReconciliationJob({
        store,
        now: () => new Date("2030-01-02T03:04:05.678Z"),
        reconcile: async () => {
          throw new Error("GitHub is unreachable");
        },
      }),
    ).resolves.toBe("RETRY_SCHEDULED");

    expect(calls.at(-1)).toEqual({
      method: "retry",
      args: ["job-1", "lease-1", new Date("2030-01-02T03:05:05.678Z")],
    });
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

  it("survives a drain that rejects with no failure reporter attached", async () => {
    const rejections = watchUnhandledRejections();
    try {
      const timer = createTimer();
      let drains = 0;

      startReconciliationWorker({
        drain: async () => {
          drains += 1;
          throw new Error("PostgreSQL is unreachable");
        },
        schedule: timer.schedule,
      });
      await timer.settle();
      await timer.settle();

      // Counted so the empty rejection list stands for a drain that really ran
      // and really rejected, rather than for a drain that never happened.
      expect(drains).toBe(1);
      expect(rejections.recorded).toEqual([]);
    } finally {
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
