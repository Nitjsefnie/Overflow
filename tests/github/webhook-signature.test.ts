import { createHmac, timingSafeEqual } from "node:crypto";
import { afterAll, describe, expect, it, vi } from "vitest";
import { verifyGitHubWebhookSignature } from "@/lib/github/webhook-signature";

// The spy delegates to the real comparison, so every other case in this file
// still exercises genuine crypto; it only records what the module compared.
vi.mock("node:crypto", async () => {
  const actual = await vi.importActual<typeof import("node:crypto")>("node:crypto");
  return { ...actual, timingSafeEqual: vi.fn(actual.timingSafeEqual) };
});

afterAll(() => {
  vi.resetModules();
});

const secret = "webhook-secret";
const rawBody = '{"action":"closed"}';

function trueDigest(): Buffer {
  return createHmac("sha256", secret).update(rawBody).digest();
}

function withByteFlipped(digest: Buffer, position: number): Buffer {
  const altered = Buffer.from(digest);
  altered[position] ^= 0x01;
  return altered;
}

const digestPositions = Array.from({ length: 32 }, (_, position) => position);

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

  it("rejects a hex payload that is not exactly the 64-character digest", () => {
    const valid = createHmac("sha256", secret).update(rawBody).digest("hex");

    expect(verifyGitHubWebhookSignature(rawBody, `sha256=${valid}0`, secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(rawBody, `sha256=${valid}ab`, secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(rawBody, `sha256=${valid.slice(0, -1)}`, secret)).toBe(false);
  });

  it("rejects a signature forged under the empty secret, because no secret is configured", () => {
    const forged = `sha256=${createHmac("sha256", "").update(rawBody).digest("hex")}`;

    expect(verifyGitHubWebhookSignature(rawBody, forged, "")).toBe(false);
  });

  it("rejects an unconfigured secret rather than hashing the body with it", () => {
    const forged = `sha256=${createHmac("sha256", "").update(rawBody).digest("hex")}`;

    expect(verifyGitHubWebhookSignature(rawBody, forged, undefined)).toBe(false);
  });

  // Every position, first and last included: a comparison that stops early
  // or skips a byte accepts at least one of these.
  it.each(digestPositions)("rejects the true digest with only byte %i changed", (position) => {
    const altered = withByteFlipped(trueDigest(), position);

    expect(altered.length).toBe(32);
    expect(altered.compare(trueDigest())).not.toBe(0);
    expect(verifyGitHubWebhookSignature(rawBody, `sha256=${altered.toString("hex")}`, secret)).toBe(false);
  });

  it("rejects a 63- or 65-character payload and the 64-character digest of another body", () => {
    const valid = trueDigest().toString("hex");
    const otherDigest = createHmac("sha256", secret).update('{"action":"opened"}').digest("hex");

    expect(otherDigest).toHaveLength(64);
    expect(otherDigest).not.toBe(valid);
    expect(verifyGitHubWebhookSignature(rawBody, `sha256=${valid.slice(0, 63)}`, secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(rawBody, `sha256=${valid}f`, secret)).toBe(false);
    expect(verifyGitHubWebhookSignature(rawBody, `sha256=${otherDigest}`, secret)).toBe(false);
  });

  it("compares through timingSafeEqual over the two 32-byte digests", async () => {
    // Earlier files can cache this module with real crypto in the shared graph.
    vi.resetModules();
    const { verifyGitHubWebhookSignature } = await import("@/lib/github/webhook-signature");
    const comparison = vi.mocked(timingSafeEqual);
    comparison.mockClear();

    const expected = trueDigest();
    const lastByteChanged = withByteFlipped(expected, 31);

    expect(verifyGitHubWebhookSignature(rawBody, `sha256=${expected.toString("hex")}`, secret)).toBe(true);
    expect(verifyGitHubWebhookSignature(rawBody, `sha256=${lastByteChanged.toString("hex")}`, secret)).toBe(false);

    expect(comparison).toHaveBeenCalledTimes(2);
    expect(comparison).toHaveBeenNthCalledWith(1, expected, expected);
    expect(comparison).toHaveBeenNthCalledWith(2, expected, lastByteChanged);
    for (const [left, right] of comparison.mock.calls) {
      expect(left.byteLength).toBe(32);
      expect(right.byteLength).toBe(32);
    }
  });
});
