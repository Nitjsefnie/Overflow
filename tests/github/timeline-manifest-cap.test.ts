import { describe, expect, it } from "vitest";
import { GitHubGateway } from "@/lib/github/client";

const repository = { owner: "octo", name: "overflow" };
const apiUrl = "https://api.github.com";
const pageInfo = { hasNextPage: false, endCursor: null };
const timelineOptions = {
  timelineCriticalLabels: new Set(["settled: 6"]),
  timelineWatchedLabels: new Set(["size/M"]),
};
const openingEvent = {
  __typename: "LabeledEvent", id: "opening-event-1", createdAt: "2026-09-05T08:00:00.000Z",
  actor: { login: "sponsor", databaseId: 4242 }, label: { name: "size/M" },
};
const settledEvent = {
  ...openingEvent, id: "settled-event", createdAt: "2026-09-06T03:59:18.000Z", label: { name: "settled: 6" },
};
const removedEvent = { ...openingEvent, __typename: "UnlabeledEvent", id: "removed" };
const assignedEvent = {
  ...openingEvent, __typename: "AssignedEvent", id: "assigned", assignee: { login: "worker" },
};
const rationale = {
  __typename: "IssueComment", id: "rationale-node", databaseId: 99,
  createdAt: "2026-09-06T04:00:00.000Z", lastEditedAt: null,
  author: { login: "sponsor", databaseId: 4242 }, body: "Delivered work rationale",
};
const common = [openingEvent, rationale];

function issueNode() {
  return {
    databaseId: 101, number: 1, title: "Manifest evidence", body: "Issue body",
    updatedAt: "2026-09-06T09:00:00.000Z", createdAt: "2026-09-05T08:00:00.000Z",
    url: "https://github.com/octo/overflow/issues/1", state: "OPEN", stateReason: null,
    closedAt: null, author: { login: "owner" }, assignees: { nodes: [] },
    labels: { nodes: [], pageInfo }, closedByPullRequestsReferences: { nodes: [], pageInfo },
  };
}

function manifestResponse(path: string, nodes: Array<{ __typename: string; id: string }>) {
  if (path === "/repos/octo/overflow/issues/events") {
    return Response.json([], { headers: { link: `<${apiUrl}${path}?page=2>; rel="next"` } });
  }
  if (path === "/repos/octo/overflow/issues/comments") return Response.json([]);
  if (path === "/repos/octo/overflow/issues/1/comments") {
    return Response.json(nodes.filter((node) => node.__typename === "IssueComment").map((node) => ({
      node_id: node.id, issue_url: `${apiUrl}/repos/octo/overflow/issues/1`,
    })));
  }
  if (path !== "/repos/octo/overflow/issues/1/events") return null;
  const events: Record<string, string> = {
    LabeledEvent: "labeled", UnlabeledEvent: "unlabeled", AssignedEvent: "assigned", ClosedEvent: "closed",
  };
  return Response.json(nodes.filter((node) => events[node.__typename] !== undefined).map((node) => ({
    node_id: node.id, event: events[node.__typename],
  })));
}

describe("timeline manifest lower-bound evidence", () => {
  it.each([
    { name: "accepts a capped REST event collection", accepts: true, count: 5,
      timeline: [openingEvent, removedEvent, assignedEvent, settledEvent, rationale],
      manifest: [openingEvent, removedEvent, assignedEvent, { __typename: "ClosedEvent", id: "closed" }, rationale] },
    { name: "refuses an empty manifest", accepts: false, count: 2, timeline: common, manifest: [] },
    { name: "refuses an empty events collection", accepts: false, count: 2,
      timeline: common, manifest: [rationale] },
    { name: "refuses a missing critical label event", accepts: false, count: 3, standing: ["settled: 6"],
      initial: [openingEvent, assignedEvent, settledEvent, rationale],
      timeline: [openingEvent, assignedEvent, rationale], manifest: common },
    { name: "refuses a manifest id missing from the reread", accepts: false, count: 2, timeline: common,
      manifest: [...common, { ...openingEvent, id: "dropped-event" }] },
    { name: "refuses a surplus duplicate", accepts: false, count: 2,
      timeline: [...common, rationale], manifest: common },
  ])("$name", async ({ accepts, count, timeline, manifest, initial, standing }) => {
    const gateway = new GitHubGateway({ accessToken: ["test", "access", "token"].join("-"), fetch: async (input, init) => {
      const response = manifestResponse(new URL(String(input)).pathname, manifest);
      if (response !== null) return response;
      const { query } = JSON.parse(String(init?.body));
      const operation = /query (\w+)/.exec(query)?.[1];
      if (operation === "RepositoryIssues") return Response.json({ data: { repository: { issues: {
        nodes: [{ ...issueNode(), labels: { nodes: (standing ?? []).map((name) => ({ name })), pageInfo },
          ...(initial === undefined ? {} : {
            timelineItems: { nodes: initial, totalCount: 4, pageInfo },
          }) }], pageInfo,
      } } } });
      if (operation === "IssueTimelineCounts") return Response.json({ data: { repository: { i1: {
        databaseId: 101, timelineItems: { totalCount: count },
      } } } });
      if (operation === "IssueTimeline") return Response.json({ data: { repository: { issue: {
        timelineItems: { nodes: timeline, pageInfo },
      } } } });
      throw new Error(`Unmodelled fetch: ${String(input)} ${operation}`);
    } });
    const result = gateway.listIssues(repository, timelineOptions);
    if (accepts) {
      await expect(result).resolves.toHaveLength(1);
      const [issue] = await result;
      expect(issue?.history.map(({ id }) => id)).toEqual(["opening-event-1", "removed", "assigned", "settled-event"]);
      expect(issue?.comments.map(({ id }) => id)).toEqual(["rationale-node"]);
    } else {
      await expect(result).rejects.toThrow("GitHub issue 1 timeline completeness could not be verified.");
    }
  });
});
