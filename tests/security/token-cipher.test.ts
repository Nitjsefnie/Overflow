import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  credentialBinding,
  decryptToken,
  encryptToken,
  isEnvelopeCurrent,
  loadTokenKeySet,
  tokenKeySetFrom,
} from "@/lib/security/token-cipher";
import { legacyV1Envelope, legacyV1Key } from "../support/legacy-token-envelope";

const encryptionKey = randomBytes(32).toString("base64url");
const otherKey = randomBytes(32).toString("base64url");
const decryptionFailure = "Unable to decrypt stored credential.";

const oauthBinding = credentialBinding.userOAuthToken(4242);
const forgeBinding = credentialBinding.forgeToken({
  provider: "gitlab",
  instanceUrl: "https://gitlab.example.com",
  forgeUserId: 4242,
});
const webhookBinding = credentialBinding.webhookSecret("5b0f7a8e-2f3c-4d71-9a53-6c1d2e3f4a5b");

function expectedKeyId(encodedKey: string): string {
  return createHash("sha256")
    .update(Buffer.concat([Buffer.from("overflow-token-key-id:v2:", "utf8"), Buffer.from(encodedKey, "base64url")]))
    .digest()
    .subarray(0, 8)
    .toString("base64url");
}

// Seals the way the persisted v2 format is specified, with raw node:crypto and
// a literal associated-data string, so a change to how the module builds either
// cannot pass by changing both sides of a round trip at once.
function sealKnownAnswer(encodedKey: string, literalAssociatedData: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(encodedKey, "base64url"), iv, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(literalAssociatedData, "utf8"));
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v2", expectedKeyId(encodedKey), iv.toString("base64url"), cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url")].join(".");
}

// Seals the way the persisted v1 format was specified, with raw node:crypto
// and no associated data, so a v1 envelope of a known plaintext can be offered
// to the module the way the issue constructs it.
function sealLegacyV1(encodedKey: string, plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(encodedKey, "base64url"), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url")].join(".");
}

function replacePart(envelope: string, index: number, replacement: (part: string) => string): string {
  const parts = envelope.split(".");
  parts[index] = replacement(parts[index]!);
  return parts.join(".");
}

function flipFirstByte(part: string): string {
  const bytes = Buffer.from(part, "base64url");
  bytes[0] = bytes[0]! ^ 0x01;
  return bytes.toString("base64url");
}

