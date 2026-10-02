import { timingSafeEqual } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { verifyGitLabWebhookToken } from "@/lib/gitlab/webhook-token";

vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

afterAll(() => {
  vi.resetModules();
});

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

  it("uses timingSafeEqual for equal-length acceptance and rejection", async () => {
    // Earlier files can cache this module with real crypto in the shared graph.
    vi.resetModules();
    const { verifyGitLabWebhookToken } = await import("@/lib/gitlab/webhook-token");
    const comparison = vi.mocked(timingSafeEqual);
    comparison.mockClear();

    expect(verifyGitLabWebhookToken("shared-secret", "shared-secret")).toBe(true);
    expect(verifyGitLabWebhookToken("shared-secrex", "shared-secret")).toBe(false);

    expect(comparison).toHaveBeenCalledTimes(2);
    expect(comparison).toHaveBeenNthCalledWith(
      1, Buffer.from("shared-secret"), Buffer.from("shared-secret"),
    );
    expect(comparison).toHaveBeenNthCalledWith(
      2, Buffer.from("shared-secret"), Buffer.from("shared-secrex"),
    );
  });
});
