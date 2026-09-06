import { callGuarded } from "@/lib/fold/guarded-callback";
import type { ClaimedReconciliationJob } from "@/lib/fold/reconciliation-jobs";

export type ReconciliationWorkerStore = {
  claimNextReconciliationJob(): Promise<ClaimedReconciliationJob | null>;
  renewReconciliationJobLease(jobId: string, leaseToken: string): Promise<boolean>;
  completeReconciliationJob(jobId: string, leaseToken: string): Promise<boolean>;
  deferReconciliationJob(jobId: string, leaseToken: string, runAfter: Date): Promise<boolean>;
  retryReconciliationJob(jobId: string, leaseToken: string, runAfter: Date): Promise<boolean>;
  failReconciliationJob(jobId: string, leaseToken: string): Promise<boolean>;
  getReconciliationCooldown(repositoryId: string): Promise<Date | null>;
};

type LeaseRenewalCancellation = () => void | PromiseLike<unknown>;

export type ReconciliationWorkerDependencies = {
  store: ReconciliationWorkerStore;
  reconcile(repositoryId: string): Promise<{ skipped?: boolean } | void>;
  now?: () => Date;
  /** Setup owns its cleanup; stopping awaits even a cancellation handle delivered late. */
  scheduleLeaseRenewal?(
    callback: () => Promise<void>,
    everyMs: number,
  ): LeaseRenewalCancellation | PromiseLike<LeaseRenewalCancellation>;
  /**
   * Reports one repository this worker could not fold, as distinct from the
   * whole-drain hook on the schedule. A hook that fails costs neither the
   * report nor the job's outcome, whichever way it fails: reading the member
   * can throw, since it may be an accessor wired lazily; the call can throw;
   * and an async hook can reject. Each of the three ends with the repository
   * failure on console.error instead, and the job is still retried or failed on
   * its own row. Omit the hook to report there in the first place.
   *
   * A console that fails too is the exception, and logJobFailure says what it
   * costs.
   */
  onFailure?(repositoryId: string, error: unknown): void | PromiseLike<unknown>;
};

/**
 * How long to wait before each retry of a repository whose fold threw.
 *
 * Five attempts across roughly eighty minutes: long enough to ride out a GitHub
 * outage, short enough that a repository is not left stale for a working day.
 */
export const RECONCILIATION_RETRY_DELAYS_MS: readonly number[] = [
  60_000,
  5 * 60_000,
  15 * 60_000,
  60 * 60_000,
];

/**
 * A short lease renewed while the fold and its outcome write are in flight,
 * up to RECONCILIATION_LEASE_MAX_RENEWAL_MS after the claim.
 *
 * Renewing every five seconds lets a live-but-slow fold keep ownership. A dead
 * worker stops renewing: expiry makes its job claimable within the twenty-second
 * lease plus a five-second poll. Actual pickup also needs a free worker; a drain
 * occupied by another repository delays it (issue 202).
 *
 * Advisory locking still serializes a spurious reclaim behind the original fold.
 * Its cost is one redundant idempotent fold only if the original releases the
 * lock within the reclaimer's sixty-second acquisition deadline. Otherwise the
 * claim has already consumed an attempt and lock timeout causes durable retry
 * backoff, or FAILED when attempts are exhausted. Locking protects correctness;
 * it does not make a missed renewal unconditionally harmless.
 */
export const RECONCILIATION_LEASE_MS = 20_000;
export const RECONCILIATION_LEASE_RENEWAL_INTERVAL_MS = 5_000;

/**
 * Heartbeats prove liveness, not progress: a fold awaiting hung I/O can renew
 * forever. Ten minutes is roughly eleven times the observed fifty-two-second
 * fold, allowing slow folds while bounding renewal at a third of the old
 * thirty-minute lease. After the cap, the last twenty-second lease expires.
 *
 * This surrenders the job; it does not unwedge the fold or rescue its repository.
 * A hung fold still holds the advisory lock. A reclaimer hits the sixty-second
 * lock deadline and enters retry backoff, eventually reaching FAILED after
 * enough attempts, with a visible last_failure_at. That is the same end state
 * as under the old lease, reached sooner instead of renewing RUNNING forever.
 */
