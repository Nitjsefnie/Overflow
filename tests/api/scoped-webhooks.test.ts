import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createGitHubWebhookPostHandler } from "@/app/api/github/webhooks/route";
import { createGitLabWebhookPostHandler } from "@/app/api/gitlab/webhooks/route";
import { webhookCredential, webhookSelector } from "../support/webhook-credential";

const githubBody = JSON.stringify({
  action: "closed", repository: { id: 42, full_name: "renamed/project" },
  pull_request: { id: 100, number: 1 },
});
const gitlabBody = JSON.stringify({
  object_kind: "merge_request",
  project: { id: 278964, path_with_namespace: "renamed/project", web_url: "https://gitlab.com/renamed/project" },
  object_attributes: { id: 100, iid: 1, action: "merge" },
});

describe.each(["github", "gitlab"] as const)("%s scoped webhook authentication", (provider) => {
  const factory = provider === "github" ? createGitHubWebhookPostHandler : createGitLabWebhookPostHandler;
  const credential = webhookCredential(provider);
  const body = provider === "github" ? githubBody : gitlabBody;
  function request(query = `?hook=${webhookSelector}`): Request {
    return new Request(`https://overflow.test/api/${provider}/webhooks${query}`, {
      method: "POST", body,
      headers: provider === "github" ? {
        "x-github-event": "pull_request", "x-github-delivery": "scoped-test",
        "x-hub-signature-256": `sha256=${createHmac("sha256", credential.secret).update(body).digest("hex")}`,
      } : {
        "x-gitlab-event": "Merge Request Hook", "x-gitlab-webhook-uuid": "scoped-test",
        "x-gitlab-token": credential.secret,
      },
    });
  }

  it("selects by provider and opaque UUID while accepting a renamed repository", async () => {
    const deliveries: unknown[] = [];
    const lookups: unknown[] = [];
    const response = await factory({
      lookupCredential: async (selector, expectedProvider) => {
        lookups.push([selector, expectedProvider]);
        return credential;
      },
      processWebhook: async (delivery) => { deliveries.push(delivery); },
    })(request());
    expect(response.status).toBe(202);
    expect(lookups).toEqual([[webhookSelector, provider]]);
    expect(deliveries).toMatchObject([{ repositoryFullName: "renamed/project" }]);
  });

  it.each(["", "?hook=", "?hook=not-a-uuid", `?hook=${webhookSelector}&hook=${webhookSelector}`])(
    "rejects malformed selector %s before lookup or processing", async (query) => {
      const accesses: string[] = [];
      const response = await factory({
        lookupCredential: async () => { accesses.push("lookup"); return credential; },
        processWebhook: async () => { accesses.push("process"); },
      })(request(query));
      expect(response.status).toBe(401);
      expect(accesses).toEqual([]);
    },
  );

  it("never falls back to the global credential for unknown or legacy hooks", async () => {
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", credential.secret);
    try {
      const deliveries: unknown[] = [];
      const response = await factory({
        lookupCredential: async () => null,
        processWebhook: async (delivery) => { deliveries.push(delivery); },
      })(request());
      expect(response.status).toBe(401);
      expect(deliveries).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("sanitizes lookup and decryption failures without processing", async () => {
    const deliveries: unknown[] = [];
    const response = await factory({
      lookupCredential: async () => { throw new Error("synthetic private credential details"); },
      processWebhook: async (delivery) => { deliveries.push(delivery); },
    })(request());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(deliveries).toEqual([]);
  });
});
