import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGitHubWebhookPostHandler, POST } from "@/app/api/github/webhooks/route";

const secret = "webhook-secret";
const rawPayload = JSON.stringify({
  action: "closed",
  repository: { id: 42, full_name: "octo/example" },
});

describe("GitHub webhook route", () => {
  it("verifies raw bytes before parsing JSON and dispatches a supported delivery", async () => {
    const processWebhook = vi.fn().mockResolvedValue({ status: "PROCESSED" });
    const route = createGitHubWebhookPostHandler({ secret, processWebhook });

    const response = await route(
      request(rawPayload, {
        "x-github-event": "pull_request",
        "x-github-delivery": "delivery-1",
      }),
    );

    expect(response.status).toBe(202);
    expect(processWebhook).toHaveBeenCalledWith({
      action: "closed",
      deliveryId: "delivery-1",
      event: "pull_request",
      repositoryGitHubId: 42,
      repositoryFullName: "octo/example",
    });
  });

  it("rejects an invalid signature before attempting to parse malformed JSON", async () => {
    const processWebhook = vi.fn();
    const route = createGitHubWebhookPostHandler({ secret, processWebhook });

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
    expect(processWebhook).not.toHaveBeenCalled();
  });

  it("requires GitHub delivery headers and a supported event action", async () => {
    const processWebhook = vi.fn();
    const route = createGitHubWebhookPostHandler({ secret, processWebhook });

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
    expect(processWebhook).not.toHaveBeenCalled();
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
