import { GitLabApiError } from "@/lib/gitlab/client";
import { RepositoryRegistrationError } from "@/lib/repositories/register";

/**
 * The step names a GitLab webhook refusal may interrupt, rendered into the
 * catalog messages verbatim.
 */
export type GitLabWebhookStep = "create the project webhook" | "delete the project webhook";

/**
 * Maps a failed GitLab webhook step onto the registration error catalog's
 * existing codes — the route's status mapping already answers those codes —
 * with GitLab-named messages. The codes stay GitHub-named because the catalog
 * union is the route's contract surface; the messages carry the forge.
 *
 * - 401: the instance rejected the linked identity's token itself — the same
 *   shape issue 93 pins for GitHub. Retrying cannot fix the token.
 * - 403: the token answers but may not manage hooks here.
 * - 404: the instance hides the project or the hook (or both are gone).
 * - 429: the instance is rate-limiting; the one transient refusal.
 * - anything else (including GitLabApiError 0, a transport failure): upstream.
 */
export function gitlabWebhookError(
  error: unknown,
  step: GitLabWebhookStep,
  retryNoun: "registration" | "unregistration",
): RepositoryRegistrationError {
  if (error instanceof GitLabApiError && error.status === 401) {
    return new RepositoryRegistrationError(
      "GITHUB_CREDENTIALS",
      `GitLab rejected the linked identity's token (HTTP 401) while trying to ${step}. `
        + "Relink your GitLab identity on the Ledger page, then retry "
        + retryNoun + ".",
    );
  }
  if (error instanceof GitLabApiError && error.status === 403) {
    return new RepositoryRegistrationError(
      "GITHUB_ACCESS",
      `GitLab refused to ${step} (HTTP 403). The linked identity does not hold maintainer permission `
        + "on this project, or the instance refuses webhook management for it. "
        + `Check the token's access, then retry ${retryNoun}.`,
    );
  }
  if (error instanceof GitLabApiError && error.status === 404) {
    return new RepositoryRegistrationError(
      "GITHUB_ACCESS",
      `GitLab answered 404 for the request to ${step}. The project may have been renamed, moved or deleted. `
        + `Check the project, then retry ${retryNoun}.`,
    );
  }
  if (error instanceof GitLabApiError && error.status === 429) {
    return new RepositoryRegistrationError(
      "GITHUB_RATE_LIMITED",
      `GitLab rate-limited the request to ${step} (HTTP 429). Please retry ${retryNoun} later.`,
    );
  }
  return new RepositoryRegistrationError(
    "UPSTREAM_FAILURE",
    `Unable to ${step} on GitLab.`,
  );
}
