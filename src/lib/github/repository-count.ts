import type { GitHubGraphqlClient } from "@/lib/github/graphql";
import type { GitHubRepositoryReference } from "@/lib/github/types";

/**
 * One count-only GraphQL read: both connections' totalCounts, every state,
 * closed items included, and no page of nodes ever listed.
 */
export async function getRepositoryHistoryCount(
  graphql: Pick<GitHubGraphqlClient, "query">,
  repository: GitHubRepositoryReference,
): Promise<number | null> {
  const data = await graphql.query<{
    repository: { issues: { totalCount: number } | null; pullRequests: { totalCount: number } | null } | null;
  }>(`query RepositoryHistoryCount($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    issues { totalCount }
    pullRequests { totalCount }
  }
}`, { owner: repository.owner, name: repository.name });
  const repositoryNode = data.repository;
  if (repositoryNode === null || repositoryNode === undefined) return null;
  const issues = repositoryNode.issues?.totalCount;
  const pullRequests = repositoryNode.pullRequests?.totalCount;
  if (typeof issues !== "number" || !Number.isSafeInteger(issues) || issues < 0
    || typeof pullRequests !== "number" || !Number.isSafeInteger(pullRequests) || pullRequests < 0) {
    return null;
  }
  return issues + pullRequests;
}
