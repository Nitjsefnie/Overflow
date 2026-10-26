import { describe, expect, it } from "vitest";
import { GitHubGateway } from "@/lib/github/client";

const reference = { owner: "octo", name: "overflow" };
const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } });
const at = "2026-10-01T00:00:00Z";
const event = { __typename: "LabeledEvent", id: "standing", createdAt: at, actor: null, label: { name: "settled" } };
const node = {
  databaseId: 101, number: 1, title: "Opening", body: "", url: "https://github.com/octo/overflow/issues/1",
  state: "OPEN", stateReason: null, createdAt: at, updatedAt: at, closedAt: null, author: null,
  assignees: { nodes: [] }, labels: page([{ name: "settled" }]),
  timelineItems: page([]), closedByPullRequestsReferences: page([]),
};
const options = { timelineCriticalLabels: new Set(["settled"]) };

function fixture(persistentGap = false, unreadable = false) {
  const calls: string[] = [];
  const gateway = new GitHubGateway({ accessToken: ["test", "token"].join("-"), fetch: async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/graphql") {
      const { query } = JSON.parse(String(init?.body));
      const operation = /query (\w+)/.exec(query)![1]!;
      calls.push(operation);
      if (operation === "RepositoryIssues") return Response.json({ data: { repository: { issues: page([{ ...node, labels: unreadable ? page([null]) : node.labels }]) } } });
      if (operation === "RepositoryIssue") return Response.json({ data: { repository: { issue: { ...node, labels: unreadable ? page([null]) : node.labels } } } });
      if (operation === "IssueTimelineCounts") return Response.json({ data: { repository: { i1: { databaseId: 101, timelineItems: { totalCount: 1 } } } } });
      if (operation === "IssueTimeline") return Response.json({ data: { repository: { issue: { timelineItems: page(persistentGap ? [] : [event]) } } } });
      throw new Error(`Unexpected query ${operation}`);
    }
    calls.push(url.pathname);
    if (/\/issues(?:\/1)?\/events$/.test(url.pathname)) return Response.json([{ node_id: "standing", event: "labeled", issue: { id: 101, number: 1 } }]);
    if (/\/issues(?:\/1)?\/comments$/.test(url.pathname)) return Response.json([]);
    throw new Error(`Unexpected request ${url.pathname}`);
  } });
  return { gateway, calls };
}

describe("the shared GitHub issue gather", () => {
  it.each(["list", "gather"])("%s rereads a targeted timeline and verifies the independent witnesses", async (mode) => {
    const { gateway, calls } = fixture();
    const issues = mode === "list" ? await gateway.listIssues(reference, options)
      : [await gateway.gatherIssue(reference, { id: 101, number: 1 }, options)];
    expect(issues[0]?.history.map(({ id }) => id)).toEqual(["standing"]);
    expect(issues[0]?.openingEvidenceUnreadable).toBeUndefined();
    expect(calls).toContain("IssueTimeline");
  });

  it.each(["list", "gather"])("%s refuses a persistently incomplete targeted timeline", async (mode) => {
    const { gateway } = fixture(true);
    const read = mode === "list" ? gateway.listIssues(reference, options)
      : gateway.gatherIssue(reference, { id: 101, number: 1 }, options);
    await expect(read).rejects.toThrow("timeline completeness could not be verified");
  });

  it.each(["list", "gather"])("%s keeps unreadable opening evidence marked", async (mode) => {
    const { gateway } = fixture(false, true);
    const issues = mode === "list" ? await gateway.listIssues(reference, options)
      : [await gateway.gatherIssue(reference, { id: 101, number: 1 }, options)];
    expect(issues[0]?.openingEvidenceUnreadable).toBe(true);
    expect(issues[0]?.history).toEqual([]);
  });
});
