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
   * A console that fails too is the exception. Every path that reports from
   * inside the loop leaves the console's throw to propagate out, and the
   * repositories still queued go unswept — no hook, a hook that throws, and a
   * hook whose retrieval throws all report from there. An async hook's rejection
   * is reported from a handler the loop is no longer inside, so there the sweep
   * finishes with its full summary and the console's throw becomes an unhandled
   * rejection instead. Both are on logRepositoryFailure.
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
  /**
   * Registers the recurring tick. Omit it for an unrefed setInterval, which is
   * what production takes: nothing wires a scheduler, so this is an injection
   * seam and a failure here is a caller defect. armSweepInterval says what one
   * costs.
   */
  schedule?(callback: () => void, everyMs: number): void | PromiseLike<unknown>;
  /**
   * How often the recurring tick runs. Omit it for the default cadence, which is
   * what production takes: nothing wires an interval — the instrumentation hook
   * passes only runSweep — so this is an injection seam and a failure here is a
   * caller defect. Reading it can throw, since it may be an accessor wired
   * lazily; that is contained and reported, RECONCILIATION_SWEEP_INTERVAL_MS
   * stands in, and the recurring tick is still armed. readSweepInterval says
   * what a failure costs, and names the one console failure that is fatal even
   * here.
   *
   * Still arming it is what separates this member from `schedule`, where a
   * member the caller supplied and broke arms nothing. `schedule` is the
   * mechanism, so standing defaultSchedule in for it would arm a real six-hour
   * interval in a process that asked to be armed some other way. This is a
   * tuning number on a mechanism the caller still supplies and which still
   * works, so the fallback runs the caller's own scheduler at this module's own
   * documented cadence: nothing is substituted for the mechanism, and the wrong
   * cadence is the whole of what the fallback costs.
   */
  intervalMs?: number;
  /**
   * Reports a sweep that failed as a whole, as distinct from the per-repository
   * `onFailure` on the dependencies. A hook that fails costs neither the process
   * nor the report, whichever way it fails: reading the member can throw, since
   * it may be an accessor wired lazily; the call can throw; and an async hook
   * can reject. Each of the three ends with the sweep failure on console.error
   * instead. Omit the hook to report there in the first place.
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
 * Guarded the three ways callGuarded describes, so a hook that fails costs
 * neither the report nor the sweep.
 *
 * Costing the sweep is what is specific here. The counters are already settled
 * when this is reached, so they are untouched either way; what a throw used to
 * cost was every repository still queued behind the failing one, since it
 * propagated out of the loop and left them unreconciled. A diagnostic must not
 * be able to do that.
 *
 * Settling the hook rather than awaiting it counts for more here than it does at
 * the scheduler: sweepReconciliations is serial, so awaiting would put every
 * remaining repository behind a diagnostic and let a hook that never settles
 * stall the whole sweep rather than one report.
 */
function reportRepositoryFailure(
  dependencies: ReconciliationSweepDependencies,
  repositoryId: string,
  error: unknown,
): void {
  callGuarded(
    dependencies,
    () => dependencies.onFailure,
    [repositoryId, error],
    // The reason the hook failed is not the subject: the report is about the
    // repository, and the hook failing is only why it is being made here.
    () => {
      logRepositoryFailure(repositoryId, error);
    },
  );
}

