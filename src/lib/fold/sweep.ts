export type ReconciliationSweepDependencies = {
  listActiveRepositoryIds(): Promise<string[]>;
  getReconciliationCooldown(repositoryId: string): Promise<Date | null>;
  reconcile(repositoryId: string): Promise<{ skipped?: boolean } | void>;
  now?: () => Date;
  /**
   * Reports one repository this sweep could not reconcile, as distinct from the
   * whole-sweep `onSweepFailure` on the schedule. A hook that fails costs
   * neither the sweep nor the report, whichever way it fails: reading the member
   * can throw, since it may be an accessor wired lazily; the call can throw; and
   * an async hook can reject. Each of the three ends with the repository failure
   * on console.error instead, and the sweep carries on to the next repository.
   * Omit the hook to report there in the first place.
   *
   * The return is declared, not left as `void`, because an async hook is
   * supported rather than merely tolerated by TypeScript's void-return
   * assignability: whatever the hook returns is settled and its rejection is
   * handled.
   */
  onFailure?(repositoryId: string, error: unknown): void | PromiseLike<unknown>;
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
   * `onFailure` on the dependencies. A hook that fails costs neither the process
   * nor the report, whichever way it fails: reading the member can throw, since
   * it may be an accessor wired lazily; the call can throw; and an async hook
   * can reject. Each of the three ends with the sweep failure on console.error
   * instead. Omit the hook to report there in the first place.
   *
   * The return is declared, not left as `void`, because an async hook is
   * supported rather than merely tolerated by TypeScript's void-return
   * assignability: whatever the hook returns is settled and its rejection is
   * handled.
   */
  onSweepFailure?(error: unknown): void | PromiseLike<unknown>;
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
 * Serial by design: a sweep is the one place that would otherwise fan out
 * across every registered repository at once, claiming the whole bounded
 * coordination allowance and spending every repository's GitHub budget in the
 * same moment.
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
      reportRepositoryFailure(dependencies, repositoryId, error);
    }
  }

  return { attempted: reconciled + failed, reconciled, failed, skipped };
}

/**
 * Reports one repository's failure, on the console when the caller has no hook
 * of its own.
 *
 * Guarded the three ways the scheduler's reportSweepFailure is, and for the same
 * reasons: retrieving the member is its own failure — it may be an accessor
 * wired lazily, which throws before any hook exists — while the call can throw
 * or, if the hook is async, reject. All three are contained and all three still
 * reach the console, so a failing hook costs neither the report nor the sweep.
 *
 * Costing the sweep is what is new here. The counters are already settled when
 * this is reached, so they are untouched either way; what a throw used to cost
 * was every repository still queued behind the failing one, since it propagated
 * out of the loop and left them unreconciled. A diagnostic must not be able to
 * do that.
 *
 * The hook is settled, not awaited. Containing a rejection does not require
 * awaiting one, and sweepReconciliations is serial, so awaiting would put every
 * remaining repository behind a diagnostic and let a hook that never settles
 * stall the whole sweep rather than one report.
 */
function reportRepositoryFailure(
  dependencies: ReconciliationSweepDependencies,
  repositoryId: string,
  error: unknown,
): void {
  let hook: ReconciliationSweepDependencies["onFailure"];
  try {
    // Read exactly once, and behind its own guard: an accessor can have a side
    // effect, and it can throw instead of yielding a hook at all.
    hook = dependencies.onFailure;
  } catch {
    hook = undefined;
  }

  // Anything uncallable — a hook that could not be retrieved, or the null an
  // untyped caller can pass where the optional member expresses only undefined —
  // counts as no hook at all.
  if (typeof hook !== "function") {
    logRepositoryFailure(repositoryId, error);
    return;
  }

  try {
    // `hook.call(dependencies, …)` because the local no longer supplies the
    // receiver the property access did: the type declares a method, so a bare
    // `hook(…)` would leave `this` undefined and turn the hook itself into the
    // throw this guard exists to prevent. A hook that cannot be invoked this way
    // falls into the guard below like any other failing hook.
    void Promise.resolve(hook.call(dependencies, repositoryId, error)).catch(() => {
      logRepositoryFailure(repositoryId, error);
    });
  } catch {
    logRepositoryFailure(repositoryId, error);
  }
}

/**
 * Logs a repository failure, keeping the line even when the reason is what
 * breaks.
 *
 * A reason can refuse to be printed — a custom inspector that throws, a proxy, a
 * getter with a side effect — and losing the whole line to that would hide the
 * failure entirely. The repository id is passed as its own argument rather than
 * built into the message, so the line that survives still says which repository
 * it was about. A console broken outright is left to surface, for the reason
 * given on logSweepFailure.
 */
function logRepositoryFailure(repositoryId: string, error: unknown): void {
  const message = "Reconciliation failed for repository";
  try {
    console.error(message, repositoryId, error);
  } catch {
    console.error(message, repositoryId);
  }
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
 * The split is finding the hook against calling it, guarded separately, because
 * each fails on its own terms: the member may be an accessor, so reading it can
 * throw before any hook exists — a reporter wired lazily throws until its
 * collector does — while the call can throw or, if the hook is async, reject.
 * All three are contained and all three still reach the console, so a failing
 * hook costs neither the process nor the report.
 *
 * The scheduler's own logging is in neither guard. That is the path production
 * takes, since nothing wires a hook, so a defect there has to surface rather
 * than leave a sweep failing forever with no signal.
 *
 * What stays fatal, deliberately: a console broken at both arities, for the
 * reason given on logSweepFailure, and any rejection this module cannot attach a
 * handler to — one is only containable while it can be reached, and a rejection
 * out of reach is Node's to report.
 *
 * Not written as an async function awaiting the hook. Making this function async
 * puts a second floating promise into the module whose whole defect was a
 * floating promise, and that one can reject on a broken console, so the fatality
 * above would arrive as a discarded rejection instead of a plain throw. Awaiting
 * in a closure keeps that part honest but hides the synchronous case, which
 * survives only because an async body runs eagerly up to its first await;
 * settling the result and catching separately shows both failure modes where
 * they happen.
 */
function reportSweepFailure(schedule: ReconciliationSweepSchedule, error: unknown): void {
  let hook: ReconciliationSweepSchedule["onSweepFailure"];
  try {
    // Read exactly once, and behind its own guard: an accessor can have a side
    // effect, and it can throw instead of yielding a hook at all.
    hook = schedule.onSweepFailure;
  } catch {
    hook = undefined;
  }

  // Anything uncallable — a hook that could not be retrieved, or the null an
  // untyped caller can pass where the optional member expresses only undefined —
  // counts as no hook at all.
  if (typeof hook !== "function") {
    logSweepFailure(error);
    return;
  }

  try {
    // `hook.call(schedule, …)` because the local no longer supplies the receiver
    // the property access did: the type declares a method, and the sibling
    // per-repository hook is invoked with its receiver too, so a bare `hook(…)`
    // would leave `this` undefined and turn the hook itself into the
    // process-killing throw this guard exists to prevent. A hook that cannot be
    // invoked this way falls into the guard below like any other failing hook.
    void Promise.resolve(hook.call(schedule, error)).catch(() => {
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
