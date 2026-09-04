import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyGitHubWebhookSignature } from "@/lib/github/webhook-signature";

const secret = "webhook-secret";
const rawBody = '{"action":"closed"}';

describe("verifyGitHubWebhookSignature", () => {
  it("accepts the exact lowercase SHA-256 HMAC for the raw request bytes", () => {
    const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

    expect(verifyGitHubWebhookSignature(rawBody, signature, secret)).toBe(true);
  });

  it("rejects missing, malformed, uppercase, and wrong-length signatures", () => {
    const valid = createHmac("sha256", secret).update(rawBody).digest("hex");

    expect(verifyGitHubWebhookSignature(rawBody, undefined, secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(rawBody, `sha1=${valid}`, secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(rawBody, `sha256=${valid.toUpperCase()}`, secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(rawBody, `sha256=${valid.slice(0, -2)}`, secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(rawBody, `sha256=${"0".repeat(64)}`, secret)).toBe(false);
  });
});
