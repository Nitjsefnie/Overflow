import { callGuarded } from "@/lib/fold/guarded-callback";
import type { ClaimedReconciliationJob } from "@/lib/fold/reconciliation-jobs";

export type ReconciliationWorkerStore = {
  claimNextReconciliationJob(): Promise<ClaimedReconciliationJob | null>;
  renewReconciliationJobLease(jobId: string, leaseToken: string, renewalDeadline: Date): Promise<boolean>;
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
 * lease plus a five-second poll when a drain slot is free. Other repositories
 * can fold concurrently, but pickup still waits when every worker slot is
 * occupied; the lease and poll do not bound that capacity wait.
 *
 * A surviving advisory-lock session serializes a reclaim behind the original fold.
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
 * thirty-minute lease. SQL admits renewal only before the absolute deadline,
 * including writes queued in the connection pool. The last lease can therefore
 * expire at most one twenty-second lease window after the deadline; the deadline
 * is an admission limit, not the instant the lease ends.
 *
 * This surrenders the job; it does not unwedge the fold or rescue its repository.
 * If its lock session survives, a hung fold still holds the advisory lock.
 * An external reclaimer hits the sixty-second
 * lock deadline and enters retry backoff, eventually reaching FAILED after
 * enough attempts, with a visible last_failure_at. That is the same end state
 * as under the old lease, reached sooner instead of renewing RUNNING forever.
 */
export const RECONCILIATION_LEASE_MAX_RENEWAL_MS = 10 * 60_000;

/**
 * How often the worker looks for a job.
 *
 * Each tick fills every free drain slot, so one repository's fold
 * does not stop pickup for another. When all slots are occupied the tick is
 * dropped, and a due job still waits for capacity before a later tick can pick
 * it up. Each claim is one indexed query against a table holding one row per
 * repository; the poll interval alone is not a bound on pickup latency.
 */
export const RECONCILIATION_WORKER_POLL_INTERVAL_MS = 5_000;

/**
 * How many drains this worker may keep in flight, filling free slots per poll.
 *
 * Four lets unrelated repositories make progress while a long fold occupies
 * one slot, without treating the database and GitHub as unbounded resources.
 * src/lib/db/client.ts gives the coordination pool
 * RECONCILIATION_COORDINATION_POOL_MAX connections, currently ten like
 * WORK_POOL_MAX. Each fold holds one for its repository advisory lock through
 * every GitHub call. Four leaves room in that pool for other reconciliation
 * callers; it is not a reservation against their own concurrent work.
 *
 * src/lib/fold/reconcile.ts already allows reconciliationConcurrency (four)
 * concurrent GitHub requests inside each fold. Four drains bound concurrent
 * folds, and while those folds succeed their requests total at most sixteen.
 * That is not a bound on all in-flight HTTP requests: a failed concurrent map
 * returns before its other requests settle, so requests from a failed fold
 * outlive it while its drain starts more work. The true in-flight request count
 * remains unbounded until issue 209 is fixed. Raising the drain bound still
 * spends more GitHub budget as well as more coordination connections.
 *
 * The atomic leased row claim keeps concurrent drains from claiming the same
 * live lease. If a lease expires during a fold, the repository advisory lock
 * serializes that repository's folds while its session survives. Local
 * repository exclusion also prevents same-store self-reclaim, but neither
 * mechanism fences writes after session loss; that belongs to issue 210.
 * Different repositories can proceed independently, but a due job behind four
 * occupied slots still waits for
 * capacity; this bound does not promise unconditional poll-bounded pickup.
 */
export const RECONCILIATION_WORKER_CONCURRENCY = 4;

/**
 * Bounds synchronous fill work even for a mistyped or hostile capacity.
 *
 * Sixteen is above the coordination pool's ten connections, so this ceiling
 * does not constrain a capacity that pool could serve. It is a startup
 * termination guard, not the recommended fold concurrency. Keep it independent
 * of src/lib/db/client.ts so this worker does not load the postgres client.
 */
export const RECONCILIATION_WORKER_MAX_CONCURRENCY = 16;

const DEFAULT_DRAIN_MAX_JOBS = 50;

export type ReconciliationWorkerSchedule = {
  drain(): Promise<unknown>;
  schedule?(callback: () => void, everyMs: number): void;
  intervalMs?: number;
  /** Injection seam like intervalMs; omit to use the module's drain capacity. */
  concurrency?: number;
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
 * Excludes a worker's own competing publisher after its lock session is lost.
 *
 * All job runners sharing a store share this record; different stores do not.
 * This is not a write fence and does not fix issue 210, where fencing belongs.
 * A separate process bypasses it entirely, and scripts/reconcile.ts folds
 * directly without claiming a queue lease, so a manual run is outside it too.
 *
 * A genuinely hung fold keeps its entry and defers that repository as long as
 * it hangs: exclusion costs recovery for that one repository. Before this
 * branch, a hung fold blocked the whole worker instead, so this is not a
 * regression against main. A duplicate claim costs one extra deferral UPDATE;
 * ordinary work costs a set lookup, add and delete, with no extra database call.
 */
const inFlightRepositoriesByStore = new WeakMap<ReconciliationWorkerStore, Set<string>>();

/**
 * Claims one job, folds its repository, and records the outcome on the job.
 *
 * Each drain takes one job at a time, while other drains may fold different
 * repositories concurrently. The atomic leased claim excludes another claim
 * of the same live job. If an expired lease permits a reclaim, the local
 * store-scoped record defers it before heartbeat setup or folding; it does not
 * rely on the original advisory-lock session still being alive.
 */
export async function runNextReconciliationJob(
  dependencies: ReconciliationWorkerDependencies,
): Promise<ReconciliationJobOutcome> {
  const { store } = dependencies;
  const job = await store.claimNextReconciliationJob();
  if (job === null) {
    return "IDLE";
  }

  let inFlightRepositories = inFlightRepositoriesByStore.get(store);
  if (inFlightRepositories === undefined) {
    inFlightRepositories = new Set();
    inFlightRepositoriesByStore.set(store, inFlightRepositories);
  }
  if (inFlightRepositories.has(job.repositoryId)) {
    const now = dependencies.now ?? (() => new Date());
    await store.deferReconciliationJob(
      job.id,
      job.leaseToken,
      new Date(now().getTime() + RECONCILIATION_WORKER_POLL_INTERVAL_MS),
    );
    return "DEFERRED";
  }
  // Claim ownership synchronously before setup or any other awaited work.
  inFlightRepositories.add(job.repositoryId);
  let stopRenewal: (() => Promise<void>) | undefined;

  try {
    stopRenewal = startLeaseRenewal(dependencies, job);
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
    try {
      await stopRenewal?.();
    } finally {
      inFlightRepositories.delete(job.repositoryId);
    }
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
  const renewalDeadline = new Date(now().getTime() + RECONCILIATION_LEASE_MAX_RENEWAL_MS);
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
    if (now().getTime() >= renewalDeadline.getTime()) {
      void stop();
      return;
    }
    if (renewing) return;
    renewing = true;
    try {
      const renewed = await dependencies.store.renewReconciliationJobLease(job.id, job.leaseToken, renewalDeadline);
      if (!renewed) void stop();
    } catch (error) {
      logLeaseRenewalFailure(job.id, error);
    } finally {
      renewing = false;
    }
  };
  // Initialize completion before external schedulers can deliver synchronously.
  const setup = Promise.resolve().then(async () => {
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
  });
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
 * Each tick fills the slots that are free when it starts. Only ticks at
 * capacity are dropped rather than queued: the durable jobs remain for a later
 * tick after a slot is released. One long fold no longer blocks other
 * repositories' pickup, but a worker at capacity still does.
 *
 * Snapshot the available count once: a drain member can throw synchronously,
 * releasing its slot before drain() returns. A loop that merely waited for
 * inFlight to reach capacity would then spin forever. A failed store instead
 * costs up to four attempts per poll at the default, and retries stay poll-paced.
 *
 * An idle poll now makes up to capacity indexed claim queries against the
 * table's one row per repository: forty-eight a minute at the default, rather
 * than twelve. That small query cost buys prompt use of free slots. Work starts
 * in a burst; peak fold concurrency and coordination connections stay at four
 * at the default, but claims and lease renewals become more synchronized.
 *
 * A drain that rejects — the store itself being briefly unreachable is the
 * ordinary case — is reported and swallowed. Node throws on an unhandled
 * rejection, so letting one escape would take the whole server down over a
 * transient database failure, which is far worse than the stale repository this
 * worker exists to repair. The slot is released either way, so a later tick can
 * drain again rather than finding capacity permanently leaked.
 *
 * Every caller-supplied configuration member is read after the immediate
 * drain: readDrainConcurrency contains a failing `concurrency`,
 * readDrainInterval a failing `intervalMs`, and armDrainInterval a failing
 * `schedule`. Capacity starts at the module default so startup can run before
 * any of those reads; every valid chosen capacity is at least one, so that
 * startup drain fits even when the caller lowers the bound. The ordering keeps
 * configuration failures from costing the startup pickup. Only after
 * readDrainConcurrency validates the bound do we fill the remaining slots,
 * so a caller choosing a lower capacity is never overshot.
 *
 * A broken capacity or cadence falls back and the tick is armed anyway; a
 * broken arming mechanism is replaced by nothing and leaves nothing armed.
 * The sweep next door reads its cadence and scheduler after startup too.
 */
export function startReconciliationWorker(schedule: ReconciliationWorkerSchedule): void {
  let inFlight = 0;
  let capacity = RECONCILIATION_WORKER_CONCURRENCY;

  const drain = () => {
    if (inFlight >= capacity) {
      return;
    }
    inFlight += 1;
    void (async () => {
      try {
        await schedule.drain();
      } catch (error) {
        reportDrainFailure(schedule, error);
      } finally {
        inFlight -= 1;
      }
    })();
  };

  /** The snapshot bounds attempts per invocation, not across nested re-entrant invocations. */
  const fillFreeSlots = () => {
    const available = capacity - inFlight;
    for (let slot = 0; slot < available; slot += 1) drain();
  };

  drain();
  capacity = readDrainConcurrency(schedule);
  fillFreeSlots();
  armDrainInterval(schedule, fillFreeSlots, readDrainInterval(schedule));
}

/**
 * Reads the capacity injection seam after startup, containing a lazily wired
 * accessor just as readDrainInterval does. A nullish value is no choice and
 * needs no report; a supplied value must be a safe integer from one through
 * RECONCILIATION_WORKER_MAX_CONCURRENCY. Integer-valued numbers such as 1e100
 * would otherwise keep the synchronous startup fill running indefinitely.
 *
 * This guard protects admission as well as tuning: zero can stop every later
 * drain, while NaN defeats the comparison and admits unbounded work. A broken
 * value therefore uses the module's bounded default and reports that choice,
 * leaving the caller's recurring scheduler available to be armed.
 */
function readDrainConcurrency(schedule: ReconciliationWorkerSchedule): number {
  let value: number | undefined;
  try {
    value = schedule.concurrency;
  } catch (error) {
    logDefaultedConcurrency(error);
    return RECONCILIATION_WORKER_CONCURRENCY;
  }
  if (value == null) return RECONCILIATION_WORKER_CONCURRENCY;
  if (Number.isSafeInteger(value) && value >= 1 && value <= RECONCILIATION_WORKER_MAX_CONCURRENCY) {
    return value;
  }
  logDefaultedConcurrency(value);
  return RECONCILIATION_WORKER_CONCURRENCY;
}

/**
 * Reports the capacity the worker will use after an unreadable or invalid
 * choice. The reason is either the thrown value or the unusable capacity, and
 * a reason that refuses to print still leaves the operator the fallback line.
 * As with logDefaultedInterval, a console broken at both arities stays fatal;
 * the startup drain has already run before either report is attempted.
 */
function logDefaultedConcurrency(reason: unknown): void {
  const message =
    "Reconciliation worker concurrency could not be used; drains use the default concurrency instead";
  try {
    console.error(message, reason);
  } catch {
    console.error(message);
  }
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
 * in the sweep: each drain takes one job at a time, so awaiting would put the
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
