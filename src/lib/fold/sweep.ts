export type ReconciliationSweepDependencies = {
  listActiveRepositoryIds(): Promise<string[]>;
  reconcile(repositoryId: string): Promise<unknown>;
  onFailure?(repositoryId: string, error: unknown): void;
};

export type ReconciliationSweepSummary = {
  attempted: number;
  reconciled: number;
  failed: number;
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

  for (const repositoryId of repositoryIds) {
    try {
      await dependencies.reconcile(repositoryId);
      reconciled += 1;
    } catch (error) {
      failed += 1;
      dependencies.onFailure?.(repositoryId, error);
    }
  }

  return { attempted: repositoryIds.length, reconciled, failed };
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
