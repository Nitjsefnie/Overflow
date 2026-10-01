import { webhookCredential } from "../support/webhook-credential";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import * as database from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createGitLabWebhookPostHandler, POST } from "@/app/api/gitlab/webhooks/route";
import {
  WEBHOOK_RATE_LIMIT_CAPACITY,
  WEBHOOK_RATE_LIMIT_REFILL_PER_MINUTE,
  createTokenBucket,
} from "@/lib/webhooks/rate-limit";
import { processWebhook, type WebhookProcessorDependencies } from "@/lib/webhooks/processor";

// The route and the spies must share the same persistence module instances.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

/**
 * The GitLab receiver mirrors the GitHub receiver's contract: 503 when no
 * secret is configured, 401 on a bad token, 400 on malformed traffic, 202
 * accepted-for-processing, 413 over the body cap. Both payload kinds the hook
 * subscribes to — issue and merge request — are accepted for processing; the
 * receiver has no deliberately-ignored (204) class. The token check replaces
 * the HMAC; the delivery uuid header is required for execution diagnostics
 * and is the fallback receipt key when stable message headers are absent.
 */

const secret = "webhook-secret";

const issuePayload = JSON.stringify({
  object_kind: "issue",
  event_type: "issue",
  project: {
    id: 278964,
    name: "GitLab",
    path_with_namespace: "gitlab-org/gitlab",
    web_url: "https://gitlab.com/gitlab-org/gitlab",
  },
  object_attributes: {
    id: 301,
    iid: 23,
    title: "Broken widget",
    description: "The widget is broken",
    state: "opened",
    updated_at: "2026-09-08T10:00:00.000Z",
    url: "https://gitlab.com/gitlab-org/gitlab/-/issues/23",
    action: "close",
  },
});

const mergeRequestPayload = JSON.stringify({
  object_kind: "merge_request",
  project: {
    id: 278964,
    path_with_namespace: "gitlab-org/gitlab",
    web_url: "https://gitlab.com/gitlab-org/gitlab",
  },
  object_attributes: {
    id: 401,
    iid: 7,
    title: "Fix widget",
    description: null,
    state: "merged",
    updated_at: "2026-09-08T11:00:00.000Z",
    url: "https://gitlab.com/gitlab-org/gitlab/-/merge_requests/7",
    action: "merge",
  },
});

function request(body: string, headers: Record<string, string>): Request {
  return new Request("https://overflow.test/api/gitlab/webhooks?hook=181a4fbb-64d1-44fd-82da-cd191613798c", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });
}

function gitlabHeaders(overrides: Record<string, string> = {}): Record<string, string> {
  return { ...gitlabHeadersBase(), ...overrides };
}

// A header named here is left OUT entirely — the missing-header cases must
// send requests without the header, not with an empty or "undefined" value,
// which a Request would stringify.
function gitlabHeadersWithout(...names: Array<"event" | "uuid" | "token">): Record<string, string> {
  const headers = gitlabHeadersBase();
  const keys = { event: "x-gitlab-event", uuid: "x-gitlab-webhook-uuid", token: "x-gitlab-token" } as const;
  for (const name of names) {
    delete headers[keys[name]];
  }
  return headers;
}

function gitlabHeadersBase(): Record<string, string> {
  return {
    "x-gitlab-event": "Issue Hook",
    "x-gitlab-webhook-uuid": "uuid-1",
    "x-gitlab-token": secret,
  };
}

