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
    void schedule.runSweep().finally(() => {
      running = false;
    });
  };

  sweep();
  scheduleTick(sweep, everyMs);
}

function defaultSchedule(callback: () => void, everyMs: number): void {
  const timer = setInterval(callback, everyMs);
  timer.unref?.();
}
