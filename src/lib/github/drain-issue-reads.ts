import { GitHubGraphqlInvalidResponseError } from "@/lib/github/errors";
import type { GitHubPullRequest } from "@/lib/github/types";

/** Drain started reads before their caller snapshots cost, retaining the first rejection. */
export async function drainIssueReads<T extends readonly unknown[] | []>(
  reads: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  try {
    return await Promise.all(reads);
  } catch (error) {
    await Promise.allSettled(reads);
    throw error;
  }
}

/**
 * One issue's closing-PR read: a null entry in that connection marks this ONE
 * issue unreadable (an empty list) instead of failing the whole walk; every
 * other rejection keeps whole-walk semantics.
 */
export type IssueClosingPullRequestsRead = {
  closingPullRequests: GitHubPullRequest[];
  closingPullRequestsUnreadable?: true;
};

export function readIssueClosingPullRequests(read: Promise<GitHubPullRequest[]>): Promise<IssueClosingPullRequestsRead> {
  return read.then((closingPullRequests) => ({ closingPullRequests }), (error: unknown) => {
    if (error instanceof GitHubGraphqlInvalidResponseError && error.fieldPath === "closedByPullRequestsReferences.nodes") {
      return { closingPullRequests: [], closingPullRequestsUnreadable: true };
    }
    throw error;
  });
}
