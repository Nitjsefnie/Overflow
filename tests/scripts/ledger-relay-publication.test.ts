import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

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
const GATE_CONTEXTS = ["actionlint", "ratchet-guard", "secret-scan", "dependency-audit"];
function gate(id: number, conclusion: string): Body {
  return { ...verify(id, 8001, conclusion), path: ".github/workflows/pr-gates.yml",
    event: "pull_request_target", head_branch: "feature/repro", head_sha: HEAD };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

/** Adapted from the adversary probe; only HTTP is replaced, and all relays share a check store. */
function world(kind: "verify" | "pr-gates" = "verify") {
  const initial = kind === "verify" ? oldVerify : gate(9001, "success");
  const state = {
    suites: [oldSuite], producers: [initial], checks: [] as Body[], requests: [] as string[],
    oversized: false, historyReadFails: false, blockOldWrite: false,
    listingReadFails: false, blockWriteId: "9001:1",
    oldCommitted: false, afterOldCommitReads: [] as string[],
    onCommit: undefined as ((body: Body) => void | Promise<void>) | undefined,
    onJobs: undefined as (() => void) | undefined,
  };
  const blocked = deferred();
  const released = deferred();
  const baseEnv = {
    LEDGER_APP_ID: "5118623", LEDGER_INSTALLATION_ID: "166057493",
    LEDGER_APP_KEY: key, GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: "123456",
  };
  const mirrorEnv = (run: Body) => ({
    ...baseEnv, GITHUB_WORKFLOW_RUN_ID: String(run.id), GITHUB_WORKFLOW_RUN_HEAD_SHA: String(run.head_sha),
    GITHUB_WORKFLOW_RUN_PATH: String(run.path), GITHUB_WORKFLOW_RUN_CONCLUSION: String(run.conclusion),
    GITHUB_WORKFLOW_RUN_HTML_URL: String(run.html_url), GITHUB_WORKFLOW_RUN_EVENT: String(run.event),
    GITHUB_WORKFLOW_RUN_HEAD_BRANCH: String(run.head_branch), GITHUB_WORKFLOW_RUN_ATTEMPT: String(run.run_attempt),
  });
  const fetchFn = (async (input: unknown, init: RequestInit = {}) => {
    const url = String(input);
    state.requests.push(url);
    if (state.oldCommitted && init.method !== "POST") state.afterOldCommitReads.push(url);
    if (url.endsWith("/access_tokens")) return response({ token: "test-only" });
    if (url === `${ROOT}/check-runs` && init.method === "POST") {
      const body = JSON.parse(String(init.body)) as Body;
      if (state.blockOldWrite && body.external_id === state.blockWriteId) {
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
    if (url === `${ROOT}/actions/runs?per_page=100`) {
      if (state.listingReadFails) return new Response("producer listing unavailable", { status: 503 });
      return response({ workflow_runs: state.producers });
    }
    if (url.includes(`/commits/${HEAD}/check-runs?`)) {
      const latest = new Map<string, Body>();
      for (const check of state.checks) latest.set(String(check.name), check);
      return response({ check_runs: [...latest.values()] });
    }
    for (const run of [...state.suites, ...state.producers]) {
      if (url === `${ROOT}/actions/runs/${run.id}`) return response(run);
      if (url === `${ROOT}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`) {
        state.onJobs?.();
        const contexts = run.path === ".github/workflows/pr-gates.yml" ? GATE_CONTEXTS : ["verify"];
        return response({ jobs: contexts.map((name) => ({ name, run_attempt: run.run_attempt,
          status: run.status, conclusion: run.conclusion })) });
      }
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const relay = (mode: "mirror" | "sweep", run = initial) => runRelay({
    env: mode === "mirror" ? mirrorEnv(run) : { ...baseEnv, LEDGER_SWEEP_ONLY: "true" },
    fetchFn, delayFn: async () => {}, readPinMap: async () => pins,
  });
  return { state, blocked, released, fetchFn, relay };
}

describe("unsuccessful upstream suites cannot receive App success", () => {
  it.each(["mirror", "sweep"] as const)("suppresses and logs %s success for cancelled or failed upstream suites", async (mode) => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const conclusion of ["cancelled", "failure"]) {
        const w = world();
        w.state.suites = [suite(8001, conclusion)];
        const result = await w.relay(mode);
        expect(w.state.checks, conclusion).toEqual([]);
        expect(result.posted).toEqual([]);
        expect(result.sweep.relayed).toEqual([]);
        expect(log.mock.calls.flat().join("\n")).toMatch(new RegExp(`9001.*upstream.*${conclusion}.*success`));
      }
    } finally { log.mockRestore(); }
  });

  it.each(["mirror", "sweep"] as const)("preserves %s failure for a cancelled upstream", async (mode) => {
    const w = world();
    const failed = verify(9001, 8001, "failure");
    w.state.suites = [suite(8001, "cancelled")];
    w.state.producers = [failed];
    await w.relay(mode, failed);
    expect(w.state.checks).toHaveLength(1);
    expect(w.state.checks[0]).toMatchObject({ head_sha: HEAD, conclusion: "failure", external_id: "9001:1" });
  });

  it.each(["mirror", "sweep"] as const)("suppresses %s success when upstream changes after the initial read", async (mode) => {
    const w = world();
    let reads = 0;
    const result = await runRelay({
      env: mode === "sweep" ? {
        LEDGER_APP_ID: "5118623", LEDGER_INSTALLATION_ID: "166057493", LEDGER_APP_KEY: key,
        GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: "123456", LEDGER_SWEEP_ONLY: "true",
      } : {
        LEDGER_APP_ID: "5118623", LEDGER_INSTALLATION_ID: "166057493", LEDGER_APP_KEY: key,
        GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: "123456", LEDGER_DISPATCH_RUN_ID: "9001",
      },
      fetchFn: (async (input, init) => {
        if (String(input) === `${ROOT}/actions/runs/8001` && ++reads > 1) {
          w.state.suites = [suite(8001, "cancelled")];
        }
        return w.fetchFn(input, init);
      }) as typeof fetch,
      delayFn: async () => {}, readPinMap: async () => pins,
    });
    expect(w.state.checks).toEqual([]);
    expect(result.posted).toEqual([]);
    expect(result.sweep.relayed).toEqual([]);
  });

  it.each(["cancelled", "failure"])("does not publish a selected newer success for a %s upstream", async (conclusion) => {
    const w = world();
    w.state.suites = [suite(8002, conclusion), oldSuite];
    w.state.producers = [verify(9002, 8002, "success"), oldVerify];
    await w.relay("sweep");
    expect(w.state.checks).toEqual([]);
  });
});

describe("issue 1195 newest-completed publication regressions", () => {
  it("never posts corrective 10002 success after the relayed 11002 failure", async () => {
    const w = world();
    const middleSuite = { ...suite(10001, "success"), run_started_at: "2026-10-12T09:01:00Z" };
    const middleVerify = { ...verify(10002, 10001, "success"), created_at: "2026-10-12T09:02:00Z" };
    const lastSuite = { ...suite(11001, "failure"), run_started_at: "2026-10-12T09:03:00Z" };
    const lastVerify = { ...verify(11002, 11001, "failure"), created_at: "2026-10-12T09:04:00Z" };
    w.state.blockOldWrite = true;
    w.state.blockWriteId = "10002:1";
    w.state.onCommit = (body) => {
      if (body.external_id !== "9001:1") return;
      w.state.suites = [middleSuite, oldSuite];
      w.state.producers = [middleVerify, oldVerify];
    };
    const olderSweep = w.relay("sweep");
    // A removed correction must let the original sweep finish; it must not
    // deadlock this reproduction waiting for a POST that no longer exists.
    await Promise.race([w.blocked.promise, olderSweep]);
    try {
      w.state.suites = [lastSuite, middleSuite, oldSuite];
      w.state.producers = [lastVerify, middleVerify, oldVerify];
      const resolution = await resolveSuitePullRequest({
        env: { GITHUB_REPOSITORY: REPO, GH_TOKEN: ["test", "only"].join("-"), SUITE_RUN_ID: "11001" },
        fetchFn: w.fetchFn,
      });
      expect(resolution.exitCode).toBe(1);
      expect(resolution.lines[0]).toMatch(/must conclude success/);
      const failure = await w.relay("mirror", lastVerify);
      expect(failure.decisions[0]).toMatchObject({ context: "verify", conclusion: "failure" });
      expect(w.state.checks.at(-1)).toMatchObject({ external_id: "11002:1", conclusion: "failure" });
    } finally { w.released.resolve(); }
    expect((await olderSweep).sweepOnly).toBe(true);
    expect(w.state.checks.at(-1)).toMatchObject({
      head_sha: HEAD, name: "verify", external_id: "11002:1", conclusion: "failure", app: { id: 5118623 },
    });
    expect(w.state.checks.map((check) => `${check.external_id}=${check.conclusion}`))
      .toEqual(["9001:1=success", "11002:1=failure"]);
    const before = w.state.checks.length;
    await w.relay("sweep");
    expect(w.state.checks).toHaveLength(before);
  });

  it("posts nothing when an older pr-gates mirror follows the newer failure relay", async () => {
    const w = world("pr-gates");
    const older = gate(9001, "success");
    const newer = gate(9002, "failure");
    w.state.producers = [newer, older];
    await w.relay("mirror", newer);
    const before = w.state.checks.length;
    const result = await w.relay("mirror", older);
    expect(result.posted).toEqual([]);
    expect(w.state.checks.slice(before)).toEqual([]);
    for (const context of GATE_CONTEXTS) {
      expect(w.state.checks.filter((check) => check.name === context).at(-1))
        .toMatchObject({ head_sha: HEAD, external_id: "9002:1", conclusion: "failure" });
    }
  });

  it("posts nothing for an older workflow_run mirror with the same unsuperseded suite", async () => {
    const w = world();
    const newer = verify(9002, 8001, "failure");
    w.state.producers = [newer, oldVerify];
    await w.relay("mirror", newer);
    const before = w.state.checks.length;
    const result = await w.relay("mirror", oldVerify);
    expect(result.supersededBy).toBeUndefined();
    expect(result.posted).toEqual([]);
    expect(w.state.checks.slice(before)).toEqual([]);
    expect(w.state.checks.at(-1)).toMatchObject({ head_sha: HEAD, external_id: "9002:1", conclusion: "failure" });
  });

  it("relies on G-1 serialization: the older sweep POST finishes before the newer failure relay starts", async () => {
    const w = world();
    w.state.blockOldWrite = true;
    const olderSweep = w.relay("sweep");
    await Promise.race([w.blocked.promise, olderSweep.then(() => { throw new Error("original POST was not held"); })]);
    // The producer can complete while a relay is running; G-1 queues its relay.
    w.state.suites = [failedSuite, oldSuite];
    w.state.producers = [failedVerify, oldVerify];
    w.released.resolve();
    expect((await olderSweep).sweepOnly).toBe(true);
    const resolution = await resolveSuitePullRequest({
      env: { GITHUB_REPOSITORY: REPO, GH_TOKEN: ["test", "only"].join("-"), SUITE_RUN_ID: "8002" },
      fetchFn: w.fetchFn,
    });
    expect(resolution.exitCode).toBe(1);
    await w.relay("mirror", failedVerify);
    expect(w.state.checks.at(-1)).toMatchObject({ head_sha: HEAD, external_id: "9002:1", conclusion: "failure" });
    const failureIndex = w.state.checks.findIndex((check) => check.external_id === "9002:1");
    expect(w.state.checks.slice(failureIndex).every((check) => check.conclusion === "failure")).toBe(true);
  });
});

describe("serialized supersession publication", () => {
  it.each(["sweep", "mirror"] as const)("finishes an older %s success before relaying the newer failure", async (mode) => {
    const w = world();
    w.state.blockOldWrite = true;
    const older = w.relay(mode);
    await Promise.race([w.blocked.promise, older.then(() => { throw new Error("old POST was not held"); })]);
    w.released.resolve();
    await older;
    w.state.suites = [failedSuite, oldSuite];
    w.state.producers = [failedVerify, oldVerify];
    const resolution = await resolveSuitePullRequest({
      env: { GITHUB_REPOSITORY: REPO, GH_TOKEN: ["test", "only"].join("-"), SUITE_RUN_ID: "8002" }, fetchFn: w.fetchFn,
    });
    expect(resolution.exitCode).toBe(1);
    expect(resolution.lines[0]).toMatch(/must conclude success/);
    await w.relay("mirror", failedVerify);
    expect(w.state.checks.map((check) => `${check.external_id}=${check.conclusion}`))
      .toEqual(["9001:1=success", "9002:1=failure"]);
    expect(w.state.checks.at(-1)).toMatchObject({ head_sha: HEAD, external_id: "9002:1", conclusion: "failure" });
  });

  it.each(["sweep", "mirror"] as const)("selects the completed %s producer instead of an unfinished replacement", async (mode) => {
    const w = world();
    w.state.producers = [{ ...verify(9002, 8001, "failure"), status: "queued", conclusion: null }, oldVerify];
    await w.relay(mode);
    expect(w.state.checks.map((check) => check.external_id)).toEqual(["9001:1"]);
    expect(w.state.requests).not.toContain(`${ROOT}/actions/runs/9002/jobs?filter=latest&per_page=100`);
  });

  it.each(["sweep", "mirror"] as const)("throws when the %s pre-write supersession read fails", async (mode) => {
    const w = world();
    w.state.onJobs = () => { w.state.historyReadFails = true; };
    await expect(w.relay(mode)).rejects.toThrow(/suite.*failed/);
    expect(w.state.checks).toEqual([]);
  });

  it("leaves producers completed after a write for the next serialized sweep", async () => {
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
    expect(w.state.checks.map((check) => check.external_id)).toEqual(["9001:1"]);
    await w.relay("sweep");
    expect(w.state.checks.map((check) => check.external_id)).toEqual(["9001:1", "9002:1"]);
    await w.relay("sweep");
    expect(w.state.checks.map((check) => `${check.external_id}=${check.conclusion}`))
      .toEqual(["9001:1=success", "9002:1=success", "9003:1=failure"]);
  });

  it("does not duplicate a newest producer already attested before an older start", async () => {
    const w = world();
    await w.relay("sweep");
    w.state.suites = [failedSuite, oldSuite];
    w.state.producers = [failedVerify, oldVerify];
    await w.relay("mirror", failedVerify);
    await w.relay("mirror", oldVerify);
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

describe("every-producer pre-write selection", () => {
  it.each(["mirror", "sweep"] as const)("fails before the %s history-bound certificate when the producer listing fails", async (mode) => {
    const w = world();
    w.state.oversized = true;
    w.state.listingReadFails = true;
    await expect(w.relay(mode)).rejects.toThrow(/listing.*failed/);
    expect(w.state.checks).toEqual([]);
  });

  it("binds a history-bound sweep certificate to the newest producer before posting", async () => {
    const w = world();
    w.state.oversized = true;
    w.state.suites = [failedSuite, oldSuite];
    w.state.producers = [failedVerify, oldVerify];
    await w.relay("sweep");
    expect(w.state.checks.map((check) => check.external_id)).toEqual(["9002:1"]);
    expect(w.state.checks.every((check) => check.conclusion === "failure")).toBe(true);
    expect((w.state.checks.at(-1)?.output as Body).summary).toMatch(/1000 runs/);
    await w.relay("sweep");
    expect(w.state.checks).toHaveLength(1);
  });

  it("serializes issue 1191's pr-gates sweep and newer failure for all four contexts", async () => {
    const w = world("pr-gates");
    const olderRun = gate(9001, "success");
    const newerRun = gate(9002, "failure");
    w.state.blockOldWrite = true;
    const older = w.relay("sweep");
    await Promise.race([w.blocked.promise, older.then(() => { throw new Error("old sweep missed its held write"); })]);
    w.released.resolve();
    await older;
    expect(w.state.afterOldCommitReads).toEqual([]);
    w.state.producers = [newerRun, olderRun];
    const failure = await w.relay("mirror", newerRun);
    expect(failure.posted).toEqual(GATE_CONTEXTS);
    for (const context of GATE_CONTEXTS) {
      const atContext = w.state.checks.filter((check) => check.name === context);
      expect(atContext.map((check) => `${check.external_id}=${check.conclusion}`))
        .toEqual(["9001:1=success", "9002:1=failure"]);
      expect(atContext.at(-1)).toMatchObject({ head_sha: HEAD, external_id: "9002:1", conclusion: "failure" });
    }
    const before = w.state.checks.length;
    await w.relay("sweep");
    expect(w.state.checks).toHaveLength(before);
  });

  it.each(["mirror", "sweep"] as const)("keeps the pr-gates %s attestation when only an unfinished replacement exists", async (mode) => {
    const w = world("pr-gates");
    w.state.producers = [{ ...gate(9002, "failure"), status: "queued", conclusion: null }, gate(9001, "success")];
    await w.relay(mode);
    expect(w.state.checks.map((check) => check.external_id)).toEqual(GATE_CONTEXTS.map(() => "9001:1"));
    expect(w.state.requests).not.toContain(`${ROOT}/actions/runs/9002/jobs?filter=latest&per_page=100`);
  });

  it("posts only the newest pr-gates producer for every context", async () => {
    const w = world("pr-gates");
    w.state.producers = [gate(9003, "failure"), gate(9002, "success"), gate(9001, "success")];
    await w.relay("sweep");
    expect(w.state.checks.map((check) => `${check.external_id}=${check.conclusion}`))
      .toEqual(GATE_CONTEXTS.map(() => "9003:1=failure"));
  });

  it.each(["mirror", "sweep"] as const)("throws on the pr-gates %s pre-write listing read failure", async (mode) => {
    const w = world("pr-gates");
    w.state.listingReadFails = true;
    await expect(w.relay(mode)).rejects.toThrow(/listing.*failed/);
    expect(w.state.checks).toEqual([]);
  });
});

describe("completed producer and bound selection", () => {
  it.each(["pr-gates", "verify"] as const)("selects completed B failure despite queued C after the serialized %s A sweep", async (kind) => {
    const w = world(kind);
    const runA = kind === "verify" ? oldVerify : gate(9001, "success");
    const runB = kind === "verify" ? failedVerify : gate(9002, "failure");
    const runC = { ...(kind === "verify" ? verify(9003, 8002, "failure") : gate(9003, "failure")),
      status: "queued", conclusion: null };
    w.state.blockOldWrite = true;
    const older = w.relay("sweep");
    await Promise.race([w.blocked.promise, older.then(() => { throw new Error("old sweep missed its held write"); })]);
    w.released.resolve();
    await older;
    w.state.suites = [failedSuite, oldSuite];
    w.state.producers = [runC, runB, runA];
    await w.relay("mirror", runA);
    for (const context of kind === "verify" ? ["verify"] : GATE_CONTEXTS) {
      const checks = w.state.checks.filter((check) => check.name === context);
      expect(checks.at(-1)).toMatchObject({ head_sha: HEAD, external_id: "9002:1", conclusion: "failure" });
      expect(checks.map((check) => `${check.external_id}=${check.conclusion}`))
        .toEqual(["9001:1=success", "9002:1=failure"]);
    }
    expect(w.state.requests).not.toContain(`${ROOT}/actions/runs/9003/jobs?filter=latest&per_page=100`);
  });

  it.each([
    ["sweep", "success"], ["mirror", "success"], ["sweep", "failure"], ["mirror", "failure"],
  ] as const)("decides the bound failure before the %s selected %s producer writes", async (mode, conclusion) => {
    const w = world();
    await w.relay("mirror");
    const middleSuite = suite(8002, conclusion);
    const middleVerify = verify(9002, 8002, conclusion);
    w.state.suites = [middleSuite, oldSuite];
    w.state.producers = [middleVerify, oldVerify];
    w.state.oversized = true;
    const result = await w.relay(mode, middleVerify);
    expect(w.state.checks.map((check) => `${check.external_id}=${check.conclusion}`))
      .toEqual(["9001:1=success", "9002:1=failure"]);
    expect(w.state.checks.at(-1)).toMatchObject({ name: "verify", head_sha: HEAD, external_id: "9002:1", conclusion: "failure" });
    expect((w.state.checks.at(-1)?.output as Body).summary).toMatch(/1000 runs/);
    if (mode === "mirror") expect(result.decisions[0]).toMatchObject({ context: "verify", conclusion: "failure", summary: expect.stringMatching(/1000 runs/) });
  });

  it.each(["sweep", "mirror"] as const)("throws for transient history failure before the %s selected newer write", async (mode) => {
    const w = world();
    await w.relay("mirror");
    const middleSuite = suite(8002, "success");
    const middleVerify = verify(9002, 8002, "success");
    w.state.suites = [middleSuite, oldSuite];
    w.state.producers = [middleVerify, oldVerify];
    w.state.onJobs = () => { w.state.historyReadFails = true; };
    await expect(w.relay(mode, middleVerify)).rejects.toThrow(/suite.*failed/);
    expect(w.state.checks.map((check) => `${check.external_id}=${check.conclusion}`))
      .toEqual(["9001:1=success"]);
  });
});
