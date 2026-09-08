import type { GitHubGateway } from "@/lib/github/client";
import type { PostgresFoldStore } from "@/lib/fold/postgres-store";
import type { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";

export type WebhookUpgradeOutcome = {
  repositoryId: string;
  subscription: "VERIFIED" | "FAILED";
  queue: "QUEUED" | "FAILED" | "NOT_ATTEMPTED";
  failure: "REGISTRATION_FAILED" | "CREDENTIALS_FAILED" | "REPOSITORY_FAILED" | "SUBSCRIPTION_FAILED" | "QUEUE_FAILED" | null;
};

export type WebhookUpgradeDependencies = {
  store: Pick<PostgresFoldStore, "listActiveRepositoryIds" | "enqueueReconciliationJob">
    & Pick<PostgresRepositoryStore, "findActiveRepositoryById" | "getGitHubAccessToken">;
  createGateway(accessToken: string, sponsorId: string): Pick<GitHubGateway, "getRepositoryById" | "ensureWebhookEvents">;
  webhookSecret: string;
  report(outcome: WebhookUpgradeOutcome): void;
};

/** Explicit administration followed by durable repair; neither belongs in the fold. */
export async function upgradeRepositoryWebhooks(
  dependencies: WebhookUpgradeDependencies,
): Promise<{ succeeded: number; failed: number }> {
  const repositoryIds = await dependencies.store.listActiveRepositoryIds();
  const summary = { succeeded: 0, failed: 0 };
  for (const repositoryId of repositoryIds) {
    const outcome = await upgradeRegistration(dependencies, repositoryId);
    dependencies.report(outcome);
    if (outcome.failure === null) summary.succeeded++;
    else summary.failed++;
  }
  return summary;
}

async function upgradeRegistration(
  { store, createGateway, webhookSecret }: WebhookUpgradeDependencies,
  repositoryId: string,
): Promise<WebhookUpgradeOutcome> {
  const outcome: WebhookUpgradeOutcome = {
    repositoryId, subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "REGISTRATION_FAILED",
  };
  try {
    const registration = await store.findActiveRepositoryById(repositoryId);
    if (registration === null || registration.id !== repositoryId) return outcome;

    outcome.failure = "CREDENTIALS_FAILED";
    const token = await store.getGitHubAccessToken(registration.sponsorId);
    if (token === null || token.length === 0) return outcome;
    const github = createGateway(token, registration.sponsorId);

    outcome.failure = "REPOSITORY_FAILED";
    const repository = await github.getRepositoryById(registration.githubRepositoryId);
    if (
      repository === null || repository.id !== registration.githubRepositoryId
      || repository.visibility !== "PUBLIC" || !repository.canAdminister
      || !isOwner(repository.owner) || !isRepositoryName(repository.name)
      || repository.fullName !== `${repository.owner}/${repository.name}`
    ) return outcome;

    outcome.failure = "SUBSCRIPTION_FAILED";
    await github.ensureWebhookEvents(repository, registration.githubWebhookId, webhookSecret);
    outcome.subscription = "VERIFIED";

    outcome.failure = "QUEUE_FAILED";
    outcome.queue = "FAILED";
    await store.enqueueReconciliationJob(repositoryId, "WEBHOOK");
    outcome.queue = "QUEUED";
    outcome.failure = null;
  } catch {
    // Only the fixed stage code escapes. Credentials, upstream bodies and DB
    // diagnostics can appear in any exception along this path.
  }
  return outcome;
}

function isOwner(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

function isRepositoryName(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}
