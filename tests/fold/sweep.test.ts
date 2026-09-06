import { describe, expect, it, vi } from "vitest";
import {
  RECONCILIATION_SWEEP_INTERVAL_MS,
  shouldStartReconciliationSweep,
  startReconciliationSweep,
  sweepReconciliations,
  type ReconciliationSweepDependencies,
  type ReconciliationSweepSchedule,
} from "@/lib/fold/sweep";

// The line the scheduler prints when it could not arm the recurring tick.
// Asserted as a whole because it is reported instead of being fatal, so the
// residual state it names is all an operator gets.
const UNARMED_MESSAGE =
  "Reconciliation sweep interval was not armed; no further sweeps will run until the process restarts";

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
    const message = "Reconciliation sweep aborted before it finished";
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
      expect(calls[0]).toEqual([message, unreachable]);
      // The reason is what could not be printed, so the line survives without it.
      expect(calls[1]).toEqual([message]);
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

  it("treats a hook whose retrieval throws as no hook at all", async () => {
    const timer = createTimer();
    const unreachable = new Error("Active repositories could not be listed");
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let sweeps = 0;
    // A lazily wired reporter: the accessor throws until its collector is
    // configured, and reading the property is the first thing the scheduler does.
    const schedule = {
      runSweep: async () => {
        sweeps += 1;
        throw unreachable;
      },
      schedule: timer.schedule,
      get onSweepFailure(): (error: unknown) => void {
        throw new Error("The reporter is not wired up yet");
      },
    };

    try {
      startReconciliationSweep(schedule);
      await timer.settle();
      await timer.settle();

      expect(unhandled).toEqual([]);
      expect(sweeps).toBe(1);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]).toContain(unreachable);

      await timer.tick();
      expect(sweeps).toBe(2);
      expect(logged).toHaveBeenCalledTimes(2);
    } finally {
      logged.mockRestore();
      process.off("unhandledRejection", listener);
    }
  });

  it("reads the failure hook once per sweep failure", async () => {
    const timer = createTimer();
    const unreachable = new Error("Active repositories could not be listed");
    const failures: unknown[] = [];
    let reads = 0;
    // A property, not a stored function: a getter with a side effect must see one
    // read per failure, not one per use of the value.
    const schedule = {
      runSweep: async () => {
        throw unreachable;
      },
      schedule: timer.schedule,
      get onSweepFailure(): (error: unknown) => void {
        reads += 1;
        return (error: unknown) => {
          failures.push(error);
        };
      },
    };

    startReconciliationSweep(schedule);
    await timer.settle();

    expect(failures).toHaveLength(1);
    expect(failures[0]).toBe(unreachable);
    expect(reads).toBe(1);
  });

  it("lets a console that cannot report at all surface instead of vanishing", async () => {
    const timer = createTimer();
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    // Not the reason failing — the console itself. The scheduler has no way left
    // to report anything, and swallowing that would leave it mute with no sign.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {
      throw new TypeError("The console cannot report at all");
    });
    let sweeps = 0;

    try {
      startReconciliationSweep({
        runSweep: async () => {
          sweeps += 1;
          throw new Error("Active repositories could not be listed");
        },
        schedule: timer.schedule,
      });
      await timer.settle();
      await timer.settle();

      expect(unhandled).toHaveLength(1);
      expect(unhandled[0]).toBeInstanceOf(TypeError);

      // It keeps ticking through a broken console.
      await timer.tick();
      expect(sweeps).toBe(2);
    } finally {
      logged.mockRestore();
      process.off("unhandledRejection", listener);
    }
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

  it("costs neither the sweep nor the report when a repository hook rejects", async () => {
    const unreconciled = new Error("GitHub reconciliation failed");
    const unhandled: unknown[] = [];
    // The hook's rejection settles one of two ways — contained and reported, or
    // escaped to Node — and either resolves the wait below.
    const settled = signal();
    const listener = (reason: unknown) => {
      unhandled.push(reason);
      settled.resolve();
    };
    process.on("unhandledRejection", listener);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {
      settled.resolve();
    });
    const reports: string[] = [];

    try {
      await expect(
        sweepReconciliations({
          listActiveRepositoryIds: async () => ["repo-a"],
          getReconciliationCooldown: async () => null,
          reconcile: async () => {
            throw unreconciled;
          },
          // The ordinary shape of a reporter that ships the failure somewhere:
          // async, and able to reject. A `try` around the call cannot see that
          // rejection, and the returned promise is not the sweep's to discard.
          onFailure: async (repositoryId) => {
            reports.push(repositoryId);
            throw new Error("Shipping the report failed");
          },
        }),
      ).resolves.toEqual({ attempted: 1, reconciled: 0, failed: 1, skipped: 0 });

      expect(reports).toEqual(["repo-a"]);
      // The sweep returns before the hook has settled, so wait on the settlement
      // itself — unbounded — rather than on a stretch of wall clock.
      await settled.promise;
      // One drain is already enough for Node to report a rejection it is going
      // to report; the second only widens the window the listener had to fire in.
      await drain();
      await drain();
      expect(unhandled).toEqual([]);
      expect(logged.mock.calls).toEqual([
        ["Reconciliation failed for repository", "repo-a", unreconciled],
      ]);
    } finally {
      logged.mockRestore();
      process.off("unhandledRejection", listener);
    }
  });

  it("reconciles every repository after one whose failure hook throws", async () => {
    const unreconciled = new Error("GitHub reconciliation failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const reconciled: string[] = [];

    try {
      await expect(
        sweepReconciliations({
          listActiveRepositoryIds: async () => ["repo-a", "broken", "repo-b", "repo-c"],
          getReconciliationCooldown: async () => null,
          reconcile: async (repositoryId) => {
            if (repositoryId === "broken") {
              throw unreconciled;
            }
            reconciled.push(repositoryId);
          },
          onFailure: () => {
            throw new Error("The failure hook itself failed");
          },
        }),
      ).resolves.toEqual({ attempted: 4, reconciled: 3, failed: 1, skipped: 0 });

      // One repository's failing reporter must not cost every later repository
      // its reconciliation.
      expect(reconciled).toEqual(["repo-a", "repo-b", "repo-c"]);
      expect(logged.mock.calls).toEqual([
        ["Reconciliation failed for repository", "broken", unreconciled],
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it("sweeps the next repository without waiting for the failure hook", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const reconciled: string[] = [];
    let reports = 0;

    try {
      await expect(
        sweepReconciliations({
          listActiveRepositoryIds: async () => ["broken", "repo-b"],
          getReconciliationCooldown: async () => null,
          reconcile: async (repositoryId) => {
            if (repositoryId === "broken") {
              throw new Error("GitHub reconciliation failed");
            }
            reconciled.push(repositoryId);
          },
          // A reporter that never settles — a collector that accepted the
          // connection and then went quiet. The sweep is serial, so an awaited
          // hook would hold every later repository behind this one diagnostic
          // and never return at all. The wait is unbounded and on the sweep's
          // own promise: awaiting the hook hangs this test rather than failing
          // an assertion about how long anything took.
          onFailure: () => {
            reports += 1;
            return new Promise<void>(() => {});
          },
        }),
      ).resolves.toEqual({ attempted: 2, reconciled: 1, failed: 1, skipped: 0 });

      expect(reports).toBe(1);
      expect(reconciled).toEqual(["repo-b"]);
      // The hook neither threw nor rejected, so nothing falls back to the console.
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("counts a sweep the same whether the failure hook fails or is absent", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // One of each outcome the summary distinguishes, so a hook that fails has
    // every counter to disturb and disturbs none of them.
    const dependencies = () => ({
      listActiveRepositoryIds: async () => ["ready", "cooling", "broken", "also-broken"],
      getReconciliationCooldown: async (repositoryId: string) => (
        repositoryId === "cooling" ? new Date("2030-01-02T04:04:05.678Z") : null
      ),
      now: () => new Date("2030-01-02T03:04:05.678Z"),
      reconcile: async (repositoryId: string) => {
        if (repositoryId.endsWith("broken")) {
          throw new Error("GitHub reconciliation failed");
        }
      },
    });

    try {
      const withoutHook = await sweepReconciliations(dependencies());
      const withFailingHook = await sweepReconciliations({
        ...dependencies(),
        onFailure: () => {
          throw new Error("The failure hook itself failed");
        },
      });

      expect(withoutHook).toEqual({ attempted: 3, reconciled: 1, failed: 2, skipped: 1 });
      expect(withFailingHook).toEqual(withoutHook);
    } finally {
      logged.mockRestore();
    }
  });

  it("treats a repository hook whose retrieval throws as no hook at all", async () => {
    const unreconciled = new Error("GitHub reconciliation failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // A lazily wired reporter: the accessor throws until its collector is
    // configured, and reading the member is the first thing the sweep does.
    const dependencies = {
      listActiveRepositoryIds: async () => ["repo-a"],
      getReconciliationCooldown: async () => null,
      reconcile: async () => {
        throw unreconciled;
      },
      get onFailure(): (repositoryId: string, error: unknown) => void {
        throw new Error("The reporter is not wired up yet");
      },
    };

    try {
      await expect(sweepReconciliations(dependencies)).resolves.toEqual({
        attempted: 1, reconciled: 0, failed: 1, skipped: 0,
      });
      expect(logged.mock.calls).toEqual([
        ["Reconciliation failed for repository", "repo-a", unreconciled],
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it("calls a method-form repository hook with its receiver intact", async () => {
    const unreconciled = new Error("GitHub reconciliation failed");
    // Nothing should reach the console here, but a hook called without its
    // receiver throws and falls back to it, so the spy keeps that out of the
    // run output and gives the failure a second thing to say.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // Declared as a method that reaches its own object through `this`, which is
    // the form the type's method syntax invites and the receiver the property
    // access used to supply for free.
    const dependencies = {
      failures: [] as Array<{ repositoryId: string; error: unknown }>,
      listActiveRepositoryIds: async () => ["repo-a"],
      getReconciliationCooldown: async () => null,
      reconcile: async () => {
        throw unreconciled;
      },
      onFailure(repositoryId: string, error: unknown) {
        this.failures.push({ repositoryId, error });
      },
    };

    try {
      await expect(sweepReconciliations(dependencies)).resolves.toEqual({
        attempted: 1, reconciled: 0, failed: 1, skipped: 0,
      });
      expect(dependencies.failures).toEqual([{ repositoryId: "repo-a", error: unreconciled }]);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      logged.mockRestore();
    }
  });

  it("reads the repository failure hook once per repository failure", async () => {
    const failures: string[] = [];
    let reads = 0;
    // A property, not a stored function: a getter with a side effect must see one
    // read per repository failure, not one per use of the value.
    const dependencies = {
      listActiveRepositoryIds: async () => ["repo-a", "repo-b", "repo-c"],
      getReconciliationCooldown: async () => null,
      reconcile: async (repositoryId: string) => {
        if (repositoryId !== "repo-b") {
          throw new Error("GitHub reconciliation failed");
        }
      },
      get onFailure(): (repositoryId: string, error: unknown) => void {
        reads += 1;
        return (repositoryId: string) => {
          failures.push(repositoryId);
        };
      },
    };

    await expect(sweepReconciliations(dependencies)).resolves.toEqual({
      attempted: 3, reconciled: 1, failed: 2, skipped: 0,
    });
    expect(failures).toEqual(["repo-a", "repo-c"]);
    expect(reads).toBe(2);
  });

  it("reports on the console when the repository failure hook is null", async () => {
    const unreconciled = new Error("GitHub reconciliation failed");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    // An untyped caller — a config object, parsed JSON, a JavaScript consumer —
    // can hand over null where the optional member expresses only undefined.
    const dependencies = {
      listActiveRepositoryIds: async () => ["repo-a"],
      getReconciliationCooldown: async () => null,
      reconcile: async () => {
        throw unreconciled;
      },
      onFailure: null,
    } as unknown as ReconciliationSweepDependencies;

    try {
      await expect(sweepReconciliations(dependencies)).resolves.toEqual({
        attempted: 1, reconciled: 0, failed: 1, skipped: 0,
      });
      expect(logged.mock.calls).toEqual([
        ["Reconciliation failed for repository", "repo-a", unreconciled],
      ]);
    } finally {
      logged.mockRestore();
    }
  });

  it("still reports a repository failure whose reason cannot be printed", async () => {
    const unreconciled = new Error("GitHub reconciliation failed");
    const message = "Reconciliation failed for repository";
    const calls: unknown[][] = [];
    // Printing the reason is what fails here — a custom inspector that throws, a
    // proxy, a getter with a side effect. The line itself has to survive that,
    // and this is the sweep's own reporting path, not a caller's hook.
    const logged = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      calls.push(args);
      if (args.length > 2) {
        throw new TypeError("This reason cannot be printed");
      }
    });

    try {
      await expect(
        sweepReconciliations({
          listActiveRepositoryIds: async () => ["repo-a"],
          getReconciliationCooldown: async () => null,
          reconcile: async () => {
            throw unreconciled;
          },
        }),
      ).resolves.toEqual({ attempted: 1, reconciled: 0, failed: 1, skipped: 0 });

      // The reason is what could not be printed, so the line survives without it.
      expect(calls).toEqual([[message, "repo-a", unreconciled], [message, "repo-a"]]);
    } finally {
      logged.mockRestore();
    }
  });

  it("contains a scheduler that rejects and still sweeps at startup", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const unarmable = new Error("The tick could not be registered");
    let sweeps = 0;

    try {
      startReconciliationSweep({
        runSweep: async () => {
          sweeps += 1;
        },
        // The ordinary shape of a scheduler that registers the tick somewhere
        // else: async, and able to reject. A `try` around the call cannot see
        // that rejection, and the returned promise is not the caller's to
        // discard — an abandoned one ends the process.
        schedule: async () => {
          throw unarmable;
        },
      });
      // One drain is already enough for Node to report a rejection it is going
      // to report; the second only widens the window the listener had to fire in.
      await drain();
      await drain();

      // The startup pass that repairs missed deliveries runs before the tick is
      // registered, so it survives a scheduler that cannot be armed.
      expect(sweeps).toBe(1);
      expect(unhandled).toEqual([]);
      expect(logged.mock.calls).toEqual([[UNARMED_MESSAGE, unarmable]]);
    } finally {
      logged.mockRestore();
      process.off("unhandledRejection", listener);
    }
  });

  it("contains a scheduler that throws without failing its caller", async () => {
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", listener);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const intervals = captureIntervals();
    const unarmable = new Error("The tick could not be registered");
    let sweeps = 0;

    try {
      // startReconciliationSweep is called from the instrumentation hook at
      // server start, so a throw out of it is a server that does not boot.
      expect(() => {
        startReconciliationSweep({
          runSweep: async () => {
            sweeps += 1;
          },
          schedule: () => {
            throw unarmable;
          },
        });
      }).not.toThrow();
      await drain();
      await drain();

      expect(sweeps).toBe(1);
      expect(unhandled).toEqual([]);
      // A scheduler that failed is not replaced by the default one.
      expect(intervals.armed).toEqual([]);
      expect(logged.mock.calls).toEqual([[UNARMED_MESSAGE, unarmable]]);
    } finally {
      intervals.restore();
      logged.mockRestore();
      process.off("unhandledRejection", listener);
    }
  });

  it("treats a scheduler whose retrieval throws as unusable and arms nothing", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const intervals = captureIntervals();
    const unwired = new Error("The scheduler is not wired up yet");
    let sweeps = 0;
    // A lazily wired scheduler: the accessor throws until whatever owns the
    // timer is configured. Reading the member used to be the first thing the
    // scheduler did, which cost the startup sweep as well as the interval.
    const schedule = {
      runSweep: async () => {
        sweeps += 1;
      },
      get schedule(): (callback: () => void, everyMs: number) => void {
        throw unwired;
      },
    };

    try {
      startReconciliationSweep(schedule);
      await drain();

      expect(sweeps).toBe(1);
      // The caller did supply a scheduler and it is broken, so the default
      // six-hour setInterval must not quietly take its place.
      expect(intervals.armed).toEqual([]);
      expect(logged.mock.calls).toEqual([[UNARMED_MESSAGE, unwired]]);
    } finally {
      intervals.restore();
      logged.mockRestore();
    }
  });

  it("says the interval was not armed and that no further sweeps will run", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const intervals = captureIntervals();

    try {
      startReconciliationSweep({
        runSweep: async () => {},
        schedule: () => {
          throw new Error("The tick could not be registered");
        },
      });
      await drain();

      // Reported rather than fatal leaves a process that serves and never
      // sweeps again, and the line is the whole mitigation for that: an
      // operator has to be able to read both facts off it.
      expect(logged).toHaveBeenCalledTimes(1);
      const [reported] = logged.mock.calls[0] as [string];
      expect(reported).toContain("was not armed");
      expect(reported).toContain("no further sweeps will run");
      expect(reported).toContain("until the process restarts");
    } finally {
      intervals.restore();
      logged.mockRestore();
    }
  });

  it("calls a method-form scheduler with its receiver intact", async () => {
    // Nothing should reach the console here, but a scheduler called without its
    // receiver throws and falls back to it, so the spy keeps that out of the run
    // output and gives the failure a second thing to say.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    let sweeps = 0;
    // Declared as a method that reaches its own object through `this`, which is
    // the form the type's method syntax invites and the receiver the property
    // access used to supply for free.
    const schedule = {
      armed: [] as Array<{ callback: () => void; everyMs: number }>,
      runSweep: async () => {
        sweeps += 1;
      },
      intervalMs: 1_234,
      schedule(callback: () => void, everyMs: number) {
        this.armed.push({ callback, everyMs });
      },
    };

    try {
      startReconciliationSweep(schedule);
      await drain();

      expect(schedule.armed).toHaveLength(1);
      expect(schedule.armed[0]?.everyMs).toBe(1_234);
      expect(logged).not.toHaveBeenCalled();

      // The registered callback is the sweep itself, not some other function
      // that happened to be handed over.
      expect(sweeps).toBe(1);
      schedule.armed[0]?.callback();
      await drain();
      expect(sweeps).toBe(2);
    } finally {
      logged.mockRestore();
    }
  });

  it("arms nothing and reports when the scheduler is not callable", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const intervals = captureIntervals();
    let sweeps = 0;
    // An untyped caller — a config object, parsed JSON, a JavaScript consumer —
    // can hand over something that is neither nullish nor callable.
    const schedule = {
      runSweep: async () => {
        sweeps += 1;
      },
      schedule: 6 * 60 * 60 * 1000,
    } as unknown as ReconciliationSweepSchedule;

    try {
      expect(() => {
        startReconciliationSweep(schedule);
      }).not.toThrow();
      await drain();

      expect(sweeps).toBe(1);
      expect(intervals.armed).toEqual([]);
      // Nothing was called, so there is no reason to print beyond the line itself.
      expect(logged.mock.calls).toEqual([[UNARMED_MESSAGE]]);
    } finally {
      intervals.restore();
      logged.mockRestore();
    }
  });

  it("runs the startup sweep before it tries to arm anything", async () => {
    // The startup sweep is the pass that repairs the deliveries missed while the
    // server was down, and it used to sit behind a retrieval that could throw. A
    // console that fails is what makes the order observable: reporting an
    // unusable scheduler is fatal there, deliberately, so for the sweep to have
    // run it has to have run first.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {
      throw new TypeError("The console cannot report at all");
    });
    const intervals = captureIntervals();
    let sweeps = 0;
    const schedule = {
      runSweep: async () => {
        sweeps += 1;
      },
      get schedule(): (callback: () => void, everyMs: number) => void {
        throw new Error("The scheduler is not wired up yet");
      },
    };

    try {
      expect(() => {
        startReconciliationSweep(schedule);
      }).toThrow(TypeError);
      await drain();

      expect(sweeps).toBe(1);
      expect(intervals.armed).toEqual([]);
    } finally {
      intervals.restore();
      logged.mockRestore();
    }
  });

  it("installs an unrefed interval when no scheduler is supplied", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const intervals = captureIntervals();
    let sweeps = 0;

    try {
      startReconciliationSweep({
        runSweep: async () => {
          sweeps += 1;
        },
      });
      await drain();

      expect(sweeps).toBe(1);
      expect(intervals.armed).toHaveLength(1);
      expect(intervals.armed[0]?.everyMs).toBe(RECONCILIATION_SWEEP_INTERVAL_MS);
      // Unrefed, or the sweep alone would hold a process open that has nothing
      // left to serve.
      expect(intervals.armed[0]?.unrefs).toBe(1);
      expect(logged).not.toHaveBeenCalled();

      intervals.armed[0]?.callback();
      await drain();
      expect(sweeps).toBe(2);
    } finally {
      intervals.restore();
      logged.mockRestore();
    }
  });

  it("installs the default interval when the scheduler is null", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const intervals = captureIntervals();
    // Null is the absent scheduler an untyped caller expresses, so it falls
    // through to the default rather than counting as a broken one.
    const schedule = {
      runSweep: async () => {},
      schedule: null,
    } as unknown as ReconciliationSweepSchedule;

    try {
      startReconciliationSweep(schedule);
      await drain();

      expect(intervals.armed).toHaveLength(1);
      expect(intervals.armed[0]?.everyMs).toBe(RECONCILIATION_SWEEP_INTERVAL_MS);
      expect(logged).not.toHaveBeenCalled();
    } finally {
      intervals.restore();
      logged.mockRestore();
    }
  });
});

function signal() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

// One macrotask turn: long enough for the queued work of a turn to run, and the
// window in which Node reports a rejection nothing handled. Used to let such a
// report arrive so a test can assert it did not, and — through
// createTimer().settle() — before positive assertions too. Neither is a margin
// something is expected to finish inside: the chains these tests drive settle in
// microtasks, which one macrotask turn drains in full, so nothing asserted after
// a drain depends on how long anything took.
function drain() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// Replaces the global setInterval for one test, so a test can assert what the
// default scheduler armed — or that nothing armed anything — without installing
// a real six-hour timer in the test process.
function captureIntervals() {
  const armed: Array<{ callback: () => void; everyMs: number; unrefs: number }> = [];
  const spy = vi.spyOn(globalThis, "setInterval").mockImplementation(((
    callback: () => void,
    everyMs: number,
  ) => {
    const entry = { callback, everyMs, unrefs: 0 };
    armed.push(entry);
    return {
      unref: () => {
        entry.unrefs += 1;
      },
    };
  }) as unknown as typeof setInterval);

  return {
    armed,
    restore: () => {
      spy.mockRestore();
    },
  };
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
      await drain();
    },
  };
}
