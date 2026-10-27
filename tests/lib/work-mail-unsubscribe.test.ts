import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildDigestMessage } from "@/lib/accounts/work-mail-transport";
import { mintUnsubscribeToken, verifyUnsubscribeToken } from "@/lib/accounts/work-mail-unsubscribe";
import { derivePurposeKey } from "@/lib/security/token-cipher";

const key = () => randomBytes(32).toString("base64url");

describe("work-mail unsubscribe tokens", () => {
  it("is the subscription id and the base64url HMAC of its purpose-keyed unsubscribe message", () => {
    const current = key();
    const id = randomUUID();
    const expected = createHmac("sha256", derivePurposeKey(current, "overflow:work-mail-unsubscribe"))
      .update(`unsubscribe:${id}`, "utf8").digest("base64url");
    expect(mintUnsubscribeToken(id, current)).toBe(`${id}.${expected}`);
  });

  it("verifies to the id it names under the current key", () => {
    const current = key();
    const id = randomUUID();
    expect(verifyUnsubscribeToken(mintUnsubscribeToken(id, current), current, "")).toBe(id);
  });

  it("still verifies a token minted under the key that is now the previous one", () => {
    const old = key();
    const id = randomUUID();
    const token = mintUnsubscribeToken(id, old);
    expect(verifyUnsubscribeToken(token, key(), old)).toBe(id);
    expect(verifyUnsubscribeToken(token, key(), "")).toBeNull();
  });

  it("refuses a token naming another id, a forged or re-encoded signature, and malformed shapes", () => {
    const current = key();
    const id = randomUUID();
    const token = mintUnsubscribeToken(id, current);
    const [, mac] = token.split(".") as [string, string];
    const flipped = `${mac.slice(0, -2)}${mac.at(-2) === "A" ? "B" : "A"}${mac.at(-1)}`;
    // A code point whose low byte is the valid last character: a low-byte encoding reads it as that character.
    const alias = `${mac.slice(0, -1)}${String.fromCharCode(mac.charCodeAt(mac.length - 1) + 0x100)}`;
    const refused = [
      `${randomUUID()}.${mac}`,
      `${id}.${flipped}`,
      `${id}.${alias}`,
      `${id}.${mac}=`,
      `${id}.${mac}!`,
      `${id.toUpperCase()}.${mac}`,
      `${token}.extra`,
      id,
      `${id}.`,
      `not-a-uuid.${mac}`,
      "",
    ];
    for (const candidate of refused) {
      expect(verifyUnsubscribeToken(candidate, current, ""), candidate).toBeNull();
    }
    expect(verifyUnsubscribeToken(token, current, "")).toBe(id);
  });

  it("refuses to mint or verify without a configured token key", () => {
    expect(() => mintUnsubscribeToken(randomUUID(), "")).toThrow("Token encryption key must be configured.");
    expect(() => verifyUnsubscribeToken("x", "", "")).toThrow("Token encryption key must be configured.");
  });

  it("mints a token the digest message carries in its one-click unsubscribe header", () => {
    const token = mintUnsubscribeToken(randomUUID(), key());
    const message = buildDigestMessage({
      from: "work@mail.example.org", to: "ada@example.net", origin: "https://overflow.example", count: 1, unsubscribeToken: token,
    });
    expect(message.content).toContain(`List-Unsubscribe: <https://overflow.example/api/work-mail/unsubscribe?token=${token}>\r\n`);
  });
});
