import { vi } from "vitest";
import { GitHubGateway } from "@/lib/github/client";
import type { GitHubRepository, GitHubRepositoryReference, GitHubSubject } from "@/lib/github/types";
import { assertClosingPullRequestQuery } from "./closing-pull-request-query";
import { verifiedRepositoryPayload } from "./verified-repository";
import type { ReconciliationDependencies } from "@/lib/fold/reconcile";

/**
 * The shared reconcileRepository fixtures: the in-memory store/gateway fake,
 * its issue and pull-request shapes, and the GraphQL-backed gateway used by
 * the paginated walks. Import them; do not restate them in a suite.
 */

export function reconciliationDependencies(
  overrides: Partial<{
    materialize: ReturnType<typeof vi.fn>;
    github: Partial<ReconciliationDependencies["github"]>;
  }> = {},
): ReconciliationDependencies & {
  github: Required<ReconciliationDependencies["github"]>;
  store: ReconciliationDependencies["store"] & {
    failRun: ReturnType<typeof vi.fn>;
    completeRun: ReturnType<typeof vi.fn>;
    recordVerifiedRepositoryIdentity: ReturnType<typeof vi.fn>;
    markRepositoryUnavailable: ReturnType<typeof vi.fn>;
  };
} {
  const github = {
    getIssue: vi.fn().mockResolvedValue(null),
    getPullRequestClosingIssues: vi.fn().mockResolvedValue([]),
    listIssues: vi.fn().mockResolvedValue([
      {
        closingPullRequests: [
          {
            id: 201,
            number: 11,
            title: "Pull request",
            body: "Pull request body",
            url: "https://github.com/octo/example/pull/11",
            state: "MERGED",
            mergedAt: "2026-09-01T12:00:00.000Z",
            mergeCommitOid: "0123456789abcdef0123456789abcdef01234567",
            finalCommitAt: "2026-09-01T10:00:00.000Z",
            authorLogin: "contributor",
            authorGitHubUserId: 2001,
            repositoryGitHubId: 5001,
            repositoryNameWithOwner: "octo/example",
          },
        ],
        id: 101,
        number: 1,
        title: "Issue",
        updatedAt: "2026-09-01T12:05:00.000Z",
        body: "Issue body",
        url: "https://github.com/octo/example/issues/1",
        state: "CLOSED",
        stateReason: "COMPLETED",
        createdAt: "2026-09-01T08:00:00.000Z",
        closedAt: "2026-09-01T12:05:00.000Z",
        authorLogin: "sponsor",
        authorGitHubUserId: null,
        labels: ["M", "delivered/6"],
        claimAssigneeGitHubLogin: "contributor",
        claimAssigneeGitHubUserId: null,
        history: [
          { kind: "LABELED", id: "opening-101", actorLogin: "sponsor", actorGitHubUserId: null, createdAt: "2026-09-01T08:01:00.000Z", label: "M" },
          { kind: "ASSIGNED", id: "assigned-101", actorLogin: "sponsor", actorGitHubUserId: null, createdAt: "2026-09-01T09:00:00.000Z", assigneeLogin: "contributor" },
          { kind: "LABELED", id: "actual-101", actorLogin: "sponsor", actorGitHubUserId: null, createdAt: "2026-09-01T11:00:00.000Z", label: "delivered/6" },
        ],
        comments: [{
          id: "comment-101",
          databaseId: 301,
          authorLogin: "sponsor",
          authorGitHubUserId: null,
          body: "Settled as delivered/6.",
          createdAt: "2026-09-01T11:30:00.000Z",
          lastEditedAt: null,
        }],
      },
    ]),
    getPullRequestReviews: vi.fn().mockResolvedValue([]),
    getPullRequestDiff: vi.fn().mockResolvedValue("diff"),
    getRepositoryById: vi.fn().mockResolvedValue(verifiedRepository()),
    ...overrides.github,
  };
  const failRun = vi.fn().mockResolvedValue(undefined);
  const store = {
    assessReconciliationFairness: vi.fn<ReconciliationDependencies["store"]["assessReconciliationFairness"]>(async ({ now }) => ({
      state: "ADMITTED", holdUntil: null, usage: { debt: 0, measuredAt: now, ratePerSecond: 0 },
    })),
    getReconciliationEvidence: async () => null,
    getDirtyReconciliationSubjects: async () => [],
    discardDirtyReconciliationSubject: vi.fn().mockResolvedValue(undefined),
    getReconciliationCooldown: vi.fn().mockResolvedValue(null),
    setReconciliationCooldown: vi.fn().mockResolvedValue(undefined),
    withRepositoryReconciliation: vi.fn(async <T>(_repositoryId: string, work: () => Promise<T>) => work()),
    getRepository: vi.fn().mockResolvedValue({
      disputePullRequests: [],
      id: "repository",
      githubRepositoryId: 5001,
      ownerName: "octo/example",
      active: true,
      registeredAt: "2026-01-01T00:00:00.000Z",
      sponsor: { id: "sponsor", githubUserId: 1001, githubLogin: "sponsor", enforcementState: "ACTIVE" },
      difficultyScheme: {
        openingName: "Size",
        actualName: "Delivered",
        openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
        actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
      },
    }),
    getGitHubAccessToken: vi.fn().mockResolvedValue("token"),
    findUsersByGitHubUserIds: vi.fn().mockResolvedValue([
      { id: "sponsor", githubUserId: 1001, githubLogin: "sponsor", enforcementState: "ACTIVE" },
      { id: "contributor", githubUserId: 2001, githubLogin: "contributor", enforcementState: "ACTIVE" },
    ]),
    hasDerivedRowsBelowFoldRevision: async () => false,
    beginRun: vi.fn().mockResolvedValue("run-1"),
    completeRun: vi.fn().mockResolvedValue(undefined),
    materialize: overrides.materialize ?? vi.fn().mockResolvedValue({ adds: 1, changes: 0, removals: 0 }),
    failRun,
    holdRun: vi.fn().mockResolvedValue(undefined),
    recordVerifiedRepositoryIdentity: vi.fn().mockResolvedValue(undefined),
    markRepositoryUnavailable: vi.fn().mockResolvedValue(undefined),
    findForgeIdentitiesByForgeUserIds: vi.fn().mockResolvedValue([]),
  };

  return { store, github } as ReconciliationDependencies & {
    github: Required<ReconciliationDependencies["github"]>;
    store: ReconciliationDependencies["store"] & {
      failRun: ReturnType<typeof vi.fn>;
      completeRun: ReturnType<typeof vi.fn>;
      recordVerifiedRepositoryIdentity: ReturnType<typeof vi.fn>;
      markRepositoryUnavailable: ReturnType<typeof vi.fn>;
    };
  };
}

