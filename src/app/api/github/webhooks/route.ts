import {
  parseGitHubWebhookDeliveryDetailed,
  type GitHubWebhookDelivery,
} from "@/lib/github/webhook-schema";
import { verifyGitHubWebhookSignature } from "@/lib/github/webhook-signature";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { processWebhook } from "@/lib/webhooks/processor";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { githubPayloadRepositoryId, webhookSelector, type WebhookCredentialLookup } from "@/lib/webhooks/credentials";

export type GitHubWebhookRouteDependencies = {
  lookupCredential: WebhookCredentialLookup;
  processWebhook(delivery: GitHubWebhookDelivery): Promise<unknown>;
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

    const contentLength = request.headers.get("content-length");
    if (contentLength !== null) {
      const declaredBytes = Number(contentLength);
      if (
        Number.isSafeInteger(declaredBytes) && declaredBytes >= 0
        && declaredBytes > GITHUB_WEBHOOK_BODY_LIMIT_BYTES
      ) {
        return new Response(null, { status: 413 });
      }
    }

    const rawBody = await readBodyWithinLimit(request);
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
      await dependencies.processWebhook(delivery);
      return new Response(null, { status: 202 });
    } catch (error) {
      // GitHub sees only an empty 503 and the store persists the sanitized
      // constant, so this console line is the operators' one view of why a
      // delivery failed. The message is a fixed template over the delivery's
      // identifiers, and the error object itself rides as the second argument
      // — Node renders its type, stack and Error.cause chain natively, and
      // nothing user-controlled beyond those identifiers is concatenated.
      console.error(
        `Webhook processing failed for delivery ${delivery.deliveryId}`
          + ` (event ${delivery.event}, repository ${delivery.repositoryFullName},`
          + ` GitHub id ${delivery.repositoryGitHubId}).`,
        error,
      );
      return new Response(null, { status: 503 });
    }
  };
}

// Reads the request body chunk by chunk under the webhook body limit,
// returning the concatenated bytes, or null once the running count crosses
// the limit. The reader is cancelled on the crossing chunk — never drained to
// completion — so a missing, unparsable, or inaccurate Content-Length cannot
// bypass the ceiling, and an oversized delivery never forces more than LIMIT
// plus one chunk into memory.
async function readBodyWithinLimit(request: Request): Promise<Buffer | null> {
  if (request.body === null) {
    return Buffer.alloc(0);
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let read = await reader.read();
  while (!read.done) {
    const chunk = read.value;
    totalBytes += chunk.byteLength;
    if (totalBytes > GITHUB_WEBHOOK_BODY_LIMIT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
    read = await reader.read();
  }
  return Buffer.concat(chunks);
}

export async function POST(request: Request): Promise<Response> {
  return createGitHubWebhookPostHandler({
    lookupCredential: (selector, provider) => new PostgresRepositoryStore().findWebhookCredential(selector, provider),
    processWebhook: async (delivery) => {
      const store = new PostgresFoldStore();
      return processWebhook({
        store,
        enqueueReconciliation: (repositoryId, event) => store.enqueueWebhookReconciliation(repositoryId, event),
      }, delivery);
    },
  })(request);
}
