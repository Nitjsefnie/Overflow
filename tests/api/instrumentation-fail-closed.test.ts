import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `register()` is Next.js's instrumentation hook: whatever it throws at server
 * start, Next catches and retries per request, so a misconfigured GitHub App
 * key (an unreadable key file throws at wiring time) used to sit the unit
 * `active` serving 500s on every route, forever, seen by nobody (issue 846).
 * What this pins is that any throw from the Node wiring is fatal at the
 * boundary — the process exits so systemd restarts it and the start limit
 * fails the unit visibly — while the healthy path and the Edge runtime (where
 * nothing is wired) still exit nothing.
 */

const { resolverFactory, startSweep, startWorker, drain, sweep, finalizeRuns, workSql, coordinationSql } = vi.hoisted(() => ({
  resolverFactory: vi.fn(),
  startSweep: vi.fn(),
  startWorker: vi.fn(),
  drain: vi.fn(),
  sweep: vi.fn(),
  finalizeRuns: vi.fn(),
  workSql: vi.fn(),
  coordinationSql: vi.fn(),
}));

vi.mock("@/lib/github/app-installation-auth", () => ({
  appInstallationTokenResolverFromEnv: resolverFactory,
}));

vi.mock("@/lib/fold/abandoned-runs", () => ({ finalizeAbandonedRuns: finalizeRuns }));

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
vi.mock("@/lib/fold/postgres-store", () => ({
  PostgresFoldStore: class {},
}));

beforeEach(() => {
  // register() must import this file's doubles, never a cached consumer that
  // captured another file's mocks or real background schedulers.
  vi.resetModules();
  resolverFactory.mockReset();
  startSweep.mockReset();
  startWorker.mockReset();
  drain.mockReset();
  sweep.mockReset();
  finalizeRuns.mockReset().mockResolvedValue({ finalized: 0, skippedLocked: 0 });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

afterAll(() => { vi.resetModules(); });

describe("server instrumentation fail-closed boundary", () => {
  it("exits fatally when the Node wiring throws, as a misconfigured GitHub App key does", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "");
    const eisdir = Object.assign(new Error("EISDIR: illegal operation on a directory, read"), { code: "EISDIR" });
    resolverFactory.mockImplementation(() => {
      throw eisdir;
    });
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const { register } = await import("@/instrumentation");

    await expect(register()).resolves.toBeUndefined();

    // The boundary is the whole nodejs branch: nothing downstream started.
    expect(resolverFactory).toHaveBeenCalledTimes(1);
    expect(startWorker).not.toHaveBeenCalled();
    expect(startSweep).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(errors).toHaveBeenCalledWith(
      expect.stringContaining("Overflow server startup failed"),
      eisdir,
    );
  });

  it("wires the server without exiting when the environment is healthy", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "");
    resolverFactory.mockReturnValue(null);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const { register } = await import("@/instrumentation");

    await expect(register()).resolves.toBeUndefined();

    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(startSweep).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
  });

  it("never exits on the Edge runtime, where nothing is wired", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const { register } = await import("@/instrumentation");

    await expect(register()).resolves.toBeUndefined();

    expect(resolverFactory).not.toHaveBeenCalled();
    expect(startWorker).not.toHaveBeenCalled();
    expect(startSweep).not.toHaveBeenCalled();
    expect(exit).not.toHaveBeenCalled();
  });

  it("keeps a DB-transient startup rejection contained — no exit, wiring still starts", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("NEXT_PHASE", "");
    vi.stubEnv("OVERFLOW_DISABLE_RECONCILIATION_SWEEP", "");
    resolverFactory.mockReturnValue(null);
    const failure = new Error("finalizer unavailable");
    finalizeRuns.mockRejectedValue(failure);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    const { register } = await import("@/instrumentation");

    await expect(register()).resolves.toBeUndefined();

    // `registerNodejs` contains the abandoned-run finalizer's own transient
    // failure (logged, startup continues) — only an escape from the wiring or
    // the import reaches this file's fatal boundary.
    expect(exit).not.toHaveBeenCalled();
    expect(startWorker).toHaveBeenCalledTimes(1);
    expect(startSweep).toHaveBeenCalledTimes(1);
    expect(errors.mock.calls.some((call) => call.includes(failure))).toBe(true);
  });
});
