import type { GitHubGraphqlClient } from "@/lib/github/graphql";
import type { GitHubRepositoryReference } from "@/lib/github/types";

export async function getCommitAuthor(
  graphql: GitHubGraphqlClient, repository: GitHubRepositoryReference, sha: string,
): Promise<number | null> {
  const data = await graphql.query<{
    repository: { object: { author?: { user: { databaseId: number | null } | null } | null } | null } | null;
  }>(commitAuthorQuery, { owner: repository.owner, name: repository.name, sha });
  return data.repository?.object?.author?.user?.databaseId ?? null;
}

const commitAuthorQuery = `
  query CommitAuthor($owner: String!, $name: String!, $sha: String!) {
    rateLimit { cost limit remaining resetAt }
    repository(owner: $owner, name: $name) {
      object(expression: $sha) { ... on Commit { author { user { databaseId } } } }
    }
  }
`;