export const RECONCILIATION_LEASE_MAX_RENEWAL_MS = 10 * 60_000;

/**
 * How often the worker looks for a job.
 *
 * An idle worker polls frequently; a drain already folding another repository
 * delays pickup (issue 202). Each poll is one indexed query against a table
 * holding one row per repository.
 */
export const RECONCILIATION_WORKER_POLL_INTERVAL_MS = 5_000;

const DEFAULT_DRAIN_MAX_JOBS = 50;

export type ReconciliationWorkerSchedule = {
  drain(): Promise<unknown>;
  schedule?(callback: () => void, everyMs: number): void;
  intervalMs?: number;
  /**
   * Reports a drain that failed as a whole, as distinct from the
   * per-repository hook on the dependencies. A hook that fails costs neither
   * the process nor the report, whichever way it fails: reading the member can
   * throw, since it may be an accessor wired lazily; the call can throw; and an
   * async hook can reject. Each of the three ends with the drain failure on
   * console.error instead. Omit the hook to report there in the first place.
   */
  onFailure?(error: unknown): void | PromiseLike<unknown>;
};

export type ReconciliationJobOutcome =
  | "IDLE"
  | "RECONCILED"
  | "DEFERRED"
  | "RETRY_SCHEDULED"
  | "FAILED";

/**
 * Claims one job, folds its repository, and records the outcome on the job.
 *
 * The worker takes one job at a time: the repository advisory lock inside the
 * fold would serialize two anyway, and the second one would spend GitHub budget
 * to discover that.
 */
export async function runNextReconciliationJob(
  dependencies: ReconciliationWorkerDependencies,
): Promise<ReconciliationJobOutcome> {
  const { store } = dependencies;
  const job = await store.claimNextReconciliationJob();
  if (job === null) {
    return "IDLE";
  }

  const stopRenewal = startLeaseRenewal(dependencies, job);

  try {
    const now = dependencies.now ?? (() => new Date());

    let result: { skipped?: boolean } | void;
    try {
      result = await dependencies.reconcile(job.repositoryId);
    } catch (error) {
      // One unreachable repository must not stop the worker draining the rest, so
      // the failure is recorded on its own job and never propagated to the drain.
      reportJobFailure(dependencies, job.repositoryId, error);
      const delayMs = RECONCILIATION_RETRY_DELAYS_MS[job.attemptCount - 1];
      if (delayMs === undefined) {
        await store.failReconciliationJob(job.id, job.leaseToken);
        return "FAILED";
      }
      await store.retryReconciliationJob(
        job.id,
        job.leaseToken,
        new Date(now().getTime() + delayMs),
      );
      return "RETRY_SCHEDULED";
    }

    if (result?.skipped) {
      await store.deferReconciliationJob(
        job.id,
        job.leaseToken,
        await deferralTime(store, job.repositoryId, now()),
      );
      return "DEFERRED";
    }

    await store.completeReconciliationJob(job.id, job.leaseToken);
    return "RECONCILED";
  } finally {
    await stopRenewal();
  }
}

/**
 * Owns one renewal at a time and the timer's setup/cleanup lifecycle.
 *
 * Retrieval, calls and rejections are guarded as with callGuarded, but setup
 * returns a resource: unlike diagnostic callbacks, its result must be awaited
 * during stop so a late timer is still cancelled by its own cleanup function.
 */