/**
 * Logs a repository failure, keeping the line even when the reason is what
 * breaks.
 *
 * A reason can refuse to be printed — a custom inspector that throws, a proxy, a
 * getter with a side effect — and losing the whole line to that would hide the
 * failure entirely. The repository id is passed as its own argument rather than
 * built into the message, so the line that survives still says which repository
 * it was about.
 *
 * A console broken at both arities stays uncontained, as callGuarded describes,
 * and it costs more here than at the scheduler: reached from the sweep's catch
 * block, the throw leaves sweepReconciliations rejecting, so the repositories
 * after this one go unswept. Reached from the rejection handler on an async
 * hook, it becomes an unhandled rejection instead and the sweep finishes.
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
 *
 * Every member the caller supplies is treated as hostile, and both of the ones
 * read to arm the tick are read after the immediate sweep: readSweepInterval
 * contains a failing `intervalMs` and armSweepInterval a failing `schedule`. So
 * neither the cadence nor the arming mechanism can cost the startup pass, and
 * the two differ only in what survives their own failure — the cadence falls
 * back and the tick is armed anyway, while a broken mechanism is replaced by
 * nothing and leaves nothing armed.
 */
export function startReconciliationSweep(schedule: ReconciliationSweepSchedule): void {
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
  armSweepInterval(schedule, sweep, readSweepInterval(schedule));
}

/**
 * Reports a sweep that failed as a whole, on the console when the caller has no
 * hook of its own.
 *
 * Guarded the three ways callGuarded describes, so a hook that fails costs
 * neither the process nor the report.
 *
 * The scheduler's own logging is in neither guard. That is the path production
 * takes, since nothing wires a hook, so a defect there has to surface rather
 * than leave a sweep failing forever with no signal.
 */
function reportSweepFailure(schedule: ReconciliationSweepSchedule, error: unknown): void {
  callGuarded(
    schedule,
    () => schedule.onSweepFailure,
    [error],
    // The reason the hook failed is not the subject: the report is about the
    // sweep, and the hook failing is only why it is being made here.
    () => {
      logSweepFailure(error);
    },
  );
}

/**
 * Logs a sweep failure, keeping the line even when the reason is what breaks.
 *
 * The line survives a reason that refuses to be printed, for the reason
 * logRepositoryFailure gives. A console broken at both arities stays fatal, as
 * callGuarded describes; reached either way from inside the tick's own floating
 * promise, its throw arrives as an unhandled rejection, which ends the process
 * under Node's default. Nothing in this module drops a later tick — the interval
 * stays armed and the running flag is already cleared — but that is as far as
 * this module's reach goes, and there is no process left to run one.
 */
function logSweepFailure(error: unknown): void {
  const message = "Reconciliation sweep aborted before it finished";
  try {
    console.error(message, error);
  } catch {
    console.error(message);
  }
}

/**
 * Arms the recurring tick, reporting on the console when the caller's scheduler
 * cannot be used.
 *
 * Guarded the three ways callGuarded describes, and for the same reason as the
 * two hooks: the scheduler is an injection seam, so anything it does wrong is a
 * caller defect and none of it may reach the process. It is called after the
 * immediate sweep, so retrieving a scheduler that throws no longer costs the
 * startup pass that repairs the deliveries missed while the server was down.
 *
 * Only a nullish member falls through to defaultSchedule, which is what the
 * `?? defaultSchedule` this replaces did. Anything else unusable — a member
 * whose accessor throws, a member holding a value that is not callable — means
 * the caller did supply a scheduler and it is broken, so nothing is armed:
 * substituting the default there would arm a real six-hour interval nobody asked
 * for and hide the defect.
 *
 * Arming nothing leaves a process that serves and never sweeps again, which is
 * why logUnarmedInterval says exactly that. It is still the better failure: the
 * sweep is started from the instrumentation hook at server start, so a scheduler
 * that cannot be armed fails the same way on the next boot, and dying under a
 * supervisor would give a server that is repeatedly down and still never
 * sweeping.
 */
function armSweepInterval(
  schedule: ReconciliationSweepSchedule,
  sweep: () => void,
  everyMs: number,
): void {
  callGuarded(
    schedule,
    () => schedule.schedule ?? defaultSchedule,
    [sweep, everyMs],
    logUnarmedInterval,
  );
}

