import type { WebhookCredentialRecord } from "@/lib/webhooks/credentials";

export const webhookSelector = "181a4fbb-64d1-44fd-82da-cd191613798c";

export function webhookCredential(provider: "github" | "gitlab", secret = "webhook-secret"): WebhookCredentialRecord {
  return {
    repositoryId: "test-registration", credentialId: webhookSelector, secret, provider,
    instanceUrl: provider === "github" ? null : "https://gitlab.com",
    projectId: provider === "github" ? 42 : 278964,
    webhookId: provider === "github" ? 501 : 4242,
    configuredAt: null,
  };
}
