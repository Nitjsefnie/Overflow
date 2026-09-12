import { timingSafeEqual } from "node:crypto";

/**
 * Each GitLab hook carries its own scoped secret as its `token` parameter,
 * and echoes it back on every delivery in the
 * `X-Gitlab-Token` header. The comparison is constant-time — the same shape
 * the GitHub HMAC check uses: a length mismatch answers false without the
 * comparison (which would throw), and equal-length buffers compare through
 * `timingSafeEqual`.
 */
export function verifyGitLabWebhookToken(
  token: string | null | undefined,
  secret: string | undefined,
): boolean {
  if (secret === undefined || secret.length === 0 || token === undefined || token === null) {
    return false;
  }

  const expected = Buffer.from(secret, "utf8");
  const supplied = Buffer.from(token, "utf8");
  if (supplied.length !== expected.length) {
    return false;
  }

  return timingSafeEqual(expected, supplied);
}
