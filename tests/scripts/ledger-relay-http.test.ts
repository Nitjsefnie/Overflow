import { appSuiteListing, appChecksUrl, appSuitesUrl, RELAY_OWN_RUN_ENV, relayJobStartListing,
  relayJobStartUrl } from "./ledger-relay-check-fixtures.ts";
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { apiCall, RateLimitExceededError, RATE_LIMIT_RESET_MARGIN_MS,
  type RelayHttpDeps } from "../../scripts/ledger-relay-http.ts";
import { renderRelayResult, runRelay, type RelayDeps } from "../../scripts/ledger-relay.ts";

const REPO = "Nitjsefnie/Overflow";
const ROOT = `https://api.github.com/repos/${REPO}`;
const HEAD = "b".repeat(40);
const CHECKS = appChecksUrl(ROOT, HEAD);
const SUITES = appSuitesUrl(ROOT, HEAD);
const LISTING = `${ROOT}/actions/runs?per_page=100`;
type Body = Record<string, unknown>;
let key: string;
beforeAll(() => {
  key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs8", format: "pem" }).toString();
});
const response = (body: unknown) => new Response(JSON.stringify(body));

/** Real relay and check store; only the remote HTTP boundary is replaced. */
function world() {
  const state = {
    checks: [] as Body[], requests: [] as Array<{ url: string; init: RequestInit }>,
    posts: 0, delays: [] as number[],
    intercept: undefined as ((url: string, init: RequestInit) => Promise<Response | undefined>) | undefined,
  };
  const fetchFn = (async (input, init = {}) => {
    const url = String(input);
    state.requests.push({ url, init });
    if (url === `${ROOT}/check-runs` && init.method === "POST") state.posts++;
    const intercepted = await state.intercept?.(url, init);
    if (intercepted !== undefined) return intercepted;
    if (url.endsWith("/access_tokens")) return response({ token: ["test", "only"].join("-") });
    if (url === LISTING) return response({ workflow_runs: [{
      id: 9001, run_attempt: 1, head_sha: HEAD, path: ".github/workflows/ci.yml",
      status: "completed", conclusion: "success", event: "push", head_branch: "main",
      html_url: `https://github.com/${REPO}/actions/runs/9001`,
    }] });
    const suites = appSuiteListing(url) ?? relayJobStartListing(url);
    if (suites !== undefined) return response(suites);
    if (url === CHECKS) return response({ check_runs: state.checks.slice(-1) });
    if (url.endsWith("/9001/jobs?filter=latest&per_page=100")) return response({ jobs: [{
      name: "verify", run_attempt: 1, status: "completed", conclusion: "success",
    }] });
    if (url === `${ROOT}/check-runs` && init.method === "POST") {
      state.checks.push({ ...JSON.parse(String(init.body)), app: { id: 5118623 } });
      return response({ id: state.checks.length });
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const deps: RelayDeps = {
    env: { ...RELAY_OWN_RUN_ENV, OVERFLOW_LEDGER_APP_ID: "5118623", OVERFLOW_LEDGER_INSTALLATION_ID: "166057493", OVERFLOW_LEDGER_APP_KEY: key,
      GITHUB_REPOSITORY: REPO, OVERFLOW_LEDGER_SWEEP_ONLY: "true" },
    fetchFn, delayFn: async (ms) => { state.delays.push(ms); },
    readPinMap: async () => ({ verify: ".github/workflows/ci.yml" }),
  };
  return { state, deps, run: (over = {}) => runRelay({ ...deps, ...over }) };
}

/** Never answers; a real AbortSignal.timeout must settle this attempt. */
function stalled(signal: AbortSignal | null | undefined): Promise<never> {
  if (signal == null) throw new Error("fetch did not receive an AbortSignal");
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

describe("ledger relay request lifetime", () => {
  it("passes a fresh native 30-second timeout to every production-default fetch, including POSTs", async () => {
    const w = world();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    try {
      await w.run();
      expect(w.state.requests).toHaveLength(7);
      expect(timeout).toHaveBeenCalledTimes(7);
      expect(timeout.mock.calls.every(([ms]) => ms === 30_000)).toBe(true);
      const signals = w.state.requests.map(({ init }) => init.signal);
      for (const signal of signals) expect(signal).toBeInstanceOf(AbortSignal);
      expect(new Set(signals).size).toBe(7);
    } finally { timeout.mockRestore(); }
  });

  it("aborts a never-resolving GET with the injected timeout and retries as a network error", async () => {
    const w = world();
    const signals: AbortSignal[] = [];
    w.state.intercept = async (url, init) => {
      if (url !== LISTING) return;
      if (init.signal != null) signals.push(init.signal);
      return stalled(init.signal);
    };

    await expect(w.run({ requestTimeoutMs: 5 })).rejects.toThrow(/failed after 3 attempts/);

    expect(signals).toHaveLength(3);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
      expect(signal.aborted).toBe(true);
      expect(signal.reason.name).toBe("TimeoutError");
    }
    expect(new Set(signals).size).toBe(3);
    expect(w.state.delays).toEqual([1000, 2000]);
  });

  it("does not re-post a timed-out check-run POST that committed", async () => {
    const w = world();
    w.state.intercept = async (url, init) => {
      if (url !== `${ROOT}/check-runs` || w.state.posts !== 1) return;
      w.state.checks.push({ ...JSON.parse(String(init.body)), app: { id: 5118623 } });
      return stalled(init.signal);
    };

    const result = await w.run({ requestTimeoutMs: 5 });

    expect(w.state.posts).toBe(1);
    expect(result.sweep.relayed).toHaveLength(1);
    expect(w.state.checks).toHaveLength(1);
    expect(w.state.checks[0]).toMatchObject({ name: "verify", head_sha: HEAD,
      external_id: "9001:1", status: "completed", conclusion: "success" });
    const post = w.state.requests.findIndex(({ url, init }) => url === `${ROOT}/check-runs` && init.method === "POST");
    expect(w.state.requests[post + 1].url).toBe(SUITES);
    expect(w.state.requests[post + 1].init.headers).toMatchObject({
      "cache-control": "no-cache", authorization: `Bearer ${["test", "only"].join("-")}`,
    });
  });

  it.each(["timeout", "network"])("re-reads before re-posting a check-run POST lost to %s exactly once", async (failure) => {
    const w = world();
    w.state.intercept = async (url) => {
      if (url === `${ROOT}/check-runs` && w.state.posts === 1) {
        throw failure === "timeout" ? new DOMException("request timed out", "TimeoutError") : new TypeError("fetch failed");
      }
    };

    await w.run();

    expect(w.state.posts).toBe(2);
    expect(w.state.checks).toHaveLength(1);
    expect(w.state.checks[0]).toMatchObject({ external_id: "9001:1", conclusion: "success" });
    const writes = w.state.requests.flatMap(({ url }, index) => url === `${ROOT}/check-runs` ? [index] : []);
    expect(w.state.requests.slice(writes[0] + 1, writes[1]).map(({ url }) => url)).toEqual([SUITES, CHECKS]);
    expect(w.state.delays).toEqual([1000]);
  });

  it("starts no request after the run deadline, measured from before pin-map loading", async () => {
    const w = world();
    let now = 1000;
    const run = w.run({ nowFn: () => now, readPinMap: async () => {
      now += 10 * 60_000;
      return { verify: ".github/workflows/ci.yml" };
    } });

    await expect(run).rejects.toThrow(/deadline.*1970-01-01T00:10:01\.000Z/);
    expect(w.state.requests).toEqual([]);
  });

  it.each(["HTTP", "network", "timeout", "malformed"])("stays red when the timed-out POST re-read fails (%s)", async (failure) => {
    const w = world();
    w.state.intercept = async (url, init) => {
      if (url === `${ROOT}/check-runs` && w.state.posts === 1) throw new DOMException("request timed out", "TimeoutError");
      if (url !== CHECKS || w.state.posts === 0) return;
      if (failure === "network") throw new TypeError("latest checks unavailable");
      if (failure === "timeout") return stalled(init.signal);
      if (failure === "malformed") return response({});
      return new Response("latest checks unavailable", { status: 503 });
    };

    await expect(w.run({ requestTimeoutMs: 5 })).rejects.toThrow(
      failure === "malformed" ? /re-read returned no check_runs array/ :
        failure === "timeout" ? /failed after 3 attempts/ : /latest checks unavailable/,
    );

    expect(w.state.posts).toBe(1);
    expect(w.state.checks).toEqual([]);
    expect(w.state.requests.filter(({ url }) => url === CHECKS)).toHaveLength(failure === "malformed" ? 2 : 4);
  });

  it.each([
    ["another producer", { external_id: "9000:1" }],
    ["an unparseable attempt", { external_id: "9001:invalid" }],
    ["unfinished status", { status: "in_progress", conclusion: null }],
    ["another conclusion", { conclusion: "failure" }],
    ["another context", { name: "actionlint" }],
    ["another App", { app: { id: 5118624 } }],
  ])("does not mistake %s for the intended concluded check during read-back", async (_name, over) => {
    const w = world();
    w.state.intercept = async (url, init) => {
      if (url !== `${ROOT}/check-runs` || w.state.posts !== 1) return;
      w.state.checks.push({ ...JSON.parse(String(init.body)), app: { id: 5118623 }, ...over });
      throw new DOMException("request timed out", "TimeoutError");
    };

    await w.run();

    expect(w.state.posts).toBe(2);
    expect(w.state.checks.at(-1)).toMatchObject({ name: "verify", external_id: "9001:1",
      status: "completed", conclusion: "success", app: { id: 5118623 } });
  });

  it.each([
    ["sweep", "higher run", "9002:1"],
    ["sweep", "higher attempt", "9001:2"],
    ["mirror", "higher run", "9002:1"],
    ["mirror", "higher attempt", "9001:2"],
  ])("preserves the %s's newer failure (%s) after an ambiguous older success POST", async (mode, _order, newerId) => {
    const w = world();
    w.state.intercept = async (url, init) => {
      if (url !== `${ROOT}/check-runs` || w.state.posts !== 1) return;
      w.state.checks.push({ ...JSON.parse(String(init.body)), app: { id: 5118623 },
        external_id: newerId, status: "completed", conclusion: "failure" });
      throw new DOMException("request timed out", "TimeoutError");
    };
    const env = mode === "sweep" ? w.deps.env : {
      ...w.deps.env, OVERFLOW_LEDGER_SWEEP_ONLY: "false", OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "9001",
      OVERFLOW_GITHUB_WORKFLOW_RUN_HEAD_SHA: HEAD, OVERFLOW_GITHUB_WORKFLOW_RUN_PATH: ".github/workflows/ci.yml",
      OVERFLOW_GITHUB_WORKFLOW_RUN_CONCLUSION: "success", OVERFLOW_GITHUB_WORKFLOW_RUN_EVENT: "push",
      OVERFLOW_GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "main", OVERFLOW_GITHUB_WORKFLOW_RUN_ATTEMPT: "1",
      OVERFLOW_GITHUB_WORKFLOW_RUN_HTML_URL: `https://github.com/${REPO}/actions/runs/9001`,
    };

    const result = await w.run({ env });

    expect(w.state.posts).toBe(1);
    expect(w.state.checks).toHaveLength(1);
    expect(w.state.checks.at(-1)).toMatchObject({ external_id: newerId, conclusion: "failure" });
    expect(result.posted).toEqual([]);
    expect(result.decisions).toEqual([]);
    expect(result.sweep.relayed).toEqual([]);
    expect(result).toMatchObject({ suppressed: [{ context: "verify", headSha: HEAD,
      externalId: "9001:1", suppressedBy: newerId }] });
    if (mode === "sweep") expect(result.sweep).toMatchObject({ suppressed: result.suppressed });
    expect(renderRelayResult(result).join("\n")).toContain(`suppressed by newer App identity ${newerId}`);
    expect(w.state.delays).toEqual([]);
  });

  it("exhausts three ambiguous write attempts and re-reads even the last attempt", async () => {
    const w = world();
    w.state.intercept = async (url) => {
      if (url === `${ROOT}/check-runs`) throw new DOMException("request timed out", "TimeoutError");
    };

    await expect(w.run()).rejects.toThrow(/the check-run for verify failed after 3 attempts/);

    expect(w.state.posts).toBe(3);
    expect(w.state.checks).toEqual([]);
    expect(w.state.requests.filter(({ url }) => url === CHECKS)).toHaveLength(4);
    expect(w.state.delays).toEqual([1000, 2000]);
  });

  it("accepts a committed final attempt without starting a fourth POST", async () => {
    const w = world();
    w.state.intercept = async (url, init) => {
      if (url !== `${ROOT}/check-runs`) return;
      if (w.state.posts === 3) w.state.checks.push({ ...JSON.parse(String(init.body)), app: { id: 5118623 } });
      throw new TypeError("fetch failed");
    };

    const result = await w.run();

    expect(w.state.posts).toBe(3);
    expect(result.sweep.relayed).toHaveLength(1);
    expect(w.state.checks).toHaveLength(1);
    expect(w.state.delays).toEqual([1000, 2000]);
  });

  it.each([500, 429])("keeps the bounded retry for a POST answering HTTP %s", async (status) => {
    const w = world();
    w.state.intercept = async (url) => {
      if (url === `${ROOT}/check-runs` && w.state.posts === 1) return new Response("try again", { status });
    };

    await w.run();

    expect(w.state.posts).toBe(2);
    expect(w.state.requests.filter(({ url }) => url === CHECKS)).toHaveLength(1);
    expect(w.state.delays).toEqual([1000]);
  });

  it("checks the deadline again after retry backoff before starting a new fetch", async () => {
    const w = world();
    let now = 1000;
    w.state.intercept = async (url) => {
      if (url === LISTING) throw new TypeError("fetch failed");
    };

    await expect(w.run({ nowFn: () => now, delayFn: async () => { now += 10 * 60_000; } }))
      .rejects.toThrow(/run deadline/);
    expect(w.state.requests.map(({ url }) => url)).toEqual([
      relayJobStartUrl(), "https://api.github.com/app/installations/166057493/access_tokens", LISTING,
    ]);
  });

  it("awaits the last POST and still fails red when it finishes after the deadline", async () => {
    const w = world();
    let now = 1000;
    let posted!: () => void;
    const started = new Promise<void>((resolve) => { posted = resolve; });
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    w.state.intercept = async (url) => {
      if (url !== `${ROOT}/check-runs`) return;
      posted();
      await pending;
      now += 10 * 60_000;
    };
    let settled = false;
    const run = w.run({ nowFn: () => now }).finally(() => { settled = true; });
    await started;
    expect(settled).toBe(false);
    finish();

    await expect(run).rejects.toThrow(/run deadline/);

    expect(w.state.checks).toHaveLength(1);
    expect(w.state.requests.at(-1)?.url).toBe(`${ROOT}/check-runs`);
  });

  it("does not start the ambiguous-write re-read after a POST times out past the deadline", async () => {
    const w = world();
    let now = 1000;
    w.state.intercept = async (url) => {
      if (url !== `${ROOT}/check-runs`) return;
      now += 10 * 60_000;
      throw new DOMException("request timed out", "TimeoutError");
    };

    await expect(w.run({ nowFn: () => now })).rejects.toThrow(/run deadline/);

    expect(w.state.posts).toBe(1);
    expect(w.state.checks).toEqual([]);
    expect(w.state.requests.at(-1)?.url).toBe(`${ROOT}/check-runs`);
  });

  it("reconciles a committed POST whose response body times out", async () => {
    const w = world();
    w.state.intercept = async (url, init) => {
      if (url !== `${ROOT}/check-runs` || w.state.posts !== 1) return;
      w.state.checks.push({ ...JSON.parse(String(init.body)), app: { id: 5118623 } });
      const headersOnly = new Response(null, { status: 201 });
      headersOnly.text = () => stalled(init.signal);
      return headersOnly;
    };

    await w.run({ requestTimeoutMs: 5 });

    expect(w.state.posts).toBe(1);
    expect(w.state.checks).toHaveLength(1);
    expect(w.state.requests.at(-1)?.url).toBe(CHECKS);
  });

  it("keeps rerun-heal's retry on a timed-out rerun POST without a check-run read-back", async () => {
    const w = world();
    let reruns = 0;
    let firstRerunSignal: AbortSignal | null | undefined;
    w.state.intercept = async (url, init) => {
      if (url === LISTING) return response({ workflow_runs: [{
        id: 9001, run_attempt: 1, head_sha: HEAD, path: ".github/workflows/ci.yml",
        status: "completed", conclusion: "cancelled", event: "pull_request_target", head_branch: "feature/heal",
        html_url: `https://github.com/${REPO}/actions/runs/9001`, run_started_at: null,
      }] });
      if (url.includes("/9001/jobs?")) return response({ jobs: [{
        name: "verify", run_attempt: 1, status: "queued", conclusion: null, started_at: null,
      }] });
      if (url.includes("/pulls?")) return response([{ state: "open", head: { sha: HEAD } }]);
      if (url.includes("/actions/runs?head_sha=")) return response({ workflow_runs: [] });
      if (url.endsWith("/9001/rerun")) {
        reruns++;
        if (reruns === 1) {
          firstRerunSignal = init.signal;
          return stalled(init.signal);
        }
        return new Response(null, { status: 202 });
      }
    };

    const result = await w.run({ requestTimeoutMs: 5, env: {
      ...w.deps.env, OVERFLOW_RELAY_RERUN_TOKEN: ["rerun", "test"].join("-"),
    } });

    expect(result.rerunDispatched).toBe(true);
    expect(reruns).toBe(2);
    expect(firstRerunSignal).toBeInstanceOf(AbortSignal);
    expect(firstRerunSignal?.aborted).toBe(true);
    expect(firstRerunSignal?.reason.name).toBe("TimeoutError");
    const first = w.state.requests.findIndex(({ url }) => url.endsWith("/9001/rerun"));
    expect(w.state.requests.slice(first).map(({ url }) => url)).toEqual([
      `${ROOT}/actions/runs/9001/rerun`, `${ROOT}/actions/runs/9001/rerun`,
    ]);
    expect(w.state.delays).toEqual([1000]);
  });
});

describe("ledger relay rate-limit handling (issue 1355)", () => {
  /** A RelayHttpDeps whose clock is injected and whose fetch replays `responses`. */
  function rateLimitDeps(responses: Response[]) {
    const state = { now: 10_000, requests: [] as number[], delays: [] as number[] };
    const deps: RelayHttpDeps = {
      deadlineMs: 60_000,
      nowFn: () => state.now,
      delayFn: async (ms) => { state.delays.push(ms); state.now += ms; },
      fetchFn: async () => {
        state.requests.push(state.now);
        const next = responses.shift();
        if (next === undefined) throw new Error("unexpected extra request");
        return next;
      },
    };
    return { deps, state };
  }

  const rateLimited = (resetEpochSec: number, status = 403) =>
    new Response("API rate limit exceeded for installation ID 166057493", {
      status,
      headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(resetEpochSec) },
    });
  const theCall = { url: "https://api.github.com/repos/Nitjsefnie/Overflow/x", method: "GET" as const, headers: {} };
  const what = "the job listing of run 9001";
  const caught = (promise: Promise<unknown>) =>
    promise.then(() => { throw new Error("expected a rejection"); }, (error: unknown) => error) as Promise<Error>;

  it("waits out a rate-limited 403 whose reset fits the deadline and retries", async () => {
    // The reset sits 4 s past now, inside the 60 s deadline with its margin.
    const { deps, state } = rateLimitDeps([
      rateLimited(14),
      new Response(JSON.stringify({ jobs: [] })),
    ]);

    await expect(apiCall(deps, theCall, what)).resolves.toEqual({ jobs: [] });

    expect(state.delays).toEqual([4_000]);
    expect(state.requests).toEqual([10_000, 14_000]);
  });

  it("throws RateLimitExceededError when a rate-limited 403's reset is past the deadline", async () => {
    const resetMs = 10_000 + 20 * 60_000;
    const { deps, state } = rateLimitDeps([rateLimited(resetMs / 1000)]);

    const error = await caught(apiCall(deps, theCall, what));

    expect(error).toBeInstanceOf(RateLimitExceededError);
    expect((error as RateLimitExceededError).resetMs).toBe(resetMs);
    expect(error.message).toContain("rate limit exhausted");
    expect(error.message).toContain(new Date(resetMs).toISOString());
    expect(error.message).toContain(new Date(60_000).toISOString());
    expect(state.delays).toEqual([]);
    expect(state.requests).toEqual([10_000]);
  });

  it("keeps the reset margin a positive wait window (issue 1355's fit check)", () => {
    expect(RATE_LIMIT_RESET_MARGIN_MS).toBe(5_000);
  });

  it("keeps a 403 without rate-limit markers an immediate plain failure with no delay", async () => {
    const { deps, state } = rateLimitDeps([
      new Response("This workflow is already running", { status: 403 }),
    ]);

    const error = await caught(apiCall(deps, theCall, what));

    expect(error.name).not.toBe("RateLimitExceededError");
    expect(error.message).toContain("HTTP 403");
    expect(state.delays).toEqual([]);
    expect(state.requests).toEqual([10_000]);
  });

  it("waits the retry-after of a rate-limited 429 and retries", async () => {
    const { deps, state } = rateLimitDeps([
      new Response("You have exceeded a secondary rate limit", { status: 429, headers: { "retry-after": "3" } }),
      new Response(JSON.stringify({ jobs: [] })),
    ]);

    await expect(apiCall(deps, theCall, what)).resolves.toEqual({ jobs: [] });

    expect(state.delays).toEqual([3_000]);
    expect(state.requests).toEqual([10_000, 13_000]);
  });

  it.each([403, 429])("does not wait after the final rate-limited HTTP %s attempt", async (status) => {
    const { deps, state } = rateLimitDeps([rateLimited(30, status), rateLimited(50, status), rateLimited(55, status)]);

    const error = await caught(apiCall(deps, theCall, what));

    expect(error).toBeInstanceOf(RateLimitExceededError);
    expect((error as RateLimitExceededError).resetMs).toBe(55_000);
    expect(error.message).toContain(new Date(55_000).toISOString());
    expect(error.message).toContain(new Date(60_000).toISOString());
    expect(state.delays).toEqual([20_000, 20_000]);
    expect(state.requests).toEqual([10_000, 30_000, 50_000]);
    expect(state.now).toBe(50_000);
  });

  it("keeps a triggered start red when its mirror job listing is rate-limited past the deadline", async () => {
    const w = world();
    const resetSec = Math.floor(Date.now() / 1000) + 3600;
    w.state.intercept = async (url) => {
      if (url === `${ROOT}/actions/runs/9001/jobs?filter=latest&per_page=100`) return rateLimited(resetSec);
    };
    const env = {
      ...w.deps.env, OVERFLOW_LEDGER_SWEEP_ONLY: "false", OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "9001",
      OVERFLOW_GITHUB_WORKFLOW_RUN_HEAD_SHA: HEAD, OVERFLOW_GITHUB_WORKFLOW_RUN_PATH: ".github/workflows/ci.yml",
      OVERFLOW_GITHUB_WORKFLOW_RUN_CONCLUSION: "success", OVERFLOW_GITHUB_WORKFLOW_RUN_EVENT: "push",
      OVERFLOW_GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "main", OVERFLOW_GITHUB_WORKFLOW_RUN_ATTEMPT: "1",
      OVERFLOW_GITHUB_WORKFLOW_RUN_HTML_URL: `https://github.com/${REPO}/actions/runs/9001`,
    };

    const error = await caught(w.run({ env }));

    expect(error).toBeInstanceOf(RateLimitExceededError);
    expect(error.message).toContain(new Date(resetSec * 1000).toISOString());
    expect(error.message).toMatch(/run deadline is /);
    expect(w.state.delays).toEqual([]);
    expect(w.state.posts).toBe(0);
  });

  it("refuses to wait a reset that fits only without the five-second margin", async () => {
    // reset 58 s + margin 5 s = 63 s > 60 s deadline: the wait would end with
    // the retried request no time, so it must not start.
    const { deps, state } = rateLimitDeps([rateLimited(58)]);

    const error = await caught(apiCall(deps, theCall, what));

    expect(error).toBeInstanceOf(RateLimitExceededError);
    expect(state.delays).toEqual([]);
    expect(state.requests).toEqual([10_000]);
  });

  it("keeps a single-attempt caller immediate on a fitting reset", async () => {
    const { deps, state } = rateLimitDeps([rateLimited(14)]);

    const error = await caught(apiCall(deps, theCall, what, false));

    expect(error).toBeInstanceOf(RateLimitExceededError);
    expect(state.delays).toEqual([]);
    expect(state.requests).toEqual([10_000]);
  });

  it("does not classify a 403 whose x-ratelimit-remaining is non-zero even with a parsable reset", async () => {
    const { deps, state } = rateLimitDeps([
      new Response("This workflow is already running", {
        status: 403, headers: { "x-ratelimit-remaining": "5", "x-ratelimit-reset": "14" },
      }),
    ]);

    const error = await caught(apiCall(deps, theCall, what));

    expect(error).not.toBeInstanceOf(RateLimitExceededError);
    expect(error.message).toContain("HTTP 403");
    expect(state.delays).toEqual([]);
    expect(state.requests).toEqual([10_000]);
  });

  it("classifies a 403 whose only marker is the rate-limit body, reading the reset from x-ratelimit-reset", async () => {
    // remaining is present but non-zero: the body match is the working marker.
    const { deps, state } = rateLimitDeps([
      new Response("API rate limit exceeded for installation ID 166057493", {
        status: 403, headers: { "x-ratelimit-remaining": "1", "x-ratelimit-reset": "14" },
      }),
      new Response(JSON.stringify({ jobs: [] })),
    ]);

    await expect(apiCall(deps, theCall, what)).resolves.toEqual({ jobs: [] });

    expect(state.delays).toEqual([4_000]);
    expect(state.requests).toEqual([10_000, 14_000]);
  });

  it("restores the backoff slot after a rate-limit wait when the next answer is a 500", async () => {
    const { deps, state } = rateLimitDeps([
      rateLimited(14),
      new Response("try again", { status: 500 }),
      new Response(JSON.stringify({ jobs: [] })),
    ]);

    await expect(apiCall(deps, theCall, what)).resolves.toEqual({ jobs: [] });

    // The wait consumed attempt 1's backoff slot; attempt 2's 500 retry takes
    // the next slot in the ladder.
    expect(state.delays).toEqual([4_000, 2_000]);
    expect(state.requests).toEqual([10_000, 14_000, 16_000]);
  });

  it("does not let an earlier rate limit name a later network failure", async () => {
    const delays: number[] = [];
    let now = 10_000;
    let requests = 0;
    const deps: RelayHttpDeps = {
      deadlineMs: 60_000,
      nowFn: () => now,
      delayFn: async (ms) => { delays.push(ms); now += ms; },
      fetchFn: async () => {
        requests += 1;
        if (requests === 1) return rateLimited(14);
        throw new TypeError("fetch failed");
      },
    };

    const error = await caught(apiCall(deps, theCall, what));

    // The network failure cleared the classified reset: the tail is the plain
    // attempts error, not the rate limit a sweep-only start would defer on.
    expect(error).not.toBeInstanceOf(RateLimitExceededError);
    expect(error.message).toContain("failed after 3 attempts: fetch failed");
    expect(delays).toEqual([4_000, 2_000]);
    expect(requests).toBe(3);
  });
});
