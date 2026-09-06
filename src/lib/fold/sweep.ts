import { callGuarded } from "@/lib/fold/guarded-callback";

export type ReconciliationSweepDependencies = {
  listActiveRepositoryIds(): Promise<string[]>;
  enqueue(repositoryId: string): Promise<unknown>;
  /**
   * Reports one repository this sweep could not queue, as distinct from the
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
  /** Repositories the sweep offered to the queue, enqueued or failed. */
  attempted: number;
  enqueued: number;
  failed: number;
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
 * Whether this process should run the reconciliation background work at all —
 * both the queue worker and the sweep that feeds it.
 *
 * They talk to PostgreSQL and, through the fold, to GitHub, so they belong only
 * to a running Node.js server: the edge runtime cannot reach either, and a
 * production build imports the instrumentation hook without being a server at
 * all.
 *
 * The environment variable keeps the name deployments already set, so turning
 * the sweep off has never needed a configuration change — it now turns off the
 * worker with it, which is the whole of reconciliation.
 */
export function shouldStartReconciliationBackground(
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
 * Offers every active repository to the reconciliation queue, one at a time.
 *
 * The sweep enqueues unconditionally rather than deciding which repositories
 * are worth reconciling. The enqueue is an upsert on one row per repository, so
 * a repository already queued keeps its place and its backoff, and one whose
 * retries were exhausted is revived — which is exactly the repair this sweep
 * exists to perform. Whether the fold should actually run is the worker's
 * decision, taken against the cooldown at the moment it folds.
 *
 * A repository that fails is counted and skipped rather than aborting the
 * sweep, so one bad row cannot stop every other repository being queued.
 */
export async function sweepReconciliations(
  dependencies: ReconciliationSweepDependencies,
): Promise<ReconciliationSweepSummary> {
  const repositoryIds = await dependencies.listActiveRepositoryIds();
  let enqueued = 0;
  let failed = 0;

  for (const repositoryId of repositoryIds) {
    try {
      await dependencies.enqueue(repositoryId);
      enqueued += 1;
    } catch (error) {
      failed += 1;
      reportRepositoryFailure(dependencies, repositoryId, error);
    }
  }

  return { attempted: enqueued + failed, enqueued, failed };
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
 * propagated out of the loop and left them unqueued. A diagnostic must not
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
 * The immediate sweep is what queues a repository registered before ingestion
 * existed, and it also repairs any webhook delivery that was missed while the
 * server was down.
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
 * act on. It claims a state the call has not reached, though, and overstates
 * wherever the arming that follows then fails: this line is printed from the
 * read, arming is the step after it, and a caller that broke both members — or
 * one that supplied no scheduler and left defaultSchedule's own setInterval to
 * throw — gets logUnarmedInterval's line next, and that one is the one that
 * holds.
 *
 * The line survives a reason that refuses to be printed, for the reason
 * logRepositoryFailure gives. There is always a failure to report, since
 * nothing reaches this but a read that threw. So a reason that is itself
 * `undefined` still goes to the two-argument line here, where
 * logUnarmedInterval folds the same input into its reasonless one: that helper
 * also reports a member that never failed, so an `undefined` beside its line
 * would suggest a reason went missing, while nothing reaches this line but a
 * failure. The two helpers diverge on that input, deliberately.
 *
 * A console broken at both arities stays fatal, as callGuarded describes;
 * readSweepInterval says where that throw lands and what it costs.
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

function defaultSchedule(callback: () => void, everyMs: number): void {
  const timer = setInterval(callback, everyMs);
  timer.unref?.();
}
