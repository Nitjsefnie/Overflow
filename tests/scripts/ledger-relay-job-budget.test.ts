import { appSuiteListing, appChecksUrl } from "./ledger-relay-check-fixtures.ts";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { REQUEST_TIMEOUT_MS } from "../../scripts/ledger-relay-http.ts";
import { JOB_DEADLINE_MARGIN_MS, RELAY_JOB_TIMEOUT_MINUTES, jobStartDeadline } from "../../scripts/ledger-relay-job-budget.ts";
import { runRelay, type RelayDeps } from "../../scripts/ledger-relay.ts";

/**
 * The job's timeout-minutes also covers the runner's "Set up job" phase,
 * which no step timeout bounds. The relay therefore reads its own job's
 * started_at before any write and stops starting requests in time for the
 * last one to finish inside the job, whatever that phase took.
 */
const REPO = "Nitjsefnie/Overflow";
const ROOT = `https://api.github.com/repos/${REPO}`;
const HEAD = "b".repeat(40);
const CHECKS = appChecksUrl(ROOT, HEAD);
const LISTING = `${ROOT}/actions/runs?per_page=100`;
const RUN_ID = "8800";
const ATTEMPT = "2";
const JOB_START = `${ROOT}/actions/runs/${RUN_ID}/attempts/${ATTEMPT}/jobs?per_page=100`;
const JOB_NAME = "relay-required-checks";
const WORKFLOW_TOKEN = ["workflow", "test"].join("-");
const JOB_STARTED_AT = Date.UTC(2026, 9, 13, 12, 0, 0);
const seconds = (count: number) => count * 1000;

let key: string;
/** The job timeout as ledger-relay.yml declares it, so this suite follows the workflow. */
let jobTimeoutMs = 0;
beforeAll(async () => {
  key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs8", format: "pem" }).toString();
  const workflow = parse(await readFile(resolve(".github/workflows/ledger-relay.yml"), "utf8")) as {
    jobs: Record<string, { "timeout-minutes"?: number }>;
  };
  jobTimeoutMs = (workflow.jobs[JOB_NAME]?.["timeout-minutes"] ?? 0) * 60_000;
});
const response = (body: unknown) => new Response(JSON.stringify(body));
const ownJob = (over: Record<string, unknown> = {}) => ({
  name: JOB_NAME, status: "in_progress", started_at: new Date(JOB_STARTED_AT).toISOString(), ...over,
});

interface Recorded { url: string; method: string; at: number; authorization: string | undefined }

/**
 * Real relay and check store behind an injected clock: each request is
 * stamped with its start time and then advances the clock by `stepMs`.
 */