function startLeaseRenewal(
  dependencies: ReconciliationWorkerDependencies,
  job: ClaimedReconciliationJob,
): () => Promise<void> {
  const now = dependencies.now ?? (() => new Date());
  const claimedAt = now().getTime();
  let stopped = false;
  let renewing = false;
  let cancel: LeaseRenewalCancellation | undefined;
  let cancellation: Promise<void> | undefined;
  const stop = () => {
    stopped = true;
    return cancellation ??= (async () => {
      await setup;
      if (cancel === undefined) return;
      try {
        await cancel();
      } catch (error) {
        logLeaseRenewalFailure(job.id, error);
      }
    })();
  };
  const renew = async () => {
    if (stopped) return;
    if (now().getTime() - claimedAt >= RECONCILIATION_LEASE_MAX_RENEWAL_MS) {
      void stop();
      return;
    }
    if (renewing) return;
    renewing = true;
    try {
      const renewed = await dependencies.store.renewReconciliationJobLease(job.id, job.leaseToken);
      if (!renewed) void stop();
    } catch (error) {
      logLeaseRenewalFailure(job.id, error);
    } finally {
      renewing = false;
    }
  };
  const setup = (async () => {
    try {
      const schedule = dependencies.scheduleLeaseRenewal ?? defaultScheduleLeaseRenewal;
      if (typeof schedule !== "function") {
        logLeaseRenewalFailure(job.id, undefined);
        return;
      }
      const cleanup = await schedule.call(dependencies, renew, RECONCILIATION_LEASE_RENEWAL_INTERVAL_MS);
      if (typeof cleanup !== "function") {
        logLeaseRenewalFailure(job.id, undefined);
        return;
      }
      cancel = cleanup;
    } catch (error) {
      logLeaseRenewalFailure(job.id, error);
    }
  })();
  return stop;
}

function defaultScheduleLeaseRenewal(callback: () => Promise<void>, everyMs: number): LeaseRenewalCancellation {
  const timer = setInterval(callback, everyMs);
  timer.unref?.();
  return () => clearInterval(timer);
}

function logLeaseRenewalFailure(jobId: string, error: unknown): void {
  const message = "Reconciliation lease heartbeat failed for job";
  try {
    console.error(message, jobId, error);
  } catch {
    console.error(message, jobId);
  }
}

/**
 * Works the queue until it is empty, or until `maxJobs` jobs have been taken.
 *
 * The bound is what keeps an enqueue storm from holding the drain forever: the
 * poll comes round again in seconds, so leaving jobs behind costs nothing and
 * lets the process shut down between drains.
 *
 * Returns the outcome of every job it took, in order; the terminating idle poll
 * is not one of them.
 */
export async function drainReconciliationJobs(
  dependencies: ReconciliationWorkerDependencies,
  options: { maxJobs?: number } = {},
): Promise<ReconciliationJobOutcome[]> {
  const maxJobs = options.maxJobs ?? DEFAULT_DRAIN_MAX_JOBS;
  const outcomes: ReconciliationJobOutcome[] = [];

  while (outcomes.length < maxJobs) {
    // A store call that throws ends the drain here rather than being caught per
    // job: the store is the one dependency every remaining job also needs, so
    // the next poll retrying the whole drain is the useful response.
    const outcome = await runNextReconciliationJob(dependencies);
    if (outcome === "IDLE") {
      break;
    }
    outcomes.push(outcome);
  }

  return outcomes;
}

/**
 * When to look at a job the reconciliation cooldown declined to fold.
 *
 * A cooldown that has already lapsed, or that the store cannot report at all,
 * would otherwise schedule the job for right now and spin the poll loop, so the
 * first retry delay stands in as the shortest safe wait.
 */
async function deferralTime(
  store: ReconciliationWorkerStore,
  repositoryId: string,
  now: Date,
): Promise<Date> {
  const notBefore = await store.getReconciliationCooldown(repositoryId);
  if (notBefore !== null && notBefore.getTime() > now.getTime()) {
    return notBefore;
  }
  return new Date(now.getTime() + RECONCILIATION_RETRY_DELAYS_MS[0]);
}