describe("stored credential cipher", () => {
  it("round trips a credential through a key-identified, row-bound envelope", () => {
    const encrypted = encryptToken("oauth-token-for-test", encryptionKey, oauthBinding);

    expect(decryptToken(encrypted, encryptionKey, oauthBinding)).toBe("oauth-token-for-test");
    expect(decryptToken(encrypted, { current: encryptionKey }, oauthBinding)).toBe("oauth-token-for-test");
  });

  it("writes a v2 envelope whose key id is derived from the current key", () => {
    const encrypted = encryptToken("oauth-token-for-test", encryptionKey, oauthBinding);
    const [version, keyId, iv, tag, ciphertext, ...extra] = encrypted.split(".");

    expect(version).toBe("v2");
    expect(keyId).toBe(expectedKeyId(encryptionKey));
    expect(Buffer.from(iv!, "base64url")).toHaveLength(12);
    expect(Buffer.from(tag!, "base64url")).toHaveLength(16);
    expect(ciphertext).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(extra).toEqual([]);
  });

  it("uses a fresh initialization vector for each encryption", () => {
    const first = encryptToken("same-token", encryptionKey, oauthBinding);
    const second = encryptToken("same-token", encryptionKey, oauthBinding);

    expect(first).not.toBe(second);
  });

  it("refuses an envelope moved to another row, column or table", () => {
    const oauth = encryptToken("secret", encryptionKey, oauthBinding);
    const forge = encryptToken("secret", encryptionKey, forgeBinding);
    const webhook = encryptToken("secret", encryptionKey, webhookBinding);

    // Another row of the same column.
    expect(() => decryptToken(oauth, encryptionKey, credentialBinding.userOAuthToken(4243))).toThrow(decryptionFailure);
    expect(() => decryptToken(forge, encryptionKey, credentialBinding.forgeToken({
      provider: "gitlab", instanceUrl: "https://gitlab.example.com", forgeUserId: 4243,
    }))).toThrow(decryptionFailure);
    expect(() => decryptToken(forge, encryptionKey, credentialBinding.forgeToken({
      provider: "gitlab", instanceUrl: "https://other.example.com", forgeUserId: 4242,
    }))).toThrow(decryptionFailure);
    expect(() => decryptToken(webhook, encryptionKey,
      credentialBinding.webhookSecret("00000000-0000-4000-8000-000000000000"))).toThrow(decryptionFailure);
    // Another column/table carrying the same row key.
    expect(() => decryptToken(oauth, encryptionKey, forgeBinding)).toThrow(decryptionFailure);
    expect(() => decryptToken(forge, encryptionKey, webhookBinding)).toThrow(decryptionFailure);
    expect(() => decryptToken(webhook, encryptionKey, oauthBinding)).toThrow(decryptionFailure);
    // Identical row-key parts in different columns.
    const sameKeyOAuth = encryptToken("secret", encryptionKey, credentialBinding.userOAuthToken(4242));
    expect(() => decryptToken(sameKeyOAuth, encryptionKey, credentialBinding.webhookSecret("4242")))
      .toThrow(decryptionFailure);
  });

  it("opens a known-answer envelope sealed with each constructor's specified associated data", () => {
    const oauth = sealKnownAnswer(encryptionKey,
      '["overflow-credential","users","encrypted_oauth_token","4242"]', "known-oauth");
    const forge = sealKnownAnswer(encryptionKey,
      '["overflow-credential","user_forge_identities","encrypted_token","gitlab","https://gitlab.example.com","4242"]',
      "known-pat");
    const webhook = sealKnownAnswer(encryptionKey,
      '["overflow-credential","registered_repositories","encrypted_webhook_secret","5b0f7a8e-2f3c-4d71-9a53-6c1d2e3f4a5b"]',
      "known-webhook-secret");

    expect(decryptToken(oauth, encryptionKey, credentialBinding.userOAuthToken(4242))).toBe("known-oauth");
    expect(decryptToken(forge, encryptionKey, credentialBinding.forgeToken({
      provider: "gitlab", instanceUrl: "https://gitlab.example.com", forgeUserId: 4242,
    }))).toBe("known-pat");
    expect(decryptToken(webhook, encryptionKey,
      credentialBinding.webhookSecret("5b0f7a8e-2f3c-4d71-9a53-6c1d2e3f4a5b"))).toBe("known-webhook-secret");
  });

  it("binds a webhook credential id the way Postgres returns the uuid, whatever its case", () => {
    const encrypted = encryptToken("secret", encryptionKey,
      credentialBinding.webhookSecret("5B0F7A8E-2F3C-4D71-9A53-6C1D2E3F4A5B"));

    expect(decryptToken(encrypted, encryptionKey, webhookBinding)).toBe("secret");
  });

  it("keeps multi-part row keys unambiguous", () => {
    const encrypted = encryptToken("secret", encryptionKey, credentialBinding.forgeToken({
      provider: "gitlab", instanceUrl: "https://a.example.com", forgeUserId: 1,
    }));

    for (const shifted of [
      { provider: "gitlabhttps://a.example.com", instanceUrl: "" },
      { provider: "gitlab,https://a.example.com", instanceUrl: "" },
      { provider: "gitlab", instanceUrl: "https://a.example.com1" },
    ]) {
      expect(() => decryptToken(encrypted, encryptionKey, credentialBinding.forgeToken({ ...shifted, forgeUserId: 1 })))
        .toThrow(decryptionFailure);
    }
  });

  it("decrypts under the previous key once the current key has rotated", () => {
    const encrypted = encryptToken("rotated-secret", encryptionKey, webhookBinding);

    expect(decryptToken(encrypted, { current: otherKey, previous: encryptionKey }, webhookBinding))
      .toBe("rotated-secret");
  });

  it("refuses a v2 envelope whose key id matches neither configured key", () => {
    const encrypted = encryptToken("orphaned-secret", encryptionKey, webhookBinding);

    expect(() => decryptToken(encrypted, otherKey, webhookBinding)).toThrow(decryptionFailure);
    expect(() => decryptToken(encrypted, { current: otherKey, previous: randomBytes(32).toString("base64url") },
      webhookBinding)).toThrow(decryptionFailure);
  });

  it("refuses a hand-built v1 envelope of a known plaintext under any binding", () => {
    const v1Envelope = sealLegacyV1(encryptionKey, "secret-of-A");
    const bindingA = credentialBinding.webhookSecret("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const bindingB = credentialBinding.webhookSecret("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");

    expect(() => decryptToken(v1Envelope, encryptionKey, bindingA)).toThrow(decryptionFailure);
    expect(() => decryptToken(v1Envelope, encryptionKey, bindingB)).toThrow(decryptionFailure);
    expect(() => decryptToken(v1Envelope, { current: encryptionKey, previous: otherKey }, bindingA))
      .toThrow(decryptionFailure);
    expect(() => decryptToken(v1Envelope, otherKey, bindingA)).toThrow(decryptionFailure);
  });

  it("refuses the persisted pre-change v1 envelope under any key or binding", () => {
    expect(() => decryptToken(legacyV1Envelope, legacyV1Key, oauthBinding)).toThrow(decryptionFailure);
    expect(() => decryptToken(legacyV1Envelope, { current: otherKey, previous: legacyV1Key }, oauthBinding))
      .toThrow(decryptionFailure);
    expect(() => decryptToken(legacyV1Envelope, legacyV1Key, forgeBinding)).toThrow(decryptionFailure);
  });

  it("refuses a tampered iv, tag, ciphertext or key id", () => {
    const encrypted = encryptToken("oauth-token-for-test", encryptionKey, oauthBinding);

    for (const index of [1, 2, 3, 4]) {
      const tampered = replacePart(encrypted, index, flipFirstByte);
      expect(tampered).not.toBe(encrypted);
      expect(() => decryptToken(tampered, { current: encryptionKey, previous: otherKey }, oauthBinding))
        .toThrow(decryptionFailure);
    }
    expect(() => decryptToken(replacePart(encrypted, 0, () => "v3"), encryptionKey, oauthBinding))
      .toThrow(decryptionFailure);
    expect(() => decryptToken(`${encrypted}.extra`, encryptionKey, oauthBinding)).toThrow(decryptionFailure);
  });

  it("reports the same generic failure whatever went wrong", () => {
    const encrypted = encryptToken("oauth-token-for-test", encryptionKey, oauthBinding);
    const failures = [
      () => decryptToken(encrypted, otherKey, oauthBinding),
      () => decryptToken(encrypted, encryptionKey, forgeBinding),
      () => decryptToken("not an envelope", encryptionKey, oauthBinding),
    ].map((attempt) => {
      try {
        attempt();
        return null;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    });

    expect(failures).toEqual([decryptionFailure, decryptionFailure, decryptionFailure]);
  });

  it("requires a decoded 32-byte encryption key", () => {
    const tooShortKey = randomBytes(31).toString("base64url");

    expect(() => encryptToken("oauth-token-for-test", tooShortKey, oauthBinding)).toThrow(
      "Token encryption key must decode to exactly 32 bytes.",
    );
  });

  it("rejects a malformed previous key rather than ignoring it", () => {
    const encrypted = encryptToken("secret", encryptionKey, oauthBinding);

    expect(() => decryptToken(encrypted, { current: encryptionKey, previous: "not-a-key" }, oauthBinding)).toThrow(
      "Previous token encryption key must decode to exactly 32 bytes.",
    );
  });
});

describe("token key set loading", () => {
  it("reads the current key and treats an unset or empty previous key as none", () => {
    expect(loadTokenKeySet({ TOKEN_ENCRYPTION_KEY: encryptionKey })).toEqual({ current: encryptionKey });
    expect(loadTokenKeySet({ TOKEN_ENCRYPTION_KEY: encryptionKey, TOKEN_ENCRYPTION_KEY_PREVIOUS: "" }))
      .toEqual({ current: encryptionKey });
    expect(loadTokenKeySet({ TOKEN_ENCRYPTION_KEY: encryptionKey, TOKEN_ENCRYPTION_KEY_PREVIOUS: otherKey }))
      .toEqual({ current: encryptionKey, previous: otherKey });
  });

  it("refuses a missing current key", () => {
    expect(() => loadTokenKeySet({})).toThrow("Token encryption key must be configured.");
    expect(() => loadTokenKeySet({ TOKEN_ENCRYPTION_KEY: "" })).toThrow("Token encryption key must be configured.");
  });

  it("refuses a malformed current or previous key", () => {
    expect(() => loadTokenKeySet({ TOKEN_ENCRYPTION_KEY: "short" })).toThrow(
      "Token encryption key must decode to exactly 32 bytes.",
    );
    expect(() => loadTokenKeySet({ TOKEN_ENCRYPTION_KEY: encryptionKey, TOKEN_ENCRYPTION_KEY_PREVIOUS: "short" }))
      .toThrow("Previous token encryption key must decode to exactly 32 bytes.");
  });
});

describe("store key set construction", () => {
  it("applies the environment rules to a store's current and previous key parameters", () => {
    expect(tokenKeySetFrom(encryptionKey, undefined)).toEqual({ current: encryptionKey });
    expect(tokenKeySetFrom(encryptionKey, "")).toEqual({ current: encryptionKey });
    expect(tokenKeySetFrom(encryptionKey, otherKey)).toEqual({ current: encryptionKey, previous: otherKey });
    expect(() => tokenKeySetFrom(undefined, otherKey)).toThrow("Token encryption key must be configured.");
    expect(() => tokenKeySetFrom(encryptionKey, "short")).toThrow(
      "Previous token encryption key must decode to exactly 32 bytes.",
    );
  });
});

describe("current-envelope detection", () => {
  it("reports a v2 envelope under the current key as current", () => {
    expect(isEnvelopeCurrent(encryptToken("secret", encryptionKey, oauthBinding), encryptionKey)).toBe(true);
  });

  it("reports a v2 envelope under another key, and any v1 envelope, as not current", () => {
    expect(isEnvelopeCurrent(encryptToken("secret", otherKey, oauthBinding), encryptionKey)).toBe(false);
    expect(isEnvelopeCurrent(legacyV1Envelope, legacyV1Key)).toBe(false);
    expect(isEnvelopeCurrent("garbage", encryptionKey)).toBe(false);
  });

  it("reports an envelope with the current key id but the wrong number of parts as not current", () => {
    const current = encryptToken("secret", encryptionKey, oauthBinding);

    expect(isEnvelopeCurrent(`v2.${expectedKeyId(encryptionKey)}.x`, encryptionKey)).toBe(false);
    expect(isEnvelopeCurrent(`${current}.extra`, encryptionKey)).toBe(false);
  });
});
