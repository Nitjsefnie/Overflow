import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitHubGateway } from "@/lib/github/client";
import * as sweep from "@/lib/fold/sweep-pass";
import type { SweepPass } from "@/lib/fold/sweep-pass";

const repository = { owner: "octo", name: "overflow" };
const apiUrl = "https://api.github.com";
const pageInfo = { hasNextPage: false, endCursor: null };
const timelineOptions = {
  timelineCriticalLabels: new Set(["settled: 6"]),
  timelineWatchedLabels: new Set(["size/M"]),
};
const openingEvent = {
  __typename: "LabeledEvent", id: "opening-event", createdAt: "2026-09-05T08:00:00.000Z",
  actor: { login: "sponsor", databaseId: 4242 }, label: { name: "size/M" },
};
const settledEvent = { ...openingEvent, id: "settled-event", label: { name: "settled: 6" } };
const rationale = {
  __typename: "IssueComment", id: "rationale-node", databaseId: 99,
  createdAt: "2026-09-06T04:00:00.000Z", lastEditedAt: null,
  author: { login: "sponsor", databaseId: 4242 }, body: "Delivered work rationale",
};
const stale = [openingEvent, rationale];
const complete = [openingEvent, settledEvent, rationale];

function issueNode(number: number, nodes: unknown[]) {
  return {
    databaseId: 100 + number, number, title: "Timeline rewritten during sweep", body: "Issue body",
    updatedAt: "2026-09-06T09:00:00.000Z", createdAt: "2026-09-05T08:00:00.000Z",
    url: `https://github.com/octo/overflow/issues/${number}`, state: "OPEN", stateReason: null,
    closedAt: null, author: { login: "owner" }, assignees: { nodes: [] },
    labels: { nodes: number === 1 ? [{ name: "settled: 6" }] : [], pageInfo },
    timelineItems: { nodes, totalCount: nodes.length, pageInfo },
    closedByPullRequestsReferences: { nodes: [], pageInfo },
  };
}

function timelineResponse(nodes: unknown[]) {
  return Response.json({ data: { repository: { issue: { timelineItems: { nodes, pageInfo } } } } });
}

function countsResponse(variables: Record<string, unknown>, count: number) {
  return Response.json({ data: { repository: Object.fromEntries(
    Object.entries(variables).filter(([key]) => key.startsWith("number")).map(([, value]) => [
      `i${value}`, { databaseId: 100 + Number(value), timelineItems: { totalCount: value === 1 ? count : 0 } },
    ]),
  ) } });
}

function manifestResponse(path: string) {
  if (!/^\/repos\/octo\/overflow\/issues\/(events|comments)$/.test(path)) return null;
  // Force the same per-issue fallback used by a repository exceeding the cap.
  return Response.json([], { headers: { link: `<${apiUrl}${path}?page=100>; rel="last", <${apiUrl}${path}?page=2>; rel="next"` } });
}

function perIssueManifestResponse(path: string, nodes: typeof complete) {
  const match = /^\/repos\/octo\/overflow\/issues\/([12])\/(events|comments)$/.exec(path);
  if (match === null) return null;
  const truth = match[1] === "1" ? nodes : [];
  return Response.json(truth.filter((node) => (node.__typename === "IssueComment") === (match[2] === "comments"))
    .map((node) => node.__typename === "IssueComment"
      ? { node_id: node.id, issue_url: `${apiUrl}/repos/octo/overflow/issues/${match[1]}` }
      : { node_id: node.id, event: "labeled" }));
}

function requestKey(identity: unknown) {
  return createHash("sha256").update(JSON.stringify(identity)).digest("hex");
}

function fakePass(pages: Map<string, unknown>) {
  const read = vi.fn(async (key: string) => {
    if (!pages.has(key)) throw new Error(`Unmodelled checkpoint read: ${key}`);
    return pages.get(key);
  });
  const write = vi.fn(async (key: string, payload: unknown) => {
    if (!pages.has(key)) throw new Error(`Unmodelled checkpoint write: ${key}`);
    pages.set(key, payload);
  });
  const pass: SweepPass = {
    id: "paused-pass", scanStartedAt: new Date("2026-09-05T08:00:00Z"), dirtySubjects: [],
    read, write, complete: async () => {},
  };
  return { pass, read, write };
}

