import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

import { runRelay } from "../../scripts/ledger-relay.ts";
import { resolveSuitePullRequest } from "../../scripts/resolve-suite-pull-request.ts";

const REPO = "Nitjsefnie/Overflow";
const ROOT = `https://api.github.com/repos/${REPO}`;
const HEAD = "b".repeat(40);
const MAIN = "a".repeat(40);
const pins = JSON.parse(readFileSync(".github/required-checks.json", "utf8"));
type Body = Record<string, unknown>;
let key: string;
beforeAll(() => {
  key = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs8", format: "pem" }).toString();
});

function suite(id: number, conclusion: string): Body {
  return {
    id, path: ".github/workflows/pr-suite.yml", event: "pull_request",
    status: "completed", conclusion, head_sha: HEAD, head_branch: "main",
    head_repository: { full_name: "contributor/Overflow", owner: { login: "contributor" } },
    run_attempt: 1, run_started_at: "2026-10-12T08:00:00Z",
  };
}

function verify(id: number, upstream: number, conclusion: string): Body {
  return {
    id, path: ".github/workflows/ci-pr.yml", event: "workflow_run",
    status: "completed", conclusion, head_sha: MAIN, head_branch: "main",
    repository: { id: 123456 }, head_repository: { full_name: REPO },
    display_title: `verify for pr suite run ${upstream}`,
    created_at: "2026-10-12T09:00:00Z", run_attempt: 1,
    html_url: `https://github.com/${REPO}/actions/runs/${id}`,
  };
}

