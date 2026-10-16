import { createHash } from "node:crypto";
import { githubWebhookEvents, parseGitHubWebhookDeliveryDetailed, type GitHubWebhookDelivery } from "@/lib/github/webhook-schema";
import { verifyGitHubWebhookSignature } from "@/lib/github/webhook-signature";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { errorClassName, errorLogToken, logField } from "@/lib/webhooks/log-field";
import { PostgresWebhookDeliveryStore } from "@/lib/webhooks/postgres-delivery-store";
import { processWebhook, type WebhookProcessingResult, type WebhookReceiptScope } from "@/lib/webhooks/processor";
import { createReceiverRateLimiter, WEBHOOK_RATE_LIMIT_CAPACITY, WEBHOOK_RATE_LIMIT_REFILL_PER_MINUTE } from "@/lib/webhooks/rate-limit";
import { FailureLogger } from "@/lib/worker/failure-logger";

export type GitHubAppWebhookRouteDependencies = {
  secret: string | undefined;
  checkRateLimit: () => boolean;
  findActiveAppRegistrationByGitHubRepositoryId(id: number): Promise<{ repositoryId: string } | null>;
  processWebhook(delivery: GitHubWebhookDelivery, scope: WebhookReceiptScope): Promise<WebhookProcessingResult>;
};

const GITHUB_WEBHOOK_BODY_LIMIT_BYTES = 25 * 1024 * 1024;
const configurationFailures = new FailureLogger();
const registrationLookupFailures = new FailureLogger();

export function createGitHubAppWebhookPostHandler(dependencies: GitHubAppWebhookRouteDependencies) {
  return async function post(request: Request): Promise<Response> {
    // Decline before touching request content, sharing one bucket per receiver.
    if (!dependencies.checkRateLimit()) return new Response(null, { status: 429, headers: { "retry-after": "1" } });
    // Configuration must fail closed even for malformed or ignored deliveries.
    // One constant outage key keeps an unconfigured receiver's journal bounded.
    if (!dependencies.secret) {
      configurationFailures.failure(
        "github-app-webhook-secret",
        "GitHub registration App webhook secret is not configured; answered 503 so GitHub retries.",
      );
      return new Response(null, { status: 503 });
    }
    const event = request.headers.get("x-github-event");
    const deliveryId = request.headers.get("x-github-delivery");
    const signature = request.headers.get("x-hub-signature-256");
    if (event === null || deliveryId === null || signature === null) {
      return new Response(null, { status: 400 });
    }

    const rawBody = await readBodyWithinLimit(request, GITHUB_WEBHOOK_BODY_LIMIT_BYTES);
    if (rawBody === null) return new Response(null, { status: 413 });
    if (!verifyGitHubWebhookSignature(rawBody, signature, dependencies.secret)) {
      return new Response(null, { status: 401 });
    }
    // App-management events are authenticated traffic, but have no repository
    // delivery to materialize. Gate before parsing even their JSON envelope.
    if (!githubWebhookEvents.some((supported) => supported === event)) {
      return new Response(null, { status: 204 });
    }
    const bodyDigest = createHash("sha256").update(rawBody).digest("hex");
    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as unknown;
    } catch {
      return new Response(null, { status: 400 });
    }
    const result = parseGitHubWebhookDeliveryDetailed(event, deliveryId, payload);
    if (result.status === "ignored") return new Response(null, { status: 204 });
    if (result.status !== "ok") return new Response(null, { status: 400 });
    const delivery = result.delivery;

    let registration;
    try {
      registration = await dependencies.findActiveAppRegistrationByGitHubRepositoryId(delivery.repositoryGitHubId);
    } catch (error) {
      registrationLookupFailures.failure(
        "github-app-registration-lookup",
        `GitHub App registration lookup failed (phase registration lookup, error ${logField(errorClassName(error))}); answered 503 so GitHub retries.`,
      );
      return new Response(null, { status: 503 });
    }
    // The lookup admits only active GitHub App rows. OAuth hook registrations
    // receive their events through their own receiver and must have no effects here.
    if (registration === null) return new Response(null, { status: 204 });

    try {
      const processed = await dependencies.processWebhook(delivery, {
        provider: "github", registrationId: registration.repositoryId, bodyDigest,
      });
      if (processed.status === "IN_PROGRESS") {
        console.warn(`Webhook delivery ${logField(delivery.deliveryId)} is still being processed by an earlier attempt; answered 503 so it is retried.`);
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 202 });
    } catch (error) {
      console.error(
        `Webhook processing failed for delivery ${logField(delivery.deliveryId)}`
          + ` (event ${delivery.event}, repository ${logField(delivery.repositoryFullName)},`
          + ` GitHub id ${delivery.repositoryGitHubId}).`,
        errorLogToken(error),
      );
      return new Response(null, { status: 503 });
    }
  };
}

const webhookRateLimiter = createReceiverRateLimiter({
  receiver: "github-app",
  capacity: WEBHOOK_RATE_LIMIT_CAPACITY,
  refillPerMinute: WEBHOOK_RATE_LIMIT_REFILL_PER_MINUTE,
});

export async function POST(request: Request): Promise<Response> {
  return createGitHubAppWebhookPostHandler({
    secret: process.env.GITHUB_REGISTRATION_APP_WEBHOOK_SECRET,
    checkRateLimit: () => webhookRateLimiter.admit(),
    findActiveAppRegistrationByGitHubRepositoryId: (id) => new PostgresRepositoryStore().findActiveAppRegistrationByGitHubRepositoryId(id),
    processWebhook: async (delivery, scope) => {
      const store = new PostgresWebhookDeliveryStore();
      return processWebhook({
        store,
        enqueueReconciliation: (repositoryId, event) => store.enqueueWebhookReconciliation(repositoryId, event),
      }, delivery, scope);
    },
  })(request);
}