function world(entryMs: number, stepMs = seconds(5)) {
  const state = {
    now: entryMs, checks: [] as Array<Record<string, unknown>>, requests: [] as Recorded[],
    jobStart: async (): Promise<Response> => response({ total_count: 1, jobs: [ownJob()] }),
  };
  const fetchFn = (async (input, init = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    const headers = (init.headers ?? {}) as Record<string, string>;
    state.requests.push({ url, method, at: state.now, authorization: headers.authorization });
    state.now += stepMs;
    if (url === JOB_START) return state.jobStart();
    if (url.endsWith("/access_tokens")) return response({ token: ["test", "only"].join("-") });
    if (url === LISTING) return response({ workflow_runs: [{
      id: 9001, run_attempt: 1, head_sha: HEAD, path: ".github/workflows/ci.yml",
      status: "completed", conclusion: "success", event: "push", head_branch: "main",
      html_url: `https://github.com/${REPO}/actions/runs/9001`,
    }] });
    const suites = appSuiteListing(url);
    if (suites !== undefined) return response(suites);
    if (url === CHECKS) return response({ check_runs: state.checks.slice(-1) });
    if (url.endsWith("/9001/jobs?filter=latest&per_page=100")) return response({ jobs: [{
      name: "verify", run_attempt: 1, status: "completed", conclusion: "success",
    }] });
    if (url === `${ROOT}/check-runs` && method === "POST") {
      state.checks.push({ ...JSON.parse(String(init.body)), app: { id: 5118623 } });
      return response({ id: state.checks.length });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const env: Record<string, string | undefined> = {
    LEDGER_APP_ID: "5118623", LEDGER_INSTALLATION_ID: "166057493", LEDGER_APP_KEY: key,
    GITHUB_REPOSITORY: REPO, LEDGER_SWEEP_ONLY: "true",
    GITHUB_RUN_ID: RUN_ID, GITHUB_RUN_ATTEMPT: ATTEMPT, RELAY_RERUN_TOKEN: WORKFLOW_TOKEN,
  };
  const deps: RelayDeps = {
    env, fetchFn, delayFn: async (ms) => { state.now += ms; }, nowFn: () => state.now,
    readPinMap: async () => ({ verify: ".github/workflows/ci.yml" }),
  };
  return { state, env, run: (over: Partial<RelayDeps> = {}) => runRelay({ ...deps, ...over }) };
}

const writesOf = (requests: Recorded[]) => requests.filter(({ method }) => method === "POST");

describe("the ledger relay's job-start budget", () => {
  it("reads its own job's start with the workflow token before any other request", async () => {
    const w = world(JOB_STARTED_AT + seconds(30));

    const result = await w.run();

    expect(result.sweep.relayed).toHaveLength(1);
    expect(w.state.checks).toHaveLength(1);
    expect(w.state.requests[0]).toMatchObject({
      url: JOB_START, method: "GET", authorization: `Bearer ${WORKFLOW_TOKEN}`,
    });
    expect(w.state.requests.filter(({ url }) => url === JOB_START)).toHaveLength(1);
    expect(w.state.requests[1]?.url).toMatch(/\/access_tokens$/);
  });

  it("starts no write that could outlive the job when Set up job ran to ~905 s of a 960 s job (claim-1 re-check)", async () => {
    // The re-check's trace: Set up job ends at ~905 s, checkout and
    // setup-node finish within their bounds, the relay step enters at 930 s,
    // and each request takes a few seconds. Measured from its own entry,
    // the relay would still be POSTing when the job timeout cancelled it.
    expect(jobTimeoutMs).toBe(seconds(960));
    const w = world(JOB_STARTED_AT + seconds(930));

    await expect(w.run()).rejects.toThrow(/job-start budget/);

    for (const write of writesOf(w.state.requests)) {
      expect(write.at + REQUEST_TIMEOUT_MS, `${write.url} could outlive the job`).toBeLessThan(JOB_STARTED_AT + jobTimeoutMs);
    }
    // Not even the sweep or the token mint starts: the job read is the only request.
    expect(w.state.requests.map(({ url }) => url)).toEqual([JOB_START]);
    expect(w.state.checks).toEqual([]);
  });

  it.each([0, 600])(
    "sweeps normally with one job-start read when the listing reports the queue time and entry is delayed by %i s",
    async (entryDelaySeconds) => {
      const queueTime = Date.UTC(2026, 9, 19, 15, 35, 10);
      const entryTime = Date.UTC(2026, 9, 19, 15, 58, 15) + seconds(entryDelaySeconds);
      const w = world(entryTime);
      w.state.jobStart = async () => response({ jobs: [ownJob({ started_at: new Date(queueTime).toISOString() })] });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const result = await w.run();

        expect(result.sweep.relayed).toHaveLength(1);
        expect(w.state.checks).toHaveLength(1);
        expect(w.state.requests.filter(({ url }) => url === JOB_START)).toHaveLength(1);
        expect(writesOf(w.state.requests).some(({ url }) => url === `${ROOT}/check-runs`)).toBe(true);
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenCalledWith(expect.stringContaining(new Date(queueTime).toISOString()));
      } finally {
        warn.mockRestore();
      }
    },
  );

  it("uses the entry deadline when the listed start is exactly one job timeout before now", async () => {
    const entryTime = JOB_STARTED_AT + seconds(930);
    const startedAt = new Date(entryTime - seconds(960)).toISOString();
    const w = world(entryTime, 0);
    w.state.jobStart = async () => response({ jobs: [ownJob({ started_at: startedAt })] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await w.run();

      expect(result.sweep.relayed).toHaveLength(1);
      expect(w.state.checks).toHaveLength(1);
      expect(w.state.requests.filter(({ url }) => url === JOB_START)).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(startedAt));
    } finally {
      warn.mockRestore();
    }
  });

  it("exits red without writing when the listed start is one second fresher than the job timeout bound", async () => {
    const entryTime = JOB_STARTED_AT + seconds(930);
    const w = world(entryTime, 0);
    w.state.jobStart = async () => response({ jobs: [ownJob({
      started_at: new Date(entryTime - seconds(959)).toISOString(),
    })] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(w.run()).rejects.toThrow(/job-start budget/);

      expect(w.state.requests.map(({ url }) => url)).toEqual([JOB_START]);
      expect(w.state.checks).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("ends the job-start budget one request bound and the stated margin before the job timeout", () => {
    expect(JOB_DEADLINE_MARGIN_MS).toBeGreaterThan(0);
    expect(jobStartDeadline(JOB_STARTED_AT) + REQUEST_TIMEOUT_MS + JOB_DEADLINE_MARGIN_MS)
      .toBe(JOB_STARTED_AT + RELAY_JOB_TIMEOUT_MINUTES * 60_000);
  });

  it.each([30, 600, 800, 840, 860, 870, 905, 930])(
    "starts every write early enough to finish inside the job when the relay enters at %i s",
    async (entrySeconds) => {
      const w = world(JOB_STARTED_AT + seconds(entrySeconds));

      await w.run().catch(() => undefined);

      for (const write of writesOf(w.state.requests)) {
        expect(write.at + REQUEST_TIMEOUT_MS, `${write.url} could outlive the job`)
          .toBeLessThan(JOB_STARTED_AT + jobTimeoutMs);
      }
    },
  );

  it.each([
    ["an HTTP error", async () => new Response("Not Found", { status: 404 }), /HTTP 404/],
    ["a network error", async () => { throw new TypeError("fetch failed"); }, /fetch failed/],
    ["a body that is not JSON", async () => new Response("<html>"), /not JSON/],
    ["a body with no jobs array", async () => response({ total_count: 1 }), /no jobs array/],
    ["a job with no started_at", async () => response({ jobs: [ownJob({ started_at: null })] }), /started_at/],
    ["an unparseable started_at", async () => response({ jobs: [ownJob({ started_at: "yesterday" })] }), /started_at/],
    ["no job of that name", async () => response({ jobs: [ownJob({ name: "verify" })] }), /found 0/],
    ["several jobs of that name", async () => response({ jobs: [ownJob(), ownJob()] }), /found 2/],
  ])("exits red without writing when the job-start read yields %s", async (_name, answer, message) => {
    const w = world(JOB_STARTED_AT + seconds(30));
    w.state.jobStart = answer;

    await expect(w.run()).rejects.toThrow(message);

    expect(w.state.requests.length).toBeGreaterThan(0);
    expect(w.state.requests.every(({ url }) => url === JOB_START)).toBe(true);
    expect(w.state.checks).toEqual([]);
  });

  it.each(["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "RELAY_RERUN_TOKEN"])(
    "exits red before any request when %s is missing",
    async (name) => {
      const w = world(JOB_STARTED_AT + seconds(30));
      const env = { ...w.env };
      delete env[name];

      await expect(w.run({ env })).rejects.toThrow(new RegExp(`${name} is required`));

      expect(w.state.requests).toEqual([]);
    },
  );
});
