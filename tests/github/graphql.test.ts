import { describe, expect, it } from "vitest";
import { GitHubGateway } from "@/lib/github/client";

describe("GitHubGateway GraphQL source adapter", () => {
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
        labels: ["size/M"],
      },
      {
        id: 102,
        number: 2,
        title: "Second issue",
        body: "Issue body",
        url: "https://github.com/octo/overflow/issues/2",
        state: "OPEN",
        labels: ["size/M"],
      },
    ]);
    expect(cursors).toEqual([null, "cursor-2"]);
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
        authorLogin: "contributor",
        labels: ["delivered/6"],
      },
    ]);
    expect(query).toMatch(/closedByPullRequestsReferences\(first:\s*100/);
    expect(query).toContain("includeClosedPrs: true");
    expect(query).not.toContain("timelineItems");
    expect(askedForRestTimeline).toBe(false);
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

function issueNode(id: number, number: number, title: string) {
  return {
    databaseId: id,
    number,
    title,
    body: "Issue body",
    url: `https://github.com/octo/overflow/issues/${number}`,
    state: "OPEN",
    labels: { nodes: [{ name: "size/M" }] },
  };
}

function pullRequestNode(id: number, number: number) {
  return {
    databaseId: id,
    number,
    title: "Closes the issue",
    body: "Pull request body",
    url: `https://github.com/octo/overflow/pull/${number}`,
    state: "MERGED",
    mergedAt: "2026-09-04T12:00:00.000Z",
    author: { login: "contributor" },
    labels: { nodes: [{ name: "delivered/6" }] },
  };
}

function reviewNode(id: number, state: string) {
  return {
    databaseId: id,
    state,
    submittedAt: "2026-09-04T12:00:00.000Z",
  };
}
