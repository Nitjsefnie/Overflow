import { checkSweepRequestBudget } from "@/lib/fold/sweep-request-budget";
import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { classifyGitHubRateLimit, GitHubApiError } from "@/lib/github/errors";

/**
 * GitHub App installation authentication for registration lookups.
 *
 * Mints a per-lookup RS256 JWT from the App's private key and resolves a
 * repository's installation. Imported from Node wiring (the registration API
 * route) — never from the page/Edge tree or `client.ts`.
 */

export type GitHubAppAuthConfig = { appId: string; privateKey: string };

const defaultApiUrl = "https://api.github.com";
const githubApiVersion = "2022-11-28";
/** GitHub tolerates a small skew; mint with a minute of slack on both ends. */
const jwtIssuedAtSlackSeconds = 60;
const jwtLifetimeSeconds = 120;

/**
 * The environment variables this module reads, spelled structurally so
 * `process.env`, any subset of it, and bare test literals are all assignable.
 * `Pick`ing the keys off `NodeJS.ProcessEnv` would make both required, Next's
 * `ProcessEnv` augmentation requires `NODE_ENV` (so a `ProcessEnv` parameter
 * rejects test literals), and an all-optional target fails the weak-type
 * check against `ProcessEnv` — hence the index signature.
 */
type GitHubAppAuthEnv = {
  readonly [key: string]: string | undefined;
  readonly GITHUB_REGISTRATION_APP_ID?: string | undefined;
  readonly GITHUB_REGISTRATION_APP_PRIVATE_KEY_PATH?: string | undefined;
};

/** Separate registration App identity; never falls back to reconciliation credentials. */
export function readGitHubRegistrationAppAuthConfig(
  env: GitHubAppAuthEnv,
  readFile: (path: string) => string = (path) => readFileSync(path, "utf8"),
): GitHubAppAuthConfig | null {
  return readAppAuthConfig(env, "GITHUB_REGISTRATION_APP_ID", "GITHUB_REGISTRATION_APP_PRIVATE_KEY_PATH", readFile);
}

function readAppAuthConfig(
  env: GitHubAppAuthEnv,
  appIdVariable: string,
  keyPathVariable: string,
  readFile: (path: string) => string,
): GitHubAppAuthConfig | null {
  const appId = env[appIdVariable];
  const keyPath = env[keyPathVariable];
  if (appId === undefined || appId.length === 0 || keyPath === undefined || keyPath.length === 0) {
    return null;
  }
  let pem: string;
  try {
    pem = readFile(keyPath);
  } catch (cause) {
    throw new Error(`${keyPathVariable} (${keyPath}) could not be read.`, { cause });
  }
  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch (cause) {
    // The message carries the variable and the path, never the file's
    // contents: a key file's text must not reach a log through this error.
    throw new Error(
      `${keyPathVariable} (${keyPath}) does not contain a parseable private key.`,
      { cause },
    );
  }
  // A parseable non-RSA key (Ed25519, EC, ...) would still fail on the first
  // mint — the JWT is signed RS256, `createSign("RSA-SHA256")` — so reject it
  // at this same wiring-time gate. rsa-pss signs fine and is admitted.
  if (key.asymmetricKeyType !== "rsa" && key.asymmetricKeyType !== "rsa-pss") {
    throw new Error(
      `${keyPathVariable} (${keyPath}) does not contain an RSA private key (received ${key.asymmetricKeyType}).`,
    );
  }
  return { appId, privateKey: pem };
}

/** One response of the App JWT request: the installation lookup. */
type JwtAppResponse = { status: number; headers: Headers; body: string | null };

export type AppInstallationAuthOptions = {
  config: GitHubAppAuthConfig;
  apiUrl?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Reserved for wiring-site diagnostics; today the lookup emits nothing. */
  logger?: (message: string) => void;
};

/** Looks up an installation without minting an installation access token. */
export function createAppInstallationLookup(options: AppInstallationAuthOptions):
  (ownerName: string) => Promise<{ installationId: number } | null> {
  const auth = createAppInstallationAuth(options);
  return async (ownerName) => {
    const result = await auth.lookupInstallation(ownerName);
    return result === null ? null : { installationId: result.installationId };
  };
}

function createAppInstallationAuth(options: AppInstallationAuthOptions) {
  const config = options.config;
  const apiUrl = (options.apiUrl ?? defaultApiUrl).replace(/\/$/, "");
  const fetchImplementation = options.fetch ?? fetch;
  const clock = options.now ?? ((): Date => new Date());

  return { lookupInstallation };

  async function lookupInstallation(ownerName: string): Promise<{ installationId: number; jwt: string } | null> {
    const [owner, repo] = parseOwnerName(ownerName);
    const jwt = mintJwt(clock());
    const installationId = await lookupInstallationId(owner, repo, jwt);
    return installationId === null ? null : { installationId, jwt };
  }

  async function lookupInstallationId(owner: string, repo: string, jwt: string): Promise<number | null> {
    const { status, headers, body } = await fetchWithJwt(
      `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
      jwt,
    );
    if (status === 404) {
      return null;
    }
    if (status !== 200) {
      throw classifiedError(status, headers, body, jwt);
    }
    const id = parseJsonPayload(body)?.["id"];
    if (typeof id !== "number" || !Number.isSafeInteger(id) || id <= 0) {
      throw new Error("GitHub App installation lookup response was invalid.");
    }
    return id;
  }

  async function fetchWithJwt(path: string, jwt: string): Promise<JwtAppResponse> {
    await checkSweepRequestBudget();
    let response: Response;
    try {
      response = await fetchImplementation(`${apiUrl}${path}`, {
        method: "GET",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${jwt}`,
          "X-GitHub-Api-Version": githubApiVersion,
        },
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

  function classifiedError(status: number, headers: Headers, body: string | null, jwt: string): GitHubApiError {
    const { rateLimited, retryAfterSeconds } = classifyGitHubRateLimit(status, headers, body);
    return new GitHubApiError(status, rateLimited, retryAfterSeconds, body, headers, jwt);
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
