import { describe, expect, it, vi } from "vitest";
import { processWebhook, type WebhookProcessorDependencies } from "@/lib/webhooks/processor";

describe("processWebhook", () => {
  it("deduplicates a GitHub delivery before scheduling one scoped reconciliation", async () => {
    const dependencies = processorDependencies({ claimDelivery: "NEW" });

    const result = await processWebhook(dependencies, delivery());

    expect(result).toEqual({ status: "PROCESSED" });
    expect(dependencies.reconcileRepository).toHaveBeenCalledWith("repository");
    expect(dependencies.store.markProcessed).toHaveBeenCalledWith("delivery-1");
  });

  it("does not reconcile an already-seen GitHub delivery", async () => {
    const dependencies = processorDependencies({ claimDelivery: "DUPLICATE" });

    const result = await processWebhook(dependencies, delivery());

    expect(result).toEqual({ status: "DUPLICATE" });
    expect(dependencies.reconcileRepository).not.toHaveBeenCalled();
    expect(dependencies.store.markProcessed).not.toHaveBeenCalled();
  });

  it("writes only a sanitized failure status before allowing GitHub to retry", async () => {
    const dependencies = processorDependencies({
      reconcileRepository: vi.fn().mockRejectedValue(new Error("databaseUrl=postgres://secret")),
    });

    await expect(processWebhook(dependencies, delivery())).rejects.toThrow("Webhook processing failed.");

    expect(dependencies.store.markFailed).toHaveBeenCalledWith("delivery-1", "Webhook processing failed.");
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
    claimDelivery: "NEW" | "DUPLICATE";
    reconcileRepository: ReturnType<typeof vi.fn>;
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
    claimDelivery: vi.fn().mockResolvedValue(overrides.claimDelivery ?? "NEW"),
    findRepositoryByGitHubId: vi.fn().mockResolvedValue({ id: "repository", active: true }),
    markProcessed: vi.fn().mockResolvedValue(undefined),
    markFailed: vi.fn().mockResolvedValue(undefined),
  };

  return { store, reconcileRepository } as WebhookProcessorDependencies & {
    reconcileRepository: ReturnType<typeof vi.fn>;
    store: WebhookProcessorDependencies["store"] & {
      markProcessed: ReturnType<typeof vi.fn>;
      markFailed: ReturnType<typeof vi.fn>;
    };
  };
}
