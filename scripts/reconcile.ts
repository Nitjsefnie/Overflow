import { closeSql } from "../src/lib/db/client.ts";
import { PostgresFoldStore } from "../src/lib/fold/postgres-store.ts";
import { reconcileRepository, type ReconciliationSummary } from "../src/lib/fold/reconcile.ts";
import { GitHubGateway } from "../src/lib/github/client.ts";

export type ReconcileCliDependencies = {
  store: Pick<PostgresFoldStore, "findRepositoryByOwnerName" | "listActiveRepositoryIds">;
  reconcile(repositoryId: string): Promise<ReconciliationSummary | { repositoryId: string; adds: number; changes: number; removals: number }>;
  write(line: string): void;
};

export async function runReconciliationCli(): Promise<void>;
export async function runReconciliationCli(
  argumentsList: readonly string[],
  dependencies: ReconcileCliDependencies,
): Promise<void>;
export async function runReconciliationCli(
  argumentsList: readonly string[] = process.argv.slice(2),
  dependencies: ReconcileCliDependencies = productionDependencies(),
): Promise<void> {
  const repositoryIds = await repositoryIdsForArguments(argumentsList, dependencies.store);
  for (const repositoryId of repositoryIds) {
    const summary = await dependencies.reconcile(repositoryId);
    dependencies.write(JSON.stringify(summary));
  }
}

async function repositoryIdsForArguments(
  argumentsList: readonly string[],
  store: ReconcileCliDependencies["store"],
): Promise<string[]> {
  if (argumentsList.length === 0) {
    return store.listActiveRepositoryIds();
  }
  if (
    argumentsList.length !== 2 ||
    argumentsList[0] !== "--repository" ||
    !isOwnerName(argumentsList[1] ?? "")
  ) {
    throw new Error("Usage: pnpm reconcile [--repository owner/name]");
  }

  const repository = await store.findRepositoryByOwnerName(argumentsList[1]!);
  if (repository === null) {
    throw new Error("Registered active repository was not found.");
  }
  return [repository.id];
}

function productionDependencies(): ReconcileCliDependencies {
  const store = new PostgresFoldStore();
  return {
    store,
    reconcile: async (repositoryId) => {
      const repository = await store.getRepository(repositoryId);
      if (repository === null) {
        throw new Error("Repository was not found.");
      }
      const accessToken = await store.getGitHubAccessToken(repository.sponsor.id);
      if (accessToken === null) {
        throw new Error("GitHub access token was not available.");
      }
      return reconcileRepository({ store, github: new GitHubGateway({ accessToken }) }, repositoryId);
    },
    write: (line) => process.stdout.write(`${line}\n`),
  };
}

function isOwnerName(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

if (isDirectExecution()) {
  try {
    await runReconciliationCli();
  } finally {
    await closeSql();
  }
}

function isDirectExecution(): boolean {
  return process.argv[1]?.endsWith("/scripts/reconcile.ts") ?? false;
}
