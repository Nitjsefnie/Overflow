import { createHmac, timingSafeEqual } from "node:crypto";

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
  if (supplied.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(expected, supplied);
}
