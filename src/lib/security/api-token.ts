import { createHash, randomBytes } from "node:crypto";

/**
 * Overflow issues these tokens itself; they are not GitHub credentials and mean
 * nothing outside this product.
 *
 * The digest is an unsalted SHA-256 because the token is 32 bytes of CSPRNG
 * output rather than a human-chosen password: there is no low-entropy guess to
 * slow down, a per-request key-derivation function would only be a denial-of-
 * service surface, and lookup is by hash, so a salt could not be applied before
 * the row is found.
 *
 * The plaintext token exists only in the response that mints it. Nothing here
 * logs it, stores it, or puts it in an error.
 */

export const apiTokenPrefix = "ovf_";

const apiTokenSecretBytes = 32;
const apiTokenPattern = /^ovf_[A-Za-z0-9_-]{43}$/;
const bearerCredentialPattern = /^bearer +(\S+)$/i;

export function mintApiToken(): { token: string; tokenHash: Buffer } {
  const token = `${apiTokenPrefix}${randomBytes(apiTokenSecretBytes).toString("base64url")}`;

  return { token, tokenHash: digestApiToken(token) };
}

export function hashApiToken(token: string): Buffer | null {
  if (!apiTokenPattern.test(token)) {
    return null;
  }

  return digestApiToken(token);
}

export function readApiTokenCredential(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (header === null) {
    return null;
  }

  return bearerCredentialPattern.exec(header)?.[1] ?? null;
}

function digestApiToken(token: string): Buffer {
  return createHash("sha256").update(token, "utf8").digest();
}
