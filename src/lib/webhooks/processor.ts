import type { GitHubWebhookDelivery } from "@/lib/github/webhook-schema";

export type WebhookDeliveryStore = {
  claimDelivery(delivery: GitHubWebhookDelivery): Promise<"NEW" | "DUPLICATE">;
  findRepositoryByGitHubId(githubRepositoryId: number): Promise<{ id: string; active: boolean } | null>;
  markProcessed(deliveryId: string): Promise<void>;
  markFailed(deliveryId: string, errorMessage: string): Promise<void>;
};

export type WebhookProcessorDependencies = {
  store: WebhookDeliveryStore;
  reconcileRepository(repositoryId: string): Promise<unknown>;
};

export type WebhookProcessingResult = { status: "PROCESSED" | "DUPLICATE" };

export async function processWebhook(
  dependencies: WebhookProcessorDependencies,
  delivery: GitHubWebhookDelivery,
): Promise<WebhookProcessingResult> {
  const claim = await dependencies.store.claimDelivery(delivery);
  if (claim === "DUPLICATE") {
    return { status: "DUPLICATE" };
  }

  try {
    const repository = await dependencies.store.findRepositoryByGitHubId(delivery.repositoryGitHubId);
    if (repository !== null && repository.active) {
      await dependencies.reconcileRepository(repository.id);
    }
    await dependencies.store.markProcessed(delivery.deliveryId);
    return { status: "PROCESSED" };
  } catch {
    await dependencies.store.markFailed(delivery.deliveryId, "Webhook processing failed.");
    throw new Error("Webhook processing failed.");
  }
}