export function verifiedRepository(overrides: Partial<GitHubRepository> = {}): GitHubRepository {
  return {
    id: 5001,
    owner: "octo",
    name: "example",
    ownerType: "USER",
    fullName: "octo/example",
    visibility: "PUBLIC",
    url: "https://github.com/octo/example",
    canAdminister: true,
    ...overrides,
  };
}

export function reconciliationIssue(input: { id: number; number: number }) {
  return {
    id: input.id,
    number: input.number,
    title: `Issue ${input.number}`,
    updatedAt: "2026-09-01T12:05:00.000Z",
    body: `Issue ${input.number} body`,
    url: `https://github.com/octo/example/issues/${input.number}`,
    state: "CLOSED" as const,
    stateReason: "COMPLETED",
    createdAt: "2026-09-01T08:00:00.000Z",
    closedAt: "2026-09-01T12:05:00.000Z",
    authorLogin: "sponsor",
    authorGitHubUserId: null,
    labels: ["M", "delivered/6"],
    claimAssigneeGitHubLogin: "contributor",
    claimAssigneeGitHubUserId: null,
    history: [
      { kind: "LABELED" as const, id: `opening-${input.id}`, actorLogin: "sponsor", actorGitHubUserId: null, createdAt: "2026-09-01T08:01:00.000Z", label: "M" },
      { kind: "ASSIGNED" as const, id: `assigned-${input.id}`, actorLogin: "sponsor", actorGitHubUserId: null, createdAt: "2026-09-01T09:00:00.000Z", assigneeLogin: "contributor" },
      { kind: "LABELED" as const, id: `actual-${input.id}`, actorLogin: "sponsor", actorGitHubUserId: null, createdAt: "2026-09-01T11:00:00.000Z", label: "delivered/6" },
    ],
    comments: [{
      id: `comment-${input.id}`,
      databaseId: input.id + 10_000,
      authorLogin: "sponsor",
      authorGitHubUserId: null,
      body: "Settled as delivered/6.",
      createdAt: "2026-09-01T11:30:00.000Z",
      lastEditedAt: null,
    }],
  };
}