type CachedLimb = "manifest" | "count" | "reread";
async function resumedGateway(limb: CachedLimb) {
  const pages = new Map<string, unknown>();
  const calls: string[] = [];
  let warming = true;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = new URL(String(input));
    let response: Response;
    let cached: Response;
    let identity: unknown;
    if (url.pathname === "/graphql") {
      const { query, variables } = JSON.parse(String(init?.body));
      const operation = /query (\w+)/.exec(query)![1]!;
      calls.push(`${operation}:${JSON.stringify(variables)}`);
      identity = ["graphql", `${apiUrl}/graphql`, query, variables];
      if (operation === "RepositoryIssues") {
        response = Response.json({ data: { repository: { issues: { nodes: [issueNode(1, stale), issueNode(2, [])], pageInfo } } } });
        cached = response.clone();
      } else if (operation === "IssueTimelineCounts") {
        const batch = variables.number2 !== undefined;
        response = countsResponse(variables, batch ? 2 : 3);
        cached = countsResponse(variables, limb === "reread" || (!batch && limb === "manifest") ? 3 : 2);
      } else if (operation === "IssueTimeline" && variables.issueNumber === 1 && variables.cursor === null) {
        response = timelineResponse(complete);
        cached = timelineResponse(limb === "reread" ? stale : complete);
      } else {
        throw new Error(`Unmodelled fetch: ${operation} ${JSON.stringify(variables)}`);
      }
      if (warming) pages.set(requestKey(identity), (await cached.json()).data);
    } else {
      calls.push(url.pathname);
      identity = ["rest", apiUrl, `${url.pathname}${url.search}`, undefined, undefined];
      const live = manifestResponse(url.pathname) ?? perIssueManifestResponse(url.pathname, complete);
      const saved = manifestResponse(url.pathname) ?? perIssueManifestResponse(url.pathname, limb === "manifest" ? stale : complete);
      if (live === null || saved === null) throw new Error(`Unmodelled fetch: ${url}`);
      response = live;
      if (warming) pages.set(requestKey(identity), { status: saved.status, headers: Object.fromEntries(saved.headers), body: await saved.text() });
    }
    return response;
  });
  const gateway = new GitHubGateway({ accessToken: ["test", "access", "token"].join("-"), fetch });
  // Capture real request identities from an earlier successful attempt, then
  // replay explicitly modelled pages from the different checkpoint windows.
  await gateway.listIssues(repository, timelineOptions);
  warming = false;
  calls.length = 0;
  fetch.mockClear();
  return { gateway, calls, fetch, ...fakePass(pages) };
}

function expectFreshTimeline(issues: Awaited<ReturnType<GitHubGateway["listIssues"]>>) {
  expect(issues[0]?.history.map(({ id }) => id)).toEqual(["opening-event", "settled-event"]);
  expect(issues[0]?.comments.map(({ id }) => id)).toEqual(["rationale-node"]);
}

describe("timeline completeness across sweep checkpoints", () => {
  it("bypasses a stale per-issue manifest witness", async () => {
    const f = await resumedGateway("manifest");
    const result = sweep.withSweepPass(f.pass, () => f.gateway.listIssues(repository, timelineOptions));
    await expect(result).resolves.toHaveLength(2);
    expectFreshTimeline(await result);
    expect(f.calls).toContain("/repos/octo/overflow/issues/1/events");
    expect(f.calls).toContain("/repos/octo/overflow/issues/1/comments");
  });

  it("bypasses a stale count witness when the manifest is already complete", async () => {
    const f = await resumedGateway("count");
    const result = sweep.withSweepPass(f.pass, () => f.gateway.listIssues(repository, timelineOptions));
    await expect(result).resolves.toHaveLength(2);
    expectFreshTimeline(await result);
    expect(f.calls.filter((call) => call.startsWith("IssueTimelineCounts:"))).toEqual([
      'IssueTimelineCounts:{"owner":"octo","name":"overflow","number1":1}',
    ]);
  });

  it("bypasses an earlier cursor-null suspect reread with complete witnesses", async () => {
    const f = await resumedGateway("reread");
    const result = sweep.withSweepPass(f.pass, () => f.gateway.listIssues(repository, timelineOptions));
    await expect(result).resolves.toHaveLength(2);
    expectFreshTimeline(await result);
    expect(f.calls.filter((call) => call.startsWith("IssueTimeline:"))).toEqual([
      'IssueTimeline:{"owner":"octo","name":"overflow","issueNumber":1,"cursor":null}',
    ]);
  });

  it("replays outside the bypass and checkpoints again after it returns", async () => {
    const identity = ["scoped-page"];
    const next = ["after-bypass"];
    const f = fakePass(new Map([[requestKey(identity), "cached"], [requestKey(next), undefined]]));
    const fetch = vi.fn(async () => "live");
    await sweep.withSweepPass(f.pass, async () => {
      expect(await sweep.checkpointSweepRequest(identity, fetch)).toBe("cached");
      expect(fetch).not.toHaveBeenCalled();
      expect(await sweep.withFreshSweepReads(() => sweep.checkpointSweepRequest(identity, fetch))).toBe("live");
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(await sweep.checkpointSweepRequest(identity, fetch)).toBe("cached");
      // An explicitly modelled miss must be written and replayed normally.
      expect(await sweep.checkpointSweepRequest(next, fetch)).toBe("live");
      expect(await sweep.checkpointSweepRequest(next, fetch)).toBe("live");
      expect(fetch).toHaveBeenCalledTimes(2);
    });
    expect(f.read).toHaveBeenCalledTimes(4);
    expect(f.write).toHaveBeenCalledExactlyOnceWith(requestKey(next), "live", undefined);
  });

  it("writes no bypassed pages for explicitly modelled cache misses", async () => {
    const identities = [["missing-page"], ["another-missing-page"]];
    const f = fakePass(new Map(identities.map((identity) => [requestKey(identity), undefined])));
    const fetch = vi.fn(async () => "verification");
    await sweep.withSweepPass(f.pass, async () => {
      await sweep.withFreshSweepReads(async () => {
        for (const identity of identities) {
          expect(await sweep.checkpointSweepRequest(identity, fetch)).toBe("verification");
        }
      });
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(f.write).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
  });
});
