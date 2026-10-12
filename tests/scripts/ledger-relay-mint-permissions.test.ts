import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { runRelay } from "../../scripts/ledger-relay.ts";

/**
 * The relay's installation-token mint, pinned at issue 1051: the POST body
 * carries exactly the minimal permission set the two ledger scripts' GitHub
 * calls derive, and every call the relay makes under the minted token is
 * covered by that set — the enumeration in APP_TOKEN_CALL_PERMISSIONS is the
 * test constant the code's actual calls are asserted against, so a NEW call
 * without a matching permission update fails the suite, and a permission the
 * calls no longer need fails the union assertion.
 */

const HEAD_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const RUN_ID = "9001";
const HTML_URL = `https://github.com/Nitjsefnie/Overflow/actions/runs/${RUN_ID}`;
const TOKEN_URL = "https://api.github.com/app/installations/166057493/access_tokens";

const PATH_CI = ".github/workflows/ci.yml";
const PATH_ACTIONLINT = ".github/workflows/actionlint.yml";
const PIN_MAP = {
  verify: PATH_CI,
  "ratchet-guard": ".github/workflows/ratchet-guard.yml",
  actionlint: PATH_ACTIONLINT,
};

/**
 * Every GitHub API call the ledger scripts make under the minted installation
 * token, and the documented permission each needs. THE ENUMERATION: the tests
 * below assert the code's actual App-token calls against this map in both
 * directions, so the map cannot drift from the code silently. checks:read is
 * written out because the check-runs listing reads; the minted `checks:
 * write` covers it.
 */
const APP_TOKEN_CALL_PERMISSIONS: Record<string, readonly string[]> = {
  "GET run": ["actions:read"],
  "GET jobs": ["actions:read"],
  "GET runs listing": ["actions:read"],
  "GET commit check-runs": ["checks:read"],
  "POST check-runs": ["checks:write"],
  "GET commit pulls": ["pull_requests:read"],
  "GET fork-head pulls": ["pull_requests:read"],
};

/**
 * The permission levels each minted grant covers: write covers read, and a
 * grant covers itself.
 */
function mintCovers(minted: Record<string, string>, needed: string): boolean {
  const [name, level] = needed.split(":");
  const granted = minted[name];
  if (granted === undefined) return false;
  if (granted === level) return true;
  return granted === "write" && level === "read";
}

/** The minimal permission set the two mints request (issue 1051). */
const MINTED = {
  actions: "read",
  checks: "write",
  metadata: "read",
  pull_requests: "read",
} as const;

interface Recorded {
  url: string;
  init: RequestInit;
}

const keyPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

type Outcome = { status: number; body: unknown } | { fail: Error };

function makeFetch(outcomes: Outcome[]) {
  const requests: Recorded[] = [];
  const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
    const rendered = typeof url === "string" ? url : String(url);
    requests.push({ url: rendered, init: init ?? {} });
    const outcome = outcomes.shift();
    if (!outcome) throw new Error(`unexpected fetch: ${rendered}`);
    if ("fail" in outcome) throw outcome.fail;
    return new Response(JSON.stringify(outcome.body), {
      status: outcome.status,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { requests, fn };
}

function makeDelay() {
  const delays: number[] = [];
  return { delays, fn: async (ms: number) => void delays.push(ms) };
}

function relayEnv(over: Record<string, string> = {}): Record<string, string> {
  return {
    LEDGER_APP_ID: "5118623",
    LEDGER_INSTALLATION_ID: "166057493",
    LEDGER_APP_KEY: keyPem,
    GITHUB_REPOSITORY: "Nitjsefnie/Overflow",
    GITHUB_WORKFLOW_RUN_ID: RUN_ID,
    GITHUB_WORKFLOW_RUN_HEAD_SHA: HEAD_SHA,
    GITHUB_WORKFLOW_RUN_PATH: PATH_CI,
    GITHUB_WORKFLOW_RUN_CONCLUSION: "success",
    GITHUB_WORKFLOW_RUN_HTML_URL: HTML_URL,
    GITHUB_WORKFLOW_RUN_EVENT: "push",
    GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "main",
    ...over,
  };
}

function dispatchEnv(over: Record<string, string> = {}): Record<string, string> {
  return relayEnv({
    GITHUB_WORKFLOW_RUN_ID: "",
    GITHUB_WORKFLOW_RUN_HEAD_SHA: "",
    GITHUB_WORKFLOW_RUN_PATH: "",
    GITHUB_WORKFLOW_RUN_CONCLUSION: "",
    GITHUB_WORKFLOW_RUN_HTML_URL: "",
    GITHUB_WORKFLOW_RUN_EVENT: "",
    GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "",
    LEDGER_DISPATCH_RUN_ID: RUN_ID,
    ...over,
  });
}

/** The workflow_run trigger's cancelled-PR heal candidate. */
function workflowRunHealEnv(): Record<string, string> {
  return relayEnv({
    GITHUB_WORKFLOW_RUN_CONCLUSION: "cancelled",
    GITHUB_WORKFLOW_RUN_EVENT: "pull_request_target",
    GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "feature/some-branch",
    GITHUB_WORKFLOW_RUN_ATTEMPT: "1",
    RELAY_RERUN_TOKEN: "rerun-token",
  });
}

/** The scheduled sweep-only start (issue 1116): no triggering run at all. */
function sweepOnlyEnv(): Record<string, string> {
  return relayEnv({
    GITHUB_WORKFLOW_RUN_ID: "",
    GITHUB_WORKFLOW_RUN_HEAD_SHA: "",
    GITHUB_WORKFLOW_RUN_PATH: "",
    GITHUB_WORKFLOW_RUN_CONCLUSION: "",
    GITHUB_WORKFLOW_RUN_HTML_URL: "",
    GITHUB_WORKFLOW_RUN_EVENT: "",
    GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "",
    LEDGER_DISPATCH_RUN_ID: "",
    LEDGER_SWEEP_ONLY: "true",
  });
}

function token(): Outcome {
  return { status: 201, body: { token: "installation-token" } };
}

function jobEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "verify",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    ...over,
  };
}

