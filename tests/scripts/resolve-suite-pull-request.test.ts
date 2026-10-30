import { rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { resolveSuitePullRequest } from "../../scripts/resolve-suite-pull-request.ts";

import { createOwnedTempDirectory, reclaimOwnedTempDirectories } from "../support/owned-temp-directory";

for (const prefix of ["suite-cancelled-outputs-", "suite-pr-outputs-"]) {
  reclaimOwnedTempDirectories(join(tmpdir(), prefix));
}

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const REPO = "Nitjsefnie/Overflow";

function suite(headRepo = REPO, branch = "feature") {
  return {
    id: 123, path: ".github/workflows/pr-suite.yml", event: "pull_request",
    status: "completed", conclusion: "success", head_sha: HEAD, head_branch: branch, run_attempt: 1,
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
  const sleeps: number[] = [];
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push(url);
    headers.push(new Headers(init?.headers));
    if (url.pathname.endsWith("/actions/runs/123")) return Response.json(run);
    if (url.pathname.endsWith("/pulls")) return Response.json(candidates);
    if (url.pathname.endsWith("/pulls/1183")) return Response.json(current);
    if (url.pathname.endsWith("/actions/workflows/pr-suite.yml/runs")) {
      return Response.json({ total_count: 1, workflow_runs: [run] });
    }
    throw new Error(`unexpected API request ${url}`);
  }) as typeof fetch;
  return {
    deps: {
      env: { GITHUB_REPOSITORY: REPO, GH_TOKEN: "test-token", OVERFLOW_SUITE_RUN_ID: "123" }, fetchFn,
      sleepFn: async (ms: number) => { sleeps.push(ms); },
    },
    requests, headers, sleeps,
  };
}

function scriptRunReads(h: ReturnType<typeof harness>, outcomeFor: (attempt: number) => Response | Error | undefined) {
  const original = h.deps.fetchFn;
  let attempts = 0;
  h.deps.fetchFn = async (input, init) => {
    if (!new URL(String(input)).pathname.endsWith("/actions/runs/123")) return original(input, init);
    const outcome = outcomeFor(attempts);
    attempts += 1;
    if (outcome instanceof Error) throw outcome;
    return outcome ?? original(input, init);
  };
  return () => attempts;
}

const timedOut = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

