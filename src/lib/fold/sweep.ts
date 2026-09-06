export type ReconciliationSweepDependencies = {
  listActiveRepositoryIds(): Promise<string[]>;
  getReconciliationCooldown(repositoryId: string): Promise<Date | null>;
  reconcile(repositoryId: string): Promise<{ skipped?: boolean } | void>;
  now?: () => Date;
  onFailure?(repositoryId: string, error: unknown): void;
};

export type ReconciliationSweepSummary = {
  /** Repositories reconciled or failed during this sweep; excludes cooldown skips. */
  attempted: number;
  reconciled: number;
  failed: number;
  /** Repositories deferred by cooldown, at the precheck or after acquiring the repository lock. */
  skipped: number;
};

export type ReconciliationSweepSchedule = {
  runSweep(): Promise<unknown>;
  schedule?(callback: () => void, everyMs: number): void;
  intervalMs?: number;
  /**
   * Reports a sweep that failed as a whole, as distinct from the per-repository
   * `onFailure` on the dependencies. A hook that fails — by throwing, or by
   * rejecting if it is async — costs neither the process nor the report: the
   * sweep failure reaches console.error instead. Omit the hook to report there
   * in the first place.
   */
  onSweepFailure?(error: unknown): void;
};

export const RECONCILIATION_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * Whether this process should run the sweep at all.
 *
 * The sweep talks to GitHub and to PostgreSQL, so it belongs only to a running
 * Node.js server: the edge runtime cannot reach either, and a production build
 * imports the instrumentation hook without being a server at all.
 */
export function shouldStartReconciliationSweep(
  environment: Partial<Record<string, string>>,
): boolean {
  if (environment.NEXT_RUNTIME !== "nodejs") {
    return false;
  }
  if (environment.NEXT_PHASE === "phase-production-build") {
    return false;
  }
  return (environment.OVERFLOW_DISABLE_RECONCILIATION_SWEEP ?? "").length === 0;
}

/**
 * Reconciles every active repository, one at a time.
 *
 * Serial by design: #11 reports that concurrent reconciliations exhaust the
 * PostgreSQL pool, and a sweep is the one place that would otherwise fan out
 * across every registered repository at once.
 *
 * A repository that fails is counted and skipped rather than aborting the
 * sweep, so one unreachable repository cannot stop every other one from
 * catching up.
 */
export async function sweepReconciliations(
  dependencies: ReconciliationSweepDependencies,
): Promise<ReconciliationSweepSummary> {
  const repositoryIds = await dependencies.listActiveRepositoryIds();
  let reconciled = 0;
  let failed = 0;
  let skipped = 0;
  const now = dependencies.now ?? (() => new Date());

  for (const repositoryId of repositoryIds) {
    try {
      const notBefore = await dependencies.getReconciliationCooldown(repositoryId);
      if (notBefore !== null && notBefore.getTime() > now().getTime()) {
        skipped += 1;
        continue;
      }
      const result = await dependencies.reconcile(repositoryId);
      // Another delivery can set a cooldown between the precheck and acquiring the lock.
      if (result?.skipped) {
        skipped += 1;
        continue;
      }
      reconciled += 1;
    } catch (error) {
      failed += 1;
      dependencies.onFailure?.(repositoryId, error);
    }
  }

  return { attempted: reconciled + failed, reconciled, failed, skipped };
}

/**
 * Runs a sweep now and then on a fixed interval.
 *
 * The immediate sweep is what brings a repository registered before ingestion
 * existed into agreement with GitHub, and it also repairs any webhook delivery
 * that was missed while the server was down.
 *
 * A tick that arrives while the previous sweep is still running is dropped, not
 * queued: sweeps are idempotent, so a slow one only needs to finish, never to
 * be run twice over.
 *
 * A sweep that rejects outright is reported here rather than left to the
 * caller: the scheduler owns every promise it starts, and nobody is awaiting
 * them. An unhandled rejection terminates the process under Node's default, and
 * the first sweep runs at startup, so a database that cannot list the
 * repositories would kill the server as it boots.
 */
export function startReconciliationSweep(schedule: ReconciliationSweepSchedule): void {
  const everyMs = schedule.intervalMs ?? RECONCILIATION_SWEEP_INTERVAL_MS;
  const scheduleTick = schedule.schedule ?? defaultSchedule;
  let running = false;

  const sweep = () => {
    if (running) {
      return;
    }
    running = true;
    // Awaited inside an async function rather than chained onto the promise, so
    // a runSweep that throws before it returns one is caught here too.
    void (async () => {
      try {
        await schedule.runSweep();
      } catch (error) {
        reportSweepFailure(schedule, error);
      } finally {
        // Cleared on rejection as well, or one failed sweep drops every later tick.
        running = false;
      }
    })();
  };

  sweep();
  scheduleTick(sweep, everyMs);
}

/**
 * Reports a sweep that failed as a whole, on the console when the caller has no
 * hook of its own.
 *
 * The hook is invoked through the schedule rather than through a reference
 * hoisted out of it, so one written in method form keeps its receiver: the type
 * declares it as a method and the sibling per-repository hook is called the same
 * way, so a detached call would leave `this` undefined and turn the hook into
 * exactly the process-killing throw the caller's catch exists to prevent.
 *
 * A hook that fails costs neither the process nor the report. A synchronous
 * throw is caught; a rejection is caught too, which takes settling whatever the
 * hook returned, because a `try` cannot see a rejected promise and an async
 * reporter shipping to a collector is the ordinary shape of this hook. Either
 * way the failure still reaches the console.
 *
 * Only the hook is guarded. The scheduler's own logging sits outside, so a
 * defect there surfaces rather than being swallowed on the one path production
 * uses.
 */
function reportSweepFailure(schedule: ReconciliationSweepSchedule, error: unknown): void {
  // Anything uncallable — including the null an untyped caller can pass where
  // the optional member expresses only undefined — counts as no hook at all.
  if (typeof schedule.onSweepFailure !== "function") {
    logSweepFailure(error);
    return;
  }

  try {
    void Promise.resolve(schedule.onSweepFailure(error)).catch(() => {
      logSweepFailure(error);
    });
  } catch {
    logSweepFailure(error);
  }
}

/**
 * Logs a sweep failure, keeping the line even when the reason is what breaks.
 *
 * A reason can refuse to be printed — a custom inspector that throws, a proxy, a
 * getter with a side effect — and losing the whole line to that would hide the
 * sweep failure entirely. A console broken outright is still fatal, deliberately:
 * hiding that behind another catch would leave the scheduler with no way to
 * report anything at all and no sign of it.
 */
function logSweepFailure(error: unknown): void {
  const message = "Reconciliation sweep aborted before it finished";
  try {
    console.error(message, error);
  } catch {
    console.error(message);
  }
}

function defaultSchedule(callback: () => void, everyMs: number): void {
  const timer = setInterval(callback, everyMs);
  timer.unref?.();
}
