import {
  parseGitHubWebhookDeliveryDetailed,
  type GitHubWebhookDelivery,
} from "@/lib/github/webhook-schema";
import { verifyGitHubWebhookSignature } from "@/lib/github/webhook-signature";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { processWebhook, type WebhookProcessingResult, type WebhookReceiptScope } from "@/lib/webhooks/processor";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { githubPayloadRepositoryId, webhookSelector, type WebhookCredentialLookup } from "@/lib/webhooks/credentials";
import { logField } from "@/lib/webhooks/log-field";
import { readBodyWithinLimit } from "@/lib/http/request-body";

export type GitHubWebhookRouteDependencies = {
  lookupCredential: WebhookCredentialLookup;
  processWebhook(delivery: GitHubWebhookDelivery, scope: WebhookReceiptScope): Promise<WebhookProcessingResult>;
};

// GitHub documents webhook payloads as capped at 25 MB. 25 MiB (26,214,400)
// exceeds that cap under either reading of "MB" (25,000,000 decimal or
// 26,214,400 binary), and the rejection is strict-greater (bytes > LIMIT), so
// a delivery at GitHub's own ceiling is still accepted. Every legitimate
// GitHub delivery passes; anything larger is rejected after reading at most
// LIMIT plus one chunk.
const GITHUB_WEBHOOK_BODY_LIMIT_BYTES = 25 * 1024 * 1024; // 25 MiB

export function createGitHubWebhookPostHandler(dependencies: GitHubWebhookRouteDependencies) {
  return async function post(request: Request): Promise<Response> {
    const event = request.headers.get("x-github-event");
    const deliveryId = request.headers.get("x-github-delivery");
    const signature = request.headers.get("x-hub-signature-256");
    if (event === null || deliveryId === null || signature === null) {
      return new Response(null, { status: 400 });
    }
    const selector = webhookSelector(request.url);
    if (selector === null) return new Response(null, { status: 401 });
    let credential;
    try {
      credential = await dependencies.lookupCredential(selector, "github");
    } catch {
      return new Response(null, { status: 503 });
    }
    if (credential === null || credential.provider !== "github" || credential.credentialId !== selector) {
      return new Response(null, { status: 401 });
    }

    // The reader carries the Content-Length pre-check the route used to make
    // itself: a declared oversize answers 413 here without a byte read, and a
    // stream that crosses the limit is cancelled mid-read, so response
    // ordering and the 413 semantics are unchanged.
    const rawBody = await readBodyWithinLimit(request, GITHUB_WEBHOOK_BODY_LIMIT_BYTES);
    if (rawBody === null) {
      return new Response(null, { status: 413 });
    }
    if (!verifyGitHubWebhookSignature(rawBody, signature, credential.secret)) {
      return new Response(null, { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as unknown;
    } catch {
      return new Response(null, { status: 400 });
    }
    const result = parseGitHubWebhookDeliveryDetailed(event, deliveryId, payload);
    if (githubPayloadRepositoryId(payload) !== credential.projectId) {
      return new Response(null, { status: 401 });
    }
    if (result.status === "ignored") {
      // Deliberately ignored (a PR-carrying issue envelope) is a success to
      // GitHub — any 2xx counts as delivered — so it must not read as a
      // rejection, or the delivery log turns red on ignored traffic and hides
      // real failures. 202 stays reserved for accepted-for-processing.
      return new Response(null, { status: 204 });
    }
    if (result.status !== "ok") {
      return new Response(null, { status: 400 });
    }
    const delivery = result.delivery;

    try {
      const processed = await dependencies.processWebhook(delivery, { provider: credential.provider, registrationId: credential.repositoryId });
      if (processed.status === "IN_PROGRESS") {
        // An earlier attempt still holds this delivery's lease and may yet
        // fail, so the redelivery is not acknowledged: an empty 503 leaves it
        // marked failed in GitHub's delivery log, and a later redelivery
        // retries it. Not a processing failure, so one fixed-template line
        // naming only the delivery id, header-derived and so encoded by
        // logField into one quoted, escaped, length-bounded token.
        console.warn(`Webhook delivery ${logField(delivery.deliveryId)} is still being processed by an earlier attempt; answered 503 so it is retried.`);
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 202 });
    } catch (error) {
      // GitHub sees only an empty 503 and the store persists the sanitized
      // constant, so this console line is the operators' one view of why a
      // delivery failed. The message is a fixed template over the delivery's
      // identifiers, and the error object itself rides as the second argument
      // — Node renders its type, stack and Error.cause chain natively. The
      // request-derived identifiers (the delivery id, and the repository's
      // full_name, which the parser accepts with internal control characters
      // and at any length) each go through logField, so each is one quoted
      // token with its controls escaped and its length bounded; the event is
      // the parser's constant and the GitHub id a number.
      console.error(
        `Webhook processing failed for delivery ${logField(delivery.deliveryId)}`
          + ` (event ${delivery.event}, repository ${logField(delivery.repositoryFullName)},`
          + ` GitHub id ${delivery.repositoryGitHubId}).`,
        error,
      );
      return new Response(null, { status: 503 });
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  return createGitHubWebhookPostHandler({
    lookupCredential: (selector, provider) => new PostgresRepositoryStore().findWebhookCredential(selector, provider),
    processWebhook: async (delivery, scope) => {
      const store = new PostgresFoldStore();
      return processWebhook({
        store,
        enqueueReconciliation: (repositoryId, event) => store.enqueueWebhookReconciliation(repositoryId, event),
      }, delivery, scope);
    },
  })(request);
}
