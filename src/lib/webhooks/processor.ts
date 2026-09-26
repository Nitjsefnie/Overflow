import type { GitHubWebhookDelivery, GitHubWebhookIssue } from "@/lib/github/webhook-schema";
import { sanitizeForgeStrings } from "@/lib/forge/sanitize-forge-strings";
import { redactPostgresError } from "@/lib/db/redact-postgres-error";

export type WebhookReceiptScope = { provider: "github" | "gitlab"; registrationId: string };

export type WebhookDeliveryStore = {
  claimDelivery(delivery: GitHubWebhookDelivery, scope: WebhookReceiptScope): Promise<WebhookDeliveryClaim>;
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
  markProcessed(receiptId: string, leaseToken: string): Promise<boolean>;
  markFailed(receiptId: string, leaseToken: string, errorMessage: string): Promise<boolean>;
};

export type WebhookProcessorDependencies = {
  store: WebhookDeliveryStore;
  enqueueReconciliation(repositoryId: string, delivery: GitHubWebhookDelivery): Promise<unknown>;
};

/**
 * DUPLICATE: the receipt is already PROCESSED, or this attempt recorded its
 * work but lost the lease before marking it. IN_PROGRESS: an earlier attempt
 * still holds the lease, so nothing was done and the sender must retry — that
 * attempt may yet fail.
 */
export type WebhookProcessingResult = { status: "PROCESSED" | "DUPLICATE" | "IN_PROGRESS" };

export type WebhookDeliveryClaim =
  | { status: "CLAIMED"; receiptId: string; leaseToken: string }
  | { status: "DUPLICATE" }
  | { status: "IN_PROGRESS" };

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
  scope: WebhookReceiptScope,
): Promise<WebhookProcessingResult> {
  const claim = await dependencies.store.claimDelivery(delivery, scope);
  if (claim.status !== "CLAIMED") {
    return { status: claim.status };
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
        await dependencies.store.applyIssueView(repository.id, delivery.subject.id, sanitizeForgeStrings(delivery.issue));
      }
      await dependencies.enqueueReconciliation(repository.id, delivery);
    }
    const markedProcessed = await dependencies.store.markProcessed(claim.receiptId, claim.leaseToken);
    return { status: markedProcessed ? "PROCESSED" : "DUPLICATE" };
  } catch (error) {
    try {
      await dependencies.store.markFailed(claim.receiptId, claim.leaseToken, "Webhook processing failed.");
    } catch {
      // A stale pending lease remains reclaimable if recording its failure also fails.
    }
    // The stored failure text is product data, and upstream errors can carry
    // secrets such as a token in a URL. Keep the stored message fixed and strip
    // record-bearing PostgreSQL fields before a route logs the thrown cause.
    throw new Error("Webhook processing failed.", { cause: redactPostgresError(error) });
  }
}
