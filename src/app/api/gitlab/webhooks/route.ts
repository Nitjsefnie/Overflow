import { parseGitLabWebhookDeliveryDetailed } from "@/lib/gitlab/webhook-schema";
import { verifyGitLabWebhookToken } from "@/lib/gitlab/webhook-token";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { processWebhook } from "@/lib/webhooks/processor";
import type { GitHubWebhookDelivery } from "@/lib/github/webhook-schema";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { normalizeInstanceUrl } from "@/lib/forge/identities";
import { webhookSelector, type WebhookCredentialLookup } from "@/lib/webhooks/credentials";

export type GitLabWebhookRouteDependencies = {
  lookupCredential: WebhookCredentialLookup;
  processWebhook(delivery: GitHubWebhookDelivery): Promise<unknown>;
};

// GitLab documents no webhook payload ceiling the way GitHub does; the
// receiver carries the same 25 MiB cap the GitHub receiver enforces, for the
// same reason: a delivery must never force an unbounded read into memory.
// The rejection is strict-greater (bytes > LIMIT), so a delivery at exactly
// the ceiling is still accepted.
const GITLAB_WEBHOOK_BODY_LIMIT_BYTES = 25 * 1024 * 1024; // 25 MiB

export function createGitLabWebhookPostHandler(dependencies: GitLabWebhookRouteDependencies) {
  return async function post(request: Request): Promise<Response> {
    const event = request.headers.get("x-gitlab-event");
    const deliveryUuid = request.headers.get("x-gitlab-webhook-uuid");
    const token = request.headers.get("x-gitlab-token");
    if (event === null || deliveryUuid === null || token === null) {
      return new Response(null, { status: 400 });
    }
    const selector = webhookSelector(request.url);
    if (selector === null) return new Response(null, { status: 401 });
    let credential;
    try {
      credential = await dependencies.lookupCredential(selector, "gitlab");
    } catch {
      return new Response(null, { status: 503 });
    }
    if (credential === null || credential.provider !== "gitlab" || credential.credentialId !== selector) {
      return new Response(null, { status: 401 });
    }
    // The token is header-only — no HMAC over the body, unlike GitHub — so a
    // wrong token is refused here, before Content-Length is consulted and
    // before a single body byte is read.
    if (!verifyGitLabWebhookToken(token, credential.secret)) {
      return new Response(null, { status: 401 });
    }

    const contentLength = request.headers.get("content-length");
    if (contentLength !== null) {
      const declaredBytes = Number(contentLength);
      if (
        Number.isSafeInteger(declaredBytes) && declaredBytes >= 0
        && declaredBytes > GITLAB_WEBHOOK_BODY_LIMIT_BYTES
      ) {
        return new Response(null, { status: 413 });
      }
    }

    const rawBody = await readBodyWithinLimit(request);
    if (rawBody === null) {
      return new Response(null, { status: 413 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as unknown;
    } catch {
      return new Response(null, { status: 400 });
    }
    // Both payload kinds the hook subscribes to — issue and merge request —
    // are accepted for processing, so the parser answers only ok or invalid;
    // there is no deliberately-ignored (204) class on this receiver.
    const result = parseGitLabWebhookDeliveryDetailed(event, deliveryUuid, payload);
    if (result.status !== "ok") {
      return new Response(null, { status: 400 });
    }
    const delivery = result.delivery;
    if (delivery.repositoryGitHubId !== credential.projectId || delivery.forge?.provider !== "gitlab"
      || credential.instanceUrl === null
      || delivery.forge.instanceUrl !== normalizeInstanceUrl(credential.instanceUrl)) {
      return new Response(null, { status: 401 });
    }

    try {
      await dependencies.processWebhook(delivery);
      return new Response(null, { status: 202 });
    } catch (error) {
      // The GitLab twin of the GitHub receiver's diagnostic: the instance sees
      // only an empty 503 and the store persists the sanitized constant, so
      // this console line is the operators' one view of why a delivery failed.
      // The message is a fixed template over the delivery's identifiers, and
      // the error object itself rides as the second argument — Node renders
      // its type, stack and Error.cause chain natively, and nothing
      // user-controlled beyond those identifiers is concatenated.
      console.error(
        `Webhook processing failed for delivery ${delivery.deliveryId}`
          + ` (event ${delivery.event}, repository ${delivery.repositoryFullName},`
          + ` forge id ${delivery.repositoryGitHubId}).`,
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
    if (totalBytes > GITLAB_WEBHOOK_BODY_LIMIT_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(chunk);
    read = await reader.read();
  }
  return Buffer.concat(chunks);
}

export async function POST(request: Request): Promise<Response> {
  return createGitLabWebhookPostHandler({
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
