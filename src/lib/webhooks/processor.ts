import type { GitHubWebhookDelivery, GitHubWebhookIssue } from "@/lib/github/webhook-schema";

export type WebhookDeliveryStore = {
  claimDelivery(delivery: GitHubWebhookDelivery): Promise<WebhookDeliveryClaim>;
  findRepositoryByGitHubId(githubRepositoryId: number): Promise<{ id: string; active: boolean } | null>;
  /**
   * Resolves the registration holding this forge identity — provider,
   * normalized instance URL, forge project id. A GitLab delivery resolves
   * through it and never through the numeric id alone, which a GitHub
   * registration could equally hold (issue 547).
   */
  findRepositoryByForgeIdentity(
    provider: string,
    instanceUrl: string,
    forgeProjectId: number,
  ): Promise<{ id: string; active: boolean } | null>;
  applyIssueView(repositoryId: string, githubIssueId: number, issue: GitHubWebhookIssue): Promise<void>;
  markProcessed(deliveryId: string, leaseToken: string): Promise<boolean>;
  markFailed(deliveryId: string, leaseToken: string, errorMessage: string): Promise<boolean>;
};

export type WebhookProcessorDependencies = {
  store: WebhookDeliveryStore;
  enqueueReconciliation(repositoryId: string, delivery: GitHubWebhookDelivery): Promise<unknown>;
};

export type WebhookProcessingResult = { status: "PROCESSED" | "DUPLICATE" };

export type WebhookDeliveryClaim =
  | { status: "CLAIMED"; leaseToken: string }
  | { status: "DUPLICATE" };

/**
 * Mirrors known issues immediately and schedules the repository's derived fold.
 *
 * The request only persists the raw issue view, delivery and queue state, so the lease taken by
 * `claimDelivery` covers it outright and nothing has to renew it. The fold
 * itself belongs to the reconciliation worker, which survives this process.
 */
export async function processWebhook(
  dependencies: WebhookProcessorDependencies,
  delivery: GitHubWebhookDelivery,
): Promise<WebhookProcessingResult> {
  const claim = await dependencies.store.claimDelivery(delivery);
  if (claim.status === "DUPLICATE") {
    return { status: "DUPLICATE" };
  }

  try {
    // One processing path for both forges: the delivery names how its
    // repository is resolved, and everything after this line is shared.
    const repository = delivery.forge === undefined
      ? await dependencies.store.findRepositoryByGitHubId(delivery.repositoryGitHubId)
      : await dependencies.store.findRepositoryByForgeIdentity(
          delivery.forge.provider,
          delivery.forge.instanceUrl,
          delivery.repositoryGitHubId,
        );
    if (repository !== null && repository.active) {
      if (delivery.subject.kind === "ISSUE" && delivery.issue !== undefined) {
        await dependencies.store.applyIssueView(repository.id, delivery.subject.id, delivery.issue);
      }
      await dependencies.enqueueReconciliation(repository.id, delivery);
    }
    const markedProcessed = await dependencies.store.markProcessed(delivery.deliveryId, claim.leaseToken);
    return { status: markedProcessed ? "PROCESSED" : "DUPLICATE" };
  } catch (error) {
    try {
      await dependencies.store.markFailed(delivery.deliveryId, claim.leaseToken, "Webhook processing failed.");
    } catch {
      // A stale pending lease remains reclaimable if recording its failure also fails.
    }
    // The stored message stays the sanitized constant: persisted error text is
    // product data, and an upstream error can carry secrets (a connection
    // string, a token in a URL). The cause belongs in the server log instead,
    // so it rides on the thrown error for the route to report there.
    throw new Error("Webhook processing failed.", { cause: error });
  }
}