function rejectedReads(h: ReturnType<typeof harness>, status: number, rejections: number, cancelFailure?: Error) {
  const events: string[] = [];
  const sleep = h.deps.sleepFn;
  h.deps.sleepFn = async (ms) => { events.push("sleep"); await sleep(ms); };
  scriptRunReads(h, (n) => {
    events.push(`read ${n}`);
    if (n >= rejections) return undefined;
    return new Response(new ReadableStream({
      async cancel() {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        events.push(`cancelled ${n}`);
        if (cancelFailure) throw cancelFailure;
      },
    }), { status });
  });
  return events;
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

  it("resolves when only the legacy SUITE_RUN_ID is set", async () => {
    const env = { GITHUB_REPOSITORY: REPO, GH_TOKEN: "test-token", SUITE_RUN_ID: "123" };
    expect((await resolveSuitePullRequest({ ...harness().deps, env })).exitCode).toBe(0);
  });

  it("keeps an empty OVERFLOW_SUITE_RUN_ID authoritative over a set legacy SUITE_RUN_ID", async () => {
    const env = { GITHUB_REPOSITORY: REPO, GH_TOKEN: "test-token", OVERFLOW_SUITE_RUN_ID: "", SUITE_RUN_ID: "123" };
    const result = await resolveSuitePullRequest({ ...harness().deps, env });
    expect(result.exitCode).toBe(1);
    expect(result.lines.join("\n")).toContain("SUITE_RUN_ID must be a positive safe integer");
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
    ["privileged PR event", { event: "pull_request_target" }, /event/i],
    ["upstream failure", { conclusion: "failure" }, /success/i],
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

  it.each(["listing", "fresh read"])("accepts a cancelled suite superseded by a moved head in the %s", async (phase) => {
    const moved = { ...pr(), head: { ...pr().head, sha: "c".repeat(40) } };
    const h = harness({ ...suite(), conclusion: "cancelled" }, phase === "listing" ? [moved] : [pr()], moved);
    const dir = createOwnedTempDirectory(join(tmpdir(), "suite-cancelled-outputs-"));
    try {
      const output = join(dir, "output");
      writeFileSync(output, "earlier=true\n");
      const result = await resolveSuitePullRequest({ ...h.deps, env: { ...h.deps.env, GITHUB_OUTPUT: output } });
      expect(result.exitCode).toBe(0);
      expect(result.outputs).toEqual({ superseded: "true" });
      expect(readFileSync(output, "utf8")).toBe("earlier=true\nsuperseded=true\n");
      expect(result.lines.join("\n")).toContain("::notice::");
      expect(result.lines.join("\n")).toContain(moved.head.sha);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts a cancelled suite superseded by a higher-id pull_request suite at the same SHA", async () => {
    const h = harness({ ...suite(), conclusion: "cancelled" });
    const original = h.deps.fetchFn;
    h.deps.fetchFn = async (input, init) => {
      const url = new URL(String(input));
      if (!url.pathname.endsWith("/actions/workflows/pr-suite.yml/runs")) return original(input, init);
      expect(url.searchParams.get("head_sha")).toBe(HEAD);
      expect(url.searchParams.get("event")).toBe("pull_request");
      expect(new Headers(init?.headers).get("cache-control")).toBe("no-cache");
      return Response.json({ total_count: 2, workflow_runs: [suite(), { ...suite(), id: 124, status: "queued", conclusion: null }] });
    };
    const result = await resolveSuitePullRequest(h.deps);
    expect(result.exitCode).toBe(0);
    expect(result.outputs).toEqual({ superseded: "true" });
    expect(result.lines.join("\n")).toMatch(/::notice::.*run 124/);
  });

  it("fails a cancelled suite at the live head without a newer suite", async () => {
    const result = await resolveSuitePullRequest(harness({ ...suite(), conclusion: "cancelled" }).deps);
    expect(result.exitCode).toBe(1);
    expect(result.outputs).toBeUndefined();
    expect(result.lines.join("\n")).toMatch(/::error::.*success/);
  });

  it.each([
    ["missing", []], ["ambiguous", [pr(), { ...pr(), number: 1184 }]],
  ] as const)("fails a cancelled suite without an unambiguous PR binding (%s)", async (_label, candidates) => {
    const result = await resolveSuitePullRequest(harness({ ...suite(), conclusion: "cancelled" }, [...candidates]).deps);
    expect(result.exitCode).toBe(1);
    expect(result.outputs).toBeUndefined();
    expect(result.lines.join("\n")).toMatch(/no open pull request|ambiguous/);
  });

  it("fails closed on an API read failure during cancelled-suite supersession", async () => {
    const h = harness({ ...suite(), conclusion: "cancelled" });
    const original = h.deps.fetchFn;
    h.deps.fetchFn = async (input, init) => new URL(String(input)).pathname.endsWith("/actions/workflows/pr-suite.yml/runs")
      ? new Response("unavailable", { status: 503 }) : original(input, init);
    const result = await resolveSuitePullRequest(h.deps);
    expect(result.exitCode).toBe(1);
    expect(result.outputs).toBeUndefined();
    expect(result.lines.join("\n")).toMatch(/::error::.*HTTP 503/);
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
    const dir = createOwnedTempDirectory(join(tmpdir(), "suite-pr-outputs-"));
    try {
      const output = join(dir, "output");
      writeFileSync(output, "earlier=true\n");
      const h = harness();
      const result = await resolveSuitePullRequest({ ...h.deps, env: { ...h.deps.env, GITHUB_OUTPUT: output } });
      expect(result.exitCode).toBe(0);
      expect(readFileSync(output, "utf8")).toBe(`earlier=true\npr_number=1183\nhead_sha=${HEAD}\nbase_sha=${BASE}\nbase_ref=main\n`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe("transient read failures", () => {
    it.each([500, 502, 503, 504])("retries a %i read and resolves once it succeeds", async (status) => {
      const h = harness();
      const attempts = scriptRunReads(h, (n) => n === 0 ? new Response("unavailable", { status }) : undefined);
      const result = await resolveSuitePullRequest(h.deps);
      expect(result.exitCode).toBe(0);
      expect(result.outputs).toEqual({ pr_number: "1183", head_sha: HEAD, base_sha: BASE, base_ref: "main" });
      expect(attempts()).toBe(2);
      expect(h.sleeps).toEqual([1_000]);
    });

    it("retries a timed-out read and resolves once it succeeds", async () => {
      const h = harness();
      const attempts = scriptRunReads(h, (n) => n === 0 ? timedOut() : undefined);
      const result = await resolveSuitePullRequest(h.deps);
      expect(result.exitCode).toBe(0);
      expect(attempts()).toBe(2);
      expect(h.sleeps).toEqual([1_000]);
    });

    it("retries a plain network failure and resolves once it succeeds", async () => {
      const h = harness();
      const attempts = scriptRunReads(h, (n) => n === 0 ? new TypeError("fetch failed") : undefined);
      const result = await resolveSuitePullRequest(h.deps);
      expect(result.exitCode).toBe(0);
      expect(attempts()).toBe(2);
      expect(h.sleeps).toEqual([1_000]);
    });

    it("bounds every request with an abort signal", async () => {
      const h = harness();
      const original = h.deps.fetchFn;
      const signals: unknown[] = [];
      h.deps.fetchFn = async (input, init) => {
        signals.push(init?.signal);
        return original(input, init);
      };
      expect((await resolveSuitePullRequest(h.deps)).exitCode).toBe(0);
      expect(signals).toHaveLength(h.requests.length);
      expect(signals.every((signal) => signal instanceof AbortSignal)).toBe(true);
    });

    it("retries a body read that times out and resolves once it succeeds", async () => {
      const h = harness();
      const attempts = scriptRunReads(h, (n) => n === 0
        ? Object.assign(new Response("{}", { status: 200 }), { json: async () => { throw timedOut(); } })
        : undefined);
      const result = await resolveSuitePullRequest(h.deps);
      expect(result.exitCode).toBe(0);
      expect(attempts()).toBe(2);
      expect(h.sleeps).toEqual([1_000]);
    });

    it("fails a body whose parse throws a SyntaxError at once without retrying", async () => {
      const h = harness();
      const attempts = scriptRunReads(h, () =>
        Object.assign(new Response("{}", { status: 200 }), { json: async () => { throw new SyntaxError("Unexpected token"); } }));
      const result = await resolveSuitePullRequest(h.deps);
      expect(result.exitCode).toBe(1);
      expect(result.lines.join("\n")).toContain("Unexpected token");
      expect(attempts()).toBe(1);
      expect(h.sleeps).toEqual([]);
    });

    it.each([
      ["5xx", () => new Response("unavailable", { status: 503 }), /::error::.*HTTP 503/],
      ["timeout", timedOut, /::error::.*timeout/],
    ])("fails after three attempts on a persistent %s", async (_label, failure, message) => {
      const h = harness();
      const attempts = scriptRunReads(h, failure);
      const result = await resolveSuitePullRequest(h.deps);
      expect(result.exitCode).toBe(1);
      expect(result.outputs).toBeUndefined();
      expect(result.lines.join("\n")).toMatch(message);
      expect(attempts()).toBe(3);
      expect(h.sleeps).toEqual([1_000, 2_000]);
    });

    it.each([401, 403, 404])("fails a %i read at once without retrying", async (status) => {
      const h = harness();
      const attempts = scriptRunReads(h, () => new Response("denied", { status }));
      const result = await resolveSuitePullRequest(h.deps);
      expect(result.exitCode).toBe(1);
      expect(result.outputs).toBeUndefined();
      expect(result.lines.join("\n")).toContain(`HTTP ${status}`);
      expect(attempts()).toBe(1);
      expect(h.sleeps).toEqual([]);
    });

    it("fails a malformed body at once without retrying", async () => {
      const h = harness();
      const attempts = scriptRunReads(h, () => new Response("{not json", { status: 200 }));
      const result = await resolveSuitePullRequest(h.deps);
      expect(result.exitCode).toBe(1);
      expect(result.outputs).toBeUndefined();
      expect(result.lines.some((line) => line.startsWith("::error::"))).toBe(true);
      expect(attempts()).toBe(1);
      expect(h.sleeps).toEqual([]);
    });

    it("still refuses a mismatched run after a retried read", async () => {
      const h = harness({ ...suite(), id: 124 } as ReturnType<typeof suite>);
      const attempts = scriptRunReads(h, (n) => n === 0 ? new Response("unavailable", { status: 502 }) : undefined);
      const result = await resolveSuitePullRequest(h.deps);
      expect(result.exitCode).toBe(1);
      expect(result.outputs).toBeUndefined();
      expect(result.lines.join("\n")).toMatch(/::error::.*does not match SUITE_RUN_ID/);
      expect(attempts()).toBe(2);
      expect(h.requests).toHaveLength(1);
    });

    describe.each([
      ["cancel succeeds", undefined],
      ["cancel rejects", new Error("stream errored")],
    ])("rejected response body, %s", (_label, cancelFailure) => {
      it.each([
        ["a retried 5xx", 503, 1, 0, ["read 0", "cancelled 0", "sleep", "read 1"]],
        ["the final 5xx", 503, 3, 1,
          ["read 0", "cancelled 0", "sleep", "read 1", "cancelled 1", "sleep", "read 2", "cancelled 2"]],
        ["a 4xx", 404, 1, 1, ["read 0", "cancelled 0"]],
      ])("is cancelled before the next attempt or the failure on %s", async (_path, status, rejections, exitCode, expected) => {
        const h = harness();
        const events = rejectedReads(h, status, rejections, cancelFailure);
        const result = await resolveSuitePullRequest(h.deps);
        expect(result.exitCode).toBe(exitCode);
        expect(result.lines.some((line) => line.includes(`HTTP ${status}`))).toBe(exitCode === 1);
        expect(events).toEqual(expected);
      });
    });

    it.each([[503, 3, [1_000, 2_000]], [404, 1, []]])(
      "reports a bodiless %i response as the HTTP failure",
      async (status, expectedAttempts, expectedSleeps) => {
        const h = harness();
        const attempts = scriptRunReads(h, () => new Response(null, { status }));
        const result = await resolveSuitePullRequest(h.deps);
        expect(result.exitCode).toBe(1);
        expect(result.lines.join("\n")).toContain(`HTTP ${status}`);
        expect(attempts()).toBe(expectedAttempts);
        expect(h.sleeps).toEqual(expectedSleeps);
      },
    );
  });
});
