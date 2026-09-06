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
  onFailure?(repositoryId: string, error: unknown): void;
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
  onFailure?(error: unknown): void;
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
    reportQuietly(() => dependencies.onFailure?.(job.repositoryId, error));
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
        reportQuietly(() => schedule.onFailure?.(error));
      } finally {
        running = false;
      }
    })();
  };

  drain();
  scheduleTick(drain, everyMs);
}

/**
 * Reports a failure without letting the reporter become a failure of its own.
 *
 * Both call sites already sit on a path whose whole purpose is to survive a
 * failure, and both are reached from a detached async call. A reporter that
 * throws there would reject that call with nothing attached, which is exactly
 * the crash the surrounding handler exists to prevent — so the reporter's own
 * error goes no further than here.
 */
function reportQuietly(report: () => void): void {
  try {
    report();
  } catch {
    // There is no second reporter to tell, and the job outcome still has to be
    // recorded.
  }
}

function defaultSchedule(callback: () => void, everyMs: number): void {
  const timer = setInterval(callback, everyMs);
  timer.unref?.();
}
