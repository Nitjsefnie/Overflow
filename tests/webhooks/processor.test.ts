import { describe, expect, it, vi } from "vitest";
import { processWebhook, type WebhookProcessorDependencies } from "@/lib/webhooks/processor";

describe("processWebhook", () => {
  it("finishes a GitHub delivery only with the lease it claimed", async () => {
    const dependencies = processorDependencies({ claimDelivery: claimedLease("lease-1") });

    const result = await processWebhook(dependencies, delivery());

    expect(result).toEqual({ status: "PROCESSED" });
    expect(dependencies.reconcileRepository).toHaveBeenCalledWith("repository");
    expect(dependencies.store.markProcessed).toHaveBeenCalledWith("delivery-1", "lease-1");
  });

  it("does not reconcile a delivery still leased by an interrupted worker", async () => {
    const dependencies = processorDependencies({ claimDelivery: { status: "DUPLICATE" } });

    const result = await processWebhook(dependencies, delivery());

    expect(result).toEqual({ status: "DUPLICATE" });
    expect(dependencies.reconcileRepository).not.toHaveBeenCalled();
    expect(dependencies.store.markProcessed).not.toHaveBeenCalled();
  });

  it("writes only a sanitized failure status before allowing GitHub to retry", async () => {
    const dependencies = processorDependencies({
      claimDelivery: claimedLease("lease-1"),
      reconcileRepository: vi.fn().mockRejectedValue(new Error("databaseUrl=postgres://secret")),
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
      reconcileRepository: vi.fn().mockRejectedValue(new Error("databaseUrl=postgres://secret")),
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

  it("renews its delivery lease while repository reconciliation is still running", async () => {
    vi.useFakeTimers();
    let finishReconciliation!: () => void;
    const dependencies = processorDependencies({
      claimDelivery: claimedLease("lease-1"),
      reconcileRepository: vi.fn(() => new Promise<void>((resolve) => {
        finishReconciliation = resolve;
      })),
      leaseHeartbeatIntervalMs: 60_000,
    });

    try {
      const processing = processWebhook(dependencies, delivery());
      await vi.advanceTimersByTimeAsync(60_001);

      expect(dependencies.store.renewDeliveryLease).toHaveBeenCalledWith("delivery-1", "lease-1");
      finishReconciliation();
      await expect(processing).resolves.toEqual({ status: "PROCESSED" });
    } finally {
      vi.useRealTimers();
    }
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
    reconcileRepository: ReturnType<typeof vi.fn>;
    markProcessed: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
    leaseHeartbeatIntervalMs: number;
  }> = {},
): WebhookProcessorDependencies & {
  reconcileRepository: ReturnType<typeof vi.fn>;
  store: WebhookProcessorDependencies["store"] & {
    markProcessed: ReturnType<typeof vi.fn>;
    markFailed: ReturnType<typeof vi.fn>;
  };
} {
  const reconcileRepository = overrides.reconcileRepository ?? vi.fn().mockResolvedValue(undefined);
  const store = {
    claimDelivery: vi.fn().mockResolvedValue(overrides.claimDelivery ?? claimedLease("lease-1")),
    findRepositoryByGitHubId: vi.fn().mockResolvedValue({ id: "repository", active: true }),
    markProcessed: overrides.markProcessed ?? vi.fn().mockResolvedValue(true),
    markFailed: overrides.markFailed ?? vi.fn().mockResolvedValue(true),
    renewDeliveryLease: vi.fn().mockResolvedValue(true),
  };

  return {
    store,
    reconcileRepository,
    leaseHeartbeatIntervalMs: overrides.leaseHeartbeatIntervalMs,
  } as WebhookProcessorDependencies & {
    reconcileRepository: ReturnType<typeof vi.fn>;
    store: WebhookProcessorDependencies["store"] & {
      markProcessed: ReturnType<typeof vi.fn>;
      markFailed: ReturnType<typeof vi.fn>;
      renewDeliveryLease: ReturnType<typeof vi.fn>;
    };
  };
}

type DeliveryClaim =
  | { status: "CLAIMED"; leaseToken: string }
  | { status: "DUPLICATE" };

function claimedLease(leaseToken: string): DeliveryClaim {
  return { status: "CLAIMED", leaseToken };
}
