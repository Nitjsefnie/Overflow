import { GitHubApiError, GitHubGraphqlInvalidResponseError, GitHubGraphqlRequestError, isGitHubSubjectNotFoundError } from "@/lib/github/errors";
import { GitHubResponseTooLargeError } from "@/lib/github/response-text";
import { isIssueOwnFieldPath } from "@/lib/github/drain-issue-reads";
import { GitLabApiError } from "@/lib/gitlab/api-error";

export type WalkDiscardReason = "NOT_FOUND" | "DIFF_TOO_LARGE" | "RESPONSE_TOO_LARGE" | "UNREADABLE_FIELD";

/** Subject-local failures for walk reads; unclassified failures reject the walk. */
export function walkSubjectDiscardReason(error: unknown, kind: "issue" | "pull_request", disputed: boolean, closing: boolean): WalkDiscardReason | null {
  if (error instanceof GitHubResponseTooLargeError) return "RESPONSE_TOO_LARGE";
  if (isGitHubSubjectNotFoundError(error)) return "NOT_FOUND";
  if (error instanceof GitLabApiError && error.status === 404) return "NOT_FOUND";
  if (kind === "issue") {
    if (error instanceof GitHubGraphqlInvalidResponseError && isIssueOwnFieldPath(error.fieldPath)) return "UNREADABLE_FIELD";
    if (error instanceof GitHubApiError && error.status === 404) return "NOT_FOUND";
  } else if (!closing) {
    if (error instanceof GitHubApiError && error.status === 406) return "DIFF_TOO_LARGE";
    if (error instanceof GitHubApiError && error.status === 404) return "NOT_FOUND";
    if (disputed && error instanceof GitHubGraphqlRequestError && error.status === 200 && !error.rateLimited
      && /^GitHub GraphQL request failed\. NOT_FOUND: Could not resolve to a Repository\b[^;]*$/.test(error.message)) return "NOT_FOUND";
  }
  return null;
}