/**
 * Logs that the recurring tick was never armed, keeping the line even when the
 * reason is what breaks.
 *
 * The message names the residual state and not just the failure, because
 * containing this one is what leaves a process alive and permanently not
 * sweeping: the line is all an operator gets, so it has to say that a restart is
 * what brings the sweep back. Every failure that reaches it before arming it
 * describes exactly. It overstates on a scheduler that arms the tick and then
 * fails — throwing after setInterval, or rejecting on a registry write that
 * follows it — which gets the same line while the interval really is armed.
 *
 * The line survives a reason that refuses to be printed, for the reason
 * logRepositoryFailure gives. There is a reason to print only when something
 * failed: a member that merely held an uncallable value did not, so that line
 * stands alone rather than carrying an `undefined` that suggests a reason went
 * missing. That split is not exact, and does not need to be — a callback that
 * rejects with `undefined`, or throws it, did fail and still reaches the
 * reasonless line, because `undefined` is precisely the reason that carries
 * nothing to print.
 *
 * A console broken at both arities stays fatal, as callGuarded describes, and it
 * costs the most here. Reached synchronously — from the retrieval, from an
 * uncallable member, or from a scheduler that throws — the throw propagates out
 * of armSweepInterval and out of startReconciliationSweep, and neither this
 * module nor the register() that calls it catches it, so it reaches Next.js's
 * instrumentation boot rather than the console: the failure this containment
 * exists to keep away from the server arrives there anyway. Reached from the
 * rejection handler on an async scheduler, it becomes an unhandled rejection,
 * which ends the process just as surely.
 */
function logUnarmedInterval(reason?: unknown): void {
  const message =
    "Reconciliation sweep interval was not armed; no further sweeps will run until the process restarts";
  if (reason === undefined) {
    console.error(message);
    return;
  }

  try {
    console.error(message, reason);
  } catch {
    console.error(message);
  }
}

/**
 * Reads the caller's interval, standing the module's own default in when the
 * read fails.
 *
 * `intervalMs` is an injection seam like the callables around it, and it can be
 * an accessor wired lazily, so retrieving it can throw. callGuarded is not the
 * guard for it: that helper contains the three ways a callable fails, and a data
 * member has only the first of them.
 *
 * The fallback is reported rather than silent, and the tick is armed rather than
 * abandoned. What failed is a tuning number and not the mechanism, so arming the
 * caller's own scheduler at this module's documented cadence substitutes nothing
 * for what the caller asked for; the wrong cadence is the whole of the cost, and
 * it is a far smaller one than trading away every later sweep in a process that
 * stays up. armSweepInterval takes the opposite course on `schedule` for the
 * opposite reason, and says so.
 *
 * A console broken at both arities stays fatal, as callGuarded describes. Its
 * throw propagates synchronously out of here and out of
 * startReconciliationSweep, but only after the immediate sweep has already been
 * started, so the startup pass that repairs the deliveries missed while the
 * server was down survives it. What is lost is the recurring tick, which is
 * never armed at all: the throw leaves before armSweepInterval is reached, so
 * the tick is not armed and nothing says so.
 */
function readSweepInterval(schedule: ReconciliationSweepSchedule): number {
  try {
    return schedule.intervalMs ?? RECONCILIATION_SWEEP_INTERVAL_MS;
  } catch (error) {
    logDefaultedInterval(error);
    return RECONCILIATION_SWEEP_INTERVAL_MS;
  }
}

/**
 * Logs that the caller's interval could not be read, keeping the line even when
 * the reason is what breaks.
 *
 * The message names the residual state and not just the failure, as
 * logUnarmedInterval's does: sweeps go on running here, at a cadence the caller
 * did not choose, and that difference is the whole of what an operator has to
 * act on. There is always a reason to print, since nothing reaches this but a
 * read that threw.
 *
 * The line survives a reason that refuses to be printed, for the reason
 * logRepositoryFailure gives. A console broken at both arities stays fatal, as
 * callGuarded describes; readSweepInterval says where that throw lands and what
 * it costs.
 */
