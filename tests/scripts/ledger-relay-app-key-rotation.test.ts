import { createPublicKey, createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { mintAppJwt } from "../../scripts/ledger-relay.ts";

/**
 * Issue 1032's code half: the rotation procedure in deploy/README.md section
 * 14 relies on two facts, and both are pinned here against the real modules
 * rather than taken from GitHub's documentation.
 *
 * 1. Any CURRENT App key verifies, so a two-key overlap window is
 *    App-native: GitHub's verifier holds every public half the App has
 *    registered, and the JWTs the two scripts mint are ordinary RS256 JWTs
 *    whose signature verifies under whichever registered key minted them.
 *    The tests model that verifier with both public halves registered and
 *    prove a JWT minted by either generated key verifies, while one minted
 *    by an unregistered key does not — and that unregistering the old half
 *    is what stops the old key's JWTs (the deletion boundary that closes the
 *    rollback window).
 * 2. The relay's key-reading path pins no key identity or PEM shape, so
 *    no code change ships with the rotation: it signs with whatever
 *    key material it is handed, and a freshly generated key exercises the
 *    identical path. `mintAppJwt` is the relay's mint (the Actions-side
 *    secret copy).
 *
 * Every key in this file is generated at test time. Nothing here, or in the
 * procedure, touches the live key.
 */

const appId = "5118623";

function rsaPrivatePem(): string {
  return generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs8", format: "pem" })
    .toString();
}

function publicHalfOf(privatePem: string): string {
  return createPublicKey(privatePem).export({ type: "spki", format: "pem" }).toString();
}

/** GitHub's side of the story: a verifier holding exactly the registered public halves. */
function registeredVerifier(publicPems: string[]): (jwt: string) => boolean {
  return (jwt: string) => {
    const [header, payload, signature] = jwt.split(".");
    if (header === undefined || payload === undefined || signature === undefined) return false;
    const encoded = Buffer.from(signature, "base64url");
    return publicPems.some((pem) =>
      createVerify("RSA-SHA256").update(`${header}.${payload}`).verify(pem, encoded),
    );
  };
}

describe("mintAppJwt under the two-key overlap", () => {
  it("accepts a JWT minted by either of two registered keys — the overlap is App-native, not a code feature", () => {
    const oldKey = rsaPrivatePem();
    const newKey = rsaPrivatePem();
    const verifier = registeredVerifier([publicHalfOf(oldKey), publicHalfOf(newKey)]);
    expect(verifier(mintAppJwt(appId, oldKey, Date.now()))).toBe(true);
    expect(verifier(mintAppJwt(appId, newKey, Date.now()))).toBe(true);
  });

  it("rejects a JWT minted by an unregistered key", () => {
    const registeredKey = rsaPrivatePem();
    const strangerKey = rsaPrivatePem();
    const verifier = registeredVerifier([publicHalfOf(registeredKey)]);
    expect(verifier(mintAppJwt(appId, strangerKey, Date.now()))).toBe(false);
  });

  it("stops accepting the old key's JWTs once it is unregistered — the deletion boundary", () => {
    const oldKey = rsaPrivatePem();
    const newKey = rsaPrivatePem();
    const before = registeredVerifier([publicHalfOf(oldKey), publicHalfOf(newKey)]);
    expect(before(mintAppJwt(appId, oldKey, Date.now()))).toBe(true);
    const afterDeletion = registeredVerifier([publicHalfOf(newKey)]);
    expect(afterDeletion(mintAppJwt(appId, oldKey, Date.now()))).toBe(false);
    expect(afterDeletion(mintAppJwt(appId, newKey, Date.now()))).toBe(true);
  });

  it("carries the App — not the key — as the identity, so both keys mint for the same iss", () => {
    const payloadOf = (pem: string) =>
      JSON.parse(
        Buffer.from(mintAppJwt(appId, pem, 1_793_000_000_000).split(".")[1]!, "base64url").toString("utf8"),
      ) as Record<string, unknown>;
    expect(payloadOf(rsaPrivatePem())).toEqual(payloadOf(rsaPrivatePem()));
  });
});
