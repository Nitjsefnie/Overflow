import type { GitHubGateway } from "@/lib/github/client";
import type { GitLabGateway } from "@/lib/gitlab/client";
import type { PostgresFoldStore } from "@/lib/fold/postgres-store";
import type { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { webhookCallbackUrl } from "@/lib/webhooks/credentials";

export type WebhookUpgradeOutcome = {
  repositoryId: string;
  /** NOT_APPLICABLE: the registration carries no webhook, so there is nothing
   * to upgrade and the run is neither a success over forge work nor a
   * failure. */
  subscription: "VERIFIED" | "FAILED" | "NOT_APPLICABLE";
  queue: "QUEUED" | "FAILED" | "NOT_ATTEMPTED";
  failure: "REGISTRATION_FAILED" | "CREDENTIALS_FAILED" | "REPOSITORY_FAILED" | "SUBSCRIPTION_FAILED" | "QUEUE_FAILED" | null;
};

export type WebhookUpgradeDependencies = {
  store: Pick<PostgresFoldStore, "listActiveRepositoryIds" | "requestRepositoryRederivation">
    & Pick<PostgresRepositoryStore, "findActiveRepositoryById" | "findActiveRepositoryForgeById" | "getGitHubAccessToken"
      | "stageWebhookCredential" | "finalizeWebhookCredential" | "withWebhookUpgradeLock">
    & {
      /**
       * The sponsor's decrypted GitLab PAT for a normalized instance, or null
       * when no verified identity is linked there (production:
       * PostgresForgeIdentityStore.getForgeToken).
       */
      getForgeToken(sponsorId: string, instanceUrl: string): Promise<string | null>;
    };
  createGateway(accessToken: string, sponsorId: string): Pick<GitHubGateway, "getRepositoryById" | "configureWebhook">;
  /** Builds the GitLab gateway a GitLab registration's hook is verified through. */
  createGitLabGateway(instanceUrl: string, token: string): Pick<GitLabGateway, "getRepositoryById" | "configureWebhook">;
  webhookUrls: Record<"github" | "gitlab", string>;
  report(outcome: WebhookUpgradeOutcome): void;
};

/** Explicit administration followed by durable repair; neither belongs in the fold. */
export async function upgradeRepositoryWebhooks(
  dependencies: WebhookUpgradeDependencies,
): Promise<{ succeeded: number; failed: number }> {
  const repositoryIds = await dependencies.store.listActiveRepositoryIds();
  const summary = { succeeded: 0, failed: 0 };
  for (const repositoryId of repositoryIds) {
    const outcome = await dependencies.store.withWebhookUpgradeLock(repositoryId,
      () => upgradeRegistration(dependencies, repositoryId)).catch((): WebhookUpgradeOutcome => ({
      repositoryId, subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "REGISTRATION_FAILED",
    }));
    dependencies.report(outcome);
    if (outcome.failure === null) summary.succeeded++;
    else summary.failed++;
  }
  return summary;
}

async function upgradeRegistration(
  { store, createGateway, createGitLabGateway, webhookUrls }: WebhookUpgradeDependencies,
  repositoryId: string,
): Promise<WebhookUpgradeOutcome> {
  const outcome: WebhookUpgradeOutcome = {
    repositoryId, subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "REGISTRATION_FAILED",
  };
  try {
    const registration = await store.findActiveRepositoryById(repositoryId);
    if (registration === null || registration.id !== repositoryId) return outcome;

    // A repository registered without a webhook has nothing to drain. The
    // skip is explicit and precedes every read: no credential is read and no
    // gateway is built for it.
    if (registration.githubWebhookId === null) {
      return { repositoryId, subscription: "NOT_APPLICABLE", queue: "NOT_ATTEMPTED", failure: null };
    }

    const forge = await store.findActiveRepositoryForgeById(repositoryId);
    if (forge === null) return outcome;

    if (forge.provider === "gitlab") {
      return await upgradeGitLabRegistration(
        { store, createGitLabGateway, webhookUrls },
        repositoryId,
        registration,
        registration.githubWebhookId,
        forge,
        outcome,
      );
    }

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
    const credential = await store.stageWebhookCredential({
      repositoryId, provider: "github", instanceUrl: null, projectId: repository.id, webhookId: registration.githubWebhookId,
    });
    if (credential === null) return outcome;
    await github.configureWebhook(repository, registration.githubWebhookId, {
      callbackUrl: webhookCallbackUrl(webhookUrls.github, credential.credentialId), secret: credential.secret,
    });
    if (!await store.finalizeWebhookCredential(credential)) return outcome;
    outcome.subscription = "VERIFIED";

    return await queueRederivation({ store }, repositoryId, outcome);
  } catch {
    // Only the fixed stage code escapes. Credentials, upstream bodies and DB
    // diagnostics can appear in any exception along this path.
  }
  return outcome;
}

/**
 * The GitLab arm of the upgrade drain (issue 547): a GitLab registration's
 * hook is verified through a GitLab gateway built on the sponsor's forge
 * identity token for the registration's own instance. A missing identity is
 * CREDENTIALS_FAILED — the drain cannot repair the hook without the
 * credential, and relinking (which re-verifies live) is the remedy.
 */
async function upgradeGitLabRegistration(
  { store, createGitLabGateway, webhookUrls }: Pick<WebhookUpgradeDependencies, "store" | "createGitLabGateway" | "webhookUrls">,
  repositoryId: string,
  registration: { id: string; sponsorId: string; githubRepositoryId: number },
  webhookId: number,
  forge: { provider: string; instanceUrl: string | null },
  outcome: WebhookUpgradeOutcome,
): Promise<WebhookUpgradeOutcome> {
  outcome.failure = "CREDENTIALS_FAILED";
  if (forge.instanceUrl === null || forge.instanceUrl.length === 0) return outcome;
  const token = await store.getForgeToken(registration.sponsorId, forge.instanceUrl);
  if (token === null || token.length === 0) return outcome;
  const gitlab = createGitLabGateway(forge.instanceUrl, token);

  outcome.failure = "REPOSITORY_FAILED";
  const repository = await gitlab.getRepositoryById(registration.githubRepositoryId);
  if (
    repository === null || repository.id !== registration.githubRepositoryId
    || repository.visibility !== "PUBLIC" || !repository.canAdminister
    || repository.fullName.length === 0 || !repository.fullName.includes("/")
    || repository.fullName !== `${repository.owner}/${repository.name}`
  ) return outcome;

  outcome.failure = "SUBSCRIPTION_FAILED";
  const credential = await store.stageWebhookCredential({
    repositoryId, provider: "gitlab", instanceUrl: forge.instanceUrl, projectId: repository.id, webhookId,
  });
  if (credential === null) return outcome;
  await gitlab.configureWebhook(
    { owner: repository.owner, name: repository.name },
    webhookId,
    { callbackUrl: webhookCallbackUrl(webhookUrls.gitlab, credential.credentialId), secret: credential.secret },
  );
  if (!await store.finalizeWebhookCredential(credential)) return outcome;
  outcome.subscription = "VERIFIED";

  return await queueRederivation({ store }, repositoryId, outcome);
}

async function queueRederivation(
  { store }: Pick<WebhookUpgradeDependencies, "store">,
  repositoryId: string,
  outcome: WebhookUpgradeOutcome,
): Promise<WebhookUpgradeOutcome> {
  outcome.failure = "QUEUE_FAILED";
  outcome.queue = "FAILED";
  // Historical missed deliveries have no known subject to invalidate. Request
  // a full refresh rather than a checkpoint-based incremental queue pass.
  await store.requestRepositoryRederivation(repositoryId, new Date());
  outcome.queue = "QUEUED";
  outcome.failure = null;
  return outcome;
}

function isOwner(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(value);
}

function isRepositoryName(value: string): boolean {
  return typeof value === "string" && /^[A-Za-z0-9_.-]+$/.test(value) && value !== "." && value !== "..";
}
