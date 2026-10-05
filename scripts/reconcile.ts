import { closeSql } from "../src/lib/db/client.ts";
import { PostgresFoldStore } from "../src/lib/fold/postgres-store.ts";
import { type ReconciliationSummary } from "../src/lib/fold/reconcile.ts";
import { reconcileRepositoryAsSponsor } from "../src/lib/fold/reconcile-as-sponsor.ts";
import { appInstallationTokenResolverFromEnv } from "../src/lib/github/app-installation-auth.ts";

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
  // GitHub repositories fold as the sponsor's GitHub App installation when the
  // App is configured (issue 804), instead of the sponsor's OAuth token.
  // Unconfigured — either variable unset or empty — the option stays unwired
  // and every fold reads the sponsor's OAuth token exactly as before;
  // configured with a key file that cannot be read or parsed the factory
  // throws here, failing the CLI run before any fold (fail-closed, the
  // GitLab credential precedent). Unconfigured reading as null from the
  // factory, unwired reading
  // as undefined on the options — both leave the option off, so
  // `?? undefined` carries the factory's null across.
  const resolveAppInstallationToken =
    appInstallationTokenResolverFromEnv(process.env) ?? undefined;
  return {
    store,
    reconcile: (repositoryId) =>
      reconcileRepositoryAsSponsor(store, repositoryId, undefined, { resolveAppInstallationToken }),
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
