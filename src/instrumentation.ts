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
  const { reconcileRepository } = await import("@/lib/fold/reconcile");
  const { GitHubGateway } = await import("@/lib/github/client");

  startReconciliationWorker({
    drain: () =>
      drainReconciliationJobs({
        store: new PostgresFoldStore(),
        // Each repository is read with its own sponsor's token, the same way the
        // webhook route reads it — the worker has no actor of its own.
        reconcile: async (repositoryId) => {
          const store = new PostgresFoldStore();
          const repository = await store.getRepository(repositoryId);
          if (repository === null) {
            throw new Error("Repository was not found.");
          }
          const accessToken = await store.getGitHubAccessToken(repository.sponsor.id);
          if (accessToken === null) {
            throw new Error("GitHub access token was not available.");
          }
          return reconcileRepository(
            { store, github: new GitHubGateway({ accessToken }) },
            repositoryId,
          );
        },
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
        listActiveRepositoryIds: async () => {
          const store = new PostgresFoldStore();
          return store.listActiveRepositoryIds();
        },
        enqueue: (repositoryId) =>
          new PostgresFoldStore().enqueueReconciliationJob(repositoryId, "SWEEP"),
        onFailure: (repositoryId, error) => {
          // One repository that cannot be queued must not silently stall the
          // sweep for the rest, so the failure is reported and the sweep moves on.
          console.error(`Reconciliation sweep failed for repository ${repositoryId}`, error);
        },
      }),
  });
}
