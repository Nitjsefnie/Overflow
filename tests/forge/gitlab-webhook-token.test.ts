import { describe, expect, it } from "vitest";
import { verifyGitLabWebhookToken } from "@/lib/gitlab/webhook-token";

/**
 * The hook's `token` is the same shared secret the GitHub hooks carry, echoed
 * back on every delivery in X-Gitlab-Token. The comparison is constant-time,
 * like the GitHub signature check it mirrors.
 */

describe("the GitLab webhook token check", () => {
  it("accepts the configured secret", () => {
    expect(verifyGitLabWebhookToken("shared-secret", "shared-secret")).toBe(true);
  });

  it("rejects a wrong token, an absent token, an absent secret and an empty secret", () => {
    expect(verifyGitLabWebhookToken("wrong", "shared-secret")).toBe(false);
    expect(verifyGitLabWebhookToken("", "shared-secret")).toBe(false);
    expect(verifyGitLabWebhookToken(null, "shared-secret")).toBe(false);
    expect(verifyGitLabWebhookToken(undefined, "shared-secret")).toBe(false);
    expect(verifyGitLabWebhookToken("shared-secret", undefined)).toBe(false);
    expect(verifyGitLabWebhookToken("shared-secret", "")).toBe(false);
  });

  it("does not read a prefix as a match", () => {
    expect(verifyGitLabWebhookToken("shared", "shared-secret")).toBe(false);
  });

  it("rejects an equal-length token that differs in content", () => {
    // Same byte length as the secret: only a real comparison can separate
    // this from the configured secret, so the case kills any mutant that
    // answers true past the length guard.
    expect(verifyGitLabWebhookToken("x".repeat("shared-secret".length), "shared-secret")).toBe(false);
  });
});
