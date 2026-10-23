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
