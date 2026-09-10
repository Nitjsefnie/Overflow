import {
  parseGitHubWebhookDeliveryDetailed,
  type GitHubWebhookDelivery,
} from "@/lib/github/webhook-schema";
import { verifyGitHubWebhookSignature } from "@/lib/github/webhook-signature";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { processWebhook } from "@/lib/webhooks/processor";

export type GitHubWebhookRouteDependencies = {
  secret: string | undefined;
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
    if (dependencies.secret === undefined || dependencies.secret.length === 0) {
      return new Response(null, { status: 503 });
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
    if (!verifyGitHubWebhookSignature(rawBody, signature, dependencies.secret)) {
      return new Response(null, { status: 401 });
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody.toString("utf8")) as unknown;
    } catch {
      return new Response(null, { status: 400 });
    }
    const result = parseGitHubWebhookDeliveryDetailed(event, deliveryId, payload);
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
    } catch {
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
    secret: process.env.GITHUB_WEBHOOK_SECRET,
    processWebhook: async (delivery) => {
      const store = new PostgresFoldStore();
      return processWebhook({
        store,
        enqueueReconciliation: (repositoryId, event) => store.enqueueWebhookReconciliation(repositoryId, event),
      }, delivery);
    },
  })(request);
}
