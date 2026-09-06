import {
  shouldStartReconciliationSweep,
  startReconciliationSweep,
  sweepReconciliations,
} from "@/lib/fold/sweep";

// Next.js calls this once when the server starts.
export async function register(): Promise<void> {
  if (!shouldStartReconciliationSweep(process.env)) {
    return;
  }

  const { PostgresFoldStore } = await import("@/lib/fold/postgres-store");
  const { reconcileRepository } = await import("@/lib/fold/reconcile");
  const { GitHubGateway } = await import("@/lib/github/client");

  startReconciliationSweep({
    runSweep: () =>
      sweepReconciliations({
        listActiveRepositoryIds: async () => {
          const store = new PostgresFoldStore();
          return store.listActiveRepositoryIds();
        },
        getReconciliationCooldown: (repositoryId) => new PostgresFoldStore().getReconciliationCooldown(repositoryId),
        // Each repository is read with its own sponsor's token, the same way the
        // webhook route reads it — a sweep has no actor of its own.
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
          // One unreachable repository must not silently stall the sweep for the
          // rest, so the failure is reported and the sweep moves on.
          console.error(`Reconciliation sweep failed for repository ${repositoryId}`, error);
        },
      }),
    onFailure: (error) => {
      // A sweep can reject before it reaches any repository — an unreachable
      // database cannot list them. Report it and let the next interval retry.
      console.error("Reconciliation sweep failed", error);
    },
  });
}
