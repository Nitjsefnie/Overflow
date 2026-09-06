import type { GitHubWebhookDelivery } from "@/lib/github/webhook-schema";

export type WebhookDeliveryStore = {
  claimDelivery(delivery: GitHubWebhookDelivery): Promise<WebhookDeliveryClaim>;
  findRepositoryByGitHubId(githubRepositoryId: number): Promise<{ id: string; active: boolean } | null>;
  markProcessed(deliveryId: string, leaseToken: string): Promise<boolean>;
  markFailed(deliveryId: string, leaseToken: string, errorMessage: string): Promise<boolean>;
};

export type WebhookProcessorDependencies = {
  store: WebhookDeliveryStore;
  enqueueReconciliation(repositoryId: string): Promise<unknown>;
};

export type WebhookProcessingResult = { status: "PROCESSED" | "DUPLICATE" };

export type WebhookDeliveryClaim =
  | { status: "CLAIMED"; leaseToken: string }
  | { status: "DUPLICATE" };

/**
 * Records the delivery and schedules the repository's fold, rather than folding.
 *
 * The whole request is now two short queries, so the delivery lease taken by
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
    const repository = await dependencies.store.findRepositoryByGitHubId(delivery.repositoryGitHubId);
    if (repository !== null && repository.active) {
      await dependencies.enqueueReconciliation(repository.id);
    }
    const markedProcessed = await dependencies.store.markProcessed(delivery.deliveryId, claim.leaseToken);
    return { status: markedProcessed ? "PROCESSED" : "DUPLICATE" };
  } catch {
    try {
      await dependencies.store.markFailed(delivery.deliveryId, claim.leaseToken, "Webhook processing failed.");
    } catch {
      // A stale pending lease remains reclaimable if recording its failure also fails.
    }
    throw new Error("Webhook processing failed.");
  }
}
