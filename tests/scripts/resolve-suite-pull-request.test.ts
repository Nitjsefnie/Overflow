import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveSuitePullRequest } from "../../scripts/resolve-suite-pull-request.ts";

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const REPO = "Nitjsefnie/Overflow";

function suite(headRepo = REPO, branch = "feature") {
  return {
    id: 123, path: ".github/workflows/pr-suite.yml", event: "pull_request",
    status: "completed", conclusion: "success", head_sha: HEAD, head_branch: branch,
    head_repository: { full_name: headRepo, owner: { login: headRepo.split("/")[0] } },
  };
}

function pr(headRepo = REPO, branch = "feature") {
  return {
    number: 1183, state: "open",
    head: { repo: { full_name: headRepo }, ref: branch, sha: HEAD },
    base: { sha: BASE, ref: "main" },
  };
}

function harness(run = suite(), candidates: unknown[] = [pr()], current: unknown = candidates[0]) {
  const requests: URL[] = [];
  const headers: Headers[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    headers.push(new Headers(init?.headers));
    if (url.pathname.endsWith("/actions/runs/123")) return Response.json(run);
    if (url.pathname.endsWith("/pulls")) return Response.json(candidates);
    if (url.pathname.endsWith("/pulls/1183")) return Response.json(current);
    throw new Error(`unexpected API request ${url}`);
  }) as typeof fetch;
  return {
    deps: { env: { GITHUB_REPOSITORY: REPO, GH_TOKEN: "test-token", SUITE_RUN_ID: "123" }, fetchFn },
    requests, headers,
  };
}

describe("suite run PR resolution", () => {
  it.each([[REPO, "feature"], ["fork/Overflow", "feature"], ["fork/Overflow", "main"]])(
    "binds %s's %s branch to its exact head",
    async (repo, branch) => {
      const h = harness(suite(repo, branch), [pr(repo, branch)]);
      const result = await resolveSuitePullRequest(h.deps);
      expect(result.exitCode).toBe(0);
      expect(result.outputs).toEqual({ pr_number: "1183", head_sha: HEAD, base_sha: BASE, base_ref: "main" });
      const list = h.requests.find((url) => url.pathname.endsWith("/pulls"))!;
      expect(list.searchParams.get("head")).toBe(`${repo.split("/")[0]}:${branch}`);
      expect(list.searchParams.get("state")).toBe("open");
      expect(h.headers.every((header) => header.get("cache-control") === "no-cache")).toBe(true);
    },
  );

  it("encodes a hostile branch as a query value, never additional parameters", async () => {
    const branch = "feature&state=closed#fragment";
    const h = harness(suite(REPO, branch), [pr(REPO, branch)]);
    expect((await resolveSuitePullRequest(h.deps)).exitCode).toBe(0);
    const list = h.requests[1]!;
    expect(list.searchParams.get("head")).toBe(`Nitjsefnie:${branch}`);
    expect(list.searchParams.getAll("state")).toEqual(["open"]);
    expect(list.hash).toBe("");
  });

  it.each([
    ["zero matches", [], /no open pull request/i],
    ["multiple matches", [pr(), { ...pr(), number: 1184 }], /more than one|ambiguous/i],
    ["other repository", [pr("Nitjsefnie/Other")], /no open pull request/i],
    ["other branch", [pr(REPO, "other")], /no open pull request/i],
    ["old SHA", [{ ...pr(), head: { ...pr().head, sha: "c".repeat(40) } }], /no open pull request/i],
  ])("refuses %s", async (_label, candidates, message) => {
    const result = await resolveSuitePullRequest(harness(suite(), candidates as unknown[]).deps);
    expect(result.exitCode).not.toBe(0);
    expect(result.outputs).toBeUndefined();
    expect(result.lines.join("\n")).toMatch(message as RegExp);
    expect(result.lines.some((line) => line.startsWith("::error::"))).toBe(true);
  });

  it("refuses a head that moved between the listing and fresh PR read", async () => {
    const moved = { ...pr(), head: { ...pr().head, sha: "c".repeat(40) } };
    const result = await resolveSuitePullRequest(harness(suite(), [pr()], moved).deps);
    expect(result.exitCode).toBe(1);
    expect(result.outputs).toBeUndefined();
    expect(result.lines.join("\n")).toMatch(/::error::.*stale|::error::.*moved/i);
  });

  it.each([
    ["wrong path", { path: ".github/workflows/ci.yml" }, /path/i],
    ["wrong event", { event: "push" }, /event/i],
    ["upstream failure", { conclusion: "failure" }, /success/i],
    ["upstream cancellation", { conclusion: "cancelled" }, /success/i],
    ["unfinished run", { status: "in_progress" }, /completed/i],
    ["wrong id", { id: 124 }, /id/i],
    ["invalid SHA", { head_sha: "bad" }, /SHA/i],
    ["deleted fork", { head_repository: null }, /repository/i],
  ])("refuses %s", async (_label, override, message) => {
    const h = harness({ ...suite(), ...override } as ReturnType<typeof suite>);
    const result = await resolveSuitePullRequest(h.deps);
    expect(result.exitCode).toBe(1);
    expect(result.outputs).toBeUndefined();
    expect(result.lines.join("\n")).toMatch(message as RegExp);
    expect(result.lines.some((line) => line.startsWith("::error::"))).toBe(true);
    expect(h.requests).toHaveLength(1);
  });

  it("refuses a failed API read", async () => {
    const h = harness();
    h.deps.fetchFn = async () => new Response("unavailable", { status: 503 });
    const result = await resolveSuitePullRequest(h.deps);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("::error::");
    expect(result.outputs).toBeUndefined();
  });

  it("checks every page so an ambiguous PR on a later page cannot pass", async () => {
    const h = harness();
    const original = h.deps.fetchFn;
    h.deps.fetchFn = async (input, init) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/pulls")) return original(input, init);
      const page = Number(url.searchParams.get("page"));
      return Response.json(page === 1
        ? [pr(), ...Array.from({ length: 99 }, () => pr("other/repo"))]
        : [{ ...pr(), number: 1184 }]);
    };
    const result = await resolveSuitePullRequest(h.deps);
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toMatch(/more than one|ambiguous/i);
  });

  it("appends only validated outputs to GITHUB_OUTPUT", async () => {
    const dir = mkdtempSync(join(tmpdir(), "suite-pr-outputs-"));
    const output = join(dir, "output");
    writeFileSync(output, "earlier=true\n");
    const h = harness();
    const result = await resolveSuitePullRequest({ ...h.deps, env: { ...h.deps.env, GITHUB_OUTPUT: output } });
    expect(result.exitCode).toBe(0);
    expect(readFileSync(output, "utf8")).toBe(`earlier=true\npr_number=1183\nhead_sha=${HEAD}\nbase_sha=${BASE}\nbase_ref=main\n`);
  });
});