/**
 * Drains the queue now and then on every poll.
 *
 * The immediate drain is what picks up the jobs enqueued while the server was
 * down, which is the whole point of a durable queue.
 *
 * A tick arriving while the previous drain is still running is dropped rather
 * than queued: the queue is still there, and a second concurrent drain would
 * only race the first one for the same jobs.
 *
 * A drain that rejects — the store itself being briefly unreachable is the
 * ordinary case — is reported and swallowed. Node throws on an unhandled
 * rejection, so letting one escape would take the whole server down over a
 * transient database failure, which is far worse than the stale repository this
 * worker exists to repair. The running flag is cleared either way, so the next
 * tick drains again rather than finding the worker wedged.
 *
 * Every member the caller supplies is treated as hostile, and both of the ones
 * read to arm the tick are read after the immediate drain: readDrainInterval
 * contains a failing `intervalMs` and armDrainInterval a failing `schedule`. So
 * neither the cadence nor the arming mechanism can cost the startup drain that
 * picks up what was enqueued while the server was down, and the two differ only
 * in what survives their own failure — the cadence falls back and the tick is
 * armed anyway, while a broken mechanism is replaced by nothing and leaves
 * nothing armed. The sweep next door reads the same way, for the same reasons.
 */
export function startReconciliationWorker(schedule: ReconciliationWorkerSchedule): void {
  let running = false;

  const drain = () => {
    if (running) {
      return;
    }
    running = true;
    void (async () => {
      try {
        await schedule.drain();
      } catch (error) {
        reportDrainFailure(schedule, error);
      } finally {
        running = false;
      }
    })();
  };

  drain();
  armDrainInterval(schedule, drain, readDrainInterval(schedule));
}

/**
 * Arms the recurring poll, reporting on the console when the caller's scheduler
 * cannot be used.
 *
 * Guarded the three ways callGuarded describes, and for the same reason as the
 * two hooks: the scheduler is an injection seam, so anything it does wrong is a
 * caller defect and none of it may reach the process.
 *
 * Only a nullish member falls through to defaultSchedule. Anything else
 * unusable — a member whose accessor throws, a member holding a value that is
 * not callable — means the caller did supply a scheduler and it is broken, so
 * nothing is armed: substituting the default there would arm a real poll nobody
 * asked for and hide the defect.
 *
 * Arming nothing leaves a process that serves and never drains again, which is
 * what logUnarmedPoll says. It is the better failure: the worker is started from
 * the instrumentation hook at server start, so a scheduler that cannot be armed
 * fails the same way on the next boot, and dying under a supervisor would give a
 * server that is repeatedly down and still never draining. What it costs while
 * it lasts is every job enqueued after the startup drain — a webhook's fold
 * waits for a restart, which is exactly the staleness this queue exists to end.
 */
function armDrainInterval(
  schedule: ReconciliationWorkerSchedule,
  drain: () => void,
  everyMs: number,
): void {
  callGuarded(
    schedule,
    () => schedule.schedule ?? defaultSchedule,
    [drain, everyMs],
    logUnarmedPoll,
  );
}

/**
 * Logs that the recurring poll was never armed, keeping the line even when the
 * reason is what breaks.
 *
 * The message names the residual state rather than only the failure, because
 * containing this one leaves a process alive and permanently not draining: the
 * line is all an operator gets, so it has to say that a restart is what brings
 * the worker back.
 *
 * There is a reason to print only when something failed: a member that merely
 * held an uncallable value did not, so that line stands alone rather than
 * carrying an `undefined` that suggests a reason went missing.
 *
 * A console broken at both arities stays fatal, as callGuarded describes. Its
 * throw propagates out of startReconciliationWorker into the instrumentation
 * hook that called it, and the startup drain has already run by then.
 */
