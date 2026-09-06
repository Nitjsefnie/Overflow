import {
  drainReconciliationJobs,
  startReconciliationWorker,
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
    drain: () =>
      drainReconciliationJobs({
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
      }),
    onFailure: (error) => {
      console.error("Reconciliation worker could not drain the job queue", error);
    },
  });

  startReconciliationSweep({
    runSweep: () =>
      sweepReconciliations({
        listActiveRepositoryIds: () => store.listActiveRepositoryIds(),
        enqueue: (repositoryId) => store.enqueueReconciliationJob(repositoryId, "SWEEP"),
        onFailure: (repositoryId, error) => {
          // One repository that cannot be queued must not silently stall the
          // sweep for the rest, so the failure is reported and the sweep moves on.
          console.error(`Reconciliation sweep failed for repository ${repositoryId}`, error);
        },
      }),
  });
}
