import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createGitHubWebhookPostHandler, POST } from "@/app/api/github/webhooks/route";
import { processWebhook, type WebhookProcessorDependencies } from "@/lib/webhooks/processor";

const secret = "webhook-secret";
const rawPayload = JSON.stringify({
  action: "closed",
  repository: { id: 42, full_name: "octo/example" },
  pull_request: { id: 201, number: 11 },
});

// The route's declared limit is 25 MiB; the oversize cases sit just above it.
// The values are hardcoded here rather than imported so the tests pin the
// 25 MiB ceiling itself, not whatever the module happens to say.
const WEBHOOK_BODY_LIMIT_BYTES = 25 * 1024 * 1024;
const CHUNK_BYTES = 1024 * 1024; // 1 MiB
const CHUNK_COUNT = 32; // 32 MiB total: past the ceiling with room to spare, so a stopped reader is distinguishable from a drained one

describe("GitHub webhook route", () => {
  it.each([undefined, { id: 0, number: 11 }, { id: 201, number: -1 }, { id: 201, number: "11" }])(
    "rejects comment delivery without a valid issue subject, even if it contains a PR subject: %j", async (issue) => {
      const deliveries: unknown[] = [];
      const route = createGitHubWebhookPostHandler({ secret, processWebhook: async (delivery) => { deliveries.push(delivery); } });
      const response = await route(request(JSON.stringify({ action: "created",
        repository: { id: 42, full_name: "octo/example" }, issue, pull_request: { id: 201, number: 11 },
      }), { "x-github-event": "issue_comment", "x-github-delivery": "invalid-comment-subject" }));
      expect(response.status).toBe(400);
      expect(deliveries).toEqual([]);
    },
  );

  // PR-carrying issue envelopes are deliberately ignored (webhook-schema's
  // pull_request guard), and an ignored delivery must read as success to
  // GitHub — any 2xx counts as delivered — or its delivery log turns red on
  // traffic Overflow chose to ignore and hides real failures.
  it.each(["issues", "issue_comment"])("answers 204 for a deliberately ignored PR-carrying %s envelope", async (event) => {
    const processWebhookMock = vi.fn().mockResolvedValue(undefined);
    const route = createGitHubWebhookPostHandler({ secret, processWebhook: processWebhookMock });
    const response = await route(request(JSON.stringify({
      action: event === "issues" ? "edited" : "created",
      repository: { id: 42, full_name: "octo/example" },
      issue: { id: 201, number: 11, state: "closed", updated_at: "2026-09-08T10:00:00Z",
        title: "Issue", body: null, html_url: "https://github.com/octo/example/issues/11",
        pull_request: { url: "https://api.github.com/repos/octo/example/pulls/11" } },
    }), { "x-github-event": event, "x-github-delivery": "pr-carrying" }));
    expect(response.status).toBe(204);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  // ready_for_review and converted_to_draft are recognized pull_request
  // actions Overflow does not materialize (webhook-schema's
  // unmaterializedActions). Like a PR-carrying issue envelope they must read
  // as success to GitHub — any 2xx counts as delivered — or the delivery log
  // turns red on traffic Overflow chose to ignore, and like every ignored
  // delivery they must persist nothing: no processWebhook call, so no claim
  // and no delivery row.
  it.each(["ready_for_review", "converted_to_draft"])("answers 204 for a recognized-but-unmaterialized %s action without processing", async (action) => {
    const processWebhookMock = vi.fn().mockResolvedValue(undefined);
    const route = createGitHubWebhookPostHandler({ secret, processWebhook: processWebhookMock });
    const response = await route(request(JSON.stringify({
      action,
      repository: { id: 42, full_name: "octo/example" },
      pull_request: { id: 201, number: 11 },
    }), { "x-github-event": "pull_request", "x-github-delivery": `unmaterialized-${action}` }));
    expect(response.status).toBe(204);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("answers 400 for a correctly signed unparseable JSON body", async () => {
    const processWebhookMock = vi.fn();
    const route = createGitHubWebhookPostHandler({ secret, processWebhook: processWebhookMock });
    const response = await route(request("{", {
      "x-github-event": "pull_request",
      "x-github-delivery": "bad-json",
    }));
    expect(response.status).toBe(400);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  // Mutants: DROP_SUBJECT_ID, IGNORE_MERGED_PR_REVIEW.
  it.each([
    { event: "issues", action: "edited", key: "issue", kind: "ISSUE" },
    { event: "pull_request", action: "closed", key: "pull_request", kind: "PULL_REQUEST" },
    { event: "pull_request_review", action: "dismissed", key: "pull_request", kind: "PULL_REQUEST" },
  ])("preserves stable subject identity for $event/$action", async ({ event, action, key, kind }) => {
    const deliveries: unknown[] = [];
    const route = createGitHubWebhookPostHandler({ secret, processWebhook: async (delivery) => { deliveries.push(delivery); } });
    const response = await route(request(JSON.stringify({ action,
      repository: { id: 42, full_name: "octo/example" }, [key]: { id: 201, number: 11, merged: true,
        state: "closed", updated_at: "2026-09-08T10:00:00Z", title: "Issue", body: null,
        html_url: "https://github.com/octo/example/issues/11" },
    }), { "x-github-event": event, "x-github-delivery": "subject" }));
    expect(response.status).toBe(202);
    expect(deliveries).toMatchObject([{ deliveryId: "subject", event, action, repositoryGitHubId: 42,
      repositoryFullName: "octo/example", subject: { kind, id: 201, number: 11 } }]);
  });

  // Mutant: DROP_SUBJECT_ID (accepting invalid or absent subjects loses durable invalidation).
  it.each([undefined, { id: 0, number: 11 }, { id: 201, number: -1 }, { id: 201.5, number: 11 },
    { id: Number.MAX_SAFE_INTEGER + 1, number: 11 }, { id: 201, number: "11" }])(
    "rejects an invalid subject %j before processing", async (subject) => {
      const deliveries: unknown[] = [];
      const route = createGitHubWebhookPostHandler({ secret, processWebhook: async (delivery) => { deliveries.push(delivery); } });
      const response = await route(request(JSON.stringify({ action: "closed",
        repository: { id: 42, full_name: "octo/example" }, pull_request: subject,
      }), { "x-github-event": "pull_request", "x-github-delivery": "invalid-subject" }));
      expect(response.status).toBe(400);
      expect(deliveries).toEqual([]);
    },
  );

  it.each([
    { action: "opened", repository: { id: 42, full_name: "octo/example" } },
    { action: "created", repository: { id: "42", full_name: "octo/example" } },
    { action: "deleted", repository: { id: 0, full_name: "octo/example" } },
    { action: "edited", repository: { id: 42 } },
    { repository: { id: 42, full_name: "octo/example" } },
  ])("rejects unsupported or malformed comment envelopes before queueing: %j", async (payload) => {
    const processed: unknown[] = [];
    const route = createGitHubWebhookPostHandler({ secret, processWebhook: async (delivery) => processed.push(delivery) });
    const response = await route(request(JSON.stringify({ issue: { id: 201, number: 11 }, ...payload }), {
      "x-github-event": "issue_comment", "x-github-delivery": "invalid-comment",
    }));
    expect(response.status).toBe(400);
    expect(processed).toEqual([]);
  });

  it("keeps setup configuration aligned with the production App Router pathname", async () => {
    const routeFile = resolve("src/app/api/github/webhooks/route.ts");
    const routePathname = `/${relative(resolve("src/app"), routeFile).replace(/\/route\.ts$/, "")}`;
    const [environmentExample, readme] = await Promise.all([
      readFile(resolve(".env.example"), "utf8"),
      readFile(resolve("README.md"), "utf8"),
    ]);

    expect(routePathname).toBe("/api/github/webhooks");
    expect(environmentExample).toContain(`GITHUB_WEBHOOK_URL=https://<public-host>${routePathname}`);
    expect(readme).toContain(`GITHUB_WEBHOOK_URL=https://<public-host>${routePathname}`);
    expect(environmentExample).not.toContain("/api/webhooks/github");
    expect(readme).not.toContain("/api/webhooks/github");
  });

  it("verifies raw bytes before parsing JSON and dispatches a supported delivery", async () => {
    const processWebhookMock = vi.fn().mockResolvedValue({ status: "PROCESSED" });
    const route = createGitHubWebhookPostHandler({ secret, processWebhook: processWebhookMock });

    const response = await route(
      request(rawPayload, {
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-1",
      }),
    );

    expect(response.status).toBe(202);
    expect(processWebhookMock).toHaveBeenCalledWith({
      action: "closed",
      deliveryId: "delivery-1",
      event: "pull_request",
      repositoryGitHubId: 42,
      repositoryFullName: "octo/example",
      subject: { kind: "PULL_REQUEST", id: 201, number: 11 },
    });
  });

  it("answers a tracked repository's delivery with a scheduled fold and none of the fold", async () => {
    const enqueued: string[] = [];
    const reconciled: string[] = [];
    // The reconcile dependency is offered on purpose. A handler that still folds
    // inside the request reaches for it and lands in `reconciled`, so this fails
    // on what the handler did rather than on a dependency it could not find.
    const dependencies: WebhookProcessorDependencies & {
      reconcileRepository(repositoryId: string): Promise<void>;
    } = {
      store: {
        applyIssueView: async () => {},
        claimDelivery: async () => ({ status: "CLAIMED", leaseToken: "lease-1" }),
        findRepositoryByGitHubId: async () => ({ id: "repository-1", active: true }),
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
    const route = createGitHubWebhookPostHandler({
      secret,
      processWebhook: (delivery) => processWebhook(dependencies, delivery),
    });

    const response = await route(
      request(rawPayload, {
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-scheduled",
      }),
    );

    expect(response.status).toBe(202);
    expect({ enqueued, reconciled }).toEqual({ enqueued: ["repository-1"], reconciled: [] });
  });

  it("answers 503 and records the failure when the fold cannot be scheduled", async () => {
    // The two halves of this path are pinned separately elsewhere; composed here
    // because what matters is what GitHub sees. A delivery Overflow did not
    // record must come back as an error, or GitHub never redelivers it and the
    // repository is left unreconciled with nothing queued to repair it.
    const markedFailed: { deliveryId: string; leaseToken: string }[] = [];
    const dependencies: WebhookProcessorDependencies = {
      store: {
        applyIssueView: async () => {},
        claimDelivery: async () => ({ status: "CLAIMED", leaseToken: "lease-1" }),
        findRepositoryByGitHubId: async () => ({ id: "repository-1", active: true }),
        markProcessed: async () => true,
        markFailed: async (deliveryId, leaseToken) => {
          markedFailed.push({ deliveryId, leaseToken });
          return true;
        },
      },
      enqueueReconciliation: async () => {
        throw new Error("PostgreSQL is unreachable");
      },
    };
    const route = createGitHubWebhookPostHandler({
      secret,
      processWebhook: (delivery) => processWebhook(dependencies, delivery),
    });
    // The diagnostic the route logs for this failure is pinned separately; here
    // it is only expected noise.
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await route(
        request(rawPayload, {
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-unqueued",
        }),
      );

      expect(response.status).toBe(503);
      expect(markedFailed).toEqual([{ deliveryId: "delivery-unqueued", leaseToken: "lease-1" }]);
    } finally {
      logged.mockRestore();
    }
  });

  it("rejects an invalid signature before attempting to parse malformed JSON", async () => {
    const processWebhookMock = vi.fn();
    const route = createGitHubWebhookPostHandler({ secret, processWebhook: processWebhookMock });

    const response = await route(
      new Request("https://overflow.test/api/github/webhooks", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-2",
          "x-hub-signature-256": "sha256=not-a-signature",
        },
        body: "{",
      }),
    );

    expect(response.status).toBe(401);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("requires GitHub delivery headers; a recognized-but-unmaterialized action answers 204 without processing", async () => {
    const processWebhookMock = vi.fn();
    const route = createGitHubWebhookPostHandler({ secret, processWebhook: processWebhookMock });

    const missingDelivery = await route(
      request(rawPayload, { "x-github-event": "pull_request" }),
    );
    const unmaterializedAction = await route(
      request(JSON.stringify({ ...JSON.parse(rawPayload), action: "converted_to_draft" }), {
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-3",
      }),
    );

    expect(missingDelivery.status).toBe(400);
    expect(unmaterializedAction.status).toBe(204);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("returns retryable 503 when delivery processing fails", async () => {
    const route = createGitHubWebhookPostHandler({
      secret,
      processWebhook: vi.fn().mockRejectedValue(new Error("upstream connection refused")),
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await route(
        request(rawPayload, {
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-4",
        }),
      );

      expect(response.status).toBe(503);
    } finally {
      logged.mockRestore();
    }
  });

  it("reports a processing failure to the server log with the delivery identifiers and the error itself", async () => {
    const rootCause = new Error("probe enqueue root cause");
    const processWebhookMock = vi.fn().mockRejectedValue(rootCause);
    const calls: unknown[][] = [];
    const logged = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    try {
      const route = createGitHubWebhookPostHandler({ secret, processWebhook: processWebhookMock });

      const response = await route(
        request(rawPayload, {
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-diagnostic",
        }),
      );

      expect(response.status).toBe(503);
      expect(await response.text()).toBe("");
      expect(logged).toHaveBeenCalledTimes(1);
      const [message, loggedError] = calls[0];
      expect(message).toContain("delivery-diagnostic");
      expect(message).toContain("pull_request");
      expect(message).toContain("octo/example");
      expect(message).toContain("GitHub id 42");
      // The error object itself is the second argument, never a stringified
      // copy: Node renders its type, stack and Error.cause chain natively, so
      // flattening it into the message line would erase the diagnostic.
      expect(loggedError).toBe(rootCause);
    } finally {
      logged.mockRestore();
    }
  });

  it("keeps the processor's cause chain intact through the route's diagnostic", async () => {
    const rootCause = new Error("probe enqueue root cause");
    const dependencies: WebhookProcessorDependencies = {
      store: {
        applyIssueView: async () => {},
        claimDelivery: async () => ({ status: "CLAIMED", leaseToken: "lease-1" }),
        findRepositoryByGitHubId: async () => ({ id: "repository-1", active: true }),
        markProcessed: async () => true,
        markFailed: async () => true,
      },
      enqueueReconciliation: async () => {
        throw rootCause;
      },
    };
    const calls: unknown[][] = [];
    const logged = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      calls.push(args);
    });
    try {
      const route = createGitHubWebhookPostHandler({
        secret,
        processWebhook: (delivery) => processWebhook(dependencies, delivery),
      });

      const response = await route(
        request(rawPayload, {
          "x-github-event": "pull_request",
          "x-github-delivery": "delivery-cause-chain",
        }),
      );

      expect(response.status).toBe(503);
      expect(logged).toHaveBeenCalledTimes(1);
      const [message, loggedError] = calls[0];
      expect(message).toContain("delivery-cause-chain");
      expect(loggedError).toBeInstanceOf(Error);
      expect((loggedError as Error).message).toBe("Webhook processing failed.");
      // The processor's rethrow reaches the log with its cause still attached,
      // so a composed failure names the layer that actually broke.
      expect((loggedError as Error).cause).toBe(rootCause);
    } finally {
      logged.mockRestore();
    }
  });

  // A delivery is rejected for size before its body is buffered, so an
  // oversized (or lying-about-size) request can never force the endpoint to
  // allocate its full length in memory before the signature check answers.
  // Mutants: DROP_DECLARED_SIZE_CHECK, DRAIN_UNCONDITIONALLY, and the
  // off-by-one twins DECLARED_SIZE_AT_LEAST / STREAMING_SIZE_AT_LEAST
  // (>= for >), killed by the exactly-at-ceiling delivery below.
  it("rejects a declared oversize delivery with 413 before reading any of the body", async () => {
    const { stream, record } = trackedBodyStream(CHUNK_COUNT);
    const processWebhookMock = vi.fn();
    const route = createGitHubWebhookPostHandler({ secret, processWebhook: processWebhookMock });
    const response = await route(streamRequest(stream, {
      "content-length": String(WEBHOOK_BODY_LIMIT_BYTES + 1),
      "x-github-event": "pull_request",
      "x-github-delivery": "oversize-declared",
      "x-hub-signature-256": "sha256=not-a-signature",
    }));
    expect(response.status).toBe(413);
    expect(record.handedOutBytes).toBe(0);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  // A delivery at EXACTLY GitHub's documented ceiling (Content-Length
  // 26214400) must still dispatch: the limit comment promises strict-greater
  // on both enforcement points, and an off-by-one here 413s legitimate
  // traffic that GitHub is allowed to send.
  // Mutants: DECLARED_SIZE_AT_LEAST and STREAMING_SIZE_AT_LEAST (>= for > on
  // either path) — both turn this 202 into a 413.
  it("accepts a correctly signed delivery at exactly the 25 MiB ceiling and dispatches it", async () => {
    const processWebhookMock = vi.fn().mockResolvedValue({ status: "PROCESSED" });
    const route = createGitHubWebhookPostHandler({ secret, processWebhook: processWebhookMock });
    // JSON.parse ignores insignificant whitespace, so trailing spaces pad the
    // envelope to exactly the limit's byte length without changing its
    // meaning; the payload is ASCII, so string length equals byte length.
    const paddedPayload = rawPayload.padEnd(WEBHOOK_BODY_LIMIT_BYTES, " ");
    expect(paddedPayload.length).toBe(WEBHOOK_BODY_LIMIT_BYTES);
    // Content-Length is set explicitly: undici auto-sets none on Request
    // bodies (verified — even string bodies carry no content-length), and the
    // declared-size fast path only sees one when the sender declares it, as
    // GitHub does. The declared value is accurate, matching the bytes below.
    const response = await route(request(paddedPayload, {
      "content-length": String(WEBHOOK_BODY_LIMIT_BYTES),
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-at-ceiling",
    }));
    expect(response.status).toBe(202);
    expect(processWebhookMock).toHaveBeenCalledWith({
      action: "closed",
      deliveryId: "delivery-at-ceiling",
      event: "pull_request",
      repositoryGitHubId: 42,
      repositoryFullName: "octo/example",
      subject: { kind: "PULL_REQUEST", id: 201, number: 11 },
    });
  });

  // Mutants: DRAIN_UNCONDITIONALLY (and any fix that only reads Content-Length).
  it("stops reading a delivery with no Content-Length once the body crosses 25 MiB, answering 413", async () => {
    const { stream, record } = trackedBodyStream(CHUNK_COUNT);
    const processWebhookMock = vi.fn();
    const route = createGitHubWebhookPostHandler({ secret, processWebhook: processWebhookMock });
    const response = await route(streamRequest(stream, {
      "x-github-event": "pull_request",
      "x-github-delivery": "oversize-stream",
      "x-hub-signature-256": "sha256=not-a-signature",
    }));
    expect(response.status).toBe(413);
    expect(record.handedOutBytes).toBeGreaterThan(WEBHOOK_BODY_LIMIT_BYTES);
    expect(record.handedOutBytes).toBeLessThanOrEqual(WEBHOOK_BODY_LIMIT_BYTES + CHUNK_BYTES);
    expect(record.cancelled).toBe(true);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  // Mutants: DRAIN_UNCONDITIONALLY (the declared header is a lie, so only the
  // streaming ceiling catches this one).
  it("stops reading a delivery whose Content-Length lies low once the body crosses 25 MiB, answering 413", async () => {
    const { stream, record } = trackedBodyStream(CHUNK_COUNT);
    const processWebhookMock = vi.fn();
    const route = createGitHubWebhookPostHandler({ secret, processWebhook: processWebhookMock });
    const response = await route(streamRequest(stream, {
      "content-length": "1024",
      "x-github-event": "pull_request",
      "x-github-delivery": "oversize-lying-content-length",
      "x-hub-signature-256": "sha256=not-a-signature",
    }));
    expect(response.status).toBe(413);
    expect(record.handedOutBytes).toBeLessThanOrEqual(WEBHOOK_BODY_LIMIT_BYTES + CHUNK_BYTES);
    expect(record.handedOutBytes).toBeLessThan(CHUNK_COUNT * CHUNK_BYTES);
    expect(record.cancelled).toBe(true);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  // Mutants: any ordering that verifies the signature before enforcing the
  // limit (the signature check cannot run without buffering the whole body).
  it("answers 413, not 401, for an oversize delivery with an invalid signature", async () => {
    const { stream, record } = trackedBodyStream(CHUNK_COUNT);
    const processWebhookMock = vi.fn();
    const route = createGitHubWebhookPostHandler({ secret, processWebhook: processWebhookMock });
    const response = await route(streamRequest(stream, {
      "x-github-event": "pull_request",
      "x-github-delivery": "oversize-invalid-signature",
      "x-hub-signature-256": "sha256=not-a-signature",
    }));
    expect(response.status).toBe(413);
    expect(record.handedOutBytes).toBeLessThanOrEqual(WEBHOOK_BODY_LIMIT_BYTES + CHUNK_BYTES);
    expect(record.cancelled).toBe(true);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  // A null request.body (no body at all) flows down the same path as an empty
  // body: the signature over the empty byte string verifies, then the empty
  // JSON document answers 400 rather than throwing.
  it("treats a null request body as empty: a correctly signed empty body answers 400", async () => {
    const signature = createHmac("sha256", secret).update("").digest("hex");
    const processWebhookMock = vi.fn();
    const route = createGitHubWebhookPostHandler({ secret, processWebhook: processWebhookMock });
    const response = await route(new Request("https://overflow.test/api/github/webhooks", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": "null-body",
        "x-hub-signature-256": `sha256=${signature}`,
      },
    }));
    expect(response.status).toBe(400);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid signature before constructing production persistence dependencies", async () => {
    const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    delete process.env.DATABASE_URL;

    try {
      const response = await POST(
        new Request("https://overflow.test/api/github/webhooks", {
          method: "POST",
          headers: {
            "x-github-event": "pull_request",
            "x-github-delivery": "delivery-production-invalid",
            "x-hub-signature-256": "sha256=not-a-signature",
          },
          body: "{",
        }),
      );

      expect(response.status).toBe(401);
    } finally {
      if (originalSecret === undefined) {
        delete process.env.GITHUB_WEBHOOK_SECRET;
      } else {
        process.env.GITHUB_WEBHOOK_SECRET = originalSecret;
      }
      if (originalDatabaseUrl === undefined) {
        delete process.env.DATABASE_URL;
      } else {
        process.env.DATABASE_URL = originalDatabaseUrl;
      }
    }
  });
});

function request(
  body: string,
  headers: Record<string, string>,
): Request {
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return new Request("https://overflow.test/api/github/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
}

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
  return new Request("https://overflow.test/api/github/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...headers,
    },
    body: stream,
    // A Request with a stream body requires declaring the duplex direction;
    // undici sets no Content-Length for a stream body, which is exactly the
    // no-Content-Length case under test.
    duplex: "half",
  } as RequestInit);
}
