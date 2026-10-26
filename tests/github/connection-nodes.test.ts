import { describe, expect, it } from "vitest";
import { GitHubGateway } from "@/lib/github/client";
import { requireConnectionNodes } from "@/lib/github/graphql";
import { errorLogToken } from "@/lib/webhooks/log-field";

/**
 * GitHub's connection `nodes` lists legally carry null entries (the schema is
 * `[Issue]`, not `[Issue!]`), and nested objects may arrive null. Every walk
 * here read node fields off such entries unchecked, so one null entry failed
 * the whole reconcile with `TypeError: Cannot read properties of null
 * (reading 'databaseId')` and the journal named no field (issue 1408). Each
 * guard throws naming the GraphQL field path it failed on, and the fold
 * journal renders that message through errorLogToken, so a failed run names
 * its cause. A null `databaseId` FIELD is a different shape and keeps its own
 * existing guard message ("GitHub GraphQL response was invalid.").
 */

const repository = { owner: "octo", name: "overflow" };

function gatewayAnswering(dataFor: (operation: string) => unknown): GitHubGateway {
  return new GitHubGateway({
    accessToken: "test-access-token",
    fetch: async (_input, init) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      const operation = /query (\w+)/.exec(request.query)![1]!;
      return Response.json({ data: dataFor(operation) });
    },
  });
}

function page(nodes: unknown[], endCursor: string | null = null) {
  return { nodes, pageInfo: { hasNextPage: endCursor !== null, endCursor } };
}

function issueNode(overrides: Record<string, unknown> = {}) {
  return {
    databaseId: 501,
    number: 3,
    title: "Overflow issue",
    body: "Issue body",
    url: "https://github.com/octo/overflow/issues/3",
    state: "OPEN",
    stateReason: null,
    createdAt: "2026-09-01T09:00:00.000Z",
    updatedAt: "2026-09-01T09:00:00.000Z",
    closedAt: null,
    author: { login: "owner", databaseId: 7001 },
    labels: page([]),
    assignees: { nodes: [] },
    closedByPullRequestsReferences: page([]),
    timelineItems: page([]),
    ...overrides,
  };
}

function closingPullRequestNode(overrides: Record<string, unknown> = {}) {
  return {
    databaseId: 201,
    number: 11,
    title: "Closes the issue",
    body: "Pull request body",
    url: "https://github.com/octo/overflow/pull/11",
    state: "MERGED",
    mergedAt: "2026-09-04T12:00:00.000Z",
    mergeCommit: { oid: "0123456789abcdef0123456789abcdef01234567" },
    commits: { nodes: [{ commit: { committedDate: "2026-09-04T10:00:00.000Z" } }] },
    author: { login: "contributor", databaseId: 7002 },
    repository: { databaseId: 6001, nameWithOwner: "octo/overflow" },
    ...overrides,
  };
}

