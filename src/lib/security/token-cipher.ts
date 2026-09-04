import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const algorithm = "aes-256-gcm";
const envelopeVersion = "v1";
const initializationVectorLength = 12;
const authenticationTagLength = 16;

export function encryptToken(token: string, encodedKey: string): string {
  const key = decodeKey(encodedKey);
  const initializationVector = randomBytes(initializationVectorLength);
  const cipher = createCipheriv(algorithm, key, initializationVector, {
    authTagLength: authenticationTagLength,
  });
  const ciphertext = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();

  return [
    envelopeVersion,
    initializationVector.toString("base64url"),
    authenticationTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptToken(envelope: string, encodedKey: string): string {
  const key = decodeKey(encodedKey);

  try {
    const [version, encodedInitializationVector, encodedAuthenticationTag, encodedCiphertext, ...extra] =
      envelope.split(".");
    if (
      version !== envelopeVersion ||
      encodedInitializationVector === undefined ||
      encodedAuthenticationTag === undefined ||
      encodedCiphertext === undefined ||
      extra.length > 0
    ) {
      throw new Error("Invalid token envelope.");
    }

    const initializationVector = decodeBase64url(encodedInitializationVector);
    const authenticationTag = decodeBase64url(encodedAuthenticationTag);
    const ciphertext = decodeBase64url(encodedCiphertext);
    if (
      initializationVector.length !== initializationVectorLength ||
      authenticationTag.length !== authenticationTagLength
    ) {
      throw new Error("Invalid token envelope.");
    }

    const decipher = createDecipheriv(algorithm, key, initializationVector, {
      authTagLength: authenticationTagLength,
    });
    decipher.setAuthTag(authenticationTag);

    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("Unable to decrypt GitHub token.");
  }
}

function decodeKey(encodedKey: string): Buffer {
  let key: Buffer;
  try {
    key = decodeBase64url(encodedKey);
  } catch {
    throw new Error("Token encryption key must decode to exactly 32 bytes.");
  }

  if (key.length !== 32) {
    throw new Error("Token encryption key must decode to exactly 32 bytes.");
  }

  return key;
}

function decodeBase64url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("Invalid base64url value.");
  }

  const decoded = Buffer.from(value, "base64url");
  if (decoded.toString("base64url") !== value) {
    throw new Error("Invalid base64url value.");
  }

  return decoded;
}
