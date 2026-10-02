import { createHmac, timingSafeEqual } from "node:crypto";

// The `{64}` is the only place the digest length is enforced: widen it and a
// wrong-length payload throws a RangeError, while a 65-character one decodes to
// the same 32 bytes and is silently accepted.
const signaturePattern = /^sha256=([0-9a-f]{64})$/;

export function verifyGitHubWebhookSignature(
  rawBody: string | Buffer,
  signature: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (secret === undefined || secret.length === 0 || signature === undefined || signature === null) {
    return false;
  }

  const match = signaturePattern.exec(signature);
  if (match === null) {
    return false;
  }

  const expected = createHmac("sha256", secret).update(rawBody).digest();
  const supplied = Buffer.from(match[1], "hex");

  return timingSafeEqual(expected, supplied);
}
