import type { GitHubGraphqlClient } from "@/lib/github/graphql";
import type { GitHubRepositoryReference } from "@/lib/github/types";

export type GitHubGraphqlPullRequestNode = {
  databaseId: number | null;
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
  commits: { nodes: Array<{ commit: { committedDate: string } }> };
  author: { login: string; databaseId?: number | null } | null;
  repository: { databaseId: unknown; nameWithOwner: unknown } | null;
};

export async function getPullRequestNode(
  graphql: GitHubGraphqlClient, repository: GitHubRepositoryReference, pullRequestNumber: number,
): Promise<GitHubGraphqlPullRequestNode | null> {
  const data = await graphql.query<{
    repository: { pullRequest: GitHubGraphqlPullRequestNode | null } | null;
  }>(pullRequestQuery, { owner: repository.owner, name: repository.name, pullRequestNumber });
  return data.repository?.pullRequest ?? null;
}

const pullRequestQuery = `
  query PullRequest($owner: String!, $name: String!, $pullRequestNumber: Int!) {
    rateLimit { cost limit remaining resetAt }
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pullRequestNumber) {
        databaseId number title body url state mergedAt
        mergeCommit { oid }
        commits(last: 1) { nodes { commit { committedDate } } }
        author { login ... on User { databaseId } }
        repository { databaseId nameWithOwner }
      }
    }
  }
`;

/**
 * The owning repository's stable identity. Absent or unusable, the pull request
 * cannot be attributed to a repository at all, which is the same standing a null
 * `databaseId` has for the pull request itself.
 */
export function repositoryGitHubId(node: GitHubGraphqlPullRequestNode): number {
  const databaseId = node.repository?.databaseId;
  if (typeof databaseId !== "number" || !Number.isSafeInteger(databaseId) || databaseId <= 0) {
    throw new Error("GitHub GraphQL response was invalid.");
  }
  return databaseId;
}

/**
 * A closing reference can name a pull request in another repository, so the
 * owning repository is as load-bearing as the number and must be present.
 */
export function repositoryNameWithOwner(node: GitHubGraphqlPullRequestNode): string {
  const nameWithOwner = node.repository?.nameWithOwner;
  if (typeof nameWithOwner !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(nameWithOwner)) {
    throw new Error("GitHub GraphQL response was invalid.");
  }
  return nameWithOwner;
}