function jobsListing(jobs: Array<Record<string, unknown>>): Outcome {
  return { status: 200, body: { total_count: jobs.length, jobs } };
}

function sweepRun(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    path: PATH_CI,
    status: "completed",
    conclusion: "success",
    head_sha: HEAD_SHA,
    html_url: `https://github.com/Nitjsefnie/Overflow/actions/runs/${id}`,
    event: "pull_request_target",
    head_branch: "feature/some-branch",
    ...over,
  };
}

function sweepListing(runs: Array<Record<string, unknown>>): Outcome {
  return { status: 200, body: { total_count: runs.length, workflow_runs: runs } };
}

function checkRunsListing(names: Array<string>): Outcome {
  return {
    status: 200,
    body: {
      total_count: names.length,
      check_runs: names.map((name) => ({ name, app: { id: 5118623 } })),
    },
  };
}

function pullEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { state: "open", head: { sha: HEAD_SHA }, ...over };
}

function pullsListing(pulls: Array<Record<string, unknown>>): Outcome {
  return { status: 200, body: pulls };
}

function runsListing(runs: Array<Record<string, unknown>>): Outcome {
  return { status: 200, body: { total_count: runs.length, workflow_runs: runs } };
}

function fetchedRunBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: Number(RUN_ID),
    head_sha: HEAD_SHA,
    path: PATH_CI,
    conclusion: "success",
    html_url: HTML_URL,
    event: "push",
    head_branch: "main",
    head_repository: { full_name: "Nitjsefnie/Overflow" },
    ...over,
  };
}

function fetchedRun(over: Record<string, unknown> = {}): Outcome {
  return { status: 200, body: fetchedRunBody(over) };
}

function requestTo(requests: Recorded[], url: string): Recorded | undefined {
  return requests.find((request) => request.url === url);
}

function authHeaderOf(request: Recorded | undefined): string {
  if (request === undefined) return "";
  const headers = request.init.headers as Record<string, string>;
  return String(headers.authorization ?? "");
}

/** The only host any minted-token call may touch. */
const GITHUB_API_HOST = "api.github.com";

/**
 * The (method, endpoint-shape) key a call classifies to, over the URL's path
 * only — ids and SHAs are normalized away. Both axes are exact: every branch
 * demands its HTTP method (a DELETE against an enumerated path is NOT the
 * enumerated GET — a method-blind classifier blessed a token exercising
 * actions: write), and any host other than the GitHub API host is rejected
 * outright (a host-blind classifier blessed a token sent to any other host).
 * Undefined for a call outside the enumeration, which the assertions below
 * read as an UNENUMERATED call.
 */
function classifyCall(url: string, method: string): string | undefined {
  const parsed = new URL(url);
  if (parsed.host !== GITHUB_API_HOST) return undefined;
  const path = parsed.pathname;
  const repo = "/repos/Nitjsefnie/Overflow";
  if (method === "POST" && path === `${repo}/check-runs`) return "POST check-runs";
  if (
    method === "POST" &&
    path.startsWith("/app/installations/") &&
    path.endsWith("/access_tokens")
  ) {
    return "POST mint";
  }
  if (
    method === "POST" &&
    path.startsWith(`${repo}/actions/runs/`) &&
    path.endsWith("/rerun")
  ) {
    return "POST rerun";
  }
  if (method === "GET" && path.startsWith(`${repo}/actions/runs/`) && path.endsWith("/jobs")) {
    return "GET jobs";
  }
  if (method === "GET" && path.startsWith(`${repo}/actions/runs/`)) return "GET run";
  if (method === "GET" && path === `${repo}/actions/runs`) return "GET runs listing";
  if (method === "GET" && path.startsWith(`${repo}/commits/`) && path.endsWith("/check-runs")) {
    return "GET commit check-runs";
  }
  if (method === "GET" && path.startsWith(`${repo}/commits/`) && path.endsWith("/pulls")) {
    return "GET commit pulls";
  }
  if (method === "GET" && path === `${repo}/pulls`) return "GET fork-head pulls";
  return undefined;
}

