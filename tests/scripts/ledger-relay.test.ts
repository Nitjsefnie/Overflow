import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  decideContexts,
  decideRerun,
  mintAppJwt,
  RERUN_ATTEMPT_CAP,
  runRelay,
  type RelayJob,
} from "../../scripts/ledger-relay.ts";

/**
 * The ledger relay (issue 708): decideContexts mirrors the triggering run's
 * producing jobs into per-context decisions; mintAppJwt shapes the GitHub App
 * JWT; runRelay mints an installation token, reads the jobs listing and posts
 * one check-run per pinned context — all through an injected fetch, never the
 * network. Issue 861 adds the rerun-heal: decideRerun is the pure decision,
 * and runRelay dispatches the rerun for a cancelled pending PR run at a live,
 * unmatched head.
 */

const PATH_CI = ".github/workflows/ci.yml";
const PATH_ACTIONLINT = ".github/workflows/actionlint.yml";

const PIN_MAP = {
  verify: PATH_CI,
  "ratchet-guard": ".github/workflows/ratchet-guard.yml",
  actionlint: PATH_ACTIONLINT,
};

function job(over: Partial<RelayJob>): RelayJob {
  return {
    name: "verify",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    ...over,
  };
}

describe("decideRerun", () => {
  const HEAD = "c".repeat(40);

  function healRun(
    over: Partial<{ conclusion: string | null; event: string; runAttempt: number; headSha: string }> = {},
  ) {
    return { conclusion: "cancelled", event: "pull_request", runAttempt: 1, headSha: HEAD, ...over };
  }

  it.each([
    [
      "heals a cancelled pending pull_request run at a live, unmatched head",
      healRun(),
      { state: "open", headSha: HEAD },
      false,
      true,
    ],
    [
      "heals a cancelled pull_request_target run at a live, unmatched head",
      healRun({ event: "pull_request_target" }),
      { state: "open", headSha: HEAD },
      false,
      true,
    ],
    [
      "does not heal a superseded head — the open PR's tip has moved on",
      healRun(),
      { state: "open", headSha: "d".repeat(40) },
      false,
      false,
    ],
    [
      "does not heal a closed PR at the head",
      healRun(),
      { state: "closed", headSha: HEAD },
      false,
      false,
    ],
    [
      "does not heal when no PR is associated with the head",
      healRun(),
      null,
      false,
      false,
    ],
    [
      "does not heal a push run",
      healRun({ event: "push" }),
      { state: "open", headSha: HEAD },
      false,
      false,
    ],
    [
      "does not heal a workflow_dispatch run",
      healRun({ event: "workflow_dispatch" }),
      { state: "open", headSha: HEAD },
      false,
      false,
    ],
    [
      "does not heal a successful run",
      healRun({ conclusion: "success" }),
      { state: "open", headSha: HEAD },
      false,
      false,
    ],
    [
      "does not heal a failed run",
      healRun({ conclusion: "failure" }),
      { state: "open", headSha: HEAD },
      false,
      false,
    ],
    [
      "does not heal a run without a conclusion",
      healRun({ conclusion: null }),
      { state: "open", headSha: HEAD },
      false,
      false,
    ],
    [
      "does not heal a run at the attempt cap",
      healRun({ runAttempt: 5 }),
      { state: "open", headSha: HEAD },
      false,
      false,
    ],
    [
      "heals a run just under the attempt cap",
      healRun({ runAttempt: 4 }),
      { state: "open", headSha: HEAD },
      false,
      true,
    ],
    [
      "does not heal when a live run of the same workflow already holds the head",
      healRun(),
      { state: "open", headSha: HEAD },
      true,
      false,
    ],
  ])("%s", (_name, run, pr, liveRunExists, expected) => {
    expect(decideRerun(run, pr, liveRunExists)).toBe(expected);
  });

  it("caps exactly at RERUN_ATTEMPT_CAP, which is 5", () => {
    expect(RERUN_ATTEMPT_CAP).toBe(5);
    const live = { state: "open", headSha: HEAD };
    expect(decideRerun(healRun({ runAttempt: RERUN_ATTEMPT_CAP }), live, false)).toBe(false);
    expect(decideRerun(healRun({ runAttempt: RERUN_ATTEMPT_CAP - 1 }), live, false)).toBe(true);
  });
});