describe("GitLab webhook route", () => {
  it.each<{ name: string; headers: Record<string, string>; key: string }>([
    { name: "Idempotency-Key", headers: { "Idempotency-Key": " stable-message " }, key: "stable-message" },
    { name: "webhook-id", headers: { "webhook-id": " stable-message " }, key: "stable-message" },
    { name: "conflicting stable headers", headers: { "Idempotency-Key": "winner", "webhook-id": "other" }, key: "winner" },
    { name: "ignored event UUID", headers: { "X-Gitlab-Event-UUID": "event-id" }, key: "uuid-1" },
  ])("dispatches the message identity from $name", async ({ headers, key }) => {
    const deliveries: unknown[] = [];
    const route = createGitLabWebhookPostHandler({
      checkRateLimit: () => true,
      lookupCredential: async () => webhookCredential("gitlab", secret),
      processWebhook: async (delivery) => { deliveries.push(delivery); return { status: "PROCESSED" as const }; },
    });
    const response = await route(request(issuePayload, gitlabHeaders(headers)));
    expect(response.status).toBe(202);
    expect(deliveries).toEqual([expect.objectContaining({ deliveryId: key, executionId: "uuid-1" })]);
  });

  it("rejects a 256-character execution header before processing", async () => {
    const processWebhook = vi.fn();
    const route = createGitLabWebhookPostHandler({ checkRateLimit: () => true, lookupCredential: async () => webhookCredential("gitlab", secret), processWebhook });
    const response = await route(request(issuePayload, gitlabHeaders({ "x-gitlab-webhook-uuid": "x".repeat(256) })));
    expect(response.status).toBe(400);
    expect(processWebhook).not.toHaveBeenCalled();
  });

  it("rejects a 256-character Idempotency-Key and accepts a 255-character one", async () => {
    const processWebhook = vi.fn().mockResolvedValue({ status: "PROCESSED" });
    const route = createGitLabWebhookPostHandler({ checkRateLimit: () => true, lookupCredential: async () => webhookCredential("gitlab", secret), processWebhook });

    const oversized = await route(request(issuePayload, gitlabHeaders({ "idempotency-key": "x".repeat(256) })));
    expect(oversized.status).toBe(400);
    expect(processWebhook).not.toHaveBeenCalled();

    const accepted = await route(request(issuePayload, gitlabHeaders({ "idempotency-key": "x".repeat(255) })));
    expect(accepted.status).toBe(202);
    expect(processWebhook).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ deliveryId: "x".repeat(255), executionId: "uuid-1" }),
      { provider: "gitlab", registrationId: "test-registration" },
    );
  });

  it.each([
    { provider: "gitlab" as const, instanceUrl: "https://gitlab.com", projectId: 42 },
    { provider: "gitlab" as const, instanceUrl: "https://another.example", projectId: 278964 },
    { provider: "github" as const, instanceUrl: null, projectId: 278964 },
  ])("binds scoped GitLab credentials to $provider $instanceUrl $projectId", async (identity) => {
    const deliveries: unknown[] = [];
    const dependencies = {
      secret,
      checkRateLimit: () => true,
      lookupCredential: async () => ({
        repositoryId: "test-registration", credentialId: "181a4fbb-64d1-44fd-82da-cd191613798c",
        secret, ...identity, webhookId: 4242, configuredAt: null,
      }),
      processWebhook: async (delivery: unknown) => { deliveries.push(delivery); return { status: "PROCESSED" as const }; },
    };
    const response = await createGitLabWebhookPostHandler(dependencies)(request(issuePayload, gitlabHeaders()));
    expect(response.status).toBe(401);
    expect(deliveries).toEqual([]);
  });

  it("dispatches a verified issue delivery with the fallback delivery id", async () => {
    const processWebhookMock = vi.fn().mockResolvedValue({ status: "PROCESSED" });
    const route = createGitLabWebhookPostHandler({ checkRateLimit: () => true, lookupCredential: async () => webhookCredential("gitlab", secret), processWebhook: processWebhookMock });

    const response = await route(request(issuePayload, gitlabHeaders()));

    expect(response.status).toBe(202);
    expect(processWebhookMock).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: "uuid-1",
      executionId: "uuid-1",
      event: "issues",
      action: "closed",
      repositoryGitHubId: 278964,
      repositoryFullName: "gitlab-org/gitlab",
      subject: { kind: "ISSUE", id: 301, number: 23 },
      forge: { provider: "gitlab", instanceUrl: "https://gitlab.com" },
    }), { provider: "gitlab", registrationId: "test-registration" });
  });

  // The missing execution UUID case sends both a stable message key and an
  // event UUID; neither can replace the execution UUID required for the receipt.
  it.each([
    { name: "a missing event header", headers: gitlabHeadersWithout("event") },
    { name: "a missing delivery UUID", headers: {
      ...gitlabHeadersWithout("uuid"),
      "idempotency-key": "stable-message",
      "x-gitlab-event-uuid": "event-execution-1",
    } },
    { name: "a missing token header", headers: gitlabHeadersWithout("token") },
  ])("answers 400 for $name", async ({ headers }) => {
    const processWebhookMock = vi.fn();
    const route = createGitLabWebhookPostHandler({ checkRateLimit: () => true, lookupCredential: async () => webhookCredential("gitlab", secret), processWebhook: processWebhookMock });
    const response = await route(request(issuePayload, headers));
    expect(response.status).toBe(400);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("answers 503 when no secret is configured", async () => {
    const processWebhookMock = vi.fn();
    const route = createGitLabWebhookPostHandler({ checkRateLimit: () => true, lookupCredential: async () => { throw new Error("unavailable key"); }, processWebhook: processWebhookMock });
    const response = await route(request(issuePayload, gitlabHeaders()));
    expect(response.status).toBe(503);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  // GitLab's token is header-only (no HMAC over the body, unlike GitHub), so
  // a wrong token is refused before the body is touched: the tracked stream
  // must hand out zero bytes. The single-chunk body is well under the cap, so
  // a receiver that reads first and verifies second still answers 401 here —
  // only the byte count tells the two orderings apart.
  it("answers 401 for a wrong token without reading the delivery further", async () => {
    const { stream, record } = trackedBodyStream(1);
    const processWebhookMock = vi.fn();
    const route = createGitLabWebhookPostHandler({ checkRateLimit: () => true, lookupCredential: async () => webhookCredential("gitlab", secret), processWebhook: processWebhookMock });
    const response = await route(streamRequest(stream, { "x-gitlab-token": "wrong-token" }));
    expect(response.status).toBe(401);
    expect(record.handedOutBytes).toBe(0);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  // Ordering control: the token check precedes the declared-size check, so a
  // wrong token on a delivery declared over the cap is a 401, not a 413.
  it("answers 401, not 413, for a wrong token on a delivery declared over the cap", async () => {
    const { stream, record } = trackedBodyStream(CHUNK_COUNT);
    const processWebhookMock = vi.fn();
    const route = createGitLabWebhookPostHandler({ checkRateLimit: () => true, lookupCredential: async () => webhookCredential("gitlab", secret), processWebhook: processWebhookMock });
    const response = await route(streamRequest(stream, {
      "x-gitlab-token": "wrong-token",
      "content-length": String(WEBHOOK_BODY_LIMIT_BYTES + 1),
    }));
    expect(response.status).toBe(401);
    expect(record.handedOutBytes).toBe(0);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("answers 400 for an unparseable body with a valid token", async () => {
    const processWebhookMock = vi.fn();
    const route = createGitLabWebhookPostHandler({ checkRateLimit: () => true, lookupCredential: async () => webhookCredential("gitlab", secret), processWebhook: processWebhookMock });
    const response = await route(request("{", gitlabHeaders()));
    expect(response.status).toBe(400);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("answers 202 for a merge request delivery and hands the processor its PULL_REQUEST subject", async () => {
    const processWebhookMock = vi.fn().mockResolvedValue({ status: "PROCESSED" });
    const route = createGitLabWebhookPostHandler({ checkRateLimit: () => true, lookupCredential: async () => webhookCredential("gitlab", secret), processWebhook: processWebhookMock });
    const response = await route(request(mergeRequestPayload, gitlabHeaders({ "x-gitlab-event": "Merge Request Hook" })));
    expect(response.status).toBe(202);
    expect(processWebhookMock).toHaveBeenCalledExactlyOnceWith({
      deliveryId: "uuid-1",
      executionId: "uuid-1",
      event: "pull_request",
      action: "closed",
      repositoryGitHubId: 278964,
      repositoryFullName: "gitlab-org/gitlab",
      subject: { kind: "PULL_REQUEST", id: 401, number: 7 },
      forge: { provider: "gitlab", instanceUrl: "https://gitlab.com" },
    }, { provider: "gitlab", registrationId: "test-registration" });
  });

  it("answers 400 for an unrecognised object kind", async () => {
    const processWebhookMock = vi.fn();
    const route = createGitLabWebhookPostHandler({ checkRateLimit: () => true, lookupCredential: async () => webhookCredential("gitlab", secret), processWebhook: processWebhookMock });
    const response = await route(request(JSON.stringify({ object_kind: "push" }), gitlabHeaders({ "x-gitlab-event": "Push Hook" })));
    expect(response.status).toBe(400);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it.each([
    { status: "IN_PROGRESS", answer: 503 },
    { status: "DUPLICATE", answer: 202 },
    { status: "PROCESSED", answer: 202 },
  ] as const)("answers the $status processing result with $answer", async ({ status, answer }) => {
    const route = createGitLabWebhookPostHandler({
      checkRateLimit: () => true,
      lookupCredential: async () => webhookCredential("gitlab", secret),
      processWebhook: vi.fn().mockResolvedValue({ status }),
    });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failed = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await route(request(issuePayload, gitlabHeaders({ "Idempotency-Key": "stable-message" })));

      expect(response.status).toBe(answer);
      expect(await response.text()).toBe("");
      expect(failed).not.toHaveBeenCalled();
      // An in-flight retry is not a processing failure: at most one line,
      // carrying the receipt key and the execution UUID and nothing from the
      // payload.
      expect(warned.mock.calls).toEqual(status === "IN_PROGRESS" ? [[expect.stringMatching(/stable-message.*uuid-1/)]] : []);
      expect(JSON.stringify(warned.mock.calls)).not.toContain("gitlab-org");
    } finally {
      warned.mockRestore();
      failed.mockRestore();
    }
  });

  it("answers 503 and lets the instance retry when processing fails", async () => {
    const route = createGitLabWebhookPostHandler({
      checkRateLimit: () => true,
      lookupCredential: async () => webhookCredential("gitlab", secret),
      processWebhook: vi.fn().mockRejectedValue(new Error("upstream connection refused")),
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await route(request(issuePayload, gitlabHeaders({ "Idempotency-Key": "stable-message" })));
      expect(response.status).toBe(503);
      // The receipt key and the execution UUID an operator looks up in
      // GitLab's delivery log differ here, so the line must carry both.
      const [message] = logged.mock.calls[0] ?? [];
      expect(message).toEqual(expect.stringContaining("stable-message"));
      expect(message).toEqual(expect.stringContaining("uuid-1"));
    } finally {
      logged.mockRestore();
    }
  });

  // path_with_namespace is trimmed but otherwise free text, and the receipt
  // key and execution UUID are header values that may carry ESC, so every
  // identifier on the failure line can be hostile. The parser still accepts
  // them — the defect is the log line, not the delivery — and the line must
  // stay one bounded line with each identifier as its own encoded token.
  it("encodes and bounds hostile identifiers in the failure line", async () => {
    const namespace = `gitlab-org\n\u001b[2J${"a".repeat(5_000)}`;
    const payload = JSON.parse(issuePayload) as { project: Record<string, unknown> };
    payload.project.path_with_namespace = namespace;
    const rootCause = new Error("upstream connection refused");
    const processWebhookMock = vi.fn().mockRejectedValue(rootCause);
    const route = createGitLabWebhookPostHandler({ checkRateLimit: () => true, lookupCredential: async () => webhookCredential("gitlab", secret), processWebhook: processWebhookMock });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await route(request(JSON.stringify(payload), gitlabHeaders({
        "Idempotency-Key": "key\u001b[1mz",
        "x-gitlab-webhook-uuid": "uuid\u001b[2Kz",
      })));

      expect(response.status).toBe(503);
      expect(processWebhookMock).toHaveBeenCalledWith(expect.objectContaining({
        deliveryId: "key\u001b[1mz", executionId: "uuid\u001b[2Kz", repositoryFullName: namespace,
      }), expect.anything());
      expect(logged).toHaveBeenCalledTimes(1);
      const [message, loggedError] = logged.mock.calls[0] ?? [];
      expect(typeof message).toBe("string");
      expect(message).not.toContain("\n");
      expect(message).not.toContain("\u001b");
      expect((message as string).length).toBeLessThan(1_024);
      expect(message).toContain("delivery \"key\\u001b[1mz\" (");
      expect(message).toContain("(execution \"uuid\\u001b[2Kz\",");
      expect(message).toContain(`repository "gitlab-org\\u000a\\u001b[2J${"a".repeat(241)}"… (+4759 more),`);
      // A fixed template over the identifiers: the error rides only as the
      // second argument and is never flattened into the message.
      expect(message).not.toContain(rootCause.message);
      expect(loggedError).toBe(rootCause);
    } finally {
      logged.mockRestore();
    }
  });

  it("encodes a terminal escape in both identifiers of the still-in-progress line", async () => {
    const route = createGitLabWebhookPostHandler({
      checkRateLimit: () => true,
      lookupCredential: async () => webhookCredential("gitlab", secret),
      processWebhook: vi.fn().mockResolvedValue({ status: "IN_PROGRESS" }),
    });
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const response = await route(request(issuePayload, gitlabHeaders({
        "Idempotency-Key": "key\u001b[2Jz",
        "x-gitlab-webhook-uuid": "uuid\u001b[2Kz",
      })));

      expect(response.status).toBe(503);
      expect(warned).toHaveBeenCalledTimes(1);
      const [message] = warned.mock.calls[0] ?? [];
      expect(message).not.toContain("\u001b");
      expect(message).toContain("delivery \"key\\u001b[2Jz\" (execution \"uuid\\u001b[2Kz\")");
    } finally {
      warned.mockRestore();
    }
  });

  // The GitLab twin of the GitHub receiver's burst guard (issue 852): 429 is
  // answered from the token bucket before a header is read and before a
  // credential is looked up. The bucket is the real limiter module's, drained
  // through the handler itself; timestamps are explicit — no wall clock, no
  // fake timers.
  it("declines a burst past capacity with 429 before reading a header or a credential", async () => {
    const bucket = createTokenBucket({
      capacity: WEBHOOK_RATE_LIMIT_CAPACITY,
      refillPerMinute: WEBHOOK_RATE_LIMIT_REFILL_PER_MINUTE,
      nowMs: () => 1_000_000,
    });
    const lookupCredential = vi.fn(async () => webhookCredential("gitlab", secret));
    const route = createGitLabWebhookPostHandler({
      checkRateLimit: () => bucket.admit(),
      lookupCredential,
      processWebhook: vi.fn().mockResolvedValue({ status: "PROCESSED" as const }),
    });

    const burstStatuses: number[] = [];
    for (let i = 0; i < WEBHOOK_RATE_LIMIT_CAPACITY; i += 1) {
      burstStatuses.push((await route(headerlessRequest())).status);
    }
    // A headerless delivery is admitted past the limiter and refused next by
    // the missing headers (400), so admission and refusal stay distinguishable.
    expect(burstStatuses).toEqual(Array.from({ length: WEBHOOK_RATE_LIMIT_CAPACITY }, () => 400));

    const declined = await route(headerlessRequest());
    expect(declined.status).toBe(429);
    expect(declined.headers.get("retry-after")).toBe("1");
    // 429 precedes the credential lookup — nothing is spent on a declined
    // delivery beyond the bucket answer itself.
    expect(lookupCredential).not.toHaveBeenCalled();

    // ... and it precedes the header reads: a fully-formed delivery is also
    // declined while the bucket is empty.
    const wellFormed = await route(request(issuePayload, gitlabHeaders()));
    expect(wellFormed.status).toBe(429);
    expect(lookupCredential).not.toHaveBeenCalled();
  });

  // The GitLab twin of the peak-rate replay: a sender at the observed
  // historical peak (25 deliveries per minute over the 14 days ending
  // 2026-10-01) must never be declined — the refill rate, one token per
  // second, outruns it, so the bucket never drains.
  it("admits a sender at the observed peak of 25 deliveries per minute indefinitely", async () => {
    let nowMs = 0;
    const bucket = createTokenBucket({
      capacity: WEBHOOK_RATE_LIMIT_CAPACITY,
      refillPerMinute: WEBHOOK_RATE_LIMIT_REFILL_PER_MINUTE,
      nowMs: () => nowMs,
    });
    const route = createGitLabWebhookPostHandler({
      checkRateLimit: () => bucket.admit(),
      lookupCredential: async () => webhookCredential("gitlab", secret),
      processWebhook: vi.fn().mockResolvedValue({ status: "PROCESSED" as const }),
    });

    const statuses: number[] = [];
    for (let minute = 0; minute < 10; minute += 1) {
      for (let nth = 0; nth < 25; nth += 1) {
        nowMs = minute * 60_000 + nth * 2_000 + 500;
        statuses.push((await route(headerlessRequest())).status);
      }
    }
    // Every delivery is admitted past the limiter (400 = admitted, then
    // refused for missing headers) — none is declined with 429.
    expect(statuses).toEqual(Array.from({ length: 250 }, () => 400));
  });
});

// The route's declared limit is 25 MiB; the oversize cases sit just above it.
// The values are hardcoded here rather than imported so the tests pin the
// 25 MiB ceiling itself, not whatever the module happens to say.
const WEBHOOK_BODY_LIMIT_BYTES = 25 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024; // 1 MiB
const CHUNK_COUNT = 32; // 32 MiB total: past the ceiling with room to spare

describe("GitLab webhook route: the shared processor and the body cap", () => {
  it("answers a tracked GitLab repository's delivery with a scheduled fold and none of the fold", async () => {
    const enqueued: string[] = [];
    const reconciled: string[] = [];
    const findRepositoryByForgeIdentity = vi.fn().mockResolvedValue(
      { id: "gitlab-repository", active: true, unavailableReason: null },
    );
    const findRepositoryByGitHubId = vi.fn().mockResolvedValue(null);
    const dependencies: WebhookProcessorDependencies & {
      reconcileRepository(repositoryId: string): Promise<void>;
    } = {
      store: {
        applyIssueView: async () => {},
        claimDelivery: async () => ({ status: "CLAIMED", receiptId: "receipt-1", leaseToken: "lease-1" }),
        findRepositoryByGitHubId,
        findRepositoryByForgeIdentity,
        markProcessed: async () => true,
        markFailed: async () => true,
      },
      enqueueReconciliation: async (repositoryId) => {
        enqueued.push(repositoryId);
      },
      reconcileRepository: async (repositoryId) => {
        reconciled.push(repositoryId);
      },
    };
    const route = createGitLabWebhookPostHandler({
      checkRateLimit: () => true,
      lookupCredential: async () => webhookCredential("gitlab", secret),
      processWebhook: (delivery, scope) => processWebhook(dependencies, delivery, scope),
    });

    const response = await route(request(issuePayload, gitlabHeaders()));

    expect(response.status).toBe(202);
    expect(findRepositoryByForgeIdentity).toHaveBeenCalledWith("gitlab", "https://gitlab.com", 278964);
    expect(findRepositoryByGitHubId).not.toHaveBeenCalled();
    expect({ enqueued, reconciled }).toEqual({ enqueued: ["gitlab-repository"], reconciled: [] });
  });

  it("rejects a declared oversize delivery with 413 before reading any of the body", async () => {
    const { stream, record } = trackedBodyStream(CHUNK_COUNT);
    const processWebhookMock = vi.fn();
    const route = createGitLabWebhookPostHandler({ checkRateLimit: () => true, lookupCredential: async () => webhookCredential("gitlab", secret), processWebhook: processWebhookMock });
    const response = await route(streamRequest(stream, {
      "content-length": String(WEBHOOK_BODY_LIMIT_BYTES + 1),
    }));
    expect(response.status).toBe(413);
    expect(record.handedOutBytes).toBe(0);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("stops reading a delivery with no Content-Length once the body crosses 25 MiB, answering 413", async () => {
    const { stream, record } = trackedBodyStream(CHUNK_COUNT);
    const processWebhookMock = vi.fn();
    const route = createGitLabWebhookPostHandler({ checkRateLimit: () => true, lookupCredential: async () => webhookCredential("gitlab", secret), processWebhook: processWebhookMock });
    const response = await route(streamRequest(stream, {}));
    expect(response.status).toBe(413);
    expect(record.handedOutBytes).toBeGreaterThan(WEBHOOK_BODY_LIMIT_BYTES);
    expect(record.handedOutBytes).toBeLessThanOrEqual(WEBHOOK_BODY_LIMIT_BYTES + CHUNK_BYTES);
    expect(record.cancelled).toBe(true);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("accepts a correctly tokened delivery at exactly the 25 MiB ceiling and dispatches it", async () => {
    const processWebhookMock = vi.fn().mockResolvedValue({ status: "PROCESSED" });
    const route = createGitLabWebhookPostHandler({ checkRateLimit: () => true, lookupCredential: async () => webhookCredential("gitlab", secret), processWebhook: processWebhookMock });
    // JSON.parse ignores insignificant whitespace, so trailing spaces pad the
    // envelope to exactly the limit's byte length without changing its
    // meaning; the payload is ASCII, so string length equals byte length.
    const paddedPayload = issuePayload.padEnd(WEBHOOK_BODY_LIMIT_BYTES, " ");
    expect(paddedPayload.length).toBe(WEBHOOK_BODY_LIMIT_BYTES);
    const response = await route(request(paddedPayload, {
      ...gitlabHeaders(),
      "content-length": String(WEBHOOK_BODY_LIMIT_BYTES),
    }));
    expect(response.status).toBe(202);
    expect(processWebhookMock).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid token before constructing production persistence dependencies", async () => {
    const originalDatabaseUrl = process.env.DATABASE_URL;
    delete process.env.DATABASE_URL;
    const getSql = vi.spyOn(database, "getSql").mockReturnValue(vi.fn() as unknown as SqlClient);
    const credentialLookup = vi.spyOn(PostgresRepositoryStore.prototype, "findWebhookCredential")
      .mockResolvedValue(webhookCredential("gitlab", secret));

    try {
      const response = await POST(
        new Request("https://overflow.test/api/gitlab/webhooks?hook=181a4fbb-64d1-44fd-82da-cd191613798c", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-gitlab-event": "Issue Hook",
            "x-gitlab-webhook-uuid": "delivery-production-invalid",
            "x-gitlab-token": "not-the-secret",
          },
          body: issuePayload,
        }),
      );

      expect(response.status).toBe(401);
      expect(getSql).toHaveBeenCalledTimes(1);
    } finally {
      getSql.mockRestore();
      credentialLookup.mockRestore();
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });
});

// Reads are tracked on the stream itself with highWaterMark 0: pull runs only
// when the consumer actually reads (zero pulls at construction or on
// getReader), so handedOutBytes counts bytes the handler delivered and never
// a queue refill it never asked for — "zero bytes pulled" stays exact.
function trackedBodyStream(chunkCount: number): {
  stream: ReadableStream<Uint8Array>;
  record: { handedOutBytes: number; cancelled: boolean };
} {
  const record = { handedOutBytes: 0, cancelled: false };
  let chunksSent = 0;
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (chunksSent >= chunkCount) {
          controller.close();
          return;
        }
        controller.enqueue(new Uint8Array(CHUNK_BYTES));
        chunksSent += 1;
        record.handedOutBytes += CHUNK_BYTES;
      },
      cancel() {
        record.cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  return { stream, record };
}

function streamRequest(
  stream: ReadableStream<Uint8Array>,
  headers: Record<string, string>,
): Request {
  return new Request("https://overflow.test/api/gitlab/webhooks?hook=181a4fbb-64d1-44fd-82da-cd191613798c", {
    method: "POST",
    headers: { "content-type": "application/json", ...gitlabHeaders(), ...headers },
    body: stream,
    // A Request with a stream body requires declaring the duplex direction;
    // undici sets no Content-Length for a stream body, which is exactly the
    // no-Content-Length case under test.
    duplex: "half",
  } as RequestInit);
}

// No headers and no body: the handler's first statement decides the whole
// answer, so the limiter's ordering ahead of the header reads is observable —
// an admitted delivery answers 400 here, a declined one 429.
function headerlessRequest(): Request {
  return new Request("https://overflow.test/api/gitlab/webhooks?hook=181a4fbb-64d1-44fd-82da-cd191613798c", {
    method: "POST",
  });
}
