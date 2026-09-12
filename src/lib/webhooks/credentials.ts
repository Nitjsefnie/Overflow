import { randomBytes, randomUUID } from "node:crypto";

export type WebhookCredential = { id: string; secret: string };

/** Private authentication data, never part of a public repository projection. */
export type WebhookCredentialRecord = {
  repositoryId: string;
  credentialId: string;
  secret: string;
  provider: "github" | "gitlab";
  instanceUrl: string | null;
  projectId: number;
  webhookId: number;
  configuredAt: Date | null;
};

export type WebhookCredentialLookup = (
  selector: string, provider: "github" | "gitlab",
) => Promise<WebhookCredentialRecord | null>;

export type WebhookCredentialTarget = Omit<WebhookCredentialRecord, "credentialId" | "secret" | "configuredAt">;

export function webhookSelector(requestUrl: string): string | null {
  const selectors = new URL(requestUrl).searchParams.getAll("hook");
  return selectors.length === 1
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(selectors[0])
    ? selectors[0].toLowerCase() : null;
}

export function githubPayloadRepositoryId(payload: unknown): number | null {
  if (typeof payload !== "object" || payload === null || !("repository" in payload)) return null;
  const repository = payload.repository;
  if (typeof repository !== "object" || repository === null || !("id" in repository)) return null;
  const id = repository.id;
  return typeof id === "number" && Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function generateWebhookCredential(): WebhookCredential {
  return { id: randomUUID(), secret: randomBytes(32).toString("base64url") };
}

export function webhookCallbackUrl(base: string, credentialId: string): string {
  const url = new URL(base);
  if (base.includes("#") || (url.protocol !== "https:" && url.protocol !== "http:")) {
    throw new Error("Webhook callback must be an HTTP(S) URL without a fragment.");
  }
  url.searchParams.set("hook", credentialId);
  return url.toString();
}
