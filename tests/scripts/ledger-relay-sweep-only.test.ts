import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { renderRelayResult, runRelay } from "../../scripts/ledger-relay.ts";

/**
 * Issue 1116's sweep-only relay starts: LEDGER_SWEEP_ONLY=true with no
 * triggering run anywhere runs the orphan sweep ALONE — no mirror, no heal —
 * and fails closed on every ambiguity between the mode and a named run. The
 * suite is its own module because tests/scripts/ledger-relay.test.ts sits at
 * its family's line ceiling; the harness here is the queue-based fetch stub
 * that file's runRelay describe uses, narrowed to what these starts touch.
 */

let KEY_PEM = "";

beforeAll(() => {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  KEY_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
});

const HEAD_SHA = "a".repeat(40);
const RUN_ID = "9001";
const PATH_CI = ".github/workflows/ci.yml";
const PATH_ACTIONLINT = ".github/workflows/actionlint.yml";
const PIN_MAP = {
  verify: PATH_CI,
  "ratchet-guard": ".github/workflows/ratchet-guard.yml",
  actionlint: PATH_ACTIONLINT,
};
const TOKEN_URL = "https://api.github.com/app/installations/166057493/access_tokens";
const SWEEP_RUNS_URL = "https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs?per_page=100";
const CHECK_RUNS_URL = "https://api.github.com/repos/Nitjsefnie/Overflow/check-runs";
const JOBS_URL = `https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs/${RUN_ID}/jobs?filter=latest&per_page=100`;

type Outcome = { status: number; body: unknown };

interface Recorded {
  url: string;
  init: RequestInit;
}

