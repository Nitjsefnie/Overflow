import type { GitHubWebhookDelivery } from "@/lib/github/webhook-schema";

export type WebhookDeliveryStore = {
  claimDelivery(delivery: GitHubWebhookDelivery): Promise<WebhookDeliveryClaim>;
  findRepositoryByGitHubId(githubRepositoryId: number): Promise<{ id: string; active: boolean } | null>;
  markProcessed(deliveryId: string, leaseToken: string): Promise<boolean>;
  renewDeliveryLease(deliveryId: string, leaseToken: string): Promise<boolean>;
  markFailed(deliveryId: string, leaseToken: string, errorMessage: string): Promise<boolean>;
};

export type WebhookProcessorDependencies = {
  store: WebhookDeliveryStore;
  reconcileRepository(repositoryId: string): Promise<unknown>;
  leaseHeartbeatIntervalMs?: number;
};

export type WebhookProcessingResult = { status: "PROCESSED" | "DUPLICATE" };

export type WebhookDeliveryClaim =
  | { status: "CLAIMED"; leaseToken: string }
  | { status: "DUPLICATE" };

export async function processWebhook(
  dependencies: WebhookProcessorDependencies,
  delivery: GitHubWebhookDelivery,
): Promise<WebhookProcessingResult> {
  const claim = await dependencies.store.claimDelivery(delivery);
  if (claim.status === "DUPLICATE") {
    return { status: "DUPLICATE" };
  }

  const heartbeat = startLeaseHeartbeat(
    dependencies.store,
    delivery.deliveryId,
    claim.leaseToken,
    dependencies.leaseHeartbeatIntervalMs ?? 60_000,
  );
  try {
    const repository = await dependencies.store.findRepositoryByGitHubId(delivery.repositoryGitHubId);
    if (repository !== null && repository.active) {
      await dependencies.reconcileRepository(repository.id);
    }
    const leaseStillOwned = await heartbeat.stop();
    if (!leaseStillOwned) {
      return { status: "DUPLICATE" };
    }
    const markedProcessed = await dependencies.store.markProcessed(delivery.deliveryId, claim.leaseToken);
    return { status: markedProcessed ? "PROCESSED" : "DUPLICATE" };
  } catch {
    await heartbeat.stop();
    try {
      await dependencies.store.markFailed(delivery.deliveryId, claim.leaseToken, "Webhook processing failed.");
    } catch {
      // A stale pending lease remains reclaimable if recording its failure also fails.
    }
    throw new Error("Webhook processing failed.");
  }
}

function startLeaseHeartbeat(
  store: WebhookDeliveryStore,
  deliveryId: string,
  leaseToken: string,
  intervalMs: number,
): { stop(): Promise<boolean> } {
  let leaseStillOwned = true;
  let renewal = Promise.resolve();
  const timer = setInterval(() => {
    renewal = renewal.then(async () => {
      if (leaseStillOwned) {
        leaseStillOwned = await store.renewDeliveryLease(deliveryId, leaseToken);
      }
    }).catch(() => {
      leaseStillOwned = false;
    });
  }, intervalMs);
  timer.unref();

  return {
    async stop() {
      clearInterval(timer);
      await renewal;
      return leaseStillOwned;
    },
  };
}
