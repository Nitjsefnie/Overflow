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

    const response = await route(
      request(rawPayload, {
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-unqueued",
      }),
    );

    expect(response.status).toBe(503);
    expect(markedFailed).toEqual([{ deliveryId: "delivery-unqueued", leaseToken: "lease-1" }]);
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

  it("requires GitHub delivery headers and a supported event action", async () => {
    const processWebhookMock = vi.fn();
    const route = createGitHubWebhookPostHandler({ secret, processWebhook: processWebhookMock });

    const missingDelivery = await route(
      request(rawPayload, { "x-github-event": "pull_request" }),
    );
    const unsupportedAction = await route(
      request(JSON.stringify({ ...JSON.parse(rawPayload), action: "converted_to_draft" }), {
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-3",
      }),
    );

    expect(missingDelivery.status).toBe(400);
    expect(unsupportedAction.status).toBe(400);
    expect(processWebhookMock).not.toHaveBeenCalled();
  });

  it("returns retryable 503 when delivery processing fails", async () => {
    const route = createGitHubWebhookPostHandler({
      secret,
      processWebhook: vi.fn().mockRejectedValue(new Error("upstream connection refused")),
    });

    const response = await route(
      request(rawPayload, {
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-4",
      }),
    );

    expect(response.status).toBe(503);
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
