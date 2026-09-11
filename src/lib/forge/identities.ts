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

/** The scopes that satisfy every read the reconciliation makes; `api` implies `read_api`. */
const acceptedScopes = new Set(["api", "read_api"]);

const transportRefusal = () =>
  new ForgeIdentityError(
    "UNVERIFIED",
    "The instance could not be reached to verify the token. Check the URL and try again.",
  );

const upstreamShapeFailure = (missing: "identity fields" | "scope answer") =>
  new ForgeIdentityError(
    "UPSTREAM_FAILURE",
    `The instance answered without the ${missing} a link needs.`,
  );

/**
 * The refusal for a token the instance accepts but which cannot make the
 * reconciliation reads. It names the scope the member has to tick when
 * minting the token and, when the instance reported them, the scopes the
 * submitted token actually carries.
 */
function scopeRefusal(carried?: string[]): ForgeIdentityError {
  const carriedClause = carried === undefined
    ? ""
    : carried.length === 0
      ? " It carries no scopes."
      : ` It carries only: ${carried.join(", ")}.`;
  return new ForgeIdentityError(
    "UNVERIFIED",
    `The token does not carry the read_api scope, so no identity was linked.${carriedClause} Create the token with the read_api scope (or api) and try again.`,
  );
}

type UpstreamAnswer = { status: number; bodyText: string };

async function readUpstream(
  fetchImplementation: typeof fetch,
  url: string,
  token: string,
  signal: AbortSignal,
): Promise<UpstreamAnswer> {
  try {
    const response = await fetchImplementation(url, {
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    return { status: response.status, bodyText: await response.text() };
  } catch {
    // A transport failure — timeout or unreachable host — is a verification
    // failure: nothing is stored, and no upstream detail escapes.
    throw transportRefusal();
  }
}

function parseJsonObject(bodyText: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return null;
  }
  return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/**
 * Verifies that the token can make the reads the reconciliation needs, which
 * `/api/v4/user` answering 200 does not establish: GitLab serves that endpoint
 * to a `read_user`-only token, and such a token then fails every note,
 * label-event, discussion and search read (401 without `read_api`).
 *
 * The token's own record, `GET /api/v4/personal_access_tokens/self`, lists its
 * scopes and is served to a token of any scope (GitLab 16.0+). When the
 * instance cannot describe the token that way — 404 on an older instance, 400
 * for a token type the endpoint does not cover — one scope-gated read decides
 * instead: `GET /api/v4/projects?membership=true&per_page=1` answers 200 with
 * the scope and 401/403 without it.
 */
async function verifyReadApiScope(
  fetchImplementation: typeof fetch,
  instanceUrl: string,
  token: string,
  signal: AbortSignal,
): Promise<void> {
  const self = await readUpstream(
    fetchImplementation,
    `${instanceUrl}/api/v4/personal_access_tokens/self`,
    token,
    signal,
  );
  if (self.status === 200) {
    const scopes = parseJsonObject(self.bodyText)?.scopes;
    if (!Array.isArray(scopes)) {
      throw upstreamShapeFailure("scope answer");
    }
    const carried = scopes.filter((scope): scope is string => typeof scope === "string");
    if (carried.some((scope) => acceptedScopes.has(scope))) {
      return;
    }
    throw scopeRefusal(carried);
  }
  const probe = await readUpstream(
    fetchImplementation,
    `${instanceUrl}/api/v4/projects?membership=true&per_page=1`,
    token,
    signal,
  );
  if (probe.status === 200) {
    return;
  }
  if (probe.status === 401 || probe.status === 403) {
    throw scopeRefusal();
  }
  throw upstreamShapeFailure("scope answer");
}

/**
 * Links a forge identity to a user by verifying the token live, all within one
 * timeout: a GET to the instance's `/api/v4/user` with the token must answer
 * 200, and the token must then prove it carries `read_api` (or `api`) —
 * see `verifyReadApiScope` — before anything is stored. The stored token is
 * the cipher envelope, never the PAT; the row is keyed on the exact triple so
 * the same forge identity on a different instance is a different identity.
 */
export async function linkForgeIdentity(
  dependencies: LinkForgeIdentityDependencies,
  input: { userId: string; instanceUrl: string; token: string },
): Promise<ForgeIdentityView> {
  const instanceUrl = normalizeInstanceUrl(input.instanceUrl);
  const fetchImplementation = dependencies.fetch ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), dependencies.timeoutMs ?? defaultTimeoutMs);
  let forgeUser: { id: number; username: string };
  try {
    const user = await readUpstream(fetchImplementation, `${instanceUrl}/api/v4/user`, input.token, controller.signal);
    if (user.status !== 200) {
      throw new ForgeIdentityError(
        "UNVERIFIED",
        "The instance did not accept the token, so no identity was linked. Check that the token is valid for that instance and carries the read_api scope.",
      );
    }
    const body = parseJsonObject(user.bodyText);
    const id = body?.id;
    const username = body?.username;
    if (typeof id !== "number" || typeof username !== "string") {
      throw upstreamShapeFailure("identity fields");
    }
    forgeUser = { id, username };
    await verifyReadApiScope(fetchImplementation, instanceUrl, input.token, controller.signal);
  } finally {
    clearTimeout(timeout);
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