describe("decideContexts", () => {
  it("returns decisions only for the contexts pinned to the triggering run's path", () => {
    const decisions = decideContexts(PIN_MAP, PATH_CI, "success", [
      job({}),
      job({ name: "actionlint" }),
    ]);
    expect(decisions.map((decision) => decision.context)).toEqual(["verify"]);
  });

  it("keeps pin-map order for several contexts sharing one path", () => {
    const decisions = decideContexts(
      { "z-context": PATH_CI, "a-context": PATH_CI },
      PATH_CI,
      "success",
      [job({}), job({ name: "a-context" })],
    );
    expect(decisions.map((decision) => decision.context)).toEqual(["z-context", "a-context"]);
  });

  it.each([
    ["success", "success"],
    ["failure", "failure"],
    ["cancelled", "cancelled"],
    ["skipped", "skipped"],
  ])("mirrors a completed job's %s conclusion", (jobConclusion, expected) => {
    const decisions = decideContexts(PIN_MAP, PATH_CI, "success", [
      job({ status: "completed", conclusion: jobConclusion }),
    ]);
    expect(decisions).toEqual([
      {
        context: "verify",
        status: "completed",
        conclusion: expected,
        title: expect.any(String),
        summary: expect.any(String),
      },
    ]);
  });

  it.each(["queued", "in_progress"] as const)(
    "posts the pending %s status without a conclusion",
    (pendingStatus) => {
      const decisions = decideContexts(PIN_MAP, PATH_CI, "success", [
        job({ status: pendingStatus, conclusion: null }),
      ]);
      expect(decisions).toEqual([
        {
          context: "verify",
          status: pendingStatus,
          title: expect.any(String),
          summary: expect.any(String),
        },
      ]);
      expect(Object.hasOwn(decisions[0] ?? {}, "conclusion")).toBe(false);
    },
  );

  it("picks the job with the highest run_attempt, whatever it concluded", () => {
    const decisions = decideContexts(PIN_MAP, PATH_CI, "success", [
      job({ run_attempt: 1, status: "completed", conclusion: "success" }),
      job({ run_attempt: 2, status: "completed", conclusion: "failure" }),
    ]);
    expect(decisions[0]?.conclusion).toBe("failure");
  });

  it("prefers a non-success over a success on an attempt tie, in either listing order", () => {
    for (const order of ["failure-first", "success-first"] as const) {
      const jobs =
        order === "failure-first"
          ? [
              job({ run_attempt: 2, status: "completed", conclusion: "failure" }),
              job({ run_attempt: 2, status: "completed", conclusion: "success" }),
            ]
          : [
              job({ run_attempt: 2, status: "completed", conclusion: "success" }),
              job({ run_attempt: 2, status: "completed", conclusion: "failure" }),
            ];
      const decisions = decideContexts(PIN_MAP, PATH_CI, "success", jobs);
      expect(decisions[0]?.conclusion, order).toBe("failure");
    }
  });

  it("reports failure naming the missing job when the run has jobs but none matches the context", () => {
    const decisions = decideContexts(PIN_MAP, PATH_CI, "success", [
      job({ name: "renamed-verify" }),
    ]);
    expect(decisions).toEqual([
      {
        context: "verify",
        status: "completed",
        conclusion: "failure",
        title: expect.any(String),
        summary: expect.any(String),
      },
    ]);
    // The renamed producer must be visible to the operator debugging the
    // blocked merge: the summary names the context the run failed to produce.
    expect(decisions[0]?.summary).toContain("verify");
  });

  it("fails every pinned context when the run concluded non-success with no jobs", () => {
    for (const conclusion of ["failure", "cancelled", null]) {
      const decisions = decideContexts(PIN_MAP, PATH_CI, conclusion, []);
      expect(decisions.map((decision) => decision.context)).toEqual(["verify"]);
      expect(decisions.every((decision) => decision.status === "completed")).toBe(true);
      expect(decisions.every((decision) => decision.conclusion === "failure")).toBe(true);
    }
  });

  it("mirrors a run-level success when the run concluded success with no jobs", () => {
    const decisions = decideContexts(PIN_MAP, PATH_CI, "success", []);
    expect(decisions.map((decision) => decision.conclusion)).toEqual(["success"]);
  });

  it("decides only from jobs named exactly the context", () => {
    const decisions = decideContexts(PIN_MAP, PATH_CI, "success", [
      job({ name: "Verify" }),
      job({ name: "verify " }),
      job({ name: "verify (false)" }),
    ]);
    expect(decisions[0]?.conclusion).toBe("failure");
  });
});

