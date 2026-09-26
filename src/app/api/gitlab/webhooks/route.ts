import { parseGitLabWebhookDeliveryDetailed } from "@/lib/gitlab/webhook-schema";
import { verifyGitLabWebhookToken } from "@/lib/gitlab/webhook-token";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { processWebhook, type WebhookProcessingResult, type WebhookReceiptScope } from "@/lib/webhooks/processor";
import type { GitHubWebhookDelivery } from "@/lib/github/webhook-schema";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { normalizeInstanceUrl } from "@/lib/forge/identities";
import { webhookSelector, type WebhookCredentialLookup } from "@/lib/webhooks/credentials";
import { logField } from "@/lib/webhooks/log-field";
import { readBodyWithinLimit } from "@/lib/http/request-body";

export type GitLabWebhookRouteDependencies = {
  lookupCredential: WebhookCredentialLookup;
  processWebhook(delivery: GitHubWebhookDelivery, scope: WebhookReceiptScope): Promise<WebhookProcessingResult>;
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

    // The reader carries the Content-Length pre-check the route used to make
    // itself: a declared oversize answers 413 here without a byte read, and a
    // stream that crosses the limit is cancelled mid-read, so response
    // ordering and the 413 semantics are unchanged. The token check above is
    // still ahead of any Content-Length consultation and any body read.
    const rawBody = await readBodyWithinLimit(request, GITLAB_WEBHOOK_BODY_LIMIT_BYTES);
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
    const result = parseGitLabWebhookDeliveryDetailed(event, deliveryUuid, payload, {
      idempotencyKey: request.headers.get("idempotency-key"),
      webhookId: request.headers.get("webhook-id"),
    });
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
      const processed = await dependencies.processWebhook(delivery, { provider: credential.provider, registrationId: credential.repositoryId });
      if (processed.status === "IN_PROGRESS") {
        // An earlier attempt still holds this message's lease and may yet
        // fail, so the retry is not acknowledged: an empty 503 records the
        // execution as failed on GitLab's side, so a later retry or resend of
        // the message processes it. Not a processing failure, so one
        // fixed-template line naming only the receipt key and this
        // execution's UUID, each header-derived and so each encoded by
        // logField into one quoted, escaped, length-bounded token.
        console.warn(
          `Webhook delivery ${logField(delivery.deliveryId)} (execution ${logField(delivery.executionId)})`
            + " is still being processed by an earlier attempt; answered 503 so it is retried.",
        );
        return new Response(null, { status: 503 });
      }
      return new Response(null, { status: 202 });
    } catch (error) {
      // The GitLab twin of the GitHub receiver's diagnostic: the instance sees
      // only an empty 503 and the store persists the sanitized constant, so
      // this console line is the operators' one view of why a delivery failed.
      // The message is a fixed template over the delivery's identifiers, and
      // the error object itself rides as the second argument — Node renders
      // its type, stack and Error.cause chain natively. The request-derived
      // identifiers (receipt key, execution UUID, and the project's
      // path_with_namespace, which the parser accepts with internal control
      // characters and at any length) each go through logField, so each is
      // one quoted token with its controls escaped and its length bounded;
      // the event is the parser's constant and the forge id a number. The
      // delivery id is the receipt key, often the Idempotency-Key; the
      // execution is the X-Gitlab-Webhook-UUID an operator finds in GitLab's
      // delivery log.
      console.error(
        `Webhook processing failed for delivery ${logField(delivery.deliveryId)}`
          + ` (execution ${logField(delivery.executionId)},`
          + ` event ${delivery.event}, repository ${logField(delivery.repositoryFullName)},`
          + ` forge id ${delivery.repositoryGitHubId}).`,
        error,
      );
      return new Response(null, { status: 503 });
    }
  };
}

export async function POST(request: Request): Promise<Response> {
  return createGitLabWebhookPostHandler({
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
