import { createHmac, timingSafeEqual } from "node:crypto";
import { readEnv } from "@/lib/env";
import { derivePurposeKey, tokenKeySetFrom } from "@/lib/security/token-cipher";

const UNSUBSCRIBE_KEY_LABEL = "overflow:work-mail-unsubscribe";
const SUBSCRIPTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SIGNATURE = /^[A-Za-z0-9_-]{43}$/;

function signature(key: string, subscriptionId: string): Buffer {
  const mac = createHmac("sha256", derivePurposeKey(key, UNSUBSCRIBE_KEY_LABEL)).update(`unsubscribe:${subscriptionId}`, "utf8");
  return Buffer.from(mac.digest("base64url"), "ascii");
}

/** The one-click opt-out token: `<subscription id>.<signature>` under the current key. */
export function mintUnsubscribeToken(
  subscriptionId: string, currentKey: string | undefined = readEnv("TOKEN_ENCRYPTION_KEY"),
): string {
  const keys = tokenKeySetFrom(currentKey, undefined);
  return `${subscriptionId}.${signature(keys.current, subscriptionId).toString("ascii")}`;
}

/** The subscription id a token names, or null; a token signed under the previous key still verifies. */
export function verifyUnsubscribeToken(
  token: string,
  currentKey: string | undefined = readEnv("TOKEN_ENCRYPTION_KEY"),
  previousKey: string | undefined = readEnv("TOKEN_ENCRYPTION_KEY_PREVIOUS"),
): string | null {
  const keys = tokenKeySetFrom(currentKey, previousKey);
  const parts = token.split(".");
  if (parts.length !== 2 || !SUBSCRIPTION_ID.test(parts[0]!) || !SIGNATURE.test(parts[1]!)) return null;
  const [subscriptionId, presented] = [parts[0]!, Buffer.from(parts[1]!, "ascii")];
  // Shape-checked, then compared encoded: no lenient decode or low-byte alias passes.
  const matches = [keys.current, ...(keys.previous === undefined ? [] : [keys.previous])].some((key) => {
    const expected = signature(key, subscriptionId);
    return presented.length === expected.length && timingSafeEqual(presented, expected);
  });
  return matches ? subscriptionId : null;
}
