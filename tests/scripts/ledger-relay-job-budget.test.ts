import { appSuiteListing, appChecksUrl } from "./ledger-relay-check-fixtures.ts";
import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { parse } from "yaml";

import { REQUEST_TIMEOUT_MS, type RelayHttpDeps } from "../../scripts/ledger-relay-http.ts";
import { JOB_DEADLINE_MARGIN_MS, RELAY_JOB_TIMEOUT_MINUTES, jobStartDeadline, readEffectiveDeadline, relayJobStartedAt } from "../../scripts/ledger-relay-job-budget.ts";
import { runRelay, type RelayDeps } from "../../scripts/ledger-relay.ts";

/**
 * The job's timeout-minutes also covers the runner's "Set up job" phase,
 * which no step timeout bounds. The relay budgets requests from a trusted
 * job start or setup-step evidence. A placeholder without step evidence uses
 * the entry deadline, which can outlive the job.
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
    OVERFLOW_LEDGER_APP_ID: "5118623", OVERFLOW_LEDGER_INSTALLATION_ID: "166057493", OVERFLOW_LEDGER_APP_KEY: key,
    GITHUB_REPOSITORY: REPO, OVERFLOW_LEDGER_SWEEP_ONLY: "true",
    GITHUB_RUN_ID: RUN_ID, GITHUB_RUN_ATTEMPT: ATTEMPT, OVERFLOW_RELAY_RERUN_TOKEN: WORKFLOW_TOKEN,
  };
  const deps: RelayDeps = {
    env, fetchFn, delayFn: async (ms) => { state.now += ms; }, nowFn: () => state.now,
    readPinMap: async () => ({ verify: ".github/workflows/ci.yml" }),
  };
  return { state, env, run: (over: Partial<RelayDeps> = {}) => runRelay({ ...deps, ...over }) };
}

const writesOf = (requests: Recorded[]) => requests.filter(({ method }) => method === "POST");

describe("the ledger relay's effective deadline", () => {
  it.each([0, -1])("keeps the job start when setup evidence starts %i s after it", async (offset) => {
    const nowMs = JOB_STARTED_AT + seconds(420);
    const timestamp = new Date(JOB_STARTED_AT).toISOString();
    const deps: RelayHttpDeps = {
      deadlineMs: nowMs + seconds(600), nowFn: () => nowMs,
      fetchFn: async () => response({ jobs: [ownJob({
        created_at: timestamp,
        steps: [{ name: "Set up job", started_at: new Date(JOB_STARTED_AT + seconds(offset)).toISOString() }],
      })] }),
      delayFn: async () => undefined,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const deadline = await readEffectiveDeadline(deps, {
        repo: REPO, runId: RUN_ID, runAttempt: ATTEMPT, workflowToken: WORKFLOW_TOKEN,
      });

      expect(deadline).toBe(jobStartDeadline(JOB_STARTED_AT));
      expect(deadline).toBe(JOB_STARTED_AT + seconds(870));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each([0, 1])(
    "uses a later valid setup start when creation is %i s after the listed start",
    async (creationOffset) => {
      const nowMs = JOB_STARTED_AT + seconds(420);
      const stepStartMs = JOB_STARTED_AT + seconds(30);
      const deps: RelayHttpDeps = {
        deadlineMs: nowMs + seconds(600), nowFn: () => nowMs,
        fetchFn: async () => response({ jobs: [ownJob({
          created_at: new Date(JOB_STARTED_AT + seconds(creationOffset)).toISOString(),
          steps: [
            null,
            { name: "Checkout", started_at: new Date(JOB_STARTED_AT + seconds(100)).toISOString() },
            { name: "Set up job", started_at: "not a date" },
            { name: "Set up job", status: "in_progress", started_at: new Date(stepStartMs).toISOString() },
          ],
        })] }),
        delayFn: async () => undefined,
      };

      const deadline = await readEffectiveDeadline(deps, {
        repo: REPO, runId: RUN_ID, runAttempt: ATTEMPT, workflowToken: WORKFLOW_TOKEN,
      });

      expect(deadline).toBe(jobStartDeadline(stepStartMs));
      expect(deadline).toBe(JOB_STARTED_AT + seconds(900));
    },
  );

  it.each([
    ["earlier", new Date(JOB_STARTED_AT - seconds(1)).toISOString()],
    ["absent", undefined],
    ["unparseable", "not a date"],
    ["non-string", 123],
  ])("keeps the listed start with an 80 s-late setup step when creation is %s", async (_description, createdAt) => {
    const nowMs = JOB_STARTED_AT + seconds(420);
    const deps: RelayHttpDeps = {
      deadlineMs: nowMs + seconds(600), nowFn: () => nowMs,
      fetchFn: async () => response({ jobs: [ownJob({
        created_at: createdAt,
        steps: [{ name: "Set up job", started_at: new Date(JOB_STARTED_AT + seconds(80)).toISOString() }],
      })] }),
      delayFn: async () => undefined,
    };

    const deadline = await readEffectiveDeadline(deps, {
      repo: REPO, runId: RUN_ID, runAttempt: ATTEMPT, workflowToken: WORKFLOW_TOKEN,
    });

    expect(deadline).toBe(jobStartDeadline(JOB_STARTED_AT));
    expect(deadline).toBe(JOB_STARTED_AT + seconds(870));
  });

  it("keeps the entry deadline when it is earlier than the setup-based deadline", async () => {
    const nowMs = JOB_STARTED_AT + seconds(600);
    const deps: RelayHttpDeps = {
      deadlineMs: nowMs + seconds(600), nowFn: () => nowMs,
      fetchFn: async () => response({ jobs: [ownJob({
        created_at: new Date(JOB_STARTED_AT).toISOString(),
        steps: [{ name: "Set up job", started_at: new Date(JOB_STARTED_AT + seconds(590)).toISOString() }],
      })] }),
      delayFn: async () => undefined,
    };

    const deadline = await readEffectiveDeadline(deps, {
      repo: REPO, runId: RUN_ID, runAttempt: ATTEMPT, workflowToken: WORKFLOW_TOKEN,
    });

    expect(deadline).toBe(JOB_STARTED_AT + seconds(1200));
  });

  it("preserves the exported listed-start reader when setup evidence is present", () => {
    const timestamp = new Date(JOB_STARTED_AT).toISOString();
    const steps = [{ name: "Set up job", started_at: timestamp }];

    expect(relayJobStartedAt({ jobs: [ownJob({ steps })] })).toBe(JOB_STARTED_AT);
    expect(() => relayJobStartedAt({ jobs: [ownJob({ started_at: "not a date", steps })] })).toThrow();
  });

  it.each([0, -1])(
    "returns the entry deadline when a fresh listed start is %i s after creation",
    async (startOffset) => {
      const nowMs = JOB_STARTED_AT + seconds(30);
      const deps: RelayHttpDeps = {
        deadlineMs: nowMs + seconds(1200), nowFn: () => nowMs,
        fetchFn: async () => response({ jobs: [
          ownJob({ name: "other", created_at: new Date(JOB_STARTED_AT - seconds(10)).toISOString() }),
          ownJob({
            started_at: new Date(JOB_STARTED_AT + seconds(startOffset)).toISOString(),
            created_at: new Date(JOB_STARTED_AT).toISOString(),
          }),
        ] }),
        delayFn: async () => undefined,
      };
      const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      try {
        const deadline = await readEffectiveDeadline(deps, {
          repo: REPO, runId: RUN_ID, runAttempt: ATTEMPT, workflowToken: WORKFLOW_TOKEN,
        });

        expect(deadline).toBe(nowMs + seconds(1200));
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn.mock.calls[0]).toHaveLength(1);
        expect(String(warn.mock.calls[0][0]).split("\n")).toHaveLength(1);
      } finally {
        warn.mockRestore();
      }
    },
  );

  it.each([
    ["absent", undefined],
    ["unparseable", "not a date"],
    ["non-string", 123],
    ["earlier than the start", new Date(JOB_STARTED_AT - seconds(1)).toISOString()],
  ])("uses the job-start deadline when creation is %s", async (_description, createdAt) => {
    const nowMs = JOB_STARTED_AT + seconds(30);
    const deps: RelayHttpDeps = {
      deadlineMs: nowMs + seconds(1200), nowFn: () => nowMs,
      fetchFn: async () => response({ jobs: [ownJob({ created_at: createdAt })] }),
      delayFn: async () => undefined,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const deadline = await readEffectiveDeadline(deps, {
        repo: REPO, runId: RUN_ID, runAttempt: ATTEMPT, workflowToken: WORKFLOW_TOKEN,
      });

      expect(deadline).toBe(JOB_STARTED_AT + seconds(870));
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("returns the supplied entry deadline unchanged when the listed job start is stale", async () => {
    const nowMs = JOB_STARTED_AT + seconds(1385);
    const deps: RelayHttpDeps = {
      deadlineMs: nowMs + seconds(600), nowFn: () => nowMs,
      fetchFn: async () => response({ jobs: [ownJob()] }), delayFn: async () => undefined,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const deadline = await readEffectiveDeadline(deps, {
        repo: REPO, runId: RUN_ID, runAttempt: ATTEMPT, workflowToken: WORKFLOW_TOKEN,
      });

      expect(deadline).toBe(deps.deadlineMs);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([30, 600])(
    "returns the earlier of the entry and job-start deadlines when the relay enters %i s after a fresh job start",
    async (entrySeconds) => {
      const nowMs = JOB_STARTED_AT + seconds(entrySeconds);
      const deps: RelayHttpDeps = {
        deadlineMs: nowMs + seconds(600), nowFn: () => nowMs,
        fetchFn: async () => response({ jobs: [ownJob()] }), delayFn: async () => undefined,
      };

      const deadline = await readEffectiveDeadline(deps, {
        repo: REPO, runId: RUN_ID, runAttempt: ATTEMPT, workflowToken: WORKFLOW_TOKEN,
      });

      expect(deadline).toBe(Math.min(deps.deadlineMs, jobStartDeadline(JOB_STARTED_AT)));
    },
  );
});

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

  it("starts no write when 930 s have elapsed since a trusted job start", async () => {
    // The remaining job time must cover the request timeout and margin.
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

  it("sweeps when a queued placeholder is 959 s older than the entry", async () => {
    const w = world(JOB_STARTED_AT + seconds(959), 0);
    const queuedAt = new Date(JOB_STARTED_AT).toISOString();
    w.state.jobStart = async () => response({ jobs: [ownJob({ started_at: queuedAt, created_at: queuedAt })] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await w.run();

      expect(result.sweep.relayed).toHaveLength(1);
      expect(w.state.checks).toHaveLength(1);
      expect(writesOf(w.state.requests).some(({ url }) => url === `${ROOT}/check-runs`)).toBe(true);
      expect(w.state.requests.filter(({ url }) => url === JOB_START)).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ["an unrelated step", [{ name: "Checkout", started_at: new Date(JOB_STARTED_AT + seconds(951)).toISOString() }]],
    ["a similarly named step", [{ name: "Set up job extra", started_at: new Date(JOB_STARTED_AT + seconds(951)).toISOString() }]],
    ["an unparseable setup start", [{ name: "Set up job", started_at: "not a date" }]],
    ["a missing setup start", [{ name: "Set up job" }]],
    ["a non-array steps field", null],
  ])("sweeps the queued placeholder with %s", async (_description, steps) => {
    const w = world(JOB_STARTED_AT + seconds(959), 0);
    const queuedAt = new Date(JOB_STARTED_AT).toISOString();
    w.state.jobStart = async () => response({ jobs: [
      ownJob({ name: "other", steps: [{ name: "Set up job", started_at: queuedAt }] }),
      ownJob({ started_at: queuedAt, created_at: queuedAt, steps }),
    ] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await w.run();

      expect(result.sweep.relayed).toHaveLength(1);
      expect(writesOf(w.state.requests).some(({ url }) => url === `${ROOT}/check-runs`)).toBe(true);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("returns the entry deadline for a similarly named setup step", async () => {
    const entryMs = JOB_STARTED_AT + seconds(959);
    const queuedAt = new Date(JOB_STARTED_AT).toISOString();
    const deps: RelayHttpDeps = {
      deadlineMs: entryMs + seconds(1200), nowFn: () => entryMs,
      fetchFn: async () => response({ jobs: [ownJob({
        created_at: queuedAt,
        steps: [{ name: "Set up job extra", started_at: new Date(JOB_STARTED_AT + seconds(951)).toISOString() }],
      })] }),
      delayFn: async () => undefined,
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const deadline = await readEffectiveDeadline(deps, {
        repo: REPO, runId: RUN_ID, runAttempt: ATTEMPT, workflowToken: WORKFLOW_TOKEN,
      });

      expect(deadline).toBe(JOB_STARTED_AT + seconds(2159));
    } finally {
      warn.mockRestore();
    }
  });

  it("exits without writing when setup evidence confirms a start 959 s before entry", async () => {
    const w = world(JOB_STARTED_AT + seconds(959), 0);
    const timestamp = new Date(JOB_STARTED_AT).toISOString();
    w.state.jobStart = async () => response({ jobs: [ownJob({
      created_at: timestamp, steps: [{ name: "Set up job", started_at: timestamp }],
    })] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(w.run()).rejects.toThrow();

      expect(w.state.requests.map(({ url }) => url)).toEqual([JOB_START]);
      expect(w.state.checks).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it.each([940, 959])("exits without writing at %i s with an 80 s-late setup step and a real start", async (age) => {
    const w = world(JOB_STARTED_AT + seconds(age), 0);
    w.state.jobStart = async () => response({ jobs: [ownJob({
      created_at: new Date(JOB_STARTED_AT - seconds(1)).toISOString(),
      steps: [{ name: "Set up job", started_at: new Date(JOB_STARTED_AT + seconds(80)).toISOString() }],
    })] });

    await expect(w.run()).rejects.toThrow();

    expect(w.state.requests.map(({ url }) => url)).toEqual([JOB_START]);
    expect(w.state.checks).toEqual([]);
  });

  it("applies the old-start guard to the later setup start", async () => {
    const w = world(JOB_STARTED_AT + seconds(1019), 0);
    w.state.jobStart = async () => response({ jobs: [ownJob({
      created_at: new Date(JOB_STARTED_AT).toISOString(),
      steps: [{ name: "Set up job", started_at: new Date(JOB_STARTED_AT + seconds(60)).toISOString() }],
    })] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(w.run()).rejects.toThrow();

      expect(w.state.requests.map(({ url }) => url)).toEqual([JOB_START]);
      expect(w.state.checks).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("uses the entry deadline when the setup start is exactly one job timeout old", async () => {
    const w = world(JOB_STARTED_AT + seconds(1020), 0);
    w.state.jobStart = async () => response({ jobs: [ownJob({
      created_at: new Date(JOB_STARTED_AT).toISOString(),
      steps: [{ name: "Set up job", started_at: new Date(JOB_STARTED_AT + seconds(60)).toISOString() }],
    })] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await w.run();

      expect(result.sweep.relayed).toHaveLength(1);
      expect(w.state.checks).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("uses setup evidence 951 s after the queued placeholder and sweeps", async () => {
    const entryMs = JOB_STARTED_AT + seconds(959);
    const stepStartMs = JOB_STARTED_AT + seconds(951);
    const queuedAt = new Date(JOB_STARTED_AT).toISOString();
    const listedJob = ownJob({
      started_at: queuedAt, created_at: queuedAt,
      steps: [{ name: "Set up job", started_at: new Date(stepStartMs).toISOString() }],
    });
    const deps: RelayHttpDeps = {
      deadlineMs: entryMs + seconds(1200), nowFn: () => entryMs,
      fetchFn: async () => response({ jobs: [ownJob({ name: "other" }), listedJob] }),
      delayFn: async () => undefined,
    };
    const w = world(entryMs, 0);
    w.state.jobStart = async () => response({ jobs: [listedJob] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const deadline = await readEffectiveDeadline(deps, {
        repo: REPO, runId: RUN_ID, runAttempt: ATTEMPT, workflowToken: WORKFLOW_TOKEN,
      });

      expect(deadline).toBe(jobStartDeadline(stepStartMs));
      expect(deadline).toBe(JOB_STARTED_AT + seconds(1821));
      const result = await w.run();
      expect(result.sweep.relayed).toHaveLength(1);
      expect(writesOf(w.state.requests).some(({ url }) => url === `${ROOT}/check-runs`)).toBe(true);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("exits without writing for a bad job start even with valid setup evidence", async () => {
    const w = world(JOB_STARTED_AT + seconds(30), 0);
    w.state.jobStart = async () => response({ jobs: [ownJob({
      started_at: "not a date", steps: [{ name: "Set up job", started_at: new Date(JOB_STARTED_AT).toISOString() }],
    })] });

    await expect(w.run()).rejects.toThrow();

    expect(w.state.requests.map(({ url }) => url)).toEqual([JOB_START]);
    expect(w.state.checks).toEqual([]);
  });

  it("exits without writing when the listed start is one second after creation and 959 s before entry", async () => {
    const w = world(JOB_STARTED_AT + seconds(959), 0);
    w.state.jobStart = async () => response({ jobs: [ownJob({
      created_at: new Date(JOB_STARTED_AT - seconds(1)).toISOString(),
    })] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await expect(w.run()).rejects.toThrow();

      expect(w.state.requests.map(({ url }) => url)).toEqual([JOB_START]);
      expect(w.state.checks).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("sweeps when a start after creation is exactly one job timeout before entry", async () => {
    const w = world(JOB_STARTED_AT + seconds(960), 0);
    w.state.jobStart = async () => response({ jobs: [ownJob({
      created_at: new Date(JOB_STARTED_AT - seconds(1)).toISOString(),
    })] });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await w.run();

      expect(result.sweep.relayed).toHaveLength(1);
      expect(w.state.checks).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("exits without writing for a bad start even when creation is valid", async () => {
    const w = world(JOB_STARTED_AT + seconds(30), 0);
    w.state.jobStart = async () => response({ jobs: [ownJob({
      started_at: "yesterday", created_at: new Date(JOB_STARTED_AT).toISOString(),
    })] });

    await expect(w.run()).rejects.toThrow();

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

  it.each(["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT", "OVERFLOW_RELAY_RERUN_TOKEN", "OVERFLOW_LEDGER_APP_ID", "OVERFLOW_LEDGER_INSTALLATION_ID", "OVERFLOW_LEDGER_APP_KEY"])(
    "exits red before any request when %s is missing",
    async (name) => {
      const w = world(JOB_STARTED_AT + seconds(30));
      const env = { ...w.env };
      delete env[name];

      await expect(w.run({ env })).rejects.toThrow(new Error(`${name.replace(/^OVERFLOW_/, "")} is required`));

      expect(w.state.requests).toEqual([]);
    },
  );
});
