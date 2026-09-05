import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  apiTokenPrefix,
  hashApiToken,
  mintApiToken,
  readApiTokenCredential,
} from "@/lib/security/api-token";

describe("Overflow API token minting", () => {
  it("encodes 32 random bytes as exactly 43 unpadded base64url characters", () => {
    const encoded = randomBytes(32).toString("base64url");

    expect(encoded).toHaveLength(43);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("mints a token that is the prefix followed by 43 base64url characters", () => {
    const { token } = mintApiToken();

    expect(apiTokenPrefix).toBe("ovf_");
    expect(token).toMatch(/^ovf_[A-Za-z0-9_-]{43}$/);
  });

  it("mints a different token on every call", () => {
    const first = mintApiToken();
    const second = mintApiToken();

    expect(first.token).not.toBe(second.token);
  });
});

describe("Overflow API token hashing", () => {
  it("hashes a minted token to the same 32-byte digest the mint returned", () => {
    const { token, tokenHash } = mintApiToken();

    expect(tokenHash).toHaveLength(32);
    expect(hashApiToken(token)).toEqual(tokenHash);
  });

  it("hashes the whole token string, prefix included", () => {
    const { token, tokenHash } = mintApiToken();
    const wholeTokenDigest = createHash("sha256").update(token, "utf8").digest();
    const secretOnlyDigest = createHash("sha256")
      .update(token.slice(apiTokenPrefix.length), "utf8")
      .digest();

    expect(tokenHash.equals(wholeTokenDigest)).toBe(true);
    expect(tokenHash.equals(secretOnlyDigest)).toBe(false);
    expect(hashApiToken(token)).toEqual(wholeTokenDigest);
  });

  it("gives distinct tokens distinct hashes", () => {
    const first = mintApiToken();
    const second = mintApiToken();

    expect(first.tokenHash.equals(second.tokenHash)).toBe(false);
  });

  it.each([
    ["an empty string", ""],
    ["the prefix alone", apiTokenPrefix],
    ["a token with the prefix stripped", "a".repeat(43)],
    ["a token with the wrong prefix", `ovf-${"a".repeat(43)}`],
    ["a token with an uppercase prefix", `OVF_${"a".repeat(43)}`],
    ["a token with another product's prefix", `tok_${"a".repeat(43)}`],
    ["a token one character short", `${apiTokenPrefix}${"a".repeat(42)}`],
    ["a token one character long", `${apiTokenPrefix}${"a".repeat(44)}`],
    ["a token containing a plus sign", `${apiTokenPrefix}+${"a".repeat(42)}`],
    ["a token containing a slash", `${apiTokenPrefix}/${"a".repeat(42)}`],
    ["a token containing base64 padding", `${apiTokenPrefix}=${"a".repeat(42)}`],
    ["a token with trailing whitespace", `${apiTokenPrefix}${"a".repeat(43)} `],
    ["a token with a trailing newline", `${apiTokenPrefix}${"a".repeat(43)}\n`],
    ["a token with leading whitespace", ` ${apiTokenPrefix}${"a".repeat(43)}`],
  ])("returns null for %s", (_description, candidate) => {
    expect(hashApiToken(candidate)).toBeNull();
  });
});

function requestWithAuthorization(headerValue: string | null): Request {
  const headers = new Headers();
  if (headerValue !== null) {
    headers.set("authorization", headerValue);
  }

  return new Request("https://overflow.test/api/repositories", { headers });
}

describe("Overflow API token credential reading", () => {
  it.each([
    ["a capitalised scheme", "Bearer ovf_x"],
    ["a lowercase scheme", "bearer ovf_x"],
    ["an uppercase scheme", "BEARER ovf_x"],
    ["several spaces after the scheme", "Bearer   ovf_x"],
    ["a trailing newline the Headers class strips before we see it", "Bearer ovf_x\n"],
  ])("reads the credential from %s", (_description, headerValue) => {
    expect(readApiTokenCredential(requestWithAuthorization(headerValue))).toBe("ovf_x");
  });

  it.each([
    ["an absent header", null],
    ["an empty header", ""],
    ["a whitespace-only header", " "],
    ["the basic scheme", "Basic ovf_x"],
    ["the token scheme", "token ovf_x"],
    ["a bare token with no scheme", "ovf_x"],
    ["a scheme with no token", "Bearer"],
    ["a scheme followed by only spaces", "Bearer   "],
    ["a scheme that merely starts with bearer", "Bearerish ovf_x"],
    ["a scheme concatenated with the token", "Bearerovf_x"],
    ["more than two whitespace-separated parts", "Bearer ovf_x extra"],
    ["a token containing a space", "Bearer ovf_ x"],
    ["a tab between scheme and token", "Bearer\tovf_x"],
  ])("returns null for %s", (_description, headerValue) => {
    expect(readApiTokenCredential(requestWithAuthorization(headerValue))).toBeNull();
  });
});
