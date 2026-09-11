import { describe, expect, it, vi } from "vitest";
import { processWebhook, type WebhookProcessorDependencies } from "@/lib/webhooks/processor";

describe("processWebhook", () => {
  it("records a reconciliation job and finishes the delivery with the lease it claimed", async () => {
    const dependencies = processorDependencies({ claimDelivery: claimedLease("lease-1") });

    const result = await processWebhook(dependencies, delivery());

    expect(result).toEqual({ status: "PROCESSED" });
    // Mutant: DROP_SUBJECT_ID at the processor/enqueue boundary.
    expect(dependencies.enqueueReconciliation).toHaveBeenCalledWith("repository", delivery());
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

  it("preserves the root cause on the thrown error while every persisted surface stays sanitized", async () => {
    const dependencies = processorDependencies({
      enqueueReconciliation: vi.fn().mockRejectedValue(new Error("probe enqueue root cause")),
    });

    const error = await processWebhook(dependencies, delivery()).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe("Webhook processing failed.");
    expect((error as Error).cause).toBeInstanceOf(Error);
    expect(((error as Error).cause as Error).message).toBe("probe enqueue root cause");
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

  // A GitLab delivery (issue 547) resolves through the forge identity it
  // carries — the numeric id alone could name a GitHub registration instead.
  it("resolves a forge delivery by its forge identity and never by the numeric id", async () => {
    const dependencies = processorDependencies({
      findRepositoryByGitHubId: vi.fn().mockResolvedValue(null),
    });
    const forgeDelivery = {
      ...delivery(),
      repositoryGitHubId: 278964,
      forge: { provider: "gitlab" as const, instanceUrl: "https://gitlab.example.com" },
    };
    dependencies.store.findRepositoryByForgeIdentity = vi.fn().mockResolvedValue({ id: "gitlab-repository", active: true });

    const result = await processWebhook(dependencies, forgeDelivery);

    expect(result).toEqual({ status: "PROCESSED" });
    expect(dependencies.store.findRepositoryByForgeIdentity).toHaveBeenCalledWith("gitlab", "https://gitlab.example.com", 278964);
    expect(dependencies.store.findRepositoryByGitHubId).not.toHaveBeenCalled();
    expect(dependencies.enqueueReconciliation).toHaveBeenCalledWith("gitlab-repository", forgeDelivery);
    expect(dependencies.store.markProcessed).toHaveBeenCalledWith("delivery-1", "lease-1");
  });

  it("does not schedule a fold for a forge delivery whose identity resolves to nothing", async () => {
    const dependencies = processorDependencies({
      findRepositoryByForgeIdentity: vi.fn().mockResolvedValue(null),
    });

    await expect(processWebhook(dependencies, {
      ...delivery(),
      forge: { provider: "gitlab" as const, instanceUrl: "https://gitlab.example.com" },
    })).resolves.toEqual({ status: "PROCESSED" });

    expect(dependencies.enqueueReconciliation).not.toHaveBeenCalled();
    expect(dependencies.store.markProcessed).toHaveBeenCalled();
  });

  it("applies the issue view of a forge delivery through the same seam", async () => {
    const dependencies = processorDependencies({
      findRepositoryByForgeIdentity: vi.fn().mockResolvedValue({ id: "gitlab-repository", active: true }),
    });
    const forgeDelivery = {
      ...delivery(),
      event: "issues" as const,
      subject: { kind: "ISSUE" as const, id: 301, number: 23 },
      issue: { state: "CLOSED" as const, updatedAt: "2026-09-08T10:00:00Z", title: "t", body: "", url: "https://gitlab.example.com/g/p/-/issues/23" },
      forge: { provider: "gitlab" as const, instanceUrl: "https://gitlab.example.com" },
    };

    await processWebhook(dependencies, forgeDelivery);

    expect(dependencies.store.applyIssueView).toHaveBeenCalledWith("gitlab-repository", 301, forgeDelivery.issue);
    expect(dependencies.enqueueReconciliation).toHaveBeenCalledWith("gitlab-repository", forgeDelivery);
  });
});

function delivery() {
  return {
    deliveryId: "delivery-1",
    event: "pull_request" as const,
    action: "closed",
    repositoryGitHubId: 42,
    repositoryFullName: "octo/example",
    subject: { kind: "PULL_REQUEST" as const, id: 201, number: 11 },
  };
}

function processorDependencies(
  overrides: Partial<{
    claimDelivery: DeliveryClaim;
    findRepositoryByGitHubId: ReturnType<typeof vi.fn>;
    findRepositoryByForgeIdentity: ReturnType<typeof vi.fn>;
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
    applyIssueView: vi.fn().mockResolvedValue(undefined),
    claimDelivery: vi.fn().mockResolvedValue(overrides.claimDelivery ?? claimedLease("lease-1")),
    findRepositoryByGitHubId:
      overrides.findRepositoryByGitHubId ?? vi.fn().mockResolvedValue({ id: "repository", active: true }),
    findRepositoryByForgeIdentity:
      overrides.findRepositoryByForgeIdentity ?? vi.fn().mockResolvedValue({ id: "repository", active: true }),
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
