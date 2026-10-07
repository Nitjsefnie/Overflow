import { createHash } from "node:crypto";
import { parseGitLabWebhookDeliveryDetailed } from "@/lib/gitlab/webhook-schema";
import { verifyGitLabWebhookToken } from "@/lib/gitlab/webhook-token";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { processWebhook, type WebhookProcessingResult, type WebhookReceiptScope } from "@/lib/webhooks/processor";
import type { GitHubWebhookDelivery } from "@/lib/github/webhook-schema";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { normalizeInstanceUrl } from "@/lib/forge/identities";
import { webhookSelector, type WebhookCredentialLookup } from "@/lib/webhooks/credentials";
import { errorClassName, errorLogToken, logField } from "@/lib/webhooks/log-field";
import { readBodyWithinLimit } from "@/lib/http/request-body";
import { FailureLogger } from "@/lib/worker/failure-logger";
import {
  WEBHOOK_RATE_LIMIT_CAPACITY,
  WEBHOOK_RATE_LIMIT_REFILL_PER_MINUTE,
  createReceiverRateLimiter,
} from "@/lib/webhooks/rate-limit";

export type GitLabWebhookRouteDependencies = {
  checkRateLimit: () => boolean;
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
    // The rate limit is answered before any request content is touched: a
    // declined delivery costs the sender one bucket answer — no header read,
    // no credential lookup, no body read.
    if (!dependencies.checkRateLimit()) return new Response(null, { status: 429, headers: { "retry-after": "1" } });
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
    } catch (error) {
      // Every 503 a forge receives has a journal line (issue 1057). The
      // message is deliberately absent — a decrypt failure's message names
      // material, so errorLogToken is not used here — and the line names the
      // phase, the logField-encoded selector, and the error's class name
      // only. The FailureLogger bounds it per selector: the first failure of
      // an outage prints, the rest count until the quiet window passes.
      credentialLookupFailures.failure(
        `webhook-credential-lookup:${selector}`,
        `Webhook credential lookup failed (phase credential lookup, selector ${logField(selector)},`
          + ` error ${logField(errorClassName(error))}); answered 503 so the forge retries.`,
      );
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
    // The receipt's replay key: a digest of the signed bytes. The shared
    // secret was verified against the token header before this body was read,
    // so anything that reaches this line is already authenticated; the
    // digest is recorded on the receipt and lets the receipts layer count a
    // fresh receipt key over an already-processed body as a duplicate
    // (issue 1041).
    const bodyDigest = createHash("sha256").update(rawBody).digest("hex");

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
      const processed = await dependencies.processWebhook(delivery, {
        provider: credential.provider, registrationId: credential.repositoryId, bodyDigest,
      });
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
      // the error rides as the second argument encoded into one bounded
      // single-line token (issue 1042) — the console sink renders a raw error
      // object through its stack, whose first line carries the message raw.
      // The request-derived identifiers (receipt key, execution UUID, and the
      // project's path_with_namespace, which the parser accepts with internal
      // control characters and at any length) each go through logField, so
      // each is one quoted token with its controls escaped and its length
      // bounded; the event is the parser's constant and the forge id a number.
      // The delivery id is the receipt key, often the Idempotency-Key; the
      // execution is the X-Gitlab-Webhook-UUID an operator finds in GitLab's
      // delivery log.
      console.error(
        `Webhook processing failed for delivery ${logField(delivery.deliveryId)}`
          + ` (execution ${logField(delivery.executionId)},`
          + ` event ${delivery.event}, repository ${logField(delivery.repositoryFullName)},`
          + ` forge id ${delivery.repositoryGitHubId}).`,
        errorLogToken(error),
      );
      return new Response(null, { status: 503 });
    }
  };
}

// The receiver's gate, built once at module scope and shared by every request
// this process serves: the bucket IS the receiver's rate limit (issue 852),
// so it must outlive individual requests — one bucket per receiver, refilled
// by the wall clock. The gate is the keyed limiter over one constant key, so
// the decline burst's start carries the once-per-burst journal line (issue
// 1053) from the same mechanism that answers the 429.
const webhookRateLimiter = createReceiverRateLimiter({
  receiver: "gitlab",
  capacity: WEBHOOK_RATE_LIMIT_CAPACITY,
  refillPerMinute: WEBHOOK_RATE_LIMIT_REFILL_PER_MINUTE,
});

// The credential lookup's journal bound, one per route module: the key is
// per selector, so a burst of unreadable credentials for one registration
// prints once per quiet window (issue 1057).
const credentialLookupFailures = new FailureLogger();

export async function POST(request: Request): Promise<Response> {
  return createGitLabWebhookPostHandler({
    checkRateLimit: () => webhookRateLimiter.admit(),
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
