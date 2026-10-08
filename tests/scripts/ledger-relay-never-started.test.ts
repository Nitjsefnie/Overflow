import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import {
  anyJobStartedOf,
  decideRerun,
  RERUN_ATTEMPT_CAP,
  runRelay,
} from "../../scripts/ledger-relay.ts";

/**
 * The rerun-heal's never-started recognition (issue 1037): a cancellation
 * caused by supersession is healed, a deliberate cancellation stays cancelled.
 * Only runs that never started are re-dispatched. The recognition rule: a run
 * whose `run_started_at` names a time — or whose job listing holds any started
 * job — was executing when it was cancelled, so the cancellation was
 * deliberate; a run that never started was cancelled out of the pending
 * concurrency slot, which is the supersession case the heal exists for.
 */

const HEAD = "c".repeat(40);
const RUN_ID = "9001";
const HEAD_SHA = "a".repeat(40);
const HTML_URL = `https://github.com/Nitjsefnie/Overflow/actions/runs/${RUN_ID}`;
const RERUN_URL = `https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs/${RUN_ID}/rerun`;
const STARTED_AT = "2026-10-08T09:00:00Z";

const PATH_CI = ".github/workflows/ci.yml";
const PIN_MAP = {
  verify: PATH_CI,
  "ratchet-guard": ".github/workflows/ratchet-guard.yml",
  actionlint: ".github/workflows/actionlint.yml",
};

/** The never-started evidence with both signals absent. */
const NEVER_STARTED = { runStartedAt: null, anyJobStarted: false } as const;

describe("decideRerun's never-started recognition (issue 1037)", () => {
  function healRun(
    over: Partial<{
      conclusion: string | null;
      event: string;
      runAttempt: number;
      headSha: string;
    }> = {},
  ) {
    return {
      conclusion: "cancelled",
      event: "pull_request_target",
      runAttempt: 1,
      headSha: HEAD,
      ...over,
    };
  }
  const livePr = { state: "open", headSha: HEAD };

  it.each([
    ["heals a never-started run: no started-at and no started job", healRun(), NEVER_STARTED, true],
    [
      "does not heal when run_started_at names a time, whatever the jobs say",
      healRun(),
      { runStartedAt: STARTED_AT, anyJobStarted: false },
      false,
    ],
    [
      "does not heal when the primary is absent but the jobs listing holds a started job",
      healRun(),
      { runStartedAt: null, anyJobStarted: true },
      false,
    ],
    [
      "does not heal when both signals say the run started",
      healRun(),
      { runStartedAt: STARTED_AT, anyJobStarted: true },
      false,
    ],
    [
      "keeps the attempt cap over a never-started run",
      healRun({ runAttempt: RERUN_ATTEMPT_CAP }),
      NEVER_STARTED,
      false,
    ],
    [
      "heals a never-started run just under the attempt cap",
      healRun({ runAttempt: RERUN_ATTEMPT_CAP - 1 }),
      NEVER_STARTED,
      true,
    ],
  ])("%s", (_name, run, startedEvidence, expected) => {
    expect(decideRerun(run, livePr, false, startedEvidence)).toBe(expected);
  });

  it("decides as the pre-1037 heal did when a call supplies no evidence at all", () => {
    // The evidence-less form is the pinned surface of
    // tests/scripts/ledger-relay.test.ts; the relay never calls it — its own
    // integration rows below pin that the relay supplies real evidence.
    expect(decideRerun(healRun(), livePr, false)).toBe(true);
  });
});

describe("anyJobStartedOf", () => {
  it.each([
    ["an empty jobs listing", { jobs: [] }, false],
    ["a listing whose jobs name no started_at", { jobs: [{ started_at: null }] }, false],
    ["a listing whose jobs name empty started_at strings", { jobs: [{ started_at: "" }] }, false],
    ["a listing with one started job", { jobs: [{ started_at: STARTED_AT }] }, true],
    [
      "a listing where only one of several jobs started",
      { jobs: [{ started_at: null }, { started_at: STARTED_AT }] },
      true,
    ],
    ["a listing holding a malformed entry", { jobs: [7, { started_at: STARTED_AT }] }, true],
    ["a body with no jobs array", { total_count: 0 }, false],
    ["a body that is not an object", null, false],
    ["a body that is an array", [{ started_at: STARTED_AT }], false],
  ])("reads %s as anyJobStarted %s", (_name, body, expected) => {
    expect(anyJobStartedOf(body)).toBe(expected);
  });
});

