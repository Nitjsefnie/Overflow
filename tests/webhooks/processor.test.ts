import { describe, expect, it, vi } from "vitest";
import { processWebhook, type WebhookProcessorDependencies } from "@/lib/webhooks/processor";

describe("processWebhook", () => {
  it("records a reconciliation job and finishes the delivery with the lease it claimed", async () => {
    const dependencies = processorDependencies({ claimDelivery: claimedLease("lease-1") });

    const result = await processWebhook(dependencies, delivery());

    expect(result).toEqual({ status: "PROCESSED" });
    expect(dependencies.enqueueReconciliation).toHaveBeenCalledWith("repository");
    expect(dependencies.store.markProcessed).toHaveBeenCalledWith("delivery-1", "lease-1");
  });

  it("does not schedule a fold for a delivery still leased by an interrupted worker", async () => {
    const dependencies = processorDependencies({ claimDelivery: { status: "DUPLICATE" } });

    const result = await processWebhook(dependencies, delivery());

    expect(result).toEqual({ status: "DUPLICATE" });
    expect(dependencies.enqueueReconciliation).not.toHaveBeenCalled();
    expect(dependencies.store.markProcessed).not.toHaveBeenCalled();
  });

  it.each([
    { repository: null, tracking: "a repository Overflow does not know" },
    { repository: { id: "repository", active: false }, tracking: "a repository Overflow no longer tracks" },
  ])("does not schedule a fold for $tracking", async ({ repository }) => {
    const dependencies = processorDependencies({
      findRepositoryByGitHubId: vi.fn().mockResolvedValue(repository),
    });

    await expect(processWebhook(dependencies, delivery())).resolves.toEqual({ status: "PROCESSED" });

    expect(dependencies.enqueueReconciliation).not.toHaveBeenCalled();
  });

  it("writes only a sanitized failure status before allowing GitHub to retry", async () => {
    const dependencies = processorDependencies({
      claimDelivery: claimedLease("lease-1"),
      enqueueReconciliation: vi.fn().mockRejectedValue(new Error("databaseUrl=postgres://secret")),
    });

    await expect(processWebhook(dependencies, delivery())).rejects.toThrow("Webhook processing failed.");

    expect(dependencies.store.markFailed).toHaveBeenCalledWith(
      "delivery-1",
      "lease-1",
      "Webhook processing failed.",
    );
  });

  it("keeps a sanitized failure when persisting FAILED itself fails", async () => {
    const dependencies = processorDependencies({
      claimDelivery: claimedLease("lease-1"),
      enqueueReconciliation: vi.fn().mockRejectedValue(new Error("databaseUrl=postgres://secret")),
      markFailed: vi.fn().mockRejectedValue(new Error("write failed with token=secret")),
    });

    await expect(processWebhook(dependencies, delivery())).rejects.toThrow("Webhook processing failed.");
  });

  it("does not report a delivery as processed when its lease ownership was lost", async () => {
    const dependencies = processorDependencies({
      claimDelivery: claimedLease("stale-lease"),
      markProcessed: vi.fn().mockResolvedValue(false),
    });

    await expect(processWebhook(dependencies, delivery())).resolves.toEqual({ status: "DUPLICATE" });
  });
});

function delivery() {
  return {
    deliveryId: "delivery-1",
    event: "pull_request" as const,
    action: "closed",
    repositoryGitHubId: 42,
    repositoryFullName: "octo/example",
  };
}

function processorDependencies(
  overrides: Partial<{
    claimDelivery: DeliveryClaim;
    findRepositoryByGitHubId: ReturnType<typeof vi.fn>;
    enqueueReconciliation: ReturnType<typeof vi.fn>;
    markProcessed: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
  }> = {},
): WebhookProcessorDependencies & {
  enqueueReconciliation: ReturnType<typeof vi.fn>;
  store: WebhookProcessorDependencies["store"] & {
    markProcessed: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
  };
} {
  const enqueueReconciliation = overrides.enqueueReconciliation ?? vi.fn().mockResolvedValue(undefined);
  const store = {
    claimDelivery: vi.fn().mockResolvedValue(overrides.claimDelivery ?? claimedLease("lease-1")),
    findRepositoryByGitHubId:
      overrides.findRepositoryByGitHubId ?? vi.fn().mockResolvedValue({ id: "repository", active: true }),
    markProcessed: overrides.markProcessed ?? vi.fn().mockResolvedValue(true),
    markFailed: overrides.markFailed ?? vi.fn().mockResolvedValue(true),
  };

  return { store, enqueueReconciliation } as WebhookProcessorDependencies & {
    enqueueReconciliation: ReturnType<typeof vi.fn>;
    store: WebhookProcessorDependencies["store"] & {
      markProcessed: ReturnType<typeof vi.fn>;
      markFailed: ReturnType<typeof vi.fn>;
    };
  };
}

type DeliveryClaim =
  | { status: "CLAIMED"; leaseToken: string }
  | { status: "DUPLICATE" };

function claimedLease(leaseToken: string): DeliveryClaim {
  return { status: "CLAIMED", leaseToken };
}