describe("mintAppJwt", () => {
  let keyPem = "";
  let publicKeyPem = "";

  beforeAll(() => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  });

  function decodeSegment(segment: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  }

  function verifies(jwt: string, pem: string): boolean {
    const [header, payload, signature] = jwt.split(".");
    if (header === undefined || payload === undefined || signature === undefined) return false;
    return createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(pem, Buffer.from(signature, "base64url"));
  }

  it("carries the RS256 header, the iat/exp offsets and the app id as iss", () => {
    const nowMs = 1_793_000_000_000;
    const jwt = mintAppJwt("5118623", keyPem, nowMs);
    const [header, payload, signature] = jwt.split(".");
    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();
    expect(decodeSegment(header ?? "")).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeSegment(payload ?? "")).toEqual({
      iat: Math.floor(nowMs / 1000) - 60,
      exp: Math.floor(nowMs / 1000) + 540,
      iss: "5118623",
    });
  });

  it("produces a signature that verifies against the minting key's public half", () => {
    const jwt = mintAppJwt("5118623", keyPem, Date.now());
    expect(verifies(jwt, publicKeyPem)).toBe(true);
  });

  it("fails verification when the payload is tampered with or the key differs", () => {
    const nowMs = Date.now();
    const jwt = mintAppJwt("5118623", keyPem, nowMs);
    const [header, , signature] = jwt.split(".");
    const forged = `${header}.${Buffer.from(
      JSON.stringify({ iat: 1, exp: 2, iss: "someone-else" }),
    ).toString("base64url")}.${signature}`;
    expect(verifies(forged, publicKeyPem)).toBe(false);

    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const otherPem = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(verifies(mintAppJwt("5118623", otherPem, nowMs), publicKeyPem)).toBe(false);
  });
});

/**
 * The posting half, against an injected fetch. Every response is queued
 * up front; a request past the queue fails the test instead of the run.
 */