function logUnarmedPoll(reason?: unknown): void {
  const message =
    "Reconciliation worker poll was not armed; no further drains will run until the process restarts";
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
 * Reads the caller's poll interval, standing the module's own default in when
 * the read fails.
 *
 * `intervalMs` is an injection seam like the callables around it and can be an
 * accessor wired lazily, so retrieving it can throw. callGuarded is not the
 * guard for it: that helper contains the three ways a callable fails, and a data
 * member has only the first of them.
 *
 * The fallback is reported rather than silent, and the tick is armed rather than
 * abandoned. What failed is a tuning number and not the mechanism, so arming the
 * caller's own scheduler at this module's documented cadence substitutes nothing
 * for what the caller asked for; the wrong cadence is the whole of the cost, and
 * it is far smaller than trading away every later drain in a process that stays
 * up. armDrainInterval takes the opposite course on `schedule`, for the opposite
 * reason.
 */
function readDrainInterval(schedule: ReconciliationWorkerSchedule): number {
  try {
    return schedule.intervalMs ?? RECONCILIATION_WORKER_POLL_INTERVAL_MS;
  } catch (error) {
    logDefaultedInterval(error);
    return RECONCILIATION_WORKER_POLL_INTERVAL_MS;
  }
}

/**
 * Logs that the caller's poll interval could not be read, keeping the line even
 * when the reason is what breaks.
 *
 * The message names the residual state as logUnarmedPoll's does: drains go on
 * running, at a cadence the caller did not choose, and that difference is what
 * an operator has to act on. It overstates wherever the arming that follows then
 * fails, and logUnarmedPoll's line comes next and is the one that holds.
 *
 * Nothing reaches this but a read that threw, so there is always a failure to
 * report and a reason that is itself `undefined` still goes to the two-argument
 * line.
 */
function logDefaultedInterval(reason: unknown): void {
  const message =
    "Reconciliation worker poll interval could not be read; the recurring tick is armed at the default interval instead";
  try {
    console.error(message, reason);
  } catch {
    console.error(message);
  }
}

/**
 * Reports one repository's failure, on the console when the caller has no hook
 * of its own.
 *
 * Guarded the three ways callGuarded describes, so a hook that fails costs
 * neither the report nor the job's outcome: the retry or the failure is written
 * to the job's row after this returns, and a throw here would leave that unsaid
 * and the lease to expire instead.
 *
 * Settling the hook rather than awaiting it matters for the same reason it does
 * in the sweep: the worker takes one job at a time, so awaiting would put the
 * next job behind a diagnostic and let a hook that never settles stall the
 * drain rather than one report.
 */
function reportJobFailure(
  dependencies: ReconciliationWorkerDependencies,
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
      logJobFailure(repositoryId, error);
    },
  );
}

/**
 * Logs a repository's fold failure, keeping the line even when the reason is
 * what breaks.
 *
 * A reason can refuse to be printed — a custom inspector that throws, a proxy, a
 * getter with a side effect — and losing the whole line to that would hide the
 * failure entirely. The repository id is passed as its own argument rather than
 * built into the message, so the line that survives still says which repository
 * it was about.
 *
 * A console broken at both arities stays uncontained, as callGuarded describes.
 * Reached from the catch block, its throw leaves runNextReconciliationJob before
 * the job's outcome is written, so the drain ends there and the lease expires
 * rather than the job being retried; the scheduler reports that as a drain
 * failure. Reached from the rejection handler on an async hook, the outcome is
 * already recorded and the throw becomes an unhandled rejection instead.
 */
function logJobFailure(repositoryId: string, error: unknown): void {
  const message = "Reconciliation failed for repository";
  try {
    console.error(message, repositoryId, error);
  } catch {
    console.error(message, repositoryId);
  }
}

/**
 * Reports a drain that failed as a whole, on the console when the caller has no
 * hook of its own.
 *
 * Guarded the three ways callGuarded describes, so a hook that fails costs
 * neither the process nor the report.
 */
function reportDrainFailure(schedule: ReconciliationWorkerSchedule, error: unknown): void {
  callGuarded(
    schedule,
    () => schedule.onFailure,
    [error],
    // The reason the hook failed is not the subject: the report is about the
    // drain, and the hook failing is only why it is being made here.
    () => {
      logDrainFailure(error);
    },
  );
}

/**
 * Logs a drain failure, keeping the line even when the reason is what breaks.
 *
 * The line survives a reason that refuses to be printed, for the reason
 * logJobFailure gives. A console broken at both arities stays fatal, as
 * callGuarded describes: reached either way from inside the tick's own floating
 * promise, its throw arrives as an unhandled rejection, which ends the process
 * under Node's default.
 */
function logDrainFailure(error: unknown): void {
  const message = "Reconciliation worker could not drain the job queue";
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
