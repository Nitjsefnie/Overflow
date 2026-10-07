import type { GitHubWebhookDelivery, GitHubWebhookIssue } from "@/lib/github/webhook-schema";
import { sanitizeForgeStrings } from "@/lib/forge/sanitize-forge-strings";
import { redactPostgresError } from "@/lib/db/redact-postgres-error";

/**
 * The registration a delivery resolves against, plus the replay key the
 * receipts layer dedups on: `bodyDigest` is the SHA-256 of the signed body,
 * computed by the receiver route after its signature check. A repeat digest
 * that matches a PROCESSED receipt for this registration is a duplicate,
 * whatever the delivery id; a null or absent digest falls back to the
 * delivery-id-only rule the previous release used (issue 1041).
 */
export type WebhookReceiptScope = { provider: "github" | "gitlab"; registrationId: string; bodyDigest?: string };

/**
 * The registration row a webhook delivery resolves against. `unavailableReason`
 * is the sweep's word that it cannot currently verify the repository as
 * crawlable-and-public (NOT_FOUND, NOT_PUBLIC, IDENTITY_MISMATCH); the row
 * still reads `active` while it stands, because flipping `active` would end
 * the crawl and with it the sweep's automatic recovery.
 */
export type WebhookRepositoryRegistration = {
  id: string;
  active: boolean;
  unavailableReason: string | null;
};

export type WebhookDeliveryStore = {
  claimDelivery(delivery: GitHubWebhookDelivery, scope: WebhookReceiptScope): Promise<WebhookDeliveryClaim>;
  findRepositoryByGitHubId(githubRepositoryId: number): Promise<WebhookRepositoryRegistration | null>;
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
  ): Promise<WebhookRepositoryRegistration | null>;
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
    // A delivery whose own payload marks the repository non-public applies
    // nothing and enqueues nothing, even while the registration row still
    // reads active: the payload is the forge's own word about visibility, and
    // acting on it would keep exposing a repository that has gone private.
    // The registration row itself carries the same veto through its sweep
    // word: a row whose unavailableReason is set cannot currently be verified
    // as crawlable-and-public, and it still reads active — flipping active
    // would end the crawl and with it the sweep's automatic recovery — so the
    // word decides here instead. The receipt is still marked PROCESSED, so the
    // route answers 202 and the sender never retries.
    if (
      repository !== null && repository.active
        && repository.unavailableReason === null && delivery.repositoryPrivate !== true
    ) {
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