describe("runRelay", () => {
  let keyPem = "";

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  });

  const HEAD_SHA = "a".repeat(40);
  const RUN_ID = "9001";
  const HTML_URL = `https://github.com/Nitjsefnie/Overflow/actions/runs/${RUN_ID}`;
  const TOKEN_URL = "https://api.github.com/app/installations/166057493/access_tokens";
  const JOBS_URL = `https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs/${RUN_ID}/jobs?filter=latest&per_page=100`;
  const CHECK_RUNS_URL = "https://api.github.com/repos/Nitjsefnie/Overflow/check-runs";
  const RUN_URL = `https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs/${RUN_ID}`;

  interface Recorded {
    url: string;
    init: RequestInit;
  }

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
      ...over,
    };
  }

  function token(): Outcome {
    return { status: 201, body: { token: "installation-token" } };
  }

  function jobsListing(jobs: RelayJob[]): Outcome {
    return { status: 200, body: { total_count: jobs.length, jobs } };
  }

  function headersOf(request: Recorded): Record<string, string> {
    return request.init.headers as Record<string, string>;
  }

  function bodiesOf(requests: Recorded[]): Array<Record<string, unknown>> {
    return requests
      .filter((request) => request.url === CHECK_RUNS_URL)
      .map((request) => JSON.parse(String(request.init.body)) as Record<string, unknown>);
  }

  it("mints the installation token, reads the jobs and posts one check-run per pinned context", async () => {
    const fetchStub = makeFetch([
      token(),
      jobsListing([job({ run_attempt: 3 })]),
      { status: 201, body: { id: 1 } },
    ]);
    const delay = makeDelay();
    const result = await runRelay({
      env: relayEnv(),
      fetchFn: fetchStub.fn,
      delayFn: delay.fn,
      readPinMap: async () => PIN_MAP,
    });

    expect(result.posted).toEqual(["verify"]);
    expect(fetchStub.requests.map((request) => request.url)).toEqual([
      TOKEN_URL,
      JOBS_URL,
      CHECK_RUNS_URL,
    ]);

    const [mint, jobsRequest] = fetchStub.requests;
    // The App JWT authenticates the mint; the minted token authenticates
    // everything after it.
    expect(mint?.init.method).toBe("POST");
    expect(headersOf(mint ?? { url: "", init: {} }).authorization).toMatch(/^Bearer /);
    const mintJwt = String(headersOf(mint ?? { url: "", init: {} }).authorization).slice(7);
    const payload = JSON.parse(
      Buffer.from(mintJwt.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(payload.iss).toBe("5118623");
    expect(JSON.parse(String(mint?.init.body))).toEqual({ repositories: ["Overflow"] });

    expect(jobsRequest?.init.method).toBe("GET");
    expect(headersOf(jobsRequest ?? { url: "", init: {} }).authorization).toBe(
      "Bearer installation-token",
    );

    expect(bodiesOf(fetchStub.requests)).toEqual([
      {
        name: "verify",
        head_sha: HEAD_SHA,
        status: "completed",
        conclusion: "success",
        details_url: HTML_URL,
        output: { title: expect.any(String), summary: expect.any(String) },
      },
    ]);
    expect(delay.delays).toEqual([]);
  });

  it("sends the GitHub API media type and api-version headers on every call", async () => {
    const fetchStub = makeFetch([token(), jobsListing([job({})]), { status: 201, body: { id: 1 } }]);
    await runRelay({
      env: relayEnv(),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => PIN_MAP,
    });
    for (const request of fetchStub.requests) {
      expect(headersOf(request)).toMatchObject({
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      });
    }
  });

  it("posts a pending status without a conclusion while the producing job runs", async () => {
    const fetchStub = makeFetch([
      token(),
      jobsListing([job({ status: "in_progress", conclusion: null })]),
      { status: 201, body: { id: 1 } },
    ]);
    const result = await runRelay({
      env: relayEnv(),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => PIN_MAP,
    });
    expect(result.posted).toEqual(["verify"]);
    const [body] = bodiesOf(fetchStub.requests);
    expect(body).toMatchObject({ name: "verify", status: "in_progress", head_sha: HEAD_SHA });
    expect(Object.hasOwn(body ?? {}, "conclusion")).toBe(false);
  });

  it("posts against the triggering run's head SHA, never a merge ref", async () => {
    const prHeadSha = "b".repeat(40);
    const fetchStub = makeFetch([
      token(),
      jobsListing([job({})]),
      { status: 201, body: { id: 1 } },
    ]);
    await runRelay({
      env: relayEnv({ GITHUB_WORKFLOW_RUN_HEAD_SHA: prHeadSha }),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => PIN_MAP,
    });
    expect(bodiesOf(fetchStub.requests).every((body) => body.head_sha === prHeadSha)).toBe(true);
  });

  it("retries a 500 once, with the recorded backoff, and succeeds", async () => {
    const fetchStub = makeFetch([
      token(),
      jobsListing([job({})]),
      { status: 500, body: { message: "boom" } },
      { status: 201, body: { id: 1 } },
    ]);
    const delay = makeDelay();
    const result = await runRelay({
      env: relayEnv(),
      fetchFn: fetchStub.fn,
      delayFn: delay.fn,
      readPinMap: async () => PIN_MAP,
    });
    expect(result.posted).toEqual(["verify"]);
    const postings = fetchStub.requests.filter((request) => request.url === CHECK_RUNS_URL);
    expect(postings).toHaveLength(2);
    expect(delay.delays).toEqual([1000]);
  });

  it("retries a network error once and succeeds", async () => {
    const fetchStub = makeFetch([
      token(),
      jobsListing([job({})]),
      { fail: new TypeError("fetch failed") },
      { status: 201, body: { id: 1 } },
    ]);
    const delay = makeDelay();
    const result = await runRelay({
      env: relayEnv(),
      fetchFn: fetchStub.fn,
      delayFn: delay.fn,
      readPinMap: async () => PIN_MAP,
    });
    expect(result.posted).toEqual(["verify"]);
    expect(delay.delays).toEqual([1000]);
  });

  it("fails immediately on a non-retryable 422", async () => {
    const fetchStub = makeFetch([
      token(),
      jobsListing([job({})]),
      { status: 422, body: { message: "invalid" } },
    ]);
    const delay = makeDelay();
    await expect(
      runRelay({
        env: relayEnv(),
        fetchFn: fetchStub.fn,
        delayFn: delay.fn,
        readPinMap: async () => PIN_MAP,
      }),
    ).rejects.toThrow(/422/);
    const postings = fetchStub.requests.filter((request) => request.url === CHECK_RUNS_URL);
    expect(postings).toHaveLength(1);
    expect(delay.delays).toEqual([]);
  });

  it("exhausts three attempts on a 500 and rejects loudly without leaking the key", async () => {
    const fetchStub = makeFetch([
      token(),
      jobsListing([job({})]),
      { status: 500, body: { message: "boom" } },
      { status: 500, body: { message: "boom" } },
      { status: 500, body: { message: "boom" } },
    ]);
    const delay = makeDelay();
    const error = await runRelay({
      env: relayEnv(),
      fetchFn: fetchStub.fn,
      delayFn: delay.fn,
      readPinMap: async () => PIN_MAP,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("verify");
    expect((error as Error).message).toContain("HTTP 500");
    // The failure names what failed, never the material that authenticated it.
    expect((error as Error).message).not.toContain(keyPem);
    const postings = fetchStub.requests.filter((request) => request.url === CHECK_RUNS_URL);
    expect(postings).toHaveLength(3);
    expect(delay.delays).toEqual([1000, 2000]);
  });

  it("recovers a dead posting through the dispatch path, re-reading the named run", async () => {
    const fetchStub = makeFetch([
      token(),
      {
        status: 200,
        body: {
          id: Number(RUN_ID),
          head_sha: HEAD_SHA,
          path: PATH_CI,
          conclusion: "success",
          html_url: HTML_URL,
          event: "push",
        },
      },
      jobsListing([job({})]),
      { status: 201, body: { id: 1 } },
    ]);
    const delay = makeDelay();
    const result = await runRelay({
      env: relayEnv({
        GITHUB_WORKFLOW_RUN_ID: "",
        GITHUB_WORKFLOW_RUN_HEAD_SHA: "",
        GITHUB_WORKFLOW_RUN_PATH: "",
        GITHUB_WORKFLOW_RUN_CONCLUSION: "",
        GITHUB_WORKFLOW_RUN_HTML_URL: "",
        GITHUB_WORKFLOW_RUN_EVENT: "",
        LEDGER_DISPATCH_RUN_ID: RUN_ID,
      }),
      fetchFn: fetchStub.fn,
      delayFn: delay.fn,
      readPinMap: async () => PIN_MAP,
    });
    expect(result.posted).toEqual(["verify"]);
    expect(fetchStub.requests.map((request) => request.url)).toEqual([
      TOKEN_URL,
      RUN_URL,
      JOBS_URL,
      CHECK_RUNS_URL,
    ]);
    expect(bodiesOf(fetchStub.requests).every((body) => body.head_sha === HEAD_SHA)).toBe(true);
  });

  it("rejects before any network call when the triggering-run env is absent", async () => {
    const fetchStub = makeFetch([]);
    await expect(
      runRelay({
        env: relayEnv({
          GITHUB_WORKFLOW_RUN_ID: "",
          GITHUB_WORKFLOW_RUN_HEAD_SHA: "",
          GITHUB_WORKFLOW_RUN_PATH: "",
          GITHUB_WORKFLOW_RUN_CONCLUSION: "",
          GITHUB_WORKFLOW_RUN_HTML_URL: "",
          GITHUB_WORKFLOW_RUN_EVENT: "",
        }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      }),
    ).rejects.toThrow(/LEDGER_DISPATCH_RUN_ID/);
    expect(fetchStub.requests).toHaveLength(0);
  });

  it("rejects before any network call on a malformed head SHA", async () => {
    const fetchStub = makeFetch([]);
    await expect(
      runRelay({
        env: relayEnv({ GITHUB_WORKFLOW_RUN_HEAD_SHA: "deadbeef" }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      }),
    ).rejects.toThrow(/GITHUB_WORKFLOW_RUN_HEAD_SHA/);
    expect(fetchStub.requests).toHaveLength(0);
  });

  it("rejects before any network call when a pin is not a workflow path", async () => {
    const fetchStub = makeFetch([]);
    await expect(
      runRelay({
        env: relayEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => ({ verify: "workflows/ci.yml" }),
      }),
    ).rejects.toThrow(/verify/);
    expect(fetchStub.requests).toHaveLength(0);
  });

  it("relays nothing when no required context is pinned to the triggering run's path", async () => {
    const fetchStub = makeFetch([]);
    const result = await runRelay({
      env: relayEnv({ GITHUB_WORKFLOW_RUN_PATH: PATH_ACTIONLINT }),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => ({ verify: PATH_CI }),
    });
    expect(result.decisions).toEqual([]);
    expect(result.posted).toEqual([]);
    expect(fetchStub.requests).toHaveLength(0);
  });

  // --- The rerun-heal (issue 861) ---

  const PULLS_URL = `https://api.github.com/repos/Nitjsefnie/Overflow/commits/${HEAD_SHA}/pulls?per_page=100`;
  const RUNS_AT_HEAD_URL = `https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs?head_sha=${HEAD_SHA}&per_page=100`;
  const RERUN_URL = `https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs/${RUN_ID}/rerun`;

  function pullEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { state: "open", head: { sha: HEAD_SHA }, ...over };
  }

  function pullsListing(pulls: Array<Record<string, unknown>>): Outcome {
    return { status: 200, body: pulls };
  }

  function runEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { path: PATH_CI, status: "queued", conclusion: null, ...over };
  }

  function runsListing(runs: Array<Record<string, unknown>>): Outcome {
    return { status: 200, body: { total_count: runs.length, workflow_runs: runs } };
  }

  function cancelledPrEnv(over: Record<string, string> = {}): Record<string, string> {
    return relayEnv({
      GITHUB_WORKFLOW_RUN_CONCLUSION: "cancelled",
      GITHUB_WORKFLOW_RUN_EVENT: "pull_request",
      GITHUB_WORKFLOW_RUN_ATTEMPT: "1",
      RELAY_RERUN_TOKEN: "rerun-token",
      ...over,
    });
  }

  function requestTo(requests: Recorded[], url: string): Recorded | undefined {
    return requests.find((request) => request.url === url);
  }

  function requestsTo(requests: Recorded[], url: string): Recorded[] {
    return requests.filter((request) => request.url === url);
  }

  function authHeaderOf(request: Recorded | undefined): string {
    if (request === undefined) return "";
    const headers = request.init.headers as Record<string, string>;
    return String(headers.authorization ?? "");
  }

  describe("rerun-heal", () => {
    it("heals a cancelled pending PR run: posts the mirror as today, then issues the rerun POST under the workflow token", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        pullsListing([pullEntry()]),
        runsListing([runEntry({ path: PATH_ACTIONLINT, status: "in_progress" })]),
        { status: 202, body: undefined },
      ]);
      const result = await runRelay({
        env: cancelledPrEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.posted).toEqual(["verify"]);
      expect(result.rerunDispatched).toBe(true);

      // The rerun: exactly one POST to the rerun endpoint, authenticated by
      // the workflow token — never the App token.
      const rerun = requestTo(fetchStub.requests, RERUN_URL);
      expect(rerun?.init.method).toBe("POST");
      expect(authHeaderOf(rerun)).toBe("Bearer rerun-token");

      // The mirror: the no-jobs branch still mirrors failure, exactly as
      // today, under the App installation token.
      const [checkRun] = bodiesOf(fetchStub.requests);
      expect(checkRun).toMatchObject({
        name: "verify",
        status: "completed",
        conclusion: "failure",
        head_sha: HEAD_SHA,
      });
      expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(1);
      expect(authHeaderOf(requestTo(fetchStub.requests, CHECK_RUNS_URL))).toBe(
        "Bearer installation-token",
      );

      // The heal queries themselves carry the App installation token.
      expect(authHeaderOf(requestTo(fetchStub.requests, PULLS_URL))).toBe(
        "Bearer installation-token",
      );
      expect(authHeaderOf(requestTo(fetchStub.requests, RUNS_AT_HEAD_URL))).toBe(
        "Bearer installation-token",
      );
    });

    it("does not heal at a superseded head and stops the heal queries there", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        pullsListing([{ state: "open", head: { sha: "d".repeat(40) } }]),
      ]);
      const result = await runRelay({
        env: cancelledPrEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.rerunDispatched).toBe(false);
      // The mirror is unchanged: failure, exactly as today.
      const [checkRun] = bodiesOf(fetchStub.requests);
      expect(checkRun).toMatchObject({ name: "verify", conclusion: "failure" });
      // The guards are evaluated in order: condition (d) failed, so the
      // live-run listing behind condition (e) is never fetched.
      expect(fetchStub.requests.map((request) => request.url)).toEqual([
        TOKEN_URL,
        JOBS_URL,
        CHECK_RUNS_URL,
        PULLS_URL,
      ]);
    });

    it("does not heal when a live run of the same workflow is already at the head", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        pullsListing([pullEntry()]),
        runsListing([
          runEntry({ path: PATH_ACTIONLINT, status: "in_progress" }),
          runEntry({ path: PATH_CI, status: "completed" }),
          runEntry({ path: PATH_CI, status: "queued" }),
        ]),
      ]);
      const result = await runRelay({
        env: cancelledPrEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.rerunDispatched).toBe(false);
      expect(requestTo(fetchStub.requests, RERUN_URL)).toBeUndefined();
      // The mirror is unchanged: failure, exactly as today.
      const [checkRun] = bodiesOf(fetchStub.requests);
      expect(checkRun).toMatchObject({ name: "verify", conclusion: "failure" });
    });

    it("rejects loudly, before any heal query, when RELAY_RERUN_TOKEN is missing on a cancelled PR run", async () => {
      const fetchStub = makeFetch([token(), jobsListing([]), { status: 201, body: { id: 1 } }]);
      await expect(
        runRelay({
          env: relayEnv({
            GITHUB_WORKFLOW_RUN_CONCLUSION: "cancelled",
            GITHUB_WORKFLOW_RUN_EVENT: "pull_request",
            GITHUB_WORKFLOW_RUN_ATTEMPT: "1",
          }),
          fetchFn: fetchStub.fn,
          delayFn: makeDelay().fn,
          readPinMap: async () => PIN_MAP,
        }),
      ).rejects.toThrow(/RELAY_RERUN_TOKEN/);
      // The token is checked before any heal API call: no query for the PR
      // and none for the live-run listing.
      expect(requestTo(fetchStub.requests, PULLS_URL)).toBeUndefined();
      expect(requestTo(fetchStub.requests, RUNS_AT_HEAD_URL)).toBeUndefined();
    });

    it("hits the rerun endpoint exactly once and keeps App-token auth on the check-runs when several contexts are pinned", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        { status: 201, body: { id: 2 } },
        pullsListing([pullEntry()]),
        runsListing([]),
        { status: 202, body: undefined },
      ]);
      const result = await runRelay({
        env: cancelledPrEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => ({
          verify: PATH_CI,
          actionlint: PATH_CI,
        }),
      });

      expect(result.posted).toEqual(["verify", "actionlint"]);
      expect(
        fetchStub.requests.filter((request) => request.url === RERUN_URL),
      ).toHaveLength(1);
      expect(authHeaderOf(requestTo(fetchStub.requests, RERUN_URL))).toBe("Bearer rerun-token");
      for (const posting of requestsTo(fetchStub.requests, CHECK_RUNS_URL)) {
        expect(authHeaderOf(posting)).toBe("Bearer installation-token");
      }
    });

    it("does not heal at the attempt cap and never queries the head", async () => {
      const fetchStub = makeFetch([token(), jobsListing([]), { status: 201, body: { id: 1 } }]);
      const result = await runRelay({
        env: cancelledPrEnv({ GITHUB_WORKFLOW_RUN_ATTEMPT: "5" }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.rerunDispatched).toBe(false);
      // The attempt guard precedes the queries: no PR lookup, no run listing.
      expect(fetchStub.requests.map((request) => request.url)).toEqual([
        TOKEN_URL,
        JOBS_URL,
        CHECK_RUNS_URL,
      ]);
    });

    it("reads a missing or non-numeric attempt as 1 and heals", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        pullsListing([pullEntry()]),
        runsListing([]),
        { status: 202, body: undefined },
      ]);
      const result = await runRelay({
        env: cancelledPrEnv({ GITHUB_WORKFLOW_RUN_ATTEMPT: "banana" }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });
      expect(result.rerunDispatched).toBe(true);
      expect(requestTo(fetchStub.requests, RERUN_URL)).toBeDefined();
    });

    it("never heals a cancelled push run", async () => {
      const fetchStub = makeFetch([token(), jobsListing([]), { status: 201, body: { id: 1 } }]);
      const result = await runRelay({
        env: cancelledPrEnv({
          GITHUB_WORKFLOW_RUN_EVENT: "push",
          GITHUB_WORKFLOW_RUN_ATTEMPT: "",
        }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.rerunDispatched).toBe(false);
      expect(requestTo(fetchStub.requests, RERUN_URL)).toBeUndefined();
      expect(fetchStub.requests.map((request) => request.url)).toEqual([
        TOKEN_URL,
        JOBS_URL,
        CHECK_RUNS_URL,
      ]);
    });

    it("heals through the dispatch path using the fetched run's run_attempt", async () => {
      const fetchStub = makeFetch([
        token(),
        {
          status: 200,
          body: {
            id: Number(RUN_ID),
            head_sha: HEAD_SHA,
            path: PATH_CI,
            conclusion: "cancelled",
            html_url: HTML_URL,
            event: "pull_request",
            run_attempt: 2,
          },
        },
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        pullsListing([pullEntry()]),
        runsListing([]),
        { status: 202, body: undefined },
      ]);
      const result = await runRelay({
        env: relayEnv({
          GITHUB_WORKFLOW_RUN_ID: "",
          GITHUB_WORKFLOW_RUN_HEAD_SHA: "",
          GITHUB_WORKFLOW_RUN_PATH: "",
          GITHUB_WORKFLOW_RUN_CONCLUSION: "",
          GITHUB_WORKFLOW_RUN_HTML_URL: "",
          GITHUB_WORKFLOW_RUN_EVENT: "",
          LEDGER_DISPATCH_RUN_ID: RUN_ID,
          RELAY_RERUN_TOKEN: "rerun-token",
        }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.rerunDispatched).toBe(true);
      const rerun = requestTo(fetchStub.requests, RERUN_URL);
      expect(rerun?.init.method).toBe("POST");
      expect(authHeaderOf(rerun)).toBe("Bearer rerun-token");
      expect(fetchStub.requests.map((request) => request.url)).toEqual([
        TOKEN_URL,
        RUN_URL,
        JOBS_URL,
        CHECK_RUNS_URL,
        PULLS_URL,
        RUNS_AT_HEAD_URL,
        RERUN_URL,
      ]);
    });
  });
});
