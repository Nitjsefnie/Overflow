import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { classifyGitHubRateLimit, GitHubApiError } from "@/lib/github/errors";

/**
 * GitHub App installation authentication for the Node reconciliation path.
 *
 * Mints a per-lookup RS256 JWT from the App's private key, resolves a
 * repository's installation, and caches that installation's short-lived
 * access token until shortly before it expires. Imported only from the Node
 * reconciliation wiring (instrumentation-node, scripts/reconcile, the fold's
 * sponsor gateway) — never from the page/Edge tree or `client.ts`.
 */

export type GitHubAppAuthConfig = { appId: string; privateKey: string };

export type AppInstallationToken = { token: string; installationId: number };

/**
 * Null means "no App installation for this repository" — the caller falls
 * back to the sponsor's OAuth token. Any other failure throws (fail-closed,
 * the GitLab credential precedent): the run fails and its retry semantics
 * apply. Fallback on anything but the definitive 404 would keep starving the
 * user budget the App exists to protect.
 */
export type AppInstallationTokenResolver =
  (ownerName: string) => Promise<AppInstallationToken | null>;

const defaultApiUrl = "https://api.github.com";
const githubApiVersion = "2022-11-28";
/** GitHub tolerates a small skew; mint with a minute of slack on both ends. */
const jwtIssuedAtSlackSeconds = 60;
const jwtLifetimeSeconds = 120;
/** Refresh before expiry so in-flight folds never read a token near death. */
const tokenRefreshMarginMs = 300_000;

/**
 * The permissions every minted installation token carries: exactly the reads
 * reconciliation makes, and nothing more. The fold reads repository metadata
 * (`GET /repositories/:id` and every GraphQL `repository(...)` traversal),
 * issues with labels, timelines and their REST event/comment manifests, and
 * pull requests (closing references, reviews, dismissals, the raw diff). A
 * token leak can therefore read those surfaces and nothing else — no write,
 * no administration. Omitting `permissions` from the mint request would grant
 * the token the App's FULL permission set instead; these three name the floor
 * reconciliation actually stands on. Tokens are short-lived on top.
 */
const installationTokenPermissions = {
  metadata: "read",
  issues: "read",
  pull_requests: "read",
} as const;

/**
 * The two environment variables this module reads, spelled structurally so
 * `process.env`, any subset of it, and bare test literals are all assignable.
 * `Pick`ing the keys off `NodeJS.ProcessEnv` would make both required, Next's
 * `ProcessEnv` augmentation requires `NODE_ENV` (so a `ProcessEnv` parameter
 * rejects test literals), and an all-optional target fails the weak-type
 * check against `ProcessEnv` — hence the index signature.
 */
type GitHubAppAuthEnv = {
  readonly [key: string]: string | undefined;
  readonly GITHUB_APP_ID?: string | undefined;
  readonly GITHUB_APP_PRIVATE_KEY_PATH?: string | undefined;
};

/**
 * The App credentials from the environment, or null when unconfigured — the
 * OAuth-fallback posture. Either var unset or empty is unconfigured. A
 * configured but unreadable key file throws: fail-closed at wiring time, not
 * first-run time.
 */
export function readGitHubAppAuthConfig(
  env: GitHubAppAuthEnv,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): GitHubAppAuthConfig | null {
  const appId = env.GITHUB_APP_ID;
  const keyPath = env.GITHUB_APP_PRIVATE_KEY_PATH;
  if (appId === undefined || appId.length === 0 || keyPath === undefined || keyPath.length === 0) {
    return null;
  }
  return { appId, privateKey: readFile(keyPath) };
}

