import { appSuiteListing, RELAY_OWN_RUN_ENV, relayJobStartListing,
  relayJobStartUrl } from "./ledger-relay-check-fixtures.ts";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { renderRelayResult, runRelay } from "../../scripts/ledger-relay.ts";
import { RUN_DEADLINE_MS } from "../../scripts/ledger-relay-http.ts";
import { SWEEP_RUN_LIMIT } from "../../scripts/ledger-relay-producers.ts";
import { MIRROR_TRIGGER_RESERVE_MS } from "../../scripts/ledger-relay-publication.ts";
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
    jobsStatus: undefined as "queued" | "in_progress" | undefined,
    reruns: [] as Array<{ id: string; authorization: string }>,
    openPulls: true, liveRuns: [] as Body[],
  };
  const blocked = deferred();
  const released = deferred();
  const baseEnv = {
    ...RELAY_OWN_RUN_ENV, LEDGER_APP_ID: "5118623", LEDGER_INSTALLATION_ID: "166057493",
    LEDGER_APP_KEY: key, GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: "123456",
    RELAY_RERUN_TOKEN: ["rerun", "test"].join("-"),
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
      const atHead = state.suites.filter((run) => run.head_sha === new URL(url).searchParams.get("head_sha"));
      return response(state.oversized
        ? { total_count: 1001, workflow_runs: Array.from({ length: 100 }, (_, i) => suite(8002 - i, "failure")) }
        : { total_count: atHead.length, workflow_runs: atHead });
    }
    if (url === `${ROOT}/actions/runs?per_page=100` || url.startsWith(`${ROOT}/actions/runs?per_page=100&page=`)) {
      if (state.listingReadFails) return new Response("producer listing unavailable", { status: 503 });
      const page = Number(new URL(url).searchParams.get("page") ?? 1);
      return response({ total_count: state.producers.length, workflow_runs: state.producers.slice((page - 1) * 100, page * 100) });
    }
    const appSuites = appSuiteListing(url) ?? relayJobStartListing(url);
    if (appSuites !== undefined) return response(appSuites);
    const checkSuite = /\/check-suites\/([0-9]+)\/check-runs\?/.exec(url)?.[1];
    const checksHead = checkSuite === undefined
      ? /\/commits\/([^/]+)\/check-runs\?/.exec(url)?.[1]
      : (BigInt(checkSuite) - 1n).toString(16).padStart(40, "0");
    if (checksHead !== undefined) {
      const latest = new Map<string, Body>();
      for (const check of state.checks) {
        if (check.head_sha === checksHead) latest.set(String(check.name), check);
      }
      return response({ check_runs: [...latest.values()] });
    }
    const pullsHead = /\/commits\/([^/]+)\/pulls\?/.exec(url)?.[1];
    if (pullsHead !== undefined) return response(state.openPulls
      ? [{ state: "open", head: { sha: pullsHead, ref: "feature/repro" } }] : []);
    if (url.includes("/actions/runs?head_sha=")) return response({ workflow_runs: state.liveRuns });
    const rerunId = /\/actions\/runs\/([0-9]+)\/rerun$/.exec(url)?.[1];
    if (rerunId !== undefined && init.method === "POST") {
      state.reruns.push({ id: rerunId, authorization: (init.headers as Record<string, string>).authorization });
      return new Response(null, { status: 202 });
    }
    for (const run of [...state.suites, ...state.producers]) {
      if (url === `${ROOT}/actions/runs/${run.id}`) return response(run);
      if (url === `${ROOT}/actions/runs/${run.id}/jobs?filter=latest&per_page=100`) {
        state.onJobs?.();
        const contexts = run.path === ".github/workflows/pr-gates.yml" ? GATE_CONTEXTS : ["verify"];
        return response({ jobs: contexts.map((name) => ({ name, run_attempt: run.run_attempt,
          status: state.jobsStatus ?? run.status,
          conclusion: state.jobsStatus === undefined ? run.conclusion : null })) });
      }
    }
    throw new Error(`unexpected request ${url}`);
  }) as typeof fetch;
  const relay = (mode: "mirror" | "sweep", run = initial, env: Record<string, string | undefined> = {}) => runRelay({
    env: { ...(mode === "mirror" ? mirrorEnv(run) : { ...baseEnv, LEDGER_SWEEP_ONLY: "true" }), ...env },
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
        ...RELAY_OWN_RUN_ENV, LEDGER_APP_ID: "5118623", LEDGER_INSTALLATION_ID: "166057493", LEDGER_APP_KEY: key,
        GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: "123456", LEDGER_SWEEP_ONLY: "true",
      } : {
        ...RELAY_OWN_RUN_ENV, LEDGER_APP_ID: "5118623", LEDGER_INSTALLATION_ID: "166057493", LEDGER_APP_KEY: key,
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

describe("fix round 1 sequential safety probes", () => {
  it.each(["mirror", "sweep"] as const)("preserves a newer attested failure outside the bounded producer window, %s", async (mode) => {
    const w = world("pr-gates");
    const older = gate(9001, "success");
    const newer = gate(9002, "failure");
    w.state.producers = [newer, older];
    await w.relay("mirror", newer);
    const otherHeadRuns = Array.from({ length: mode === "mirror" ? SWEEP_RUN_LIMIT : SWEEP_RUN_LIMIT - 1 }, (_, i) => ({
      ...gate(10020 - i, "success"), head_sha: "c".repeat(40),
    }));
    // The mirror retains its omitted trigger; the sweep must actually select
    // the older candidate inside its window while the newer one is outside.
    w.state.producers = mode === "mirror"
      ? [...otherHeadRuns, newer, older] : [...otherHeadRuns, older, newer];
    const before = w.state.checks.length;
    await w.relay(mode, older);
    for (const context of GATE_CONTEXTS) {
      expect(w.state.checks.filter((check) => check.head_sha === HEAD && check.name === context).at(-1))
        .toMatchObject({ external_id: "9002:1", conclusion: "failure" });
    }
    expect(w.state.checks.slice(before).filter((check) => check.head_sha === HEAD)).toEqual([]);
  });

  it.each(["mirror", "sweep"] as const)("preserves a newer attested failure while its next attempt is queued, %s", async (mode) => {
    const w = world("pr-gates");
    const older = gate(9001, "success");
    const newer = gate(9002, "failure");
    w.state.producers = [newer, older];
    await w.relay("mirror", newer);
    w.state.producers = [{ ...newer, run_attempt: 2, status: "queued", conclusion: null }, older];
    const before = w.state.checks.length;
    await w.relay(mode, older);
    for (const context of GATE_CONTEXTS) {
      expect(w.state.checks.filter((check) => check.name === context).at(-1))
        .toMatchObject({ external_id: "9002:1", conclusion: "failure" });
    }
    expect(w.state.checks.slice(before)).toEqual([]);
  });

  it.each(["mirror", "sweep"] as const)("keeps the bound certificate when the same identity was green, %s", async (mode) => {
    const w = world();
    await w.relay("mirror");
    w.state.oversized = true;
    await w.relay(mode);
    expect(w.state.checks.at(-1)).toMatchObject({ external_id: "9001:1", conclusion: "failure" });
    expect((w.state.checks.at(-1)?.output as Body).summary).toMatch(/1000 runs/);
    expect(w.state.checks).toHaveLength(2);
    await w.relay(mode);
    expect(w.state.checks).toHaveLength(2);
  });

  it.each(["mirror", "sweep"] as const)("requires failure and bound evidence before skipping a same-identity certificate, %s", async (mode) => {
    const bound = "suite history exceeds 10 pages / 1000 runs";
    for (const [conclusion, output] of [
      ["success", { summary: bound }],
      ["failure", { summary: "the producing job failed" }],
      ["failure", {}],
    ] as const) {
      const w = world();
      await w.relay("mirror");
      Object.assign(w.state.checks[0], { conclusion, output });
      w.state.oversized = true;
      await w.relay(mode);
      expect(w.state.checks, `${conclusion}: ${JSON.stringify(output)}`).toHaveLength(2);
      expect(w.state.checks.at(-1)).toMatchObject({ external_id: "9001:1", conclusion: "failure" });
      expect((w.state.checks.at(-1)?.output as Body).summary).toContain(bound);
    }
  });

  it.each(["mirror", "sweep"] as const)("orders run ID before attempt when the producer keys oppose each other, %s", async (mode) => {
    const w = world("pr-gates");
    const lowerId = { ...gate(9001, "success"), run_attempt: 7 };
    const higherId = gate(9002, "failure");
    w.state.producers = [lowerId, higherId];
    await w.relay(mode, lowerId);
    expect(w.state.checks.map((check) => `${check.external_id}=${check.conclusion}`))
      .toEqual(GATE_CONTEXTS.map(() => "9002:1=failure"));
  });
});

describe("fix round 2 pending recovery and malformed identity probes", () => {
  it.each(["queued", "in_progress"] as const)("completes a mirror-created %s check after the job concludes", async (status) => {
    const w = world("pr-gates");
    let jobsPending = true;
    const fetchFn = (async (input: unknown, init: RequestInit = {}) => {
      if (String(input) === `${ROOT}/actions/runs/9001/jobs?filter=latest&per_page=100` && jobsPending) {
        w.state.requests.push(String(input));
        return response({ jobs: GATE_CONTEXTS.map((name) => ({ name, run_attempt: 1, status, conclusion: null })) });
      }
      return w.fetchFn(input as RequestInfo, init);
    }) as typeof fetch;
    const producer = w.state.producers[0];
    const baseEnv = {
      ...RELAY_OWN_RUN_ENV, LEDGER_APP_ID: "5118623", LEDGER_INSTALLATION_ID: "166057493", LEDGER_APP_KEY: key,
      GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: "123456",
    };
    const mirrorEnv = {
      ...baseEnv, GITHUB_WORKFLOW_RUN_ID: String(producer.id),
      GITHUB_WORKFLOW_RUN_HEAD_SHA: String(producer.head_sha), GITHUB_WORKFLOW_RUN_PATH: String(producer.path),
      GITHUB_WORKFLOW_RUN_CONCLUSION: String(producer.conclusion), GITHUB_WORKFLOW_RUN_HTML_URL: String(producer.html_url),
      GITHUB_WORKFLOW_RUN_EVENT: String(producer.event), GITHUB_WORKFLOW_RUN_HEAD_BRANCH: String(producer.head_branch),
      GITHUB_WORKFLOW_RUN_ATTEMPT: String(producer.run_attempt),
    };
    const start = (mode: "mirror" | "sweep") => runRelay({
      env: mode === "mirror" ? mirrorEnv : { ...baseEnv, LEDGER_SWEEP_ONLY: "true" },
      fetchFn, delayFn: async () => {}, readPinMap: async () => pins,
    });
    await start("mirror");
    expect(w.state.checks).toHaveLength(4);
    expect(w.state.checks.every((check) => check.external_id === "9001:1" && check.status === status && check.conclusion === undefined)).toBe(true);
    jobsPending = false;
    const recovery = await start("sweep");
    await start("mirror");
    await start("sweep");
    for (const context of GATE_CONTEXTS) {
      expect(w.state.checks.filter((check) => check.name === context).at(-1))
        .toMatchObject({ external_id: "9001:1", status: "completed", conclusion: "success" });
    }
    expect(recovery.sweep.relayed).toEqual(GATE_CONTEXTS.map((context) => ({ context, runId: "9001" })));
    expect(w.state.checks).toHaveLength(8);
  });

  it.each(["mirror", "sweep"] as const)("treats nonempty malformed external identities as no floor, %s", async (mode) => {
    for (const externalId of ["legacy-producer", "9002", "9002:bad", "9002:1:extra", "9002:1\n"]) {
      const w = world();
      await w.relay("mirror");
      w.state.checks[0].external_id = externalId;
      await w.relay(mode);
      expect(w.state.checks.at(-1), externalId)
        .toMatchObject({ external_id: "9001:1", status: "completed", conclusion: "success" });
      expect(w.state.checks, externalId).toHaveLength(2);
      await w.relay(mode);
      expect(w.state.checks, externalId).toHaveLength(2);
    }
  });

  it.each(["mirror", "sweep"] as const)("preserves a strictly newer identity floor even when the App check is pending, %s", async (mode) => {
    for (const status of ["queued", "in_progress"] as const) {
      const w = world("pr-gates");
      const older = gate(9001, "success");
      const newer = gate(9002, "success");
      w.state.producers = [newer, older];
      w.state.jobsStatus = status;
      await w.relay("mirror", newer);
      expect(w.state.checks).toHaveLength(4);
      expect(w.state.checks.every((check) => check.external_id === "9002:1" && check.status === status)).toBe(true);
      w.state.jobsStatus = undefined;
      w.state.producers = [{ ...newer, status: "queued", conclusion: null, run_attempt: 2 }, older];
      await w.relay(mode, older);
      expect(w.state.checks).toHaveLength(4);
      for (const context of GATE_CONTEXTS) {
        expect(w.state.checks.filter((check) => check.name === context).at(-1))
          .toMatchObject({ external_id: "9002:1", status });
      }
    }
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
  it.each(["mirror", "sweep"] as const)("retries the %s's uncommitted timed-out bound certificate over an ordinary same-identity failure", async (mode) => {
    const w = world();
    const failed = verify(9001, 8001, "failure");
    w.state.producers = [failed];
    await w.relay("sweep");
    expect((w.state.checks.at(-1)?.output as Body).summary).not.toContain("1000 runs");
    w.state.oversized = true;
    let writes = 0;
    const env = {
      ...RELAY_OWN_RUN_ENV, LEDGER_APP_ID: "5118623", LEDGER_INSTALLATION_ID: "166057493", LEDGER_APP_KEY: key,
      GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: "123456",
      ...(mode === "sweep" ? { LEDGER_SWEEP_ONLY: "true" } : {
        GITHUB_WORKFLOW_RUN_ID: "9001", GITHUB_WORKFLOW_RUN_HEAD_SHA: String(failed.head_sha),
        GITHUB_WORKFLOW_RUN_PATH: String(failed.path), GITHUB_WORKFLOW_RUN_CONCLUSION: "failure",
        GITHUB_WORKFLOW_RUN_HTML_URL: String(failed.html_url), GITHUB_WORKFLOW_RUN_EVENT: "workflow_run",
        GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "main", GITHUB_WORKFLOW_RUN_ATTEMPT: "1",
      }),
    };
    const result = await runRelay({
      env, fetchFn: (async (input, init) => {
        if (String(input) === `${ROOT}/check-runs` && init?.method === "POST" && ++writes === 1)
          throw new DOMException("request timed out before commit", "TimeoutError");
        return w.fetchFn(input, init);
      }) as typeof fetch,
      delayFn: async () => {}, readPinMap: async () => pins,
    });

    expect((w.state.checks.at(-1)?.output as Body).summary).toContain("1000 runs");
    expect(writes).toBe(2);
    expect(w.state.checks).toHaveLength(2);
    expect(w.state.checks.at(-1)).toMatchObject({ external_id: "9001:1", status: "completed", conclusion: "failure" });
    if (mode === "sweep") expect(result.sweep.relayed).toEqual([{ context: "verify", runId: "9001" }]);
    else expect(result.posted).toEqual(["verify"]);
    await w.relay(mode, failed);
    expect(w.state.checks).toHaveLength(2);
  });

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

/** One running start and one pending slot; replaced starts are never invoked. */
function concurrencyGroup() {
  type Start = { name: string; run: () => Promise<unknown> };
  let running: Promise<void> | undefined;
  let pending: Start | undefined;
  const started: string[] = [], displaced: string[] = [];
  const errors: unknown[] = [];
  function launch(start: Start) {
    started.push(start.name);
    running = (async () => {
      try { await start.run(); } catch (error) { errors.push(error); }
      const next = pending;
      pending = undefined;
      running = undefined;
      if (next !== undefined) launch(next);
    })();
  }
  return {
    started, displaced, errors,
    enqueue(name: string, run: () => Promise<unknown>) {
      if (running === undefined) launch({ name, run });
      else {
        if (pending !== undefined) displaced.push(pending.name);
        pending = { name, run };
      }
    },
    async drain() { while (running !== undefined) await running; },
  };
}

/** Unpinned runs are real listing rows, and must not consume producer capacity. */
function unrelated(id: number): Body {
  return { ...gate(id, "success"), path: ".github/workflows/unpinned.yml" };
}

function burstProducers(w: ReturnType<typeof world>, count: number, mixed = true): Body[] {
  return Array.from({ length: count }, (_, i) => {
    const head = mixed && i === 0 ? HEAD : (i + 100).toString(16).padStart(40, "0");
    if (mixed && i % 2 === 1) {
      w.state.suites.push({ ...suite(8002 + i, "success"), head_sha: head });
      return verify(9002 + i, 8002 + i, "success");
    }
    return { ...gate(9002 + i, mixed && i === 0 ? "failure" : "success"), head_sha: head };
  });
}

function enqueueBurst(w: ReturnType<typeof world>, group: ReturnType<typeof concurrencyGroup>, burst: Body[], survivor: string) {
  for (const producer of burst) {
    w.state.producers.unshift(producer, ...Array.from({ length: 3 }, (_, i) => unrelated(20000 + Number(producer.id) * 3 + i)));
    group.enqueue(String(producer.id), () => w.relay("mirror", producer));
  }
  if (survivor === "sweep-only") group.enqueue(survivor, () => w.relay("sweep"));
  if (survivor === "refused") {
    const refused = { ...gate(10000, "success"), event: "pull_request" };
    w.state.producers.unshift(refused);
    group.enqueue(survivor, () => w.relay("mirror", refused));
  }
}

function unattested(w: ReturnType<typeof world>, burst: Body[]): unknown[] {
  return burst.filter((producer) => {
    const head = producer.event === "workflow_run"
      ? w.state.suites.find((s) => s.id === Number(String(producer.display_title).split(" ").at(-1)))?.head_sha
      : producer.head_sha;
    const contexts = producer.event === "workflow_run" ? ["verify"] : GATE_CONTEXTS;
    return contexts.some((context) => {
      const latest = w.state.checks.filter((c) => c.head_sha === head && c.name === context).at(-1);
      return latest?.external_id !== `${producer.id}:1` || latest.status !== "completed" || latest.conclusion !== producer.conclusion;
    });
  }).map((producer) => producer.id);
}

describe("issue 1195 pending-start displacement", () => {
  it.each(["completion", "sweep-only", "refused"] as const)(
    "attests the burst by the next start cycle when the survivor is %s", async (survivor) => {
      const w = world("pr-gates");
      w.state.blockOldWrite = true;
      const group = concurrencyGroup();
      group.enqueue("in-flight", () => w.relay("sweep"));
      await w.blocked.promise;
      // Keep the promised 50-producer workload when a mutant shrinks the
      // implementation limit; growing the configured window grows the burst.
      const burst = burstProducers(w, Math.max(SWEEP_RUN_LIMIT, 50));
      enqueueBurst(w, group, burst, survivor);
      let failurePosted = false;
      w.state.onCommit = () => {
        const latest = w.state.checks.filter((c) => c.head_sha === HEAD && c.name === "actionlint").at(-1);
        if (latest?.external_id === "9002:1") failurePosted = true;
        if (failurePosted) expect(latest).toMatchObject({ external_id: "9002:1", conclusion: "failure" });
      };
      w.released.resolve();
      await group.drain();
      expect(group.started).toEqual(["in-flight", survivor === "completion" ? String(burst.at(-1)?.id) : survivor]);
      expect(group.displaced).toEqual(burst.slice(0, survivor === "completion" ? -1 : undefined).map((p) => String(p.id)));
      expect(unattested(w, burst)).toEqual([]);
      expect(failurePosted).toBe(true);
      expect(group.errors).toHaveLength(survivor === "refused" ? 1 : 0);
      if (survivor === "refused") expect(String(group.errors[0])).toContain("did not execute the base branch's workflow definition");
    },
  );

  it.each(["completion", "sweep-only", "refused"] as const)(
    "documents the burst bound: SWEEP_RUN_LIMIT + 1 leaves exactly the oldest unattested with %s", async (survivor) => {
      const w = world("pr-gates");
      w.state.blockOldWrite = true;
      const group = concurrencyGroup();
      group.enqueue("in-flight", () => w.relay("sweep"));
      await w.blocked.promise;
      const burst = burstProducers(w, SWEEP_RUN_LIMIT + 1, false);
      enqueueBurst(w, group, burst, survivor);
      w.released.resolve();
      await group.drain();
      expect(group.started).toEqual(["in-flight", survivor === "completion" ? String(burst.at(-1)?.id) : survivor]);
      expect(group.errors).toHaveLength(survivor === "refused" ? 1 : 0);
      expect(unattested(w, burst)).toEqual([9002]);
      expect(w.state.checks.some((c) => c.head_sha === burst[0].head_sha)).toBe(false);
    },
  );
});

describe("issue 1195 every start sweeps", () => {
  it.each(["unpinned-event", "unpinned-dispatch", "untrusted-live", "untrusted-dead", "workflow-run-refusal"])(
    "recovers another head's orphan through %s", async (path) => {
      const w = world("pr-gates");
      const orphan = gate(9002, "failure");
      let trigger: Body = { ...gate(9001, "success"), head_sha: "c".repeat(40) };
      if (path.startsWith("unpinned")) trigger.path = ".github/workflows/other.yml";
      if (path.startsWith("untrusted")) trigger.event = "pull_request";
      if (path === "workflow-run-refusal") trigger = { ...trigger, event: "workflow_run" };
      w.state.producers = [orphan, trigger];
      w.state.openPulls = path !== "untrusted-dead";
      const operation = w.relay("mirror", trigger, path === "unpinned-dispatch"
        ? { GITHUB_WORKFLOW_RUN_ID: "", LEDGER_DISPATCH_RUN_ID: "9001" } : {});
      if (path === "untrusted-live") await expect(operation).rejects.toThrow(
        'run 9001 (event "pull_request", head branch "feature/repro") did not execute the base branch\'s workflow definition; no required context was relayed',
      );
      else if (path === "workflow-run-refusal") await expect(operation).rejects.toThrow(/producer.*path/);
      else {
        const result = await operation;
        expect(result.posted).toEqual([]);
        expect(renderRelayResult(result).join("\n")).toContain("orphan-sweep");
      }
      for (const context of GATE_CONTEXTS) expect(w.state.checks.find((check) => check.name === context))
        .toMatchObject({ head_sha: HEAD, external_id: "9002:1", conclusion: "failure" });
    },
  );

  it("keeps the original refusal visible when the finally sweep also fails", async () => {
    const w = world("pr-gates");
    const refused = { ...gate(9001, "success"), event: "pull_request" };
    w.state.producers = [refused];
    w.state.listingReadFails = true;
    const error = await w.relay("mirror", refused).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect((error as AggregateError).message).toContain("did not execute the base branch's workflow definition");
    expect(((error as AggregateError).errors[0] as Error).message).toBe(
      'run 9001 (event "pull_request", head branch "feature/repro") did not execute the base branch\'s workflow definition; no required context was relayed',
    );
    expect((error as AggregateError).errors.map((entry: Error) => entry.message).join("\n"))
      .toContain("the repository's workflow-run listing for the orphan sweep");
    expect(w.state.requests.filter((url) => url === `${ROOT}/actions/runs?per_page=100`)).toHaveLength(3);
  });
});

describe("issue 1195 sweep rerun-heal", () => {
  it.each(["sweep", "mirror"] as const)("heals the newest cancelled candidate through %s exactly once", async (mode) => {
    const w = world("pr-gates");
    const candidate = { ...gate(9001, "cancelled"), run_started_at: null };
    w.state.producers = [candidate];
    const result = await w.relay(mode, candidate);
    expect(w.state.reruns).toEqual([{ id: "9001", authorization: "Bearer rerun-test" }]);
    expect(result.rerunDispatched).toBe(true);
    expect(renderRelayResult(result).join("\n")).toContain("rerun-heal");
  });

  it("heals an already-attested orphan using jobs only as fallback evidence", async () => {
    const w = world("pr-gates");
    const candidate = { ...gate(9001, "cancelled"), run_started_at: null };
    w.state.producers = [candidate];
    // Pre-attested checks must not prevent the heal from recovering a lost start.
    for (const name of GATE_CONTEXTS) w.state.checks.push({ name, head_sha: HEAD,
      external_id: "9001:1", status: "completed", conclusion: "failure", app: { id: 5118623 } });
    await w.relay("sweep");
    expect(w.state.reruns.map((run) => run.id)).toEqual(["9001"]);
    expect(w.state.requests.filter((url) => url.includes("/jobs?filter="))).toHaveLength(1);
  });

  it.each([
    ["non-cancelled", { conclusion: "success" }],
    ["non-healable event", { event: "push", head_branch: "main" }],
    ["attempt cap", { run_attempt: 5 }],
    ["run started", { run_started_at: "2026-10-12T08:00:00Z" }],
  ] as const)("applies the cheap %s guard before any heal query", async (_name, over) => {
    const w = world("pr-gates");
    w.state.producers = [{ ...gate(9001, "cancelled"), ...over }];
    await w.relay("sweep");
    expect(w.state.reruns).toEqual([]);
    expect(w.state.requests.some((url) => url.includes("/pulls?") || url.includes("?head_sha="))).toBe(false);
  });

  it.each(["started-job", "closed-pr", "live-run", "newer-producer"])("does not heal a %s candidate", async (guard) => {
    const w = world("pr-gates");
    const candidate = gate(9001, "cancelled");
    w.state.producers = [candidate];
    if (guard === "newer-producer") w.state.producers.unshift(gate(9002, "failure"));
    if (guard === "closed-pr") w.state.openPulls = false;
    if (guard === "live-run") w.state.liveRuns = [{ path: candidate.path, status: "pending" }];
    const fetchFn = (async (input: unknown, init?: RequestInit) => {
      if (guard === "started-job" && String(input).includes("/jobs?filter=")) {
        w.state.requests.push(String(input));
        return response({ jobs: GATE_CONTEXTS.map((name) => ({ name, status: "completed",
          conclusion: "cancelled", started_at: "2026-10-12T08:00:00Z" })) });
      }
      return w.fetchFn(input as RequestInfo, init);
    }) as typeof fetch;
    await runRelay({ env: { ...RELAY_OWN_RUN_ENV, LEDGER_APP_ID: "5118623", LEDGER_INSTALLATION_ID: "166057493",
      LEDGER_APP_KEY: key, GITHUB_REPOSITORY: REPO, LEDGER_SWEEP_ONLY: "true", RELAY_RERUN_TOKEN: "test" },
    fetchFn, delayFn: async () => {}, readPinMap: async () => pins });
    expect(w.state.reruns).toEqual([]);
    if (guard === "started-job" || guard === "newer-producer") {
      expect(w.state.requests.some((url) => url.includes("/pulls?"))).toBe(false);
    }
    if (guard === "closed-pr") expect(w.state.requests.some((url) => url.includes("/actions/runs?head_sha="))).toBe(false);
  });

  it("uses the listing's started-at for the trigger before the jobs fallback", async () => {
    const w = world("pr-gates");
    const candidate = { ...gate(9001, "cancelled"), run_started_at: "2026-10-12T08:00:00Z" };
    w.state.producers = [candidate];
    await w.relay("mirror", candidate);
    expect(w.state.reruns).toEqual([]);
    expect(w.state.requests.some((url) => url.includes("/pulls?"))).toBe(false);
  });

  it("fails red for a missing rerun token before any request, with or without a heal candidate", async () => {
    // The job-start read authenticates with the same workflow token.
    const w = world("pr-gates");
    await expect(w.relay("sweep", undefined, { RELAY_RERUN_TOKEN: "" })).rejects.toThrow("RELAY_RERUN_TOKEN is required");
    w.state.producers = [gate(9001, "cancelled")];
    await expect(w.relay("sweep", undefined, { RELAY_RERUN_TOKEN: "" })).rejects.toThrow("RELAY_RERUN_TOKEN is required");
    expect(w.state.requests).toEqual([]);
  });
});

describe("issue 1195 sweep request budget", () => {
  it.each([false, true].flatMap((attested) => [1, 2, 5].map((pages) => ({ attested, pages }))))(
    "pins requests for 50 distinct workflow_run heads across $pages pages, attested=$attested", async ({ attested, pages }) => {
      const w = world();
      w.state.producers = [];
      w.state.suites = [];
      for (let index = 0; index < 50; index++) {
        const head = (index + 1).toString(16).padStart(40, "0");
        w.state.suites.push({ ...suite(8001 + index, "success"), head_sha: head });
        w.state.producers.push(verify(9001 + index, 8001 + index, "success"),
          ...Array.from({ length: pages === 1 ? 0 : pages === 2 ? 3 : 8 }, (_, i) => unrelated(20000 + index * 10 + i)));
        if (attested) w.state.checks.push({ name: "verify", head_sha: head, external_id: `${9001 + index}:1`,
          status: "completed", conclusion: "success", app: { id: 5118623 } });
      }
      const result = await w.relay("sweep");
      expect(result.sweep.examined).toBe(50);
      expect(result.sweep.relayed).toHaveLength(attested ? 0 : 50);
      expect(w.state.requests).toHaveLength((attested ? 252 : 552) + pages);
      expect(w.state.requests.filter((url) => url === relayJobStartUrl())).toHaveLength(1);
      expect(w.state.requests.filter((url) => url.endsWith("/access_tokens"))).toHaveLength(1);
      expect(w.state.requests.filter((url) => url.startsWith(`${ROOT}/actions/runs?per_page=100`))).toHaveLength(pages);
      expect(w.state.requests.filter((url) => /\/actions\/runs\/[0-9]+$/.test(url))).toHaveLength(attested ? 100 : 200);
      expect(w.state.requests.filter((url) => url.includes("/actions/workflows/pr-suite.yml/runs?"))).toHaveLength(attested ? 50 : 150);
      expect(w.state.requests.filter((url) => url.includes("/commits/") && url.includes("/check-suites?"))).toHaveLength(50);
      expect(w.state.requests.filter((url) => url.includes("/check-suites/") && url.includes("/check-runs?"))).toHaveLength(50);
      expect(w.state.requests.filter((url) => url.includes("/jobs?filter="))).toHaveLength(attested ? 0 : 50);
      expect(w.state.requests.filter((url) => url === `${ROOT}/check-runs`)).toHaveLength(attested ? 0 : 50);
  });
});

it("does not heal the trigger's older cancelled attempt after a newer attempt completed", async () => {
  const w = world("pr-gates");
  const cancelled = gate(9001, "cancelled");
  w.state.producers = [{ ...gate(9001, "success"), run_attempt: 2 }];
  await w.relay("mirror", cancelled);
  expect(w.state.reruns).toEqual([]);
  for (const context of GATE_CONTEXTS) expect(w.state.checks.filter((check) => check.name === context).at(-1))
    .toMatchObject({ external_id: "9001:2", conclusion: "success" });
});

it("a refused start heals each newest cancelled orphan once across distinct heads", async () => {
  const w = world("pr-gates");
  const refused = { ...gate(9003, "success"), event: "pull_request" };
  w.state.producers = [refused, gate(9002, "cancelled"), { ...gate(9001, "cancelled"), head_sha: "c".repeat(40) }];
  await expect(w.relay("mirror", refused)).rejects.toThrow("did not execute the base branch's workflow definition");
  expect(w.state.reruns.map((run) => run.id)).toEqual(["9002", "9001"]);
});

describe("trigger validation still recovers displaced completions", () => {
  const ambiguous = "LEDGER_SWEEP_ONLY=true is a sweep-only relay: no triggering run may be named alongside it " +
    "(GITHUB_WORKFLOW_RUN_ID or LEDGER_DISPATCH_RUN_ID); unset one of the two";
  const absent = "no triggering run in the environment: expected GITHUB_WORKFLOW_RUN_* (workflow_run) " +
    "or LEDGER_DISPATCH_RUN_ID (workflow_dispatch recovery)";
  const cases: Array<[string, Record<string, string | undefined>, string]> = [
    ["invalid sweep-only value", { LEDGER_SWEEP_ONLY: "yes" },
      'LEDGER_SWEEP_ONLY must be exactly "true" or "false" (got "yes")'],
    ["sweep-only with workflow_run id", { LEDGER_SWEEP_ONLY: "true" }, ambiguous],
    ["sweep-only with dispatch id", { LEDGER_SWEEP_ONLY: "true", GITHUB_WORKFLOW_RUN_ID: "", LEDGER_DISPATCH_RUN_ID: "9001" }, ambiguous],
    ["malformed workflow_run id", { GITHUB_WORKFLOW_RUN_ID: "not-a-run-id" },
      'GITHUB_WORKFLOW_RUN_ID must be a workflow-run id (got "not-a-run-id")'],
    ["missing workflow_run head", { GITHUB_WORKFLOW_RUN_HEAD_SHA: undefined },
      'GITHUB_WORKFLOW_RUN_HEAD_SHA must be a 40-hex SHA (got "")'],
    ["malformed workflow_run head", { GITHUB_WORKFLOW_RUN_HEAD_SHA: "invalid-head" },
      'GITHUB_WORKFLOW_RUN_HEAD_SHA must be a 40-hex SHA (got "invalid-head")'],
    ["missing workflow_run path", { GITHUB_WORKFLOW_RUN_PATH: undefined },
      'GITHUB_WORKFLOW_RUN_PATH must be a workflow path (got "")'],
    ["malformed workflow_run path", { GITHUB_WORKFLOW_RUN_PATH: "workflows/other.yml" },
      'GITHUB_WORKFLOW_RUN_PATH must be a workflow path (got "workflows/other.yml")'],
    ["missing workflow_run URL", { GITHUB_WORKFLOW_RUN_HTML_URL: undefined },
      "GITHUB_WORKFLOW_RUN_HTML_URL is required for the check-run's details_url"],
    ["malformed dispatch id (review probe)", { GITHUB_WORKFLOW_RUN_ID: "", LEDGER_DISPATCH_RUN_ID: "not-a-run-id" },
      'LEDGER_DISPATCH_RUN_ID must be a workflow-run id (got "not-a-run-id")'],
    ["no triggering identity", { GITHUB_WORKFLOW_RUN_ID: "" }, absent],
    ["explicit false without a triggering identity", { GITHUB_WORKFLOW_RUN_ID: "", LEDGER_SWEEP_ONLY: "false" }, absent],
  ];

  it.each(cases)("sweeps after %s and rejects with the original message", async (_name, over, message) => {
    const w = world("pr-gates");
    w.state.producers = [gate(9002, "failure")];
    const error = await w.relay("mirror", gate(9001, "success"), over).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(message);
    for (const context of GATE_CONTEXTS) expect(w.state.checks.filter((check) => check.name === context).at(-1))
      .toMatchObject({ head_sha: HEAD, external_id: "9002:1", conclusion: "failure", app: { id: 5118623 } });
    expect(w.state.requests.filter((url) => url.endsWith("/access_tokens"))).toHaveLength(1);
    expect(w.state.requests.filter((url) => url === `${ROOT}/actions/runs?per_page=100`)).toHaveLength(1);
    expect(w.state.requests.some((url) => url.includes("/actions/runs/9001"))).toBe(false);
  });

  it("preserves the trigger validation error when the sweep also fails", async () => {
    const w = world("pr-gates");
    w.state.listingReadFails = true;
    const error = await w.relay("sweep", undefined, {
      LEDGER_SWEEP_ONLY: "false", LEDGER_DISPATCH_RUN_ID: "not-a-run-id",
    }).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(AggregateError);
    expect(((error as AggregateError).errors[0] as Error).message).toBe(
      'LEDGER_DISPATCH_RUN_ID must be a workflow-run id (got "not-a-run-id")',
    );
    expect((error as AggregateError).message).toContain('LEDGER_DISPATCH_RUN_ID must be a workflow-run id (got "not-a-run-id")');
    expect((error as AggregateError).message).toContain("the repository's workflow-run listing for the orphan sweep");
    expect(w.state.requests.filter((url) => url === `${ROOT}/actions/runs?per_page=100`)).toHaveLength(3);
  });

  it.each([
    ["malformed head", { GITHUB_WORKFLOW_RUN_HEAD_SHA: "invalid-head" }],
    ["ambiguous dispatch mode", { LEDGER_SWEEP_ONLY: "true", GITHUB_WORKFLOW_RUN_ID: "", LEDGER_DISPATCH_RUN_ID: "9001" }],
  ] as const)("recovers a producer sharing the raw trigger id after %s using its API identity", async (_name, over) => {
    const w = world("pr-gates");
    const producer = { ...gate(9001, "failure"), head_sha: "d".repeat(40),
      html_url: `https://github.com/${REPO}/actions/runs/9001?from=api` };
    w.state.producers = [producer];

    await expect(w.relay("mirror", gate(9001, "success"), over)).rejects.toThrow();

    expect(w.state.checks).toHaveLength(4);
    for (const context of GATE_CONTEXTS) expect(w.state.checks.find((check) => check.name === context))
      .toMatchObject({ head_sha: producer.head_sha, details_url: producer.html_url,
        external_id: "9001:1", status: "completed", conclusion: "failure", app: { id: 5118623 } });
    expect(w.state.checks.some((check) => check.head_sha === HEAD)).toBe(false);
  });
});


describe("panel regression: App suite visibility", () => {
  it.each([999, 1001])("preserves the newer failure behind %i newer non-App suites", async (laterSuites) => {
    const w = world("pr-gates");
    const older = gate(9001, "success"), newer = gate(9002, "failure");
    w.state.producers = [newer, older];
    await w.relay("mirror", newer);
    const before = w.state.checks.length;
    const suites = [{ id: 1, app: { id: 5118623 } }, ...Array.from({ length: laterSuites }, (_, i) => ({
      id: i + 2, app: { id: 15368 },
    }))];
    let cappedReads = 0;
    await runRelay({
      env: { ...RELAY_OWN_RUN_ENV, LEDGER_APP_ID: "5118623", LEDGER_INSTALLATION_ID: "166057493", LEDGER_APP_KEY: key,
        GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: "123456", LEDGER_DISPATCH_RUN_ID: "9001" },
      fetchFn: (async (input, init) => {
        const url = String(input);
        if (url === `${ROOT}/actions/runs?per_page=100`) return response({ workflow_runs: [] });
        if (url.includes(`/commits/${HEAD}/check-runs?`)) {
          // Model the documented cap before App filtering; the complete route
          // must preserve the floor under either possible filter ordering.
          cappedReads++;
          return response({ check_runs: suites.slice(-1000).some((s) => s.id === 1) ? w.state.checks : [] });
        }
        if (url.includes(`/commits/${HEAD}/check-suites?`)) {
          expect(new URL(url).searchParams.get("app_id")).toBe("5118623");
          return response({ total_count: 1, check_suites: [suites[0]] });
        }
        if (url.includes("/check-suites/1/check-runs?")) return response({ check_runs: w.state.checks });
        return w.fetchFn(input, init);
      }) as typeof fetch,
      delayFn: async () => {}, readPinMap: async () => pins,
    });
    for (const context of GATE_CONTEXTS) expect(w.state.checks.filter((c) => c.name === context).at(-1))
      .toMatchObject({ external_id: "9002:1", conclusion: "failure" });
    expect(w.state.checks).toHaveLength(before);
    expect(cappedReads).toBe(0);
  });
});

describe("panel regression: incremental sweep deadline", () => {
  it.each([0, 4000])("attests newest candidates first at %i ms per successful response", async (latency) => {
    const w = world();
    w.state.producers = Array.from({ length: 50 }, (_, i) => verify(9001 + i, 8001 + i, "success"));
    w.state.suites = Array.from({ length: 50 }, (_, i) => ({
      ...suite(8001 + i, "success"), head_sha: (i + 1).toString(16).padStart(40, "0"),
    }));
    let now = 0;
    const startedAt: number[] = [];
    const result = await runRelay({
      env: { ...RELAY_OWN_RUN_ENV, LEDGER_APP_ID: "5118623", LEDGER_INSTALLATION_ID: "166057493", LEDGER_APP_KEY: key,
        GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: "123456", LEDGER_SWEEP_ONLY: "true" },
      nowFn: () => now,
      fetchFn: (async (input, init) => {
        startedAt.push(now);
        const reply = await w.fetchFn(input, init);
        now += latency;
        return reply;
      }) as typeof fetch,
      delayFn: async () => {}, readPinMap: async () => pins,
    }).catch((error: unknown) => error);
    if (latency === 0) expect(w.state.checks).toHaveLength(50);
    else {
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain("run deadline");
      expect(w.state.checks.some((c) => c.external_id === "9050:1")).toBe(true);
      expect(w.state.checks.some((c) => c.external_id === "9049:1")).toBe(true);
    }
    expect(w.state.checks.map((c) => c.external_id)).toEqual(
      Array.from({ length: w.state.checks.length }, (_, i) => `${9050 - i}:1`),
    );
    expect(startedAt.every((time) => time < RUN_DEADLINE_MS)).toBe(true);
  });
});

it.each([5, 6])("reads at most five repository pages when a producer is on page %i", async (producerPage) => {
  const w = world("pr-gates");
  w.state.producers = [
    ...Array.from({ length: (producerPage - 1) * 100 }, (_, i) => unrelated(20000 + i)),
    gate(9002, "failure"),
  ];
  await w.relay("sweep");
  expect(w.state.checks).toHaveLength(producerPage === 5 ? 4 : 0);
  expect(w.state.requests.filter((url) => url.startsWith(`${ROOT}/actions/runs?per_page=100`))).toHaveLength(5);
});

describe("panel fix round resolved-attempt ordering", () => {
  it.each([false, true])("publishes a newer resolved attempt beyond a retained trigger, retained=%s", async (retained) => {
    const w = world();
    const stale = verify(9001, 8001, "success");
    const current = { ...stale, run_attempt: 3, conclusion: "failure" };
    w.state.producers = [stale];
    w.state.checks = [{ name: "verify", head_sha: HEAD, external_id: "9001:2",
      status: "completed", conclusion: "success", app: { id: 5118623 } }];
    const { sweepOrphans } = await import("../../scripts/ledger-relay-sweep.ts");
    const { decideContexts } = await import("../../scripts/ledger-relay-decisions.ts");
    const { sweepApi } = await import("../../scripts/ledger-relay-http.ts");
    const api = sweepApi({ fetchFn: (async (input, init) => {
      if (String(input) === `${ROOT}/actions/runs/9001`) return response(current);
      if (String(input).includes("/9001/jobs?")) return response({ jobs: [{ name: "verify", run_attempt: 3,
        status: "completed", conclusion: "failure" }] });
      return w.fetchFn(input, init);
    }) as typeof fetch, delayFn: async () => {}, deadlineMs: Date.now() + RUN_DEADLINE_MS },
    REPO, "5118623", { authorization: `Bearer ${["test", "only"].join("-")}` });
    const outcome = await sweepOrphans({ api, pinMap: pins, apiRoot: "https://api.github.com", repo: REPO,
      appId: "5118623", repositoryId: "123456", decide: decideContexts,
      triggerRunId: retained ? "9001" : "", ...(retained ? { triggerRun: {
        runId: "9001", runAttempt: 2, headSha: HEAD, path: ".github/workflows/ci-pr.yml",
        conclusion: "success", htmlUrl: String(stale.html_url), status: "completed" as const,
        workflowRun: true as const, event: "workflow_run",
      } } : {}) });
    expect(w.state.checks.at(-1)).toMatchObject({ external_id: "9001:3", status: "completed", conclusion: "failure" });
    expect(outcome.relayed).toEqual([{ context: "verify", runId: "9001" }]);
  });

  it("refreshes the App floor before a newer resolved attempt follows this sweep's write", async () => {
    const w = world();
    const stale = verify(9001, 8001, "success");
    w.state.producers = [{ ...stale, run_attempt: 2 }, stale];
    const observedFloors: unknown[][] = [];
    const { sweepOrphans } = await import("../../scripts/ledger-relay-sweep.ts");
    const { decideContexts } = await import("../../scripts/ledger-relay-decisions.ts");
    const { sweepApi } = await import("../../scripts/ledger-relay-http.ts");
    const api = sweepApi({ fetchFn: (async (input, init) => {
      const url = String(input);
      const attempt = w.state.checks.length === 0 ? 2 : 3;
      if (url === `${ROOT}/actions/runs/9001`) return response({ ...stale, run_attempt: attempt,
        conclusion: attempt === 2 ? "success" : "failure" });
      if (url.includes("/9001/jobs?")) return response({ jobs: [{ name: "verify", run_attempt: attempt,
        status: "completed", conclusion: attempt === 2 ? "success" : "failure" }] });
      if (url.includes("/check-suites/") && url.includes("/check-runs?")) {
        observedFloors.push(w.state.checks.map((c) => c.external_id));
      }
      return w.fetchFn(input, init);
    }) as typeof fetch, delayFn: async () => {}, deadlineMs: Date.now() + RUN_DEADLINE_MS },
    REPO, "5118623", { authorization: `Bearer ${["test", "only"].join("-")}` });
    const outcome = await sweepOrphans({ api, pinMap: pins, apiRoot: "https://api.github.com", repo: REPO,
      appId: "5118623", repositoryId: "123456", decide: decideContexts, triggerRunId: "" });
    expect(outcome.relayed).toHaveLength(2);
    expect(w.state.checks.map((c) => `${c.external_id}=${c.conclusion}`)).toEqual(["9001:2=success", "9001:3=failure"]);
    expect(observedFloors).toEqual([[], ["9001:2"]]);
    expect(w.state.requests.filter((url) => url.includes("/commits/") && url.includes("/check-suites?"))).toHaveLength(2);
  });

  it.each([["an equal", 2], ["a lower", 1]] as const)(
    "skips a later candidate whose resolved identity is %s attempt, without another App read or write",
    async (_order, laterAttempt) => {
      const w = world();
      const stale = verify(9001, 8001, "success");
      w.state.producers = [{ ...stale, run_attempt: 2 }, stale];
      let resolutions = 0;
      let jobReads = 0;
      const { sweepOrphans } = await import("../../scripts/ledger-relay-sweep.ts");
      const { decideContexts } = await import("../../scripts/ledger-relay-decisions.ts");
      const { sweepApi } = await import("../../scripts/ledger-relay-http.ts");
      const api = sweepApi({ fetchFn: (async (input, init) => {
        const url = String(input);
        if (url === `${ROOT}/actions/runs/9001`) {
          resolutions++;
          return response({ ...stale, run_attempt: resolutions === 1 ? 2 : laterAttempt,
            conclusion: resolutions === 1 ? "success" : "failure" });
        }
        if (url.includes("/9001/jobs?")) {
          jobReads++;
          return response({ jobs: [{ name: "verify", run_attempt: 2, status: "completed", conclusion: "success" }] });
        }
        return w.fetchFn(input, init);
      }) as typeof fetch, delayFn: async () => {}, deadlineMs: Date.now() + RUN_DEADLINE_MS },
      REPO, "5118623", { authorization: `Bearer ${["test", "only"].join("-")}` });
      const outcome = await sweepOrphans({ api, pinMap: pins, apiRoot: "https://api.github.com", repo: REPO,
        appId: "5118623", repositoryId: "123456", decide: decideContexts, triggerRunId: "" });
      expect(resolutions).toBe(2);
      expect(outcome.relayed).toEqual([{ context: "verify", runId: "9001" }]);
      expect(w.state.checks.map((c) => `${c.external_id}=${c.conclusion}`)).toEqual(["9001:2=success"]);
      expect(w.state.requests.filter((url) => url.includes("/commits/") && url.includes("/check-suites?"))).toHaveLength(1);
      expect(jobReads).toBe(1);
    },
  );
});

/**
 * The claim-3 re-check's slow-API probe: 50 completed verify producers on
 * distinct heads, sequential starts, the clock advanced per response. The
 * mirror must not resolve the whole listing before its first write.
 */
describe("mirror liveness under a slow API", () => {
  function slowWorld(latency: number) {
    const w = world();
    w.state.producers = Array.from({ length: 50 }, (_, i) => verify(9050 - i, 8050 - i, "success"));
    w.state.suites = Array.from({ length: 50 }, (_, i) => ({
      ...suite(8050 - i, "success"), head_sha: (50 - i).toString(16).padStart(40, "0"),
    }));
    let now = 0;
    const env = { ...RELAY_OWN_RUN_ENV, LEDGER_APP_ID: "5118623", LEDGER_INSTALLATION_ID: "166057493",
      LEDGER_APP_KEY: key, GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: "123456" };
    const start = async (extra: Record<string, string>) => {
      const before = w.state.checks.length;
      await runRelay({
        env: { ...env, ...extra }, nowFn: () => now,
        fetchFn: (async (input, init) => {
          const reply = await w.fetchFn(input, init);
          now += latency;
          return reply;
        }) as typeof fetch,
        delayFn: async () => {}, readPinMap: async () => pins,
      }).catch(() => undefined);
      return w.state.checks.slice(before).map((check) => String(check.external_id));
    };
    return { w, start };
  }

  it("posts a completion start's own newest producer at 4 s per response after earlier starts", async () => {
    const { w, start } = slowWorld(4000);
    await start({ LEDGER_SWEEP_ONLY: "true" });
    await start({ LEDGER_DISPATCH_RUN_ID: "9001" });
    await start({ LEDGER_SWEEP_ONLY: "true" });
    const fresh = verify(9051, 8051, "success");
    w.state.producers = [fresh, ...w.state.producers];
    w.state.suites = [{ ...suite(8051, "success"), head_sha: (51).toString(16).padStart(40, "0") }, ...w.state.suites];

    const posted = await start({
      GITHUB_WORKFLOW_RUN_ID: "9051", GITHUB_WORKFLOW_RUN_HEAD_SHA: String(fresh.head_sha),
      GITHUB_WORKFLOW_RUN_PATH: String(fresh.path), GITHUB_WORKFLOW_RUN_CONCLUSION: "success",
      GITHUB_WORKFLOW_RUN_HTML_URL: String(fresh.html_url), GITHUB_WORKFLOW_RUN_EVENT: "workflow_run",
      GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "main", GITHUB_WORKFLOW_RUN_ATTEMPT: "1",
    });

    expect(posted[0]).toBe("9051:1");
  });

  it("posts a mid-window dispatch start's trigger at 4 s per response without resolving older producers", async () => {
    const { w, start } = slowWorld(4000);

    const posted = await start({ LEDGER_DISPATCH_RUN_ID: "9025" });

    expect(posted[0]).toBe("9025:1");
    // Older candidates are the sweep's: the mirror never fetches them.
    const resolvedBeforeWrite = w.state.requests.slice(0, w.state.requests.indexOf(`${ROOT}/check-runs`));
    for (let id = 9001; id < 9025; id++) expect(resolvedBeforeWrite).not.toContain(`${ROOT}/actions/runs/${id}`);
  });

  it("posts the newest of several newer producers at the trigger's head, not the first one resolved", async () => {
    const w = world();
    w.state.producers = [verify(9002, 8001, "failure"), verify(9003, 8001, "success"), oldVerify];

    const result = await w.relay("mirror");

    expect(result.posted).toEqual(["verify"]);
    expect(w.state.checks.map((check) => `${check.external_id}=${check.conclusion}`)).toEqual(["9003:1=success"]);
  });

  it("posts the oldest dispatch trigger before its deadline at 4 s per response among 49 newer producers", async () => {
    const { start } = slowWorld(4000);

    const posted = await start({ LEDGER_DISPATCH_RUN_ID: "9001" });

    expect(posted[0]).toBe("9001:1");
  });

  it("still resolves newer candidates at zero latency and posts a newer producer at the trigger's head", async () => {
    const { w, start } = slowWorld(0);
    // 9030 is a rerun of 9001's pr suite, so it resolves to the trigger's head.
    w.state.producers = w.state.producers.map((run) => run.id === 9030 ? verify(9030, 8001, "failure") : run);

    const posted = await start({ LEDGER_DISPATCH_RUN_ID: "9001" });

    expect(posted[0]).toBe("9030:1");
    expect(w.state.checks.filter((check) => check.external_id === "9001:1")).toEqual([]);
  });
});

/**
 * The selection reserve bounds only the choice of a newer candidate. Once a
 * winner is chosen, its publication (floor, jobs, upstream recheck, POST)
 * runs under the ordinary run deadline, even below the reserve.
 */
describe("mirror reserve scope", () => {
  // Built per test: the App key exists only after beforeAll.
  const dispatchEnv = () => ({ ...RELAY_OWN_RUN_ENV, LEDGER_APP_ID: "5118623", LEDGER_INSTALLATION_ID: "166057493",
    LEDGER_APP_KEY: key, GITHUB_REPOSITORY: REPO, GITHUB_REPOSITORY_ID: "123456", LEDGER_DISPATCH_RUN_ID: "9001" });

  it("publishes a newer same-head winner found just above the reserve, whose publication runs below it", async () => {
    const w = world();
    w.state.producers = [verify(9002, 8001, "failure"), oldVerify];
    let now = 0;
    const remainingAtWinner: number[] = [];
    const result = await runRelay({
      env: dispatchEnv(), nowFn: () => now, delayFn: async (ms) => { now += ms; }, readPinMap: async () => pins,
      fetchFn: (async (input, init) => {
        const url = String(input);
        // The winner's resolution starts so that it ends with the reserve plus
        // 11 s left (224 s at a 213 s reserve); its floor and jobs reads then
        // take the remaining budget below the reserve before the recheck.
        if (url === `${ROOT}/actions/runs/9002` && remainingAtWinner.length === 0) {
          now = RUN_DEADLINE_MS - MIRROR_TRIGGER_RESERVE_MS - 23_000;
          remainingAtWinner.push(MIRROR_TRIGGER_RESERVE_MS + 11_000);
        }
        const reply = await w.fetchFn(input, init);
        now += 4000;
        return reply;
      }) as typeof fetch,
    });

    expect(remainingAtWinner).toHaveLength(1);
    // The mirror itself posts the winner; the start does not fail over to the sweep.
    expect(result.posted).toEqual(["verify"]);
    expect(result.decisions).toMatchObject([{ context: "verify", conclusion: "failure" }]);
    expect(w.state.checks.map((check) => check.external_id)).toEqual(["9002:1"]);
  });

  it("keeps enough reserve for an uncommitted ambiguous POST, its read-back and one retry", async () => {
    const w = world();
    w.state.producers = Array.from({ length: 50 }, (_, i) => verify(9050 - i, 8050 - i, "success"));
    w.state.suites = Array.from({ length: 50 }, (_, i) => ({ ...suite(8050 - i, "success"),
      head_sha: (50 - i).toString(16).padStart(40, "0") }));
    let now = 0;
    let posts = 0;
    await runRelay({
      env: dispatchEnv(), nowFn: () => now, delayFn: async (ms) => { now += ms; }, readPinMap: async () => pins,
      fetchFn: (async (input, init = {}) => {
        // Successful responses take 29 s; the first check-run POST runs to the
        // 30 s request bound and fails without committing.
        if (String(input) === `${ROOT}/check-runs` && ++posts === 1) {
          now += 30_000;
          throw new TypeError("ambiguous POST did not commit");
        }
        const reply = await w.fetchFn(input, init);
        now += 29_000;
        return reply;
      }) as typeof fetch,
    }).catch(() => undefined);

    expect(posts).toBeGreaterThanOrEqual(2);
    expect(w.state.checks[0]).toMatchObject({ external_id: "9001:1", conclusion: "success" });
  });
});
