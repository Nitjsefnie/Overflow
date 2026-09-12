/**
 * The authoritative reading of what a stored GitHub token may do (issue
 * 599): the scopes GitHub itself reports in the `X-OAuth-Scopes` header of an
 * authenticated response. Repository registration asks this before it builds
 * the flow that would create a webhook, for a cookie session and a bearer
 * caller alike, so a token that granted only public identity is refused with
 * a stable code and a remedy instead of a webhook request GitHub 404s.
 *
 * The probe is the smallest authenticated request there is — `GET /user`,
 * the same endpoint sign-in reads — and it reads only the header. Neither
 * the scope the sign-in requested nor the JWT's hint is consulted: the
 * former is a request, the latter a snapshot, and GitHub's answer is what a
 * webhook call would actually get. The deadline matches the sign-in
 * userinfo request and the GitHub clients: 10 seconds, after which the
 * transport is aborted and the probe fails as an upstream failure.
 */
import { grantsWebhookAdministration, parseGrantedScopes } from "@/lib/auth/github-oauth-scopes";

const GITHUB_API_USER_URL = "https://api.github.com/user";

/** The same deadline the GitHub REST and GraphQL clients give every request. */
const defaultTimeoutMs = 10_000;

/** GitHub answered the probe with a non-2xx status: the token is refused (401) or GitHub is unavailable. */
export class GitHubScopeProbeError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`GitHub /user responded ${status} to the granted-scope probe.`);
    this.name = "GitHubScopeProbeError";
    this.status = status;
  }
}

/** The token is live but its granted scopes cannot administer repository webhooks. */
export class GitHubWebhookScopeError extends Error {
  readonly grantedScopes: readonly string[];

  constructor(grantedScopes: readonly string[]) {
    super(
      "The GitHub authorization Overflow holds for your account cannot administer repository webhooks: " +
        "registration needs the admin:repo_hook scope. Use \"Sign in to register a repository\" " +
        "to authorize webhook administration with the same GitHub account, then register again.",
    );
    this.name = "GitHubWebhookScopeError";
    this.grantedScopes = grantedScopes;
  }
}

/** The scopes GitHub reports granting to `accessToken`, from the /user response's X-OAuth-Scopes header. */
export async function readGitHubGrantedScopes(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  // One absolute deadline settles the call even against a transport that
  // ignores the abort — the same shape as the sign-in userinfo request.
  const deadline = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error("GitHub /user granted-scope probe timed out.");
      controller.abort(error);
      reject(error);
    }, defaultTimeoutMs);
  });
  try {
    const response = await Promise.race([
      fetchImpl(GITHUB_API_USER_URL, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/vnd.github+json",
          "User-Agent": "overflow",
        },
        signal: controller.signal,
      }),
      deadline,
    ]);
    if (!response.ok) {
      throw new GitHubScopeProbeError(response.status);
    }
    return parseGrantedScopes(response.headers.get("x-oauth-scopes"));
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * The granted scopes when they let the token administer webhooks; otherwise
 * `GitHubWebhookScopeError`. A probe failure passes through unchanged.
 */
export async function requireWebhookAdministration(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string[]> {
  const grantedScopes = await readGitHubGrantedScopes(accessToken, fetchImpl);
  if (!grantsWebhookAdministration(grantedScopes)) {
    throw new GitHubWebhookScopeError(grantedScopes);
  }
  return grantedScopes;
}