/** The queue-based fetch stub: one recorded request per supplied outcome, in order. */
function makeFetch(outcomes: Outcome[]) {
  const requests: Recorded[] = [];
  const fn = (async (url: unknown, init?: RequestInit) => {
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

async function caughtError(promise: Promise<unknown>): Promise<Error | undefined> {
  return promise.then(
    () => undefined,
    (caught: unknown) => (caught instanceof Error ? caught : new Error(String(caught))),
  );
}

function requestsTo(requests: Recorded[], url: string): Recorded[] {
  return requests.filter((request) => request.url === url);
}

function token(): Outcome {
  return { status: 201, body: { token: "installation-token" } };
}

function sweepListing(runs: Array<Record<string, unknown>>): Outcome {
  return { status: 200, body: { total_count: runs.length, workflow_runs: runs } };
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

function checkRunsListing(names: Array<string>): Outcome {
  return {
    status: 200,
    body: {
      total_count: names.length,
      check_runs: names.map((name) => ({ name, app: { id: 5118623 } })),
    },
  };
}

// --- Sweep-only relay runs (issue 1116) ---

describe("sweep-only relay runs (issue 1116)", () => {
  /**
   * The scheduled start's environment: no triggering run anywhere, and the
   * workflow's sweep-only predicate true. Every GITHUB_WORKFLOW_RUN_* field
   * is emptied the way the relay's empty-means-absent discipline reads them.
   */
  function sweepOnlyEnv(over: Record<string, string> = {}): Record<string, string> {
    return {
      LEDGER_APP_ID: "5118623",
      LEDGER_INSTALLATION_ID: "166057493",
      LEDGER_APP_KEY: KEY_PEM,
      GITHUB_REPOSITORY: "Nitjsefnie/Overflow",
      GITHUB_WORKFLOW_RUN_ID: "",
      GITHUB_WORKFLOW_RUN_HEAD_SHA: "",
      GITHUB_WORKFLOW_RUN_PATH: "",
      GITHUB_WORKFLOW_RUN_CONCLUSION: "",
      GITHUB_WORKFLOW_RUN_HTML_URL: "",
      GITHUB_WORKFLOW_RUN_EVENT: "",
      GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "",
      LEDGER_SWEEP_ONLY: "true",
      ...over,
    };
  }

  it("sweeps alone: the listing runs, the mirror and the heal never do, and it exits 0", async () => {
    const fetchStub = makeFetch([token(), sweepListing([])]);
    const result = await runRelay({
      env: sweepOnlyEnv(),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => PIN_MAP,
    });

    expect(result.posted).toEqual([]);
    expect(result.decisions).toEqual([]);
    expect(result.rerunDispatched).toBe(false);
    expect(result.sweep).toEqual({ examined: 0, relayed: [] });
    // Past the mint, the sweep's listing is the only request: no jobs
    // listing, no check-run POST, no heal queries.
    expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, SWEEP_RUNS_URL]);
    expect(renderRelayResult(result)).toEqual([]);
  });

  it("prints the sweep's summary lines when a sweep-only start relays an orphan", async () => {
    const fetchStub = makeFetch([
      token(),
      sweepListing([sweepRun(9002, { path: PATH_ACTIONLINT })]),
      checkRunsListing([]),
      {
        status: 200,
        body: {
          jobs: [{ name: "actionlint", run_attempt: 1, status: "completed", conclusion: "success" }],
        },
      },
      { status: 201, body: { id: 1 } },
    ]);
    const result = await runRelay({
      env: sweepOnlyEnv(),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => PIN_MAP,
    });

    expect(result.posted).toEqual([]);
    expect(result.sweep.relayed).toEqual([{ context: "actionlint", runId: "9002" }]);
    expect(renderRelayResult(result)).toEqual([
      "[ledger-relay] orphan-sweep: examined 1 completed run(s), relayed 1 context(s)",
      "[ledger-relay] orphan-sweep: relayed actionlint from run 9002 (no App check-run existed for it)",
    ]);
    // The swept context posts through the App token like any other start.
    expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(1);
    // No mirror: the triggering run's own jobs listing is never read (the
    // sweep's candidates bring their own).
    expect(requestsTo(fetchStub.requests, JOBS_URL)).toHaveLength(0);
  });

  it.each([
    ["the workflow_run run id", { GITHUB_WORKFLOW_RUN_ID: RUN_ID }],
    ["the dispatch run id", { LEDGER_DISPATCH_RUN_ID: RUN_ID }],
  ])("refuses sweep-only mode when %s is also set", async (_name, over) => {
    const fetchStub = makeFetch([]);
    const error = await caughtError(
      runRelay({
        env: sweepOnlyEnv(over),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      }),
    );

    expect(error, "a sweep-only start names no triggering run").toBeInstanceOf(Error);
    expect(error?.message).toContain("LEDGER_SWEEP_ONLY");
    expect(error?.message).toContain("no triggering run may be named");
    expect(fetchStub.requests).toHaveLength(0);
  });

  it("refuses a LEDGER_SWEEP_ONLY value that is neither true nor false", async () => {
    const fetchStub = makeFetch([]);
    const error = await caughtError(
      runRelay({
        env: sweepOnlyEnv({ LEDGER_SWEEP_ONLY: "yes" }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      }),
    );

    expect(error, "an ambiguous mode must fail closed").toBeInstanceOf(Error);
    expect(error?.message).toContain('LEDGER_SWEEP_ONLY must be exactly "true" or "false"');
    expect(fetchStub.requests).toHaveLength(0);
  });

  it("reads LEDGER_SWEEP_ONLY=false with no run id as today's no-triggering-run refusal", async () => {
    const fetchStub = makeFetch([]);
    const error = await caughtError(
      runRelay({
        env: sweepOnlyEnv({ LEDGER_SWEEP_ONLY: "false" }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      }),
    );

    expect(error, "false is absent, and absent means today's refusal").toBeInstanceOf(Error);
    expect(error?.message).toContain("no triggering run in the environment");
    expect(fetchStub.requests).toHaveLength(0);
  });

  it("fails visibly when the sweep itself throws", async () => {
    const fetchStub = makeFetch([
      token(),
      { status: 500, body: { message: "boom" } },
      { status: 500, body: { message: "boom" } },
      { status: 500, body: { message: "boom" } },
    ]);
    const delay = makeDelay();
    const error = await caughtError(
      runRelay({
        env: sweepOnlyEnv(),
        fetchFn: fetchStub.fn,
        delayFn: delay.fn,
        readPinMap: async () => PIN_MAP,
      }),
    );

    expect(error, "a thrown sweep must leave the job red").toBeInstanceOf(Error);
    expect(error?.message).toContain("the repository's workflow-run listing for the orphan sweep");
    // The bounded retry ran and the failure still propagated.
    expect(delay.delays).toEqual([1000, 2000]);
  });
});
