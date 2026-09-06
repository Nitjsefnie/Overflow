import {
  drainReconciliationJobs,
  startReconciliationWorker,
  type ReconciliationJobOutcome,
} from "@/lib/fold/reconciliation-worker";
import {
  shouldStartReconciliationBackground,
  startReconciliationSweep,
  sweepReconciliations,
} from "@/lib/fold/sweep";

// Next.js calls this once when the server starts.
export async function register(): Promise<void> {
  if (!shouldStartReconciliationBackground(process.env)) {
    return;
  }

  const { PostgresFoldStore } = await import("@/lib/fold/postgres-store");
  const { reconcileRepositoryAsSponsor } = await import("@/lib/fold/reconcile-as-sponsor");
  const store = new PostgresFoldStore();

  startReconciliationWorker({
    drain: async () => {
      const outcomes = await drainReconciliationJobs({
        store,
        // Each repository is folded with its own sponsor's token, the same way the
        // webhook route reads it — the worker has no actor of its own. Which token
        // and whether one is needed at all belong to the fold, so this is wiring
        // and nothing else.
        reconcile: (repositoryId) => reconcileRepositoryAsSponsor(store, repositoryId),
        onFailure: (repositoryId, error) => {
          // The job carries its own retry, so this is the operator's only view of
          // a repository that keeps failing to fold.
          console.error(`Reconciliation failed for repository ${repositoryId}`, error);
        },
      });
      // A drain that took no job is the ordinary case and says nothing; anything
      // else is the only record that the queue is being worked at all.
      if (outcomes.length > 0) {
        console.info("Reconciliation drain", countOutcomes(outcomes));
      }
      return outcomes;
    },
    onFailure: (error) => {
      console.error("Reconciliation worker could not drain the job queue", error);
    },
  });

  startReconciliationSweep({
    runSweep: async () => {
      const summary = await sweepReconciliations({
        listActiveRepositoryIds: () => store.listActiveRepositoryIds(),
        enqueue: (repositoryId) => store.enqueueReconciliationJob(repositoryId, "SWEEP"),
        onFailure: (repositoryId, error) => {
          // One repository that cannot be queued must not silently stall the
          // sweep for the rest, so the failure is reported and the sweep moves on.
          console.error(`Reconciliation sweep failed for repository ${repositoryId}`, error);
        },
      });
      // One line per sweep, so an operator can see the repair path running rather
      // than inferring it from the absence of complaints.
      console.info("Reconciliation sweep", summary);
      return summary;
    },
  });
}

/** Counts a drain's outcomes by kind, so one line says what the pass actually did. */
function countOutcomes(outcomes: readonly ReconciliationJobOutcome[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const outcome of outcomes) {
    counts[outcome] = (counts[outcome] ?? 0) + 1;
  }
  return counts;
}
