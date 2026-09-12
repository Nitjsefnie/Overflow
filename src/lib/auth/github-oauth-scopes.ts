/**
 * The GitHub OAuth scopes Overflow asks for, and the reading of the scopes
 * GitHub actually granted (issue 599).
 *
 * Two sign-ins exist. A contributor grants nothing beyond public identity:
 * the scope is the explicit empty string, which must stay explicit because
 * an omitted scope makes `@auth/core` 0.41.3 (`lib/utils/providers.js`,
 * `normalizeOAuth`) inject its OIDC default `openid profile email`, which
 * GitHub does not know. A sponsor registering a repository grants webhook
 * administration, the one permission registration and unregistration spend.
 *
 * Granted scopes arrive from GitHub in two shapes — the token response's
 * `scope` claim (comma-delimited) and the `X-OAuth-Scopes` response header
 * (comma-and-space-delimited) — and the parser accepts both, plus the
 * space-delimited spelling a request uses. `admin:repo_hook` is sufficient
 * on its own; `repo` grants full repository access including hooks, and
 * `public_repo` grants the same for the public repositories this flow is
 * limited to, so either subsumes it here. `write:repo_hook` does not: it
 * cannot delete the hook unregistration removes.
 */

/** The contributor sign-in: public identity only. */
export const GITHUB_CONTRIBUTOR_SCOPE = "";

/** The repository-registration sign-in: webhook administration. */
export const GITHUB_REPOSITORY_REGISTRATION_SCOPE = "admin:repo_hook";

/** Every granted scope that lets this token create and delete a public repository's webhooks. */
const WEBHOOK_ADMINISTRATION_SCOPES: ReadonlySet<string> = new Set([
  GITHUB_REPOSITORY_REGISTRATION_SCOPE,
  "repo",
  "public_repo",
]);

/**
 * The individual scopes in a GitHub scope list, in either delimiter GitHub
 * uses. Anything that is not a string reads as no scopes granted.
 */
export function parseGrantedScopes(raw: unknown): string[] {
  if (typeof raw !== "string") {
    return [];
  }
  return raw.split(/[\s,]+/).filter((scope) => scope.length > 0);
}

/** Whether a granted scope list lets the token administer public-repository webhooks. */
export function grantsWebhookAdministration(scopes: readonly string[]): boolean {
  return scopes.some((scope) => WEBHOOK_ADMINISTRATION_SCOPES.has(scope));
}
