import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  decideContexts,
  mintAppJwt,
  runRelay,
  type RelayJob,
} from "../../scripts/ledger-relay.ts";

/**
 * The ledger relay (issue 708): decideContexts mirrors the triggering run's
 * producing jobs into per-context decisions; mintAppJwt shapes the GitHub App
 * JWT; runRelay mints an installation token, reads the jobs listing and posts
 * one check-run per pinned context — all through an injected fetch, never the
 * network.
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
});