export function reconciliationPullRequest(input: { id: number; number: number }) {
  return {
    id: input.id,
    number: input.number,
    title: `Pull request ${input.number}`,
    body: `Pull request ${input.number} body`,
    url: `https://github.com/octo/example/pull/${input.number}`,
    state: "MERGED" as const,
    mergedAt: "2026-09-01T12:00:00.000Z",
    mergeCommitOid: `${input.id.toString(16).padStart(40, "0")}`,
    finalCommitAt: "2026-09-01T10:00:00.000Z",
    authorLogin: "contributor",
    authorGitHubUserId: 2001,
    repositoryGitHubId: 5001,
    repositoryNameWithOwner: "octo/example",
  };
}

export function pagedReconciliationGateway(
  requests: Array<{ operation: string; variables: Record<string, unknown> }>,
  merged: boolean,
  closingReferenceCount: 1 | 121 = 1,
): GitHubGateway {
  const pageInfo = { hasNextPage: false, endCursor: null };
  const pullRequestNode = (number: number) => {
    const pullRequest = reconciliationPullRequest({ id: 200 + number, number: 10 + number });
    return {
      ...pullRequest,
      databaseId: pullRequest.id,
      state: merged ? "MERGED" : "OPEN",
      mergedAt: merged ? pullRequest.mergedAt : null,
      mergeCommit: merged ? { oid: pullRequest.mergeCommitOid } : null,
      commits: { nodes: [{ commit: { committedDate: pullRequest.finalCommitAt } }] },
      author: { __typename: "User", login: pullRequest.authorLogin, databaseId: pullRequest.authorGitHubUserId },
      repository: {
        databaseId: pullRequest.repositoryGitHubId,
        nameWithOwner: pullRequest.repositoryNameWithOwner,
      },
    };
  };
  const timelineNodes = (number: number) => {
    const issue = reconciliationIssue({ id: 100 + number, number });
    return [
      ...issue.history.map((event) => ({
        ...event,
        __typename: event.kind === "ASSIGNED" ? "AssignedEvent" : "LabeledEvent",
        actor: { login: event.actorLogin, databaseId: event.actorGitHubUserId },
        label: { name: event.label },
        assignee: { login: event.assigneeLogin },
      })),
      ...issue.comments.map((comment) => ({
        ...comment,
        __typename: "IssueComment",
        author: { login: comment.authorLogin, databaseId: comment.authorGitHubUserId },
      })),
    ];
  };
  const closingReferences = (number: number) => [
    ...Array.from({ length: closingReferenceCount - 1 }, (_, index) => ({
      ...pullRequestNode(number),
      databaseId: 10_000 + number * 1000 + index,
      number: 1000 + number * 1000 + index,
      url: `https://github.com/octo/example/pull/${1000 + number * 1000 + index}`,
      state: "CLOSED",
      mergedAt: null,
      mergeCommit: null,
    })),
    pullRequestNode(number),
  ];
  return new GitHubGateway({
    accessToken: "test-token",
    fetch: async (input, init) => {
      if (String(input).endsWith("/repositories/5001")) {
        return Response.json(verifiedRepositoryPayload(5001, "octo/example"));
      }
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/issues/events")) return Response.json([1, 2, 3].flatMap((number) =>
        timelineNodes(number).filter((node) => node.__typename !== "IssueComment").map((node) => ({
          node_id: node.id, event: node.__typename === "AssignedEvent" ? "assigned" : "labeled",
          issue: { id: 100 + number, number },
        }))));
      if (path.endsWith("/issues/comments")) return Response.json([1, 2, 3].flatMap((number) =>
        timelineNodes(number).filter((node) => node.__typename === "IssueComment").map((node) => ({
          node_id: node.id, issue_url: `https://api.github.com/repos/octo/example/issues/${number}`,
        }))));
      if (String(input).endsWith("/graphql")) {
        const { query, variables } = JSON.parse(String(init?.body));
        const operation = /query (\w+)/.exec(query)![1]!;
        requests.push({ operation, variables });
        if (operation === "RepositoryIssues") {
          assertClosingPullRequestQuery(query, operation);
          if (variables.cursor !== null && variables.cursor !== "issues-next") {
            throw new Error(`Unmodeled issue cursor: ${variables.cursor}`);
          }
          const numbers = variables.cursor === null ? [3, 1] : [2];
          const nodes = numbers.map((number) => {
            const issue = reconciliationIssue({ id: 100 + number, number });
            return {
              ...issue,
              databaseId: issue.id,
              author: { login: issue.authorLogin, databaseId: issue.authorGitHubUserId },
              labels: { nodes: issue.labels.map((name) => ({ name })), pageInfo },
              assignees: { nodes: [{ login: "contributor" }] },
              closedByPullRequestsReferences: {
                nodes: closingReferences(number).slice(0, 20),
                pageInfo: closingReferenceCount === 121
                  ? { hasNextPage: true, endCursor: `closing-${number}-next` }
                  : pageInfo,
              },
            };
          });
          return Response.json({ data: { repository: { issues: {
            nodes,
            pageInfo: variables.cursor === null ? { hasNextPage: true, endCursor: "issues-next" } : pageInfo,
          } } } });
        }
        if (operation === "RepositoryIssue") {
          const issueNumber = variables.issueNumber as number;
          const issue = reconciliationIssue({ id: 100 + issueNumber, number: issueNumber });
          return Response.json({ data: { repository: { issue: {
            ...issue,
            databaseId: issue.id,
            author: { login: issue.authorLogin, databaseId: issue.authorGitHubUserId },
            labels: { nodes: issue.labels.map((name) => ({ name })), pageInfo },
            assignees: { nodes: [{ login: "contributor" }] },
            timelineItems: { nodes: [], pageInfo },
            closedByPullRequestsReferences: { nodes: closingReferences(issueNumber).slice(0, 20), pageInfo },
          } } } });
        }
        if (operation === "IssueLabels") {
          return Response.json({ data: { repository: { issue: { labels: { nodes: [], pageInfo } } } } });
        }
        if (operation === "IssueTimelineCounts") {
          return Response.json({ data: { repository: Object.fromEntries([1, 2, 3].map((number) => [
            `i${number}`, { databaseId: 100 + number, timelineItems: { totalCount: timelineNodes(number).length } },
          ])) } });
        }
        if (operation === "IssueTimeline") {
          return Response.json({ data: { repository: { issue: { timelineItems: {
            nodes: timelineNodes(variables.issueNumber), pageInfo,
          } } } } });
        }
        if (operation === "ClosingPullRequests") {
          assertClosingPullRequestQuery(query, operation);
          const { issueNumber, cursor } = variables;
          const modeledCursors: Array<string | null> = closingReferenceCount === 1
            ? [null]
            : [`closing-${issueNumber}-next`, `closing-${issueNumber}-last`];
          if (![1, 2, 3].includes(issueNumber) ||
              !modeledCursors.includes(cursor)) {
            throw new Error(`Unmodeled closing-reference request: ${JSON.stringify(variables)}`);
          }
          const start = cursor === null ? 0 : cursor === `closing-${issueNumber}-next` ? 20 : 120;
          return Response.json({ data: { repository: { issue: {
            closedByPullRequestsReferences: {
              nodes: closingReferences(issueNumber).slice(start, start + 100),
              pageInfo: start + 100 < closingReferenceCount
                ? { hasNextPage: true, endCursor: `closing-${issueNumber}-last` }
                : pageInfo,
            },
          } } } });
        }
        if (operation === "PullRequestReviews") {
          return Response.json({ data: { repository: { pullRequest: { reviews: { nodes: [], pageInfo } } } } });
        }
        if (operation === "PullRequestReviewDismissals") {
          return Response.json({ data: { repository: { pullRequest: { timelineItems: { nodes: [], pageInfo } } } } });
        }
        throw new Error(`Unexpected operation ${operation}`);
      }
      return new Response("diff");
    },
  });
}