async function runDispatchFlow(): Promise<Recorded[]> {
  const fetchStub = makeFetch([
    token(),
    // The dispatch path's run fetch: a heal candidate that never started —
    // no run_started_at — so the heal's own queries run below.
    fetchedRun({
      conclusion: "cancelled",
      event: "pull_request_target",
      head_branch: "feature/some-branch",
      run_attempt: 1,
    }),
    jobsListing([]),
    { status: 201, body: { id: 1 } },
    // The sweep with one orphan at another commit: check-runs GET, jobs GET,
    // check-run POST.
    sweepListing([sweepRun(9002, { head_sha: OTHER_SHA })]),
    checkRunsListing([]),
    jobsListing([jobEntry({})]),
    { status: 201, body: { id: 2 } },
    // The heal's queries and its rerun.
    pullsListing([pullEntry()]),
    runsListing([]),
    { status: 202, body: undefined },
  ]);
  await runRelay({
    env: dispatchEnv({ RELAY_RERUN_TOKEN: "rerun-token" }),
    fetchFn: fetchStub.fn,
    delayFn: makeDelay().fn,
    readPinMap: async () => PIN_MAP,
  });
  return fetchStub.requests;
}

async function runForkRefusalFlow(): Promise<Recorded[]> {
  const fetchStub = makeFetch([
    token(),
    fetchedRun({
      event: "pull_request",
      head_branch: "some-branch",
      head_repository: { full_name: "someone/some-fork", owner: { login: "someone" } },
    }),
    // The fork path re-fetches the run body to prove the owner's login.
    fetchedRun({
      event: "pull_request",
      head_branch: "some-branch",
      head_repository: { full_name: "someone/some-fork", owner: { login: "someone" } },
    }),
    { status: 200, body: [] },
  ]);
  const result = await runRelay({
    env: dispatchEnv(),
    fetchFn: fetchStub.fn,
    delayFn: makeDelay().fn,
    readPinMap: async () => PIN_MAP,
  });
  expect(result.posted).toEqual([]);
  return fetchStub.requests;
}

/** The workflow_run trigger's full relay: mirror, sweep with an orphan, heal. */
async function runWorkflowRunFlow(): Promise<Recorded[]> {
  const fetchStub = makeFetch([
    token(),
    jobsListing([]),
    { status: 201, body: { id: 3 } },
    sweepListing([sweepRun(9002, { head_sha: OTHER_SHA })]),
    checkRunsListing([]),
    jobsListing([jobEntry({})]),
    { status: 201, body: { id: 4 } },
    pullsListing([pullEntry()]),
    runsListing([]),
    { status: 202, body: undefined },
  ]);
  const result = await runRelay({
    env: workflowRunHealEnv(),
    fetchFn: fetchStub.fn,
    delayFn: makeDelay().fn,
    readPinMap: async () => PIN_MAP,
  });
  expect(result.posted).toEqual(["verify"]);
  expect(result.rerunDispatched).toBe(true);
  return fetchStub.requests;
}

/** The scheduled sweep-only start (issue 1116): mint and sweep, nothing else. */
async function runSweepOnlyFlow(): Promise<Recorded[]> {
  const fetchStub = makeFetch([
    token(),
    sweepListing([sweepRun(9002, { head_sha: OTHER_SHA })]),
    checkRunsListing([]),
    jobsListing([jobEntry({})]),
    { status: 201, body: { id: 5 } },
  ]);
  const result = await runRelay({
    env: sweepOnlyEnv(),
    fetchFn: fetchStub.fn,
    delayFn: makeDelay().fn,
    readPinMap: async () => PIN_MAP,
  });
  expect(result.sweepOnly).toBe(true);
  expect(result.sweep.relayed).toHaveLength(1);
  return fetchStub.requests;
}

