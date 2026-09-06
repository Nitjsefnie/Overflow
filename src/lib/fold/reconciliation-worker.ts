import { callGuarded } from "@/lib/fold/guarded-callback";
import type { ClaimedReconciliationJob } from "@/lib/fold/reconciliation-jobs";

export type ReconciliationWorkerStore = {
  claimNextReconciliationJob(): Promise<ClaimedReconciliationJob | null>;
  completeReconciliationJob(jobId: string, leaseToken: string): Promise<boolean>;
  deferReconciliationJob(jobId: string, leaseToken: string, runAfter: Date): Promise<boolean>;
  retryReconciliationJob(jobId: string, leaseToken: string, runAfter: Date): Promise<boolean>;
  failReconciliationJob(jobId: string, leaseToken: string): Promise<boolean>;
  getReconciliationCooldown(repositoryId: string): Promise<Date | null>;
};

export type ReconciliationWorkerDependencies = {
  store: ReconciliationWorkerStore;
  reconcile(repositoryId: string): Promise<{ skipped?: boolean } | void>;
  now?: () => Date;
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
 * How often the worker looks for a job.
 *
 * A webhook's whole visible latency is now this poll, so it is short; the cost
 * is one indexed query against a table holding at most two rows per repository.
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
 */
export function startReconciliationWorker(schedule: ReconciliationWorkerSchedule): void {
  const everyMs = schedule.intervalMs ?? RECONCILIATION_WORKER_POLL_INTERVAL_MS;
  const scheduleTick = schedule.schedule ?? defaultSchedule;
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
  scheduleTick(drain, everyMs);
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