function logDefaultedInterval(reason: unknown): void {
  const message =
    "Reconciliation sweep interval could not be read; the recurring tick is armed at the default interval instead";
  try {
    console.error(message, reason);
  } catch {
    console.error(message);
  }
}

type GuardedCallback<Arguments extends unknown[]> = (
  ...args: Arguments
) => void | PromiseLike<unknown>;

/**
 * Calls a callback the caller supplied, containing every way one can fail, and
 * reports instead of failing.
 *
 * The three ways are guarded separately because each fails on its own terms:
 * retrieving the member can throw before any callback exists, since it may be an
 * accessor wired lazily; the call itself can throw; and an async callback can
 * reject, which no `try` around the call can see. Each of the three ends at
 * `report`, which is given the reason where there is one and nothing where the
 * member simply held a value that is not callable, since nothing failed there.
 * Anything uncallable — a member that could not be retrieved, or the null an
 * untyped caller can pass where an optional member expresses only undefined —
 * counts as no callback at all, though what arrives here is the thunk's to
 * decide: armSweepInterval maps a nullish member to defaultSchedule before it
 * gets this far, so a null scheduler arms the default rather than nothing. The
 * member is read once, through the thunk, because an accessor can have a side
 * effect as well as a failure.
 *
 * The receiver is passed rather than left to the call, because the local no
 * longer supplies the one the property access did: these members are declared as
 * methods, so a bare call would leave `this` undefined and turn the callback
 * itself into the failure this guard exists to prevent. A callback that cannot
 * be invoked that way falls into the guard below like any other failing one.
 *
 * One caller hands over a callback that is not a member of its receiver at all:
 * armSweepInterval falls back to this module's own defaultSchedule, which now
 * runs with `this` bound to the caller's schedule where the bare call left it
 * undefined. That is the one observable change this guard makes on a path that
 * already worked, and it is safe because defaultSchedule never reads `this`.
 *
 * Every member this guards declares its return as `void | PromiseLike<unknown>`
 * rather than `void`, because an async callback is supported rather than merely
 * tolerated by TypeScript's void-return assignability: what one returns is
 * settled here and its rejection is handled.
 *
 * The result is settled, not awaited: containing a rejection does not require
 * awaiting one, and awaiting would put whatever follows behind a callback that
 * may never settle at all. For the same reason this is not written as an async
 * function awaiting the callback — that puts a second floating promise into a
 * module whose whole defect was a floating promise, and it hides the synchronous
 * case, which survives only because an async body runs eagerly up to its first
 * await. Settling the result and catching separately shows both failure modes
 * where they happen.
 *
 * What stays fatal, deliberately: a console broken at every arity, since
 * catching that would leave the module unable to report anything at all with no
 * sign of it, and any rejection this module cannot attach a handler to — one is
 * only containable while it can be reached, and a rejection out of reach is
 * Node's to report. Where a `report` that throws lands depends on the path that
 * reached it: from the retrieval, the uncallable check or a synchronous throw it
 * propagates to this function's caller, while from the rejection handler it
 * becomes an unhandled rejection. Each caller documents what that costs it.
 */
function callGuarded<Arguments extends unknown[]>(
  receiver: object,
  retrieve: () => GuardedCallback<Arguments> | undefined,
  args: Arguments,
  report: (reason?: unknown) => void,
): void {
  let callback: GuardedCallback<Arguments> | undefined;
  try {
    callback = retrieve();
  } catch (error) {
    report(error);
    return;
  }

  if (typeof callback !== "function") {
    report();
    return;
  }

  try {
    void Promise.resolve(callback.apply(receiver, args)).catch((reason: unknown) => {
      report(reason);
    });
  } catch (error) {
    report(error);
  }
}

function defaultSchedule(callback: () => void, everyMs: number): void {
  const timer = setInterval(callback, everyMs);
  timer.unref?.();
}