describe("classifyCall rejects what the enumeration must never bless", () => {
  it.each([
    [
      "the adversary's mutant: a DELETE against an enumerated run path (needs actions: write)",
      "https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs/9001",
      "DELETE",
    ],
    [
      "a POST against an enumerated run path",
      "https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs/9001",
      "POST",
    ],
    [
      "a PATCH against the check-runs path",
      "https://api.github.com/repos/Nitjsefnie/Overflow/check-runs",
      "PATCH",
    ],
    [
      "the adversary's mutant: any call to a host outside the GitHub API",
      "https://evil.example/repos/Nitjsefnie/Overflow/actions/runs/9001",
      "GET",
    ],
    [
      "a check-run POST to a lookalike path on another host",
      "https://evil.example/repos/Nitjsefnie/Overflow/check-runs",
      "POST",
    ],
    [
      "a GET on the access_tokens mint path",
      "https://api.github.com/app/installations/166057493/access_tokens",
      "GET",
    ],
    ["a path the enumeration does not name", "https://api.github.com/repos/Nitjsefnie/Overflow/contents", "GET"],
  ])("refuses %s", (_name, url, method) => {
    expect(classifyCall(url, method)).toBeUndefined();
  });

  it.each([
    [
      "the enumerated GET run",
      "https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs/9001",
      "GET",
      "GET run",
    ],
    [
      "the enumerated check-run POST",
      "https://api.github.com/repos/Nitjsefnie/Overflow/check-runs",
      "POST",
      "POST check-runs",
    ],
    [
      "the mint POST",
      "https://api.github.com/app/installations/166057493/access_tokens",
      "POST",
      "POST mint",
    ],
  ])("still classifies %s", (_name, url, method, expected) => {
    expect(classifyCall(url, method)).toBe(expected);
  });
});

describe("the relay's installation-token mint (issue 1051)", () => {
  it("requests exactly the derived minimal permission set beside the repository", async () => {
    const requests = await runDispatchFlow();
    const mint = requestTo(requests, TOKEN_URL);
    expect(mint).toBeDefined();
    expect(JSON.parse(String(mint?.init.body))).toEqual({
      repositories: ["Overflow"],
      permissions: { ...MINTED },
    });
  });

  it("authenticates the mint with the App JWT and never the installation token", async () => {
    const requests = await runDispatchFlow();
    const mint = authHeaderOf(requestTo(requests, TOKEN_URL));
    const minted = mint.startsWith("Bearer ") && mint.split(".").length === 3;
    expect(minted, "the mint's authorization is a three-part JWT").toBe(true);
    expect(mint).not.toBe("Bearer installation-token");
  });

  it("covers every App-token call the flows make, and nothing the enumeration lacks", async () => {
    const requests = [
      ...(await runDispatchFlow()),
      ...(await runWorkflowRunFlow()),
      ...(await runSweepOnlyFlow()),
      ...(await runForkRefusalFlow()),
    ];
    const seen = new Set<string>();
    for (const request of requests) {
      const key = classifyCall(request.url, String(request.init.method));
      expect(
        key,
        `an unenumerated call: ${String(request.init.method)} ${request.url}`,
      ).toBeDefined();
      if (key === undefined) continue;
      if (key === "POST mint") {
        // The mint runs under the App JWT, not the token it mints.
        expect(authHeaderOf(request)).not.toBe("Bearer installation-token");
        continue;
      }
      if (key === "POST rerun") {
        // The rerun authenticates with the workflow's own RELAY_RERUN_TOKEN
        // (actions: write, which the App does not hold), so it is the one
        // relay shape deliberately outside the App token's enumeration.
        expect(authHeaderOf(request)).toBe("Bearer rerun-token");
        continue;
      }
      expect(authHeaderOf(request), `${key} runs under the installation token`).toBe(
        "Bearer installation-token",
      );
      seen.add(key);
    }
    // Both directions: the flows exercise every enumerated shape, and the
    // enumeration names no shape the flows do not make.
    expect(new Set(Object.keys(APP_TOKEN_CALL_PERMISSIONS))).toEqual(seen);
  });

  it("mints exactly the union of the enumerated calls' needs", () => {
    const minted: Record<string, string> = { ...MINTED };
    // metadata: read is granted to every installation token by GitHub
    // regardless of the request; it is pinned in the body above and needs no
    // call to justify it.
    delete minted.metadata;
    for (const [key, needed] of Object.entries(APP_TOKEN_CALL_PERMISSIONS)) {
      for (const permission of needed) {
        expect(
          mintCovers(minted, permission),
          `${key} needs ${permission}; the mint does not grant it`,
        ).toBe(true);
      }
    }
    // No dead permission either: every granted name is some call's need.
    const needed = new Set(
      Object.values(APP_TOKEN_CALL_PERMISSIONS).flatMap((levels) =>
        levels.map((level) => level.split(":")[0]),
      ),
    );
    for (const name of Object.keys(minted)) {
      expect(needed.has(name), `${name} is minted but no enumerated call needs it`).toBe(true);
    }
  });
});
