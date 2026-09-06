import { closeSql } from "../src/lib/db/client.ts";
import { PostgresFoldStore } from "../src/lib/fold/postgres-store.ts";
import { type ReconciliationSummary } from "../src/lib/fold/reconcile.ts";
import { reconcileRepositoryAsSponsor } from "../src/lib/fold/reconcile-as-sponsor.ts";

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
  dependencies?: ReconcileCliDependencies,
): Promise<void> {
  const ownerName = parseArguments(argumentsList);
  dependencies ??= productionDependencies();
  const repositoryIds = await repositoryIdsForOwnerName(ownerName, dependencies.store);
  for (const repositoryId of repositoryIds) {
    const summary = await dependencies.reconcile(repositoryId);
    dependencies.write(JSON.stringify(summary));
  }
}

function parseArguments(argumentsList: readonly string[]): string | null {
  if (argumentsList.length === 0) {
    return null;
  }
  if (
    argumentsList.length !== 2 ||
    argumentsList[0] !== "--repository" ||
    !isOwnerName(argumentsList[1] ?? "")
  ) {
    throw new Error("Usage: pnpm reconcile [--repository owner/name]");
  }

  return argumentsList[1]!;
}

async function repositoryIdsForOwnerName(
  ownerName: string | null,
  store: ReconcileCliDependencies["store"],
): Promise<string[]> {
  if (ownerName === null) {
    return store.listActiveRepositoryIds();
  }
  const repository = await store.findRepositoryByOwnerName(ownerName);
  if (repository === null) {
    throw new Error("Registered active repository was not found.");
  }
  return [repository.id];
}

function productionDependencies(): ReconcileCliDependencies {
  const store = new PostgresFoldStore();
  return {
    store,
    reconcile: (repositoryId) => reconcileRepositoryAsSponsor(store, repositoryId),
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
