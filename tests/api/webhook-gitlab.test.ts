import { describe, expect, it, vi } from "vitest";
import { createGitLabWebhookPostHandler, POST } from "@/app/api/gitlab/webhooks/route";
import { processWebhook, type WebhookProcessorDependencies } from "@/lib/webhooks/processor";

/**
 * The GitLab receiver mirrors the GitHub receiver's contract: 503 when no
 * secret is configured, 401 on a bad token, 400 on malformed traffic, 202
 * accepted-for-processing, 413 over the body cap. Both payload kinds the hook
 * subscribes to — issue and merge request — are accepted for processing; the
 * receiver has no deliberately-ignored (204) class. The token check replaces
 * the HMAC; the delivery uuid header is required (the namespaced dedup key is
 * built from it, issue 547).
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
  return new Request("https://overflow.test/api/gitlab/webhooks", {
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
  it("dispatches a verified issue delivery with the namespaced delivery id", async () => {
    const processWebhookMock = vi.fn().mockResolvedValue({ status: "PROCESSED" });
    const route = createGitLabWebhookPostHandler({ secret, processWebhook: processWebhookMock });

    const response = await route(request(issuePayload, gitlabHeaders()));

    expect(response.status).toBe(202);
    expect(processWebhookMock).toHaveBeenCalledWith(expect.objectContaining({
      deliveryId: "gitlab:uuid-1",
      event: "issues",
      action: "closed",
      repositoryGitHubId: 278964,
      repositoryFullName: "gitlab-org/gitlab",
      subject: { kind: "ISSUE", id: 301, number: 23 },
      forge: { provider: "gitlab", instanceUrl: "https://gitlab.com" },
    }));
  });

  // The delivery uuid header is load-bearing beyond the 400: the namespaced
  // dedup key is built from it, so a request without it can never be claimed.
  it.each([
    { name: "no event header", headers: gitlabHeadersWithout("event") },
    { name: "no delivery uuid", headers: gitlabHeadersWithout("uuid") },
    { name: "no token header", headers: gitlabHeadersWithout("token") },
  ])("answers 400 when $name is missing", async ({ headers }) => {
    const processWebhookMock = vi.fn();
    const route = createGitLabWebhookPostHandler({ secret, processWebhook: processWebhookMock });
    const response = await route(request(issuePayload, headers));
    expect(response.status).toBe(400);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("answers 503 when no secret is configured", async () => {
    const processWebhookMock = vi.fn();
    const route = createGitLabWebhookPostHandler({ secret: undefined, processWebhook: processWebhookMock });
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
    const route = createGitLabWebhookPostHandler({ secret, processWebhook: processWebhookMock });
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
    const route = createGitLabWebhookPostHandler({ secret, processWebhook: processWebhookMock });
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
    const route = createGitLabWebhookPostHandler({ secret, processWebhook: processWebhookMock });
    const response = await route(request("{", gitlabHeaders()));
    expect(response.status).toBe(400);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("answers 202 for a merge request delivery and hands the processor its PULL_REQUEST subject", async () => {
    const processWebhookMock = vi.fn().mockResolvedValue({ status: "PROCESSED" });
    const route = createGitLabWebhookPostHandler({ secret, processWebhook: processWebhookMock });
    const response = await route(request(mergeRequestPayload, gitlabHeaders({ "x-gitlab-event": "Merge Request Hook" })));
    expect(response.status).toBe(202);
    expect(processWebhookMock).toHaveBeenCalledExactlyOnceWith({
      deliveryId: "gitlab:uuid-1",
      event: "pull_request",
      action: "closed",
      repositoryGitHubId: 278964,
      repositoryFullName: "gitlab-org/gitlab",
      subject: { kind: "PULL_REQUEST", id: 401, number: 7 },
      forge: { provider: "gitlab", instanceUrl: "https://gitlab.com" },
    });
  });

  it("answers 400 for an unrecognised object kind", async () => {
    const processWebhookMock = vi.fn();
    const route = createGitLabWebhookPostHandler({ secret, processWebhook: processWebhookMock });
    const response = await route(request(JSON.stringify({ object_kind: "push" }), gitlabHeaders({ "x-gitlab-event": "Push Hook" })));
    expect(response.status).toBe(400);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("answers 503 and lets the instance retry when processing fails", async () => {
    const route = createGitLabWebhookPostHandler({
      secret,
      processWebhook: vi.fn().mockRejectedValue(new Error("upstream connection refused")),
    });
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const response = await route(request(issuePayload, gitlabHeaders()));
      expect(response.status).toBe(503);
    } finally {
      logged.mockRestore();
    }
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
    const findRepositoryByForgeIdentity = vi.fn().mockResolvedValue({ id: "gitlab-repository", active: true });
    const findRepositoryByGitHubId = vi.fn().mockResolvedValue(null);
    const dependencies: WebhookProcessorDependencies & {
      reconcileRepository(repositoryId: string): Promise<void>;
    } = {
      store: {
        applyIssueView: async () => {},
        claimDelivery: async () => ({ status: "CLAIMED", leaseToken: "lease-1" }),
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
      secret,
      processWebhook: (delivery) => processWebhook(dependencies, delivery),
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
    const route = createGitLabWebhookPostHandler({ secret, processWebhook: processWebhookMock });
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
    const route = createGitLabWebhookPostHandler({ secret, processWebhook: processWebhookMock });
    const response = await route(streamRequest(stream, {}));
    expect(response.status).toBe(413);
    expect(record.handedOutBytes).toBeGreaterThan(WEBHOOK_BODY_LIMIT_BYTES);
    expect(record.handedOutBytes).toBeLessThanOrEqual(WEBHOOK_BODY_LIMIT_BYTES + CHUNK_BYTES);
    expect(record.cancelled).toBe(true);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("accepts a correctly tokened delivery at exactly the 25 MiB ceiling and dispatches it", async () => {
    const processWebhookMock = vi.fn().mockResolvedValue({ status: "PROCESSED" });
    const route = createGitLabWebhookPostHandler({ secret, processWebhook: processWebhookMock });
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
    const originalSecret = process.env.GITHUB_WEBHOOK_SECRET;
    const originalDatabaseUrl = process.env.DATABASE_URL;
    process.env.GITHUB_WEBHOOK_SECRET = secret;
    delete process.env.DATABASE_URL;

    try {
      const response = await POST(
        new Request("https://overflow.test/api/gitlab/webhooks", {
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
  return new Request("https://overflow.test/api/gitlab/webhooks", {
    method: "POST",
    headers: { "content-type": "application/json", ...gitlabHeaders(), ...headers },
    body: stream,
    // A Request with a stream body requires declaring the duplex direction;
    // undici sets no Content-Length for a stream body, which is exactly the
    // no-Content-Length case under test.
    duplex: "half",
  } as RequestInit);
}
