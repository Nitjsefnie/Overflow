import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "@/lib/security/token-cipher";

const encryptionKey = randomBytes(32).toString("base64url");

describe("GitHub OAuth token cipher", () => {
  it("round trips a token through a versioned authenticated envelope", () => {
    const encrypted = encryptToken("oauth-token-for-test", encryptionKey);

    expect(encrypted).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(decryptToken(encrypted, encryptionKey)).toBe("oauth-token-for-test");
  });

  it("uses a fresh initialization vector for each encryption", () => {
    const first = encryptToken("same-token", encryptionKey);
    const second = encryptToken("same-token", encryptionKey);

    expect(first).not.toBe(second);
  });

  it("rejects a tampered authenticated envelope without revealing its contents", () => {
    const encrypted = encryptToken("oauth-token-for-test", encryptionKey);
    const tampered = `${encrypted.slice(0, -1)}${encrypted.endsWith("A") ? "B" : "A"}`;

    expect(() => decryptToken(tampered, encryptionKey)).toThrow("Unable to decrypt GitHub token.");
  });

  it("requires a decoded 32-byte encryption key", () => {
    const tooShortKey = randomBytes(31).toString("base64url");

    expect(() => encryptToken("oauth-token-for-test", tooShortKey)).toThrow(
      "Token encryption key must decode to exactly 32 bytes.",
    );
  });
});