export function createAppInstallationTokenResolver(options: {
  config: GitHubAppAuthConfig;
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Reserved for wiring-site diagnostics; today the resolver emits nothing. */
  logger?: (message: string) => void;
}): AppInstallationTokenResolver {
  const config = options.config;
  const apiUrl = (options.apiUrl ?? defaultApiUrl).replace(/\/$/, "");
  const fetchImplementation = options.fetch ?? fetch;
  const clock = options.now ?? ((): Date => new Date());
  const tokenCache = new Map<number, { token: string; expiresAt: number }>();
  const mintsInFlight = new Map<number, Promise<AppInstallationToken>>();

  return async (ownerName) => {
    const [owner, repo] = parseOwnerName(ownerName);
    return resolveInstallationToken(owner, repo);
  };

  async function resolveInstallationToken(owner: string, repo: string): Promise<AppInstallationToken | null> {
    const jwt = mintJwt(clock());
    const installationId = await lookupInstallationId(owner, repo, jwt);
    if (installationId === null) {
      return null;
    }
    return cachedOrMintedToken(installationId, jwt);
  }

  async function cachedOrMintedToken(installationId: number, jwt: string): Promise<AppInstallationToken> {
    const cached = tokenCache.get(installationId);
    if (cached !== undefined && clock().getTime() < cached.expiresAt - tokenRefreshMarginMs) {
      return { token: cached.token, installationId };
    }
    const inFlight = mintsInFlight.get(installationId);
    if (inFlight !== undefined) {
      return inFlight;
    }
    const mint = mintToken(installationId, jwt)
      .then(({ token, expiresAt }) => {
        tokenCache.set(installationId, { token, expiresAt });
        return { token, installationId };
      })
      .finally(() => {
        mintsInFlight.delete(installationId);
      });
    mintsInFlight.set(installationId, mint);
    return mint;
  }

  async function lookupInstallationId(owner: string, repo: string, jwt: string): Promise<number | null> {
    const { status, headers, body } = await fetchWithJwt(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      "GET",
      jwt,
      undefined,
    );
    if (status === 404) {
      return null;
    }
    if (status !== 200) {
      throw classifiedError(status, headers, body);
    }
    const id = parseJsonPayload(body)?.["id"];
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error("GitHub App installation lookup response was invalid.");
    }
    return id;
  }

  async function mintToken(
    installationId: number,
    jwt: string,
  ): Promise<{ token: string; expiresAt: number }> {
    const { status, headers, body } = await fetchWithJwt(
      `/app/installations/${installationId}/access_tokens`,
      "POST",
      jwt,
      // An omitted body would mint the token with the App's FULL permission
      // grant; reconciliation only reads, so it names the read set instead.
      JSON.stringify({ permissions: installationTokenPermissions }),
    );
    if (status !== 201) {
      throw classifiedError(status, headers, body);
    }
    const payload = parseJsonPayload(body);
    const token = payload?.["token"];
    const expiresAt = parseIsoInstantMs(payload?.["expires_at"]);
    if (typeof token !== "string" || token.length === 0 || expiresAt === null) {
      throw new Error("GitHub App installation token response was invalid.");
    }
    return { token, expiresAt };
  }

  async function fetchWithJwt(
    path: string,
    method: "GET" | "POST",
    jwt: string,
    requestBody: string | undefined,
  ): Promise<{ status: number; headers: Headers; body: string | null }> {
    let response: Response;
    try {
      response = await fetchImplementation(`${apiUrl}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "X-GitHub-Api-Version": githubApiVersion,
          ...(method === "POST" ? { "Content-Type": "application/json" } : {}),
        },
        ...(method === "POST" ? { body: requestBody } : {}),
      });
    } catch (cause) {
      throw new Error(`GitHub App request failed: ${path}`, { cause });
    }
    if (response.ok) {
      return { status: response.status, headers: response.headers, body: await response.text() };
    }
    const body = await response.text().catch(() => null);
    return { status: response.status, headers: response.headers, body };
  }

  function classifiedError(status: number, headers: Headers, body: string | null): GitHubApiError {
    const { rateLimited, retryAfterSeconds } = classifyGitHubRateLimit(status, headers, body);
    return new GitHubApiError(status, rateLimited, retryAfterSeconds, body);
  }

  function mintJwt(at: Date): string {
    const issuedAtSeconds = Math.floor(at.getTime() / 1000);
    const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({
      iat: issuedAtSeconds - jwtIssuedAtSlackSeconds,
      exp: issuedAtSeconds + jwtLifetimeSeconds,
      iss: config.appId,
    })).toString("base64url");
    const signingInput = `${header}.${payload}`;
    const signature = createSign("RSA-SHA256").update(signingInput).sign(config.privateKey);
    return `${signingInput}.${signature.toString("base64url")}`;
  }
}

/** Production glue: null when unconfigured; throws on an unreadable key file. */
export function appInstallationTokenResolverFromEnv(
  env: GitHubAppAuthEnv,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): AppInstallationTokenResolver | null {
  const config = readGitHubAppAuthConfig(env, readFile);
  return config === null ? null : createAppInstallationTokenResolver({ config });
}

/**
 * The stored full name (`owner/repo`); both segments non-empty, exactly two.
 * Checked before any network call: a malformed name is a caller bug, not an
 * upstream condition.
 */
function parseOwnerName(ownerName: string): [owner: string, repo: string] {
  const segments = ownerName.split("/");
  if (segments.length !== 2 || segments[0]!.length === 0 || segments[1]!.length === 0) {
    throw new Error(
      `GitHub App installation lookup requires an owner/repo full name, received ${JSON.stringify(ownerName)}.`,
    );
  }
  return [segments[0]!, segments[1]!];
}

function parseJsonPayload(body: string | null): Record<string, unknown> | null {
  if (body === null) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Strict ISO 8601 instant (date, time, optional fraction, Z or offset); null otherwise. */
function parseIsoInstantMs(value: unknown): number | null {
  if (typeof value !== "string"
    || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}
