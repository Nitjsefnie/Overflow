import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * The cipher for every credential stored at rest: GitHub OAuth tokens, forge
 * personal access tokens and webhook secrets.
 *
 * New code writes `v2.<kid>.<iv>.<tag>.<ct>`, AES-256-GCM, every part
 * base64url. `<kid>` identifies the key that sealed the envelope so a rotated
 * deployment can pick the right one of {current, previous}, and the envelope is
 * bound through associated data to the column and the natural key of the row
 * it lives in, so ciphertext copied into another row or column fails to open.
 *
 * `v1.<iv>.<tag>.<ct>` (no key id, no associated data) was the legacy shape; it
 * is no longer read anywhere, so a v1 envelope fails closed like any invalid
 * envelope, and it is never written.
 */

const algorithm = "aes-256-gcm";
const envelopeVersion = "v2";
const initializationVectorLength = 12;
const authenticationTagLength = 16;
const keyIdLength = 8;
const keyIdDomain = Buffer.from("overflow-token-key-id:v2:", "utf8");
const bindingDomain = "overflow-credential";
const decryptionFailure = "Unable to decrypt stored credential.";
const currentKeyFailure = "Token encryption key must decode to exactly 32 bytes.";
const previousKeyFailure = "Previous token encryption key must decode to exactly 32 bytes.";

/** `current` encrypts and decrypts; `previous` only decrypts. */
export type TokenKeySet = { current: string; previous?: string };

declare const credentialBindingBrand: unique symbol;

/**
 * The row a stored credential belongs to. Only the constructors in
 * `credentialBinding` produce one, so no caller composes table or column
 * names itself.
 */
export type CredentialBinding = {
  readonly associatedData: Buffer;
  readonly [credentialBindingBrand]: true;
};

type IntegerId = number | string | bigint;

function bind(table: string, column: string, rowKey: readonly string[]): CredentialBinding {
  return {
    associatedData: Buffer.from(JSON.stringify([bindingDomain, table, column, ...rowKey]), "utf8"),
  } as CredentialBinding;
}

/** Each binding is the row's natural unique key, known before the row's surrogate id exists. */
export const credentialBinding = {
  userOAuthToken(githubUserId: IntegerId): CredentialBinding {
    return bind("users", "encrypted_oauth_token", [String(githubUserId)]);
  },
  /** `instanceUrl` is the normalized form, exactly as stored. */
  forgeToken(identity: { provider: string; instanceUrl: string; forgeUserId: IntegerId }): CredentialBinding {
    return bind("user_forge_identities", "encrypted_token", [
      identity.provider,
      identity.instanceUrl,
      String(identity.forgeUserId),
    ]);
  },
  /** The id is a Postgres uuid, which reads back lowercase, so it binds lowercase. */
  webhookSecret(webhookCredentialId: string): CredentialBinding {
    return bind("registered_repositories", "encrypted_webhook_secret", [webhookCredentialId.toLowerCase()]);
  },
} as const;

/**
 * Reads the key set from an environment-like object. An unset or empty
 * previous key means none; a set but malformed one is an error.
 */
export function loadTokenKeySet(env: Readonly<Record<string, string | undefined>>): TokenKeySet {
  const current = env.TOKEN_ENCRYPTION_KEY;
  if (current === undefined || current.length === 0) {
    throw new Error("Token encryption key must be configured.");
  }
  decodeKey(current, currentKeyFailure);
  const previous = env.TOKEN_ENCRYPTION_KEY_PREVIOUS;
  if (previous === undefined || previous.length === 0) {
    return { current };
  }
  decodeKey(previous, previousKeyFailure);
  return { current, previous };
}

/** The key set a store holds as its current and previous key parameters, read like the environment. */
export function tokenKeySetFrom(current: string | undefined, previous: string | undefined): TokenKeySet {
  return loadTokenKeySet({ TOKEN_ENCRYPTION_KEY: current, TOKEN_ENCRYPTION_KEY_PREVIOUS: previous });
}

export function encryptToken(plaintext: string, currentKey: string, binding: CredentialBinding): string {
  const key = decodeKey(currentKey, currentKeyFailure);
  const initializationVector = randomBytes(initializationVectorLength);
  const cipher = createCipheriv(algorithm, key, initializationVector, {
    authTagLength: authenticationTagLength,
  });
  cipher.setAAD(binding.associatedData);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authenticationTag = cipher.getAuthTag();

  return [
    envelopeVersion,
    keyIdOf(key),
    initializationVector.toString("base64url"),
    authenticationTag.toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(".");
}

export function decryptToken(envelope: string, keys: string | TokenKeySet, binding: CredentialBinding): string {
  const keySet = typeof keys === "string" ? { current: keys } : keys;
  const candidates = [decodeKey(keySet.current, currentKeyFailure)];
  if (keySet.previous !== undefined) {
    candidates.push(decodeKey(keySet.previous, previousKeyFailure));
  }

  try {
    const [version, ...parts] = envelope.split(".");
    if (version === envelopeVersion && parts.length === 4) {
      const [encodedKeyId, ...sealed] = parts as [string, string, string, string];
      const key = candidates.find((candidate) => keyIdOf(candidate) === encodedKeyId);
      if (key === undefined) {
        throw new Error("Unknown key id.");
      }
      return open(key, sealed, binding.associatedData);
    }
    throw new Error("Invalid envelope.");
  } catch {
    throw new Error(decryptionFailure);
  }
}

/**
 * Whether the envelope is already v2 under the given current key, so a
 * re-encryption pass can leave it alone. Structural only: it does not open the
 * envelope.
 */
export function isEnvelopeCurrent(envelope: string, currentKey: string): boolean {
  const parts = envelope.split(".");
  return parts.length === 5 && parts[0] === envelopeVersion
    && parts[1] === keyIdOf(decodeKey(currentKey, currentKeyFailure));
}

function open(
  key: Buffer,
  [encodedInitializationVector, encodedAuthenticationTag, encodedCiphertext]: readonly [string, string, string],
  associatedData: Buffer,
): string {
  const initializationVector = decodeBase64url(encodedInitializationVector);
  const authenticationTag = decodeBase64url(encodedAuthenticationTag);
  const ciphertext = decodeBase64url(encodedCiphertext);
  if (
    initializationVector.length !== initializationVectorLength ||
    authenticationTag.length !== authenticationTagLength
  ) {
    throw new Error("Invalid envelope.");
  }

  const decipher = createDecipheriv(algorithm, key, initializationVector, {
    authTagLength: authenticationTagLength,
  });
  decipher.setAAD(associatedData);
  decipher.setAuthTag(authenticationTag);

  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}

function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(keyIdDomain).update(key).digest().subarray(0, keyIdLength).toString("base64url");
}

function decodeKey(encodedKey: string, failure: string): Buffer {
  let key: Buffer;
  try {
    key = decodeBase64url(encodedKey);
  } catch {
    throw new Error(failure);
  }

  if (key.length !== 32) {
    throw new Error(failure);
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