const oldSuite = suite(8001, "success");
const oldVerify = verify(9001, 8001, "success");
const failedSuite = suite(8002, "failure");
const failedVerify = verify(9002, 8002, "failure");
const response = (body: unknown) => new Response(JSON.stringify(body));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Adapted from the adversary probe; only HTTP is replaced, and all relays share a check store. */
function world() {
  const state = {
    suites: [oldSuite], producers: [oldVerify], checks: [] as Body[], requests: [] as string[],
    oversized: false, historyReadFails: false, blockOldWrite: false,
    oldCommitted: false, afterOldCommitReads: [] as string[],
    onCommit: undefined as ((body: Body) => void | Promise<void>) | undefined,
  };
  const blocked = deferred();
  const released = deferred();
  const baseEnv = {
    LEDGER_APP_ID: "5118623", LEDGER_INSTALLATION_ID: "166057493",
    LEDGER_APP_KEY: key, GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: "123456",
  };
  const mirrorEnv = (run: Body) => ({
    ...baseEnv, GITHUB_WORKFLOW_RUN_ID: String(run.id), GITHUB_WORKFLOW_RUN_HEAD_SHA: MAIN,
    GITHUB_WORKFLOW_RUN_PATH: String(run.path), GITHUB_WORKFLOW_RUN_CONCLUSION: String(run.conclusion),
    GITHUB_WORKFLOW_RUN_HTML_URL: String(run.html_url), GITHUB_WORKFLOW_RUN_EVENT: String(run.event),
    GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "main", GITHUB_WORKFLOW_RUN_ATTEMPT: String(run.run_attempt),
  });
  const fetchFn = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    state.requests.push(url);
    if (state.oldCommitted && init.method !== "POST") state.afterOldCommitReads.push(url);
    if (url.endsWith("/access_tokens")) return response({ token: "test-only" });
    if (url === `${ROOT}/check-runs` && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as Body;
      if (state.blockOldWrite && body.external_id === "9001:1") {
        blocked.resolve();
        await released.promise;
      }
      state.checks.push({ ...body, app: { id: 5118623 } });
      if (body.external_id === "9001:1") state.oldCommitted = true;
      await state.onCommit?.(body);
      return response({ id: state.checks.length });
    }
    if (url.includes("/actions/workflows/pr-suite.yml/runs?")) {
      // A matching message is still a transient error, never deterministic exhaustion.
      if (state.historyReadFails) return new Response("suite history exceeds 10 pages / 1000 runs", { status: 503 });
      return response(state.oversized
        ? { total_count: 1001, workflow_runs: Array.from({ length: 100 }, (_, i) => suite(8002 - i, "failure")) }
        : { total_count: state.suites.length, workflow_runs: state.suites });
    }
    if (url === `${ROOT}/actions/runs?per_page=100`) return response({ workflow_runs: state.producers });
    if (url.includes(`/commits/${HEAD}/check-runs?`)) return response({ check_runs: state.checks.slice(-1) });
    for (const run of [...state.suites, ...state.producers]) {
      if (url === `${ROOT}/actions/runs/${run.id}`) return response(run);
      if (url === `${ROOT}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`) {
        return response({ jobs: [{ name: "verify", run_attempt: run.run_attempt,
          status: run.status, conclusion: run.conclusion }] });
      }
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const relay = (mode: "mirror" | "sweep", run = oldVerify) => runRelay({
    env: mode === "mirror" ? mirrorEnv(run) : { ...baseEnv, LEDGER_SWEEP_ONLY: "true" },
    fetchFn, delayFn: async () => {}, readPinMap: async () => pins,
  });
  return { state, blocked, released, fetchFn, relay };
}

describe("post-write supersession repair", () => {
  it.each(["sweep", "mirror"] as const)("repairs a delayed older %s success after the newer failure relay completes", async (mode) => {
    const w = world();
    w.state.blockOldWrite = true;
    const older = w.relay(mode);
    await w.blocked.promise;
    try {
      w.state.suites = [failedSuite, oldSuite];
      w.state.producers = [failedVerify, oldVerify];
      const resolution = await resolveSuitePullRequest({
        env: { GITHUB_REPOSITORY: REPO, GH_TOKEN: "test-only", SUITE_RUN_ID: "8002" }, fetchFn: w.fetchFn,
      });
      expect(resolution.exitCode).toBe(1);
      expect(resolution.lines[0]).toMatch(/must conclude success/);
      await w.relay("mirror", failedVerify);
      expect(w.state.checks.at(-1)?.conclusion).toBe("failure");
    } finally {
      w.released.resolve();
    }
    await older;
    expect(w.state.afterOldCommitReads[0]).toBe(`${ROOT}/actions/runs/8001`);
    expect(w.state.checks.map((check) => `${check.external_id}=${check.conclusion}`))
      .toEqual(["9002:1=failure", "9001:1=success", "9002:1=failure"]);
    expect(w.state.checks.at(-1)).toMatchObject({ head_sha: HEAD, external_id: "9002:1", conclusion: "failure" });
  });

  it.each(["sweep", "mirror"] as const)("does not correct the %s write when the newest producer is not completed", async (mode) => {
    const w = world();
    w.state.onCommit = (body) => {
      if (body.external_id !== "9001:1") return;
      w.state.suites = [failedSuite, oldSuite];
      w.state.producers = [{ ...failedVerify, status: "queued", conclusion: null }, oldVerify];
    };
    await w.relay(mode);
    expect(w.state.checks.map((check) => check.external_id)).toEqual(["9001:1"]);
    expect(w.state.requests).not.toContain(`${ROOT}/actions/runs/9002/jobs?filter=latest&per_page=100`);
  });

  it.each(["sweep", "mirror"] as const)("throws when the %s post-write supersession read fails", async (mode) => {
    const w = world();
    w.state.onCommit = () => { w.state.historyReadFails = true; };
    await expect(w.relay(mode)).rejects.toThrow(/suite.*failed/);
    expect(w.state.checks).toHaveLength(1);
  });

  it("bounds correction to one even when a third producer appears", async () => {
    const w = world();
    const middleSuite = suite(8002, "success");
    const middleVerify = verify(9002, 8002, "success");
    const lastSuite = suite(8003, "failure");
    const lastVerify = verify(9003, 8003, "failure");
    w.state.onCommit = (body) => {
      if (body.external_id === "9001:1") {
        w.state.suites = [middleSuite, oldSuite];
        w.state.producers = [middleVerify, oldVerify];
      } else if (body.external_id === "9002:1") {
        w.state.suites = [lastSuite, middleSuite, oldSuite];
        w.state.producers = [lastVerify, middleVerify, oldVerify];
      }
    };
    await w.relay("sweep");
    expect(w.state.checks.map((check) => check.external_id)).toEqual(["9001:1", "9002:1"]);
  });

  it("does not duplicate a newest producer already attested after the older write", async () => {
    const w = world();
    w.state.onCommit = async (body) => {
      if (body.external_id !== "9001:1") return;
      w.state.suites = [failedSuite, oldSuite];
      w.state.producers = [failedVerify, oldVerify];
      await w.relay("mirror", failedVerify);
    };
    await w.relay("sweep");
    expect(w.state.checks.map((check) => check.external_id)).toEqual(["9001:1", "9002:1"]);
    expect(w.state.checks.at(-1)?.conclusion).toBe("failure");
  });
});

describe("history-bound publication direction", () => {
  it.each(["mirror", "sweep"] as const)("replaces a seeded green with verify failure at the deterministic bound, %s", async (mode) => {
    const w = world();
    await w.relay("mirror");
    expect(w.state.checks.at(-1)?.conclusion).toBe("success");
    w.state.suites = [failedSuite, oldSuite];
    w.state.producers = [failedVerify];
    w.state.oversized = true;
    await w.relay(mode, failedVerify);
    expect(w.state.checks.at(-1)).toMatchObject({ name: "verify", head_sha: HEAD, conclusion: "failure" });
    expect((w.state.checks.at(-1)?.output as Body).summary).toMatch(/1000 runs/);
  });

  it.each(["mirror", "sweep"] as const)("transient history errors still throw before posting, %s", async (mode) => {
    const w = world();
    w.state.historyReadFails = true;
    await expect(w.relay(mode)).rejects.toThrow(/suite.*failed/);
    expect(w.state.checks).toEqual([]);
  });
});