describe("GitHubGateway connection node guards", () => {
  it("refuses a null entry in issues.nodes naming the field", async () => {
    const gateway = gatewayAnswering(() => ({ repository: { issues: page([null]) } }));
    await expect(gateway.listIssues(repository)).rejects.toThrow(
      "GitHub GraphQL response was invalid. issues.nodes contained a null entry.",
    );
  });

  it("refuses a null entry in closingIssuesReferences.nodes naming the field", async () => {
    const gateway = gatewayAnswering(() => ({ repository: { pullRequest: {
      databaseId: 9001,
      closingIssuesReferences: page([null]),
    } } }));
    await expect(gateway.getPullRequestClosingIssues(repository, { id: 9001, number: 7 })).rejects.toThrow(
      "GitHub GraphQL response was invalid. closingIssuesReferences.nodes contained a null entry.",
    );
  });

  it("refuses a closing issue whose nested repository is null naming the field", async () => {
    const gateway = gatewayAnswering(() => ({ repository: { pullRequest: {
      databaseId: 9001,
      closingIssuesReferences: page([{ databaseId: 501, number: 3, repository: null }]),
    } } }));
    await expect(gateway.getPullRequestClosingIssues(repository, { id: 9001, number: 7 })).rejects.toThrow(
      "GitHub GraphQL response was invalid. closingIssuesReferences.nodes.repository was null.",
    );
  });

  it("refuses a null entry in closedByPullRequestsReferences.nodes naming the field", async () => {
    const gateway = gatewayAnswering(() => ({ repository: { issue: {
      closedByPullRequestsReferences: page([null]),
    } } }));
    await expect(gateway.getIssueClosingPullRequests(repository, 3)).rejects.toThrow(
      "GitHub GraphQL response was invalid. closedByPullRequestsReferences.nodes contained a null entry.",
    );
  });

  it("refuses a null closing pull request nested in the issue page naming the field", async () => {
    const gateway = gatewayAnswering((operation) => operation === "RepositoryIssues"
      ? { repository: { issues: page([issueNode({ closedByPullRequestsReferences: page([null]) })]) } }
      : { repository: { issue: { timelineItems: page([]) } } });
    await expect(gateway.listIssues(repository)).rejects.toThrow(
      "GitHub GraphQL response was invalid. closedByPullRequestsReferences.nodes contained a null entry.",
    );
  });

  // A null element in a closing pull request's commits connection is no final
  // commit: the `?.` after `.at(-1)` resolves finalCommitAt to null, no throw.
  it("resolves a closing pull request whose final commit node is null with no finalCommitAt", async () => {
    const gateway = gatewayAnswering(() => ({ repository: { issue: {
      closedByPullRequestsReferences: page([closingPullRequestNode({ commits: { nodes: [null] } })]),
    } } }));
    await expect(gateway.getIssueClosingPullRequests(repository, 3)).resolves.toEqual([
      expect.objectContaining({ id: 201, finalCommitAt: null }),
    ]);
  });

  it("refuses a null timeline entry naming the field", async () => {
    const gateway = gatewayAnswering((operation) => operation === "RepositoryIssues"
      ? { repository: { issues: page([issueNode()]) } }
      : { repository: { issue: { timelineItems: page([null]) } } });
    await expect(gateway.listIssues(repository)).rejects.toThrow(
      "GitHub GraphQL response was invalid. timelineItems.nodes contained a null entry.",
    );
  });

  it("refuses a null label entry nested in the issue page naming the field", async () => {
    const gateway = gatewayAnswering((operation) => operation === "RepositoryIssues"
      ? { repository: { issues: page([issueNode({ labels: page([null]) })]) } }
      : { repository: { issue: { timelineItems: page([]) } } });
    await expect(gateway.listIssues(repository)).rejects.toThrow(
      "GitHub GraphQL response was invalid. labels.nodes contained a null entry.",
    );
  });

  it("refuses a null review entry naming the field", async () => {
    const gateway = gatewayAnswering((operation) => operation === "PullRequestReviewDismissals"
      ? { repository: { pullRequest: { timelineItems: page([]) } } }
      : { repository: { pullRequest: { reviews: page([null]) } } });
    await expect(gateway.getPullRequestReviews(repository, 7)).rejects.toThrow(
      "GitHub GraphQL response was invalid. reviews.nodes contained a null entry.",
    );
  });

  it("refuses a null dismissal entry naming the field", async () => {
    const gateway = gatewayAnswering((operation) => operation === "PullRequestReviewDismissals"
      ? { repository: { pullRequest: { timelineItems: page([null]) } } }
      : { repository: { pullRequest: { reviews: page([]) } } });
    await expect(gateway.getPullRequestReviews(repository, 7)).rejects.toThrow(
      "GitHub GraphQL response was invalid. timelineItems.nodes contained a null entry.",
    );
  });

  // A dismissal event whose `review` object is null carries no dismissal data:
  // the `?.` in `node.review?.databaseId == null` skips it without a throw and
  // the review still maps with no dismissal attached.
  it("skips a dismissed review whose review object is null", async () => {
    const gateway = gatewayAnswering((operation) => operation === "PullRequestReviewDismissals"
      ? { repository: { pullRequest: { timelineItems: page([{
          __typename: "ReviewDismissedEvent",
          createdAt: "2026-09-04T12:00:00.000Z",
          previousReviewState: "CHANGES_REQUESTED",
          review: null,
        }]) } } }
      : { repository: { pullRequest: { reviews: page([
          { databaseId: 301, state: "APPROVED", submittedAt: "2026-09-04T12:00:00.000Z" },
        ]) } } });

    await expect(gateway.getPullRequestReviews(repository, 7)).resolves.toEqual([
      { id: 301, state: "APPROVED", submittedAt: "2026-09-04T12:00:00.000Z", dismissal: null },
    ]);
  });

  it("refuses a null issues.nodes list naming the field", async () => {
    const gateway = gatewayAnswering(() => ({
      repository: { issues: { nodes: null, pageInfo: { hasNextPage: false, endCursor: null } } },
    }));
    await expect(gateway.listIssues(repository)).rejects.toThrow(
      "GitHub GraphQL response was invalid. issues.nodes was not a list.",
    );
  });

  it("carries the field path into the journal token the fold renders", async () => {
    const gateway = gatewayAnswering(() => ({ repository: { issues: page([null]) } }));
    const error = await gateway.listIssues(repository).catch((error: unknown) => error);
    expect((error as Error).message).toContain("issues.nodes");
    expect(errorLogToken(error)).toContain("issues.nodes");
  });

  it("keeps a healthy issue page with its closing pull request flowing", async () => {
    const gateway = gatewayAnswering((operation) => operation === "RepositoryIssues"
      ? { repository: { issues: page([issueNode({
        closedByPullRequestsReferences: page([closingPullRequestNode()]),
      })]) } }
      : { repository: { issue: { timelineItems: page([]) } } });

    const issues = await gateway.listIssues(repository);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.closingPullRequests).toEqual([
      expect.objectContaining({ id: 201, repositoryNameWithOwner: "octo/overflow" }),
    ]);
  });

  // The guard's own limbs, driven directly: a non-list `nodes`, a null entry
  // and an undefined entry each refuse with the field named.
  it("names the field for a non-list nodes and for null and undefined entries", () => {
    expect(() => requireConnectionNodes("issues.nodes", null))
      .toThrow("GitHub GraphQL response was invalid. issues.nodes was not a list.");
    expect(() => requireConnectionNodes("issues.nodes", [null]))
      .toThrow("GitHub GraphQL response was invalid. issues.nodes contained a null entry.");
    expect(() => requireConnectionNodes("issues.nodes", [undefined]))
      .toThrow("GitHub GraphQL response was invalid. issues.nodes contained a null entry.");
  });
});
