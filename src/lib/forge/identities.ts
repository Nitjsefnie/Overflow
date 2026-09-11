import { encryptToken } from "@/lib/security/token-cipher";

export type ForgeIdentityView = {
  id: string;
  provider: string;
  instanceUrl: string;
  forgeLogin: string;
  verifiedAt: string;
};

export class ForgeIdentityError extends Error {
  public constructor(
    public readonly code: "INVALID_INPUT" | "UNVERIFIED" | "NOT_FOUND" | "FORBIDDEN" | "UPSTREAM_FAILURE",
    message: string,
  ) {
    super(message);
    this.name = "ForgeIdentityError";
  }
}

/**
 * The instance URL is stored normalized — lowercase scheme and host, no path,
 * no trailing slash — so the identity triple compares instances exactly, and
 * gitlab.com and a self-hosted instance can never alias. The normalization is
 * the flow's normalization: the 040/038 CHECK is a typo guard, and the gate
 * that makes a URL storable is this function.
 */
export function normalizeInstanceUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ForgeIdentityError("INVALID_INPUT", "The instance URL must be an absolute URL.");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new ForgeIdentityError("INVALID_INPUT", "The instance URL must use http or https.");
  }
  if (parsed.hostname === "") {
    throw new ForgeIdentityError("INVALID_INPUT", "The instance URL must name a host.");
  }
  return `${parsed.protocol}//${parsed.host}`.toLowerCase();
}

/**
 * Storage for linked forge identities. The upsert is conditional on the
 * triple's existing row belonging to the same user: a re-link by its owner
 * refreshes login, token and verification instant, while the same forge
 * identity held by a different account inserts nothing — the caller reads
 * that refusal.
 */
export interface ForgeIdentityStore {
  listForUser(userId: string): Promise<ForgeIdentityView[]>;
  upsertIdentity(input: {
    userId: string;
    provider: string;
    instanceUrl: string;
    forgeUserId: number;
    forgeLogin: string;
    encryptedToken: string;
  }): Promise<ForgeIdentityView | null>;
  deleteForUser(input: { identityId: string; userId: string }): Promise<boolean>;
}

export type LinkForgeIdentityDependencies = {
  store: ForgeIdentityStore;
  tokenEncryptionKey: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  /**
   * Claims the past GitLab work the newly verified identity owns (contract
   * decision 3's retroactivity): invoked after the identity is stored, with
   * the verified triple. Wired to the fold store's claim in production;
   * a failure propagates — the identity stays linked and a re-link retries
   * the claim.
   */
  claimPastWork?: (input: { userId: string; instanceUrl: string; forgeUserId: number }) => Promise<void>;
};

const defaultTimeoutMs = 10_000;

/**
 * Links a forge identity to a user by verifying the token live: a GET to the
 * instance's `/api/v4/user` with the token must answer 200 before anything is
 * stored. The stored token is the cipher envelope, never the PAT; the row is
 * keyed on the exact triple so the same forge identity on a different
 * instance is a different identity.
 */
export async function linkForgeIdentity(
  dependencies: LinkForgeIdentityDependencies,
  input: { userId: string; instanceUrl: string; token: string },
): Promise<ForgeIdentityView> {
  const instanceUrl = normalizeInstanceUrl(input.instanceUrl);
  const fetchImplementation = dependencies.fetch ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? defaultTimeoutMs);
  let status: number;
  let bodyText: string;
  try {
    const response = await fetchImplementation(`${instanceUrl}/api/v4/user`, {
      headers: { authorization: `Bearer ${input.token}` },
      signal: controller.signal,
    });
    status = response.status;
    bodyText = await response.text();
  } catch {
    // A transport failure — timeout or unreachable host — is a verification
    // failure: nothing is stored, and no upstream detail escapes.
    throw new ForgeIdentityError(
      "UNVERIFIED",
      "The instance could not be reached to verify the token. Check the URL and try again.",
    );
  } finally {
    clearTimeout(timeout);
  }
  if (status !== 200) {
    throw new ForgeIdentityError(
      "UNVERIFIED",
      "The instance did not accept the token, so no identity was linked. Check that the token is valid for that instance and carries the read_api scope.",
    );
  }
  const forgeUser = JSON.parse(bodyText) as { id?: unknown; username?: unknown };
  if (typeof forgeUser.id !== "number" || typeof forgeUser.username !== "string") {
    throw new ForgeIdentityError(
      "UPSTREAM_FAILURE",
      "The instance answered without the identity fields a link needs.",
    );
  }

  const encryptedToken = encryptToken(input.token, dependencies.tokenEncryptionKey);
  const identity = await dependencies.store.upsertIdentity({
    userId: input.userId,
    provider: "gitlab",
    instanceUrl,
    forgeUserId: forgeUser.id,
    forgeLogin: forgeUser.username,
    encryptedToken,
  });
  if (identity === null) {
    throw new ForgeIdentityError(
      "FORBIDDEN",
      "That forge identity is already linked to another account.",
    );
  }
  // Retroactivity (contract decision 3): the verified claim reaches back to
  // the UNCLAIMED GitLab settlements this triple already owns. The identity
  // stands either way; a claim failure surfaces and the next re-link retries.
  if (dependencies.claimPastWork !== undefined) {
    await dependencies.claimPastWork({
      userId: input.userId,
      instanceUrl,
      forgeUserId: forgeUser.id,
    });
  }
  return identity;
}

export async function listForgeIdentities(
  store: ForgeIdentityStore,
  userId: string,
): Promise<ForgeIdentityView[]> {
  return store.listForUser(userId);
}

/**
 * Unlinks by identity id, owner-checked at the query: the statement only
 * touches a row that is both the named identity and the caller's, so a
 * foreign id is indistinguishable from an absent one.
 */
export async function unlinkForgeIdentity(
  store: ForgeIdentityStore,
  input: { userId: string; identityId: string },
): Promise<boolean> {
  return store.deleteForUser(input);
}
