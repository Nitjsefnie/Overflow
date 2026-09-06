import { expect } from "vitest";

/** The exact connection shape these response fixtures model, ignoring whitespace. */
export function assertClosingPullRequestQuery(
  query: string,
  operation: "RepositoryIssues" | "ClosingPullRequests",
): void {
  const normalized = query.replace(/\s+/g, " ").trim();
  expect(normalized).toMatch(new RegExp(`^query ${operation}\\(`));
  expect(normalized).toContain("repository(owner: $owner, name: $name)");

  const argumentsText = operation === "RepositoryIssues"
    ? "first: 20, includeClosedPrs: true"
    : "first: 100, includeClosedPrs: true, after: $cursor";
  // Pin the selected subtree, not merely variable values sent alongside the query.
  expect(normalized).toContain(`closedByPullRequestsReferences(${argumentsText}) { nodes { databaseId number title body url state mergedAt mergeCommit { oid } commits(last: 1) { nodes { commit { committedDate } } } author { login ... on User { databaseId } } repository { nameWithOwner } } pageInfo { hasNextPage endCursor } }`);

  if (operation === "ClosingPullRequests") {
    expect(normalized).toMatch(/^query ClosingPullRequests\([^)]*\$issueNumber: Int!/);
    expect(normalized).toMatch(/^query ClosingPullRequests\([^)]*\$cursor: String\)/);
    expect(normalized).toContain("issue(number: $issueNumber) { closedByPullRequestsReferences(");
  }
}
