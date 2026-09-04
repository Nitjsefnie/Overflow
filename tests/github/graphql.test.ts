import { describe, expect, it } from "vitest";
import { GitHubGateway } from "@/lib/github/client";

describe("GitHubGateway GraphQL source adapter", () => {
  it("collects paginated immutable issue label, assignment, and owner-comment history", async () => {
    const historyCursors: Array<string | null> = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { cursor: string | null; issueNumber?: number };
        };
        if (request.query.includes("query RepositoryIssues")) {
          return Response.json({
            data: {
              repository: {
                issues: {
                  nodes: [
                    {
                      ...issueNode(101, 1, "History issue"),
                      createdAt: "2026-08-30T09:00:00.000Z",
                      author: { login: "owner" },
                      timelineItems: {
                        nodes: [
                          {
                            __typename: "LabeledEvent",
                            id: "label-event-1",
                            createdAt: "2026-08-30T10:00:00.000Z",
                            actor: { login: "owner" },
                            label: { name: "size/M" },
                          },
                        ],
                        pageInfo: { hasNextPage: true, endCursor: "history-cursor-2" },
                      },
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          });
        }

        historyCursors.push(request.variables.cursor);
        return Response.json({
          data: {
            repository: {
              issue: {
                timelineItems: {
                  nodes: [
                    {
                      __typename: "AssignedEvent",
                      id: "assignment-event-1",
                      createdAt: "2026-08-31T09:00:00.000Z",
                      actor: { login: "owner" },
                      assignee: { login: "contributor" },
                    },
                    {
                      __typename: "IssueComment",
                      id: "comment-node-1",
                      databaseId: 501,
                      createdAt: "2026-09-01T11:30:00.000Z",
                      author: { login: "owner" },
                      body: "Owner rationale for delivered/6.",
                    },
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      },
    });

    const issues = await gateway.listIssues({ owner: "octo", name: "overflow" });

    expect(issues[0]).toMatchObject({
      authorLogin: "owner",
      createdAt: "2026-08-30T09:00:00.000Z",
      history: [
        {
          kind: "LABELED",
          id: "label-event-1",
          actorLogin: "owner",
          label: "size/M",
          createdAt: "2026-08-30T10:00:00.000Z",
        },
        {
          kind: "ASSIGNED",
          id: "assignment-event-1",
          actorLogin: "owner",
          assigneeLogin: "contributor",
          createdAt: "2026-08-31T09:00:00.000Z",
        },
      ],
      comments: [
        {
          id: "comment-node-1",
          databaseId: 501,
          authorLogin: "owner",
          body: "Owner rationale for delivered/6.",
          createdAt: "2026-09-01T11:30:00.000Z",
        },
      ],
    });
    expect(historyCursors).toEqual(["history-cursor-2"]);
  });

  it("collects every cursor-paginated issue page from GitHub GraphQL", async () => {
    const cursors: Array<string | null> = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        expect(String(input)).toBe("https://api.github.com/graphql");
        const request = JSON.parse(String(init?.body)) as {
          variables: { cursor: string | null };
        };
        cursors.push(request.variables.cursor);

        if (request.variables.cursor === null) {
          return Response.json({
            data: {
              repository: {
                issues: {
                  nodes: [issueNode(101, 1, "First issue")],
                  pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
                },
              },
            },
          });
        }

        return Response.json({
          data: {
            repository: {
              issues: {
                nodes: [issueNode(102, 2, "Second issue")],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      },
    });

    await expect(gateway.listIssues({ owner: "octo", name: "overflow" })).resolves.toEqual([
      {
        id: 101,
        number: 1,
        title: "First issue",
        body: "Issue body",
        url: "https://github.com/octo/overflow/issues/1",
        state: "OPEN",
        createdAt: "2026-08-30T09:00:00.000Z",
        authorLogin: "owner",
        labels: ["size/M"],
        claimAssigneeGitHubLogin: null,
        history: [],
        comments: [],
      },
      {
        id: 102,
        number: 2,
        title: "Second issue",
        body: "Issue body",
        url: "https://github.com/octo/overflow/issues/2",
        state: "OPEN",
        createdAt: "2026-08-30T09:00:00.000Z",
        authorLogin: "owner",
        labels: ["size/M"],
        claimAssigneeGitHubLogin: null,
        history: [],
        comments: [],
      },
    ]);
    expect(cursors).toEqual([null, "cursor-2"]);
  });

  it("maps only one unambiguous GraphQL assignee as an issue claim lock", async () => {
    let query = "";
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        query = (JSON.parse(String(init?.body)) as { query: string }).query;
        return Response.json({
          data: {
            repository: {
              issues: {
                nodes: [
                  issueNode(101, 1, "One assignee", undefined, [{ login: "claim-holder" }]),
                  issueNode(102, 2, "No assignee", undefined, []),
                  issueNode(103, 3, "Several assignees", undefined, [
                    { login: "first" },
                    { login: "second" },
                  ]),
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          },
        });
      },
    });

    const issues = await gateway.listIssues({ owner: "octo", name: "overflow" });

    expect(issues.map((issue) => issue.claimAssigneeGitHubLogin)).toEqual([
      "claim-holder",
      null,
      null,
    ]);
    expect(query).toMatch(/assignees\(first:\s*2\)/);
  });

  it("collects labels after the first one hundred nodes for every returned issue", async () => {
    const labelRequests: Array<{ issueNumber: number; cursor: string | null }> = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          query: string;
          variables: { cursor: string | null; issueNumber?: number };
        };

        if (request.query.includes("query RepositoryIssues")) {
          return Response.json({
            data: {
              repository: {
                issues: {
                  nodes: [
                    issueNode(101, 1, "First issue", firstLabelPage("issue-one")),
                    issueNode(102, 2, "Second issue", firstLabelPage("issue-two")),
                  ],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          });
        }

        labelRequests.push({
          issueNumber: request.variables.issueNumber ?? 0,
          cursor: request.variables.cursor,
        });
        return Response.json({
          data: {
            repository: {
              issue: {
                labels: {
                  nodes: [{ name: `required/${request.variables.issueNumber}` }],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      },
    });

    const issues = await gateway.listIssues({ owner: "octo", name: "overflow" });

    expect(issues.map((issue) => issue.labels)).toEqual([
      [...firstHundredLabels("issue-one"), "required/1"],
      [...firstHundredLabels("issue-two"), "required/2"],
    ]);
    expect(labelRequests).toEqual([
      { issueNumber: 1, cursor: "issue-one-label-cursor" },
      { issueNumber: 2, cursor: "issue-two-label-cursor" },
    ]);
  });

  it("takes closing pull request links only from closedByPullRequestsReferences", async () => {
    let query = "";
    let askedForRestTimeline = false;
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (input, init) => {
        if (String(input) !== "https://api.github.com/graphql") {
          askedForRestTimeline = true;
          return Response.json({
            event: "cross-referenced",
            source: { issue: { number: 999 } },
          });
        }

        query = (JSON.parse(String(init?.body)) as { query: string }).query;
        return Response.json({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: {
                  nodes: [pullRequestNode(201, 4)],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      },
    });

    await expect(
      gateway.getIssueClosingPullRequests({ owner: "octo", name: "overflow" }, 1),
    ).resolves.toEqual([
      {
        id: 201,
        number: 4,
        title: "Closes the issue",
        body: "Pull request body",
        url: "https://github.com/octo/overflow/pull/4",
        state: "MERGED",
        mergedAt: "2026-09-04T12:00:00.000Z",
        mergeCommitOid: "0123456789abcdef0123456789abcdef01234567",
        finalCommitAt: "2026-09-04T10:00:00.000Z",
        authorLogin: "contributor",
      },
    ]);
    expect(query).toMatch(/closedByPullRequestsReferences\(first:\s*100/);
    expect(query).toContain("includeClosedPrs: true");
    expect(query).not.toContain("timelineItems");
    expect(askedForRestTimeline).toBe(false);
  });

  it("carries the exact merge commit OID and final PR commit time from GraphQL", async () => {
    let query = "";
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        query = (JSON.parse(String(init?.body)) as { query: string }).query;
        return Response.json({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: {
                  nodes: [pullRequestNode(201, 4)],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      },
    });

    const [pullRequest] = await gateway.getIssueClosingPullRequests(
      { owner: "octo", name: "overflow" },
      1,
    );

    expect(pullRequest).toMatchObject({
      mergeCommitOid: "0123456789abcdef0123456789abcdef01234567",
      finalCommitAt: "2026-09-04T10:00:00.000Z",
    });
    expect(query).toMatch(/mergeCommit\s*\{\s*oid\s*\}/);
    expect(query).toMatch(/commits\(last:\s*1\)/);
  });

  it("does not request mutable pull-request labels for settlement pricing", async () => {
    const queries: string[] = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { query: string };
        queries.push(request.query);
        return Response.json({
          data: {
            repository: {
              issue: {
                closedByPullRequestsReferences: {
                  nodes: [pullRequestNode(201, 4), pullRequestNode(202, 5)],
                  pageInfo: { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      },
    });

    const pullRequests = await gateway.getIssueClosingPullRequests(
      { owner: "octo", name: "overflow" },
      1,
    );

    expect(pullRequests).toHaveLength(2);
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toMatch(/pullRequest\(number:.*labels/s);
  });

  it("collects pull request reviews through cursor-paginated GraphQL", async () => {
    const cursors: Array<string | null> = [];
    const gateway = new GitHubGateway({
      accessToken: "test-access-token",
      fetch: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as {
          variables: { cursor: string | null };
        };
        cursors.push(request.variables.cursor);
        return Response.json({
          data: {
            repository: {
              pullRequest: {
                reviews: {
                  nodes:
                    request.variables.cursor === null
                      ? [reviewNode(301, "CHANGES_REQUESTED")]
                      : [reviewNode(302, "APPROVED")],
                  pageInfo:
                    request.variables.cursor === null
                      ? { hasNextPage: true, endCursor: "review-cursor-2" }
                      : { hasNextPage: false, endCursor: null },
                },
              },
            },
          },
        });
      },
    });

    await expect(
      gateway.getPullRequestReviews({ owner: "octo", name: "overflow" }, 4),
    ).resolves.toEqual([
      { id: 301, state: "CHANGES_REQUESTED", submittedAt: "2026-09-04T12:00:00.000Z" },
      { id: 302, state: "APPROVED", submittedAt: "2026-09-04T12:00:00.000Z" },
    ]);
    expect(cursors).toEqual([null, "review-cursor-2"]);
  });
});

function issueNode(
  id: number,
  number: number,
  title: string,
  labels: LabelConnectionFixture = {
    nodes: [{ name: "size/M" }],
    pageInfo: { hasNextPage: false, endCursor: null },
  },
  assignees: Array<{ login: string }> = [],
) {
  return {
    databaseId: id,
    number,
    title,
    body: "Issue body",
    url: `https://github.com/octo/overflow/issues/${number}`,
    state: "OPEN",
    createdAt: "2026-08-30T09:00:00.000Z",
    author: { login: "owner" },
    labels,
    assignees: { nodes: assignees },
    timelineItems: {
      nodes: [],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

function pullRequestNode(
  id: number,
  number: number,
) {
  return {
    databaseId: id,
    number,
    title: "Closes the issue",
    body: "Pull request body",
    url: `https://github.com/octo/overflow/pull/${number}`,
    state: "MERGED",
    mergedAt: "2026-09-04T12:00:00.000Z",
    mergeCommit: { oid: "0123456789abcdef0123456789abcdef01234567" },
    commits: {
      nodes: [{ commit: { committedDate: "2026-09-04T10:00:00.000Z" } }],
    },
    author: { login: "contributor" },
  };
}

function reviewNode(id: number, state: string) {
  return {
    databaseId: id,
    state,
    submittedAt: "2026-09-04T12:00:00.000Z",
  };
}

function firstLabelPage(prefix: string) {
  return {
    nodes: firstHundredLabels(prefix).map((name) => ({ name })),
    pageInfo: { hasNextPage: true, endCursor: `${prefix}-label-cursor` },
  };
}

type LabelConnectionFixture = {
  nodes: Array<{ name: string }>;
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
};

function firstHundredLabels(prefix: string): string[] {
  return Array.from({ length: 100 }, (_, index) => `${prefix}/${index + 1}`);
}