describe("the heal's evidence on the live relay paths (issue 1037)", () => {
  const keyPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs8", format: "pem" })
    .toString();

  interface Recorded {
    url: string;
    init: RequestInit;
  }
  type Outcome = { status: number; body: unknown };

  function makeFetch(outcomes: Outcome[]) {
    const requests: Recorded[] = [];
    const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const rendered = typeof url === "string" ? url : String(url);
      requests.push({ url: rendered, init: init ?? {} });
      const outcome = outcomes.shift();
      if (!outcome) throw new Error(`unexpected fetch: ${rendered}`);
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

  function cancelledPrEnv(): Record<string, string> {
    return relayEnv({
      GITHUB_WORKFLOW_RUN_CONCLUSION: "cancelled",
      GITHUB_WORKFLOW_RUN_EVENT: "pull_request_target",
      GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "feature/some-branch",
      GITHUB_WORKFLOW_RUN_ATTEMPT: "1",
      RELAY_RERUN_TOKEN: "rerun-token",
    });
  }

  function dispatchEnv(): Record<string, string> {
    return relayEnv({
      GITHUB_WORKFLOW_RUN_ID: "",
      GITHUB_WORKFLOW_RUN_HEAD_SHA: "",
      GITHUB_WORKFLOW_RUN_PATH: "",
      GITHUB_WORKFLOW_RUN_CONCLUSION: "",
      GITHUB_WORKFLOW_RUN_HTML_URL: "",
      GITHUB_WORKFLOW_RUN_EVENT: "",
      GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "",
      LEDGER_DISPATCH_RUN_ID: RUN_ID,
      RELAY_RERUN_TOKEN: "rerun-token",
    });
  }

  function token(): Outcome {
    return { status: 201, body: { token: "installation-token" } };
  }

  function jobsListing(jobs: Array<Record<string, unknown>>): Outcome {
    return { status: 200, body: { total_count: jobs.length, jobs } };
  }

  /** An unstarted job: GitHub names no started_at until a runner picks it up. */
  function unstartedJob(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: "verify",
      run_attempt: 1,
      status: "queued",
      conclusion: null,
      started_at: null,
      ...over,
    };
  }

  /** A started job, as any completed or in-flight job reports it. */
  function startedJob(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      name: "other-job",
      run_attempt: 1,
      status: "completed",
      conclusion: "success",
      started_at: STARTED_AT,
      ...over,
    };
  }

  /** The commit's associated-PR listing with the one open PR at the head. */
  function pullListing(): Outcome {
    return { status: 200, body: [{ state: "open", head: { sha: HEAD_SHA } }] };
  }

  /** The empty runs-at-head listing, so no live run blocks the heal. */
  function noLiveRuns(): Outcome {
    return { status: 200, body: { total_count: 0, workflow_runs: [] } };
  }

  function requestTo(requests: Recorded[], url: string): Recorded | undefined {
    return requests.find((request) => request.url === url);
  }

  function fetchedRunBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: Number(RUN_ID),
      head_sha: HEAD_SHA,
      path: PATH_CI,
      conclusion: "cancelled",
      html_url: HTML_URL,
      event: "pull_request_target",
      head_branch: "feature/some-branch",
      run_attempt: 1,
      head_repository: { full_name: "Nitjsefnie/Overflow" },
      ...over,
    };
  }

  it("does not heal a workflow_run run whose jobs listing holds a started job", async () => {
    const fetchStub = makeFetch([
      token(),
      jobsListing([startedJob()]),
      { status: 201, body: { id: 1 } },
      { status: 200, body: { total_count: 0, workflow_runs: [] } },
      pullListing(),
    ]);
    const result = await runRelay({
      env: cancelledPrEnv(),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => PIN_MAP,
    });

    // The mirror still posted; the heal read the started job and stood down —
    // no rerun was dispatched, and the queue holds no rerun answer to prove it.
    expect(result.posted).toEqual(["verify"]);
    expect(result.rerunDispatched).toBe(false);
    expect(requestTo(fetchStub.requests, RERUN_URL)).toBeUndefined();
  });

  it("heals a workflow_run run whose jobs listing holds only unstarted jobs", async () => {
    const fetchStub = makeFetch([
      token(),
      jobsListing([unstartedJob()]),
      { status: 201, body: { id: 1 } },
      { status: 200, body: { total_count: 0, workflow_runs: [] } },
      pullListing(),
      noLiveRuns(),
      { status: 202, body: undefined },
    ]);
    const result = await runRelay({
      env: cancelledPrEnv(),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => PIN_MAP,
    });

    expect(result.rerunDispatched).toBe(true);
    expect(requestTo(fetchStub.requests, RERUN_URL)).toBeDefined();
  });

  it("does not heal a dispatch run whose body names a run_started_at, even with no started job", async () => {
    const fetchStub = makeFetch([
      token(),
      { status: 200, body: fetchedRunBody({ run_started_at: STARTED_AT }) },
      jobsListing([unstartedJob({ name: "verify" })]),
      { status: 201, body: { id: 1 } },
      { status: 200, body: { total_count: 0, workflow_runs: [] } },
      pullListing(),
    ]);
    const result = await runRelay({
      env: dispatchEnv(),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => PIN_MAP,
    });

    // The primary signal decided: the run had started, so the cancellation was
    // deliberate. The mirror still posted the cancelled conclusion.
    expect(result.posted).toEqual(["verify"]);
    expect(result.rerunDispatched).toBe(false);
    expect(requestTo(fetchStub.requests, RERUN_URL)).toBeUndefined();
  });

  it("heals a dispatch run whose body names no run_started_at and whose jobs never started", async () => {
    const fetchStub = makeFetch([
      token(),
      { status: 200, body: fetchedRunBody() },
      jobsListing([unstartedJob({ name: "verify" })]),
      { status: 201, body: { id: 1 } },
      { status: 200, body: { total_count: 0, workflow_runs: [] } },
      pullListing(),
      noLiveRuns(),
      { status: 202, body: undefined },
    ]);
    const result = await runRelay({
      env: dispatchEnv(),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => PIN_MAP,
    });

    expect(result.rerunDispatched).toBe(true);
    expect(requestTo(fetchStub.requests, RERUN_URL)).toBeDefined();
  });

  it("does not heal a dispatch run whose body names a started_at AND whose jobs started", async () => {
    const fetchStub = makeFetch([
      token(),
      { status: 200, body: fetchedRunBody({ run_started_at: STARTED_AT }) },
      jobsListing([startedJob()]),
      { status: 201, body: { id: 1 } },
      { status: 200, body: { total_count: 0, workflow_runs: [] } },
      pullListing(),
    ]);
    const result = await runRelay({
      env: dispatchEnv(),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => PIN_MAP,
    });

    expect(result.rerunDispatched).toBe(false);
    expect(requestTo(fetchStub.requests, RERUN_URL)).toBeUndefined();
  });

  it("does not heal when only the jobs listing testifies the run started, on the dispatch path", async () => {
    const fetchStub = makeFetch([
      token(),
      // No run_started_at in the body: the fallback decides.
      { status: 200, body: fetchedRunBody() },
      jobsListing([startedJob()]),
      { status: 201, body: { id: 1 } },
      { status: 200, body: { total_count: 0, workflow_runs: [] } },
      pullListing(),
    ]);
    const result = await runRelay({
      env: dispatchEnv(),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => PIN_MAP,
    });

    expect(result.rerunDispatched).toBe(false);
    expect(requestTo(fetchStub.requests, RERUN_URL)).toBeUndefined();
  });
});
