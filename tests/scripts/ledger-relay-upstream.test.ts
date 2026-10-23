import { appSuiteListing, appChecksUrl, RELAY_OWN_RUN_ENV, relayJobStartListing } from "./ledger-relay-check-fixtures.ts";
import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { isTrustedProducerRun, renderRelayResult, runRelay } from "../../scripts/ledger-relay.ts";

const REPO = "Nitjsefnie/Overflow";
const REPO_ID = "123456";
const API = `https://api.github.com/repos/${REPO}`;
const VERIFY_PATH = ".github/workflows/ci-pr.yml";
const SUITE_PATH = ".github/workflows/pr-suite.yml";
const MAIN_SHA = "a".repeat(40);
const PR_SHA = "b".repeat(40);
const OTHER_PR_SHA = "c".repeat(40);
const PIN_MAP = { verify: [".github/workflows/ci.yml", VERIFY_PATH] };
const runsUrl = `${API}/actions/runs?per_page=100`;
const suiteRunsUrl = (sha = PR_SHA) => `${API}/actions/workflows/pr-suite.yml/runs?head_sha=${sha}&event=pull_request&per_page=100&page=1`;
const runUrl = (id: number) => `${API}/actions/runs/${id}`;
const jobsUrl = (id: number) => `${runUrl(id)}/jobs?filter=latest&per_page=100`;
const checksUrl = (sha: string) =>
  appChecksUrl(API, sha);

let keyPem: string;
beforeAll(() => {
  keyPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs8", format: "pem" }).toString();
});

function producer(over: Record<string, unknown> = {}): Record<string, unknown> {
  const id = over.id ?? 9001;
  return {
    id: 9001,
    created_at: "2026-10-12T09:00:00Z",
    path: VERIFY_PATH,
    event: "workflow_run",
    repository: { id: Number(REPO_ID), full_name: REPO },
    head_repository: { id: Number(REPO_ID), full_name: REPO, owner: { login: "Nitjsefnie" } },
    head_branch: "main",
    head_sha: MAIN_SHA,
    display_title: "verify for pr suite run 8001",
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/${REPO}/actions/runs/${id}`,
    run_attempt: 1,
    ...over,
  };
}

function suite(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 8001,
    run_started_at: "2026-10-12T08:00:00Z",
    path: SUITE_PATH,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: PR_SHA,
    head_branch: "main",
    head_repository: { id: 654321, full_name: "contributor/Overflow", owner: { login: "contributor" } },
    // PR content deliberately disagrees: only this run's head_sha is evidence.
    pull_requests: [{ head: { sha: OTHER_PR_SHA } }],
    ...over,
  };
}

type ResponseSpec = unknown | Error | { httpStatus: number };

function harness(over: {
  producer?: unknown;
  upstream?: ResponseSpec;
  env?: Record<string, string | undefined>;
  handlers?: Record<string, ResponseSpec>;
  pinMap?: Record<string, string | readonly string[]>;
} = {}) {
  const requests: string[] = [];
  const posts: Record<string, unknown>[] = [];
  const handlers: Record<string, ResponseSpec> = {
    [runUrl(9001)]: over.producer ?? producer(),
    [runUrl(8001)]: over.upstream ?? suite(),
    [jobsUrl(9001)]: {
      jobs: [{ name: "verify", run_attempt: 1, status: "completed", conclusion: "success" }],
    },
    [runsUrl]: { workflow_runs: [] },
    [suiteRunsUrl()]: { total_count: 1, workflow_runs: [suite()] },
    [suiteRunsUrl(OTHER_PR_SHA)]: { total_count: 1, workflow_runs: [suite({ id: 8002, head_sha: OTHER_PR_SHA })] },
    [checksUrl(MAIN_SHA)]: { check_runs: [] },
    [checksUrl(PR_SHA)]: { check_runs: [] },
    [checksUrl(OTHER_PR_SHA)]: { check_runs: [] },
    // Keep the legacy refusal's liveness read answerable: a no-op is NOT a throw.
    [`${API}/commits/${MAIN_SHA}/pulls?per_page=100`]: [],
    [`${API}/pulls?state=open&head=contributor%3Amain&per_page=100`]: [],
    ...over.handlers,
  };
  const fetchFn = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    const suites = appSuiteListing(url) ?? relayJobStartListing(url);
    if (suites !== undefined) return new Response(JSON.stringify(suites));
    if (url.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
    }
    if (url === `${API}/check-runs` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push(body);
      const checkUrl = checksUrl(String(body.head_sha));
      const snapshot = handlers[checkUrl];
      const checks = (typeof snapshot === "function" ? snapshot() : snapshot) as { check_runs: Record<string, unknown>[] };
      handlers[checkUrl] = { check_runs: [
        ...checks.check_runs.filter((entry) => entry.name !== body.name), { ...body, app: { id: 5118623 } },
      ] };
      return new Response(JSON.stringify({ id: posts.length }), { status: 201 });
    }
    if (!(url in handlers)) throw new Error(`unexpected fetch: ${url}`);
    const result = handlers[url];
    if (result instanceof Error) throw result;
    if (typeof result === "function") return new Response(JSON.stringify(result()));
    if (typeof result === "object" && result !== null && "httpStatus" in result) {
      return new Response("upstream unavailable", { status: Number(result.httpStatus) });
    }
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  const env: Record<string, string | undefined> = {
    ...RELAY_OWN_RUN_ENV, OVERFLOW_LEDGER_APP_ID: "5118623",
    OVERFLOW_LEDGER_INSTALLATION_ID: "166057493",
    OVERFLOW_LEDGER_APP_KEY: keyPem,
    GITHUB_REPOSITORY: REPO,
    GITHUB_REPOSITORY_ID: REPO_ID,
    OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "9001",
    OVERFLOW_GITHUB_WORKFLOW_RUN_HEAD_SHA: MAIN_SHA,
    OVERFLOW_GITHUB_WORKFLOW_RUN_PATH: VERIFY_PATH,
    OVERFLOW_GITHUB_WORKFLOW_RUN_CONCLUSION: "success",
    OVERFLOW_GITHUB_WORKFLOW_RUN_HTML_URL: `https://github.com/${REPO}/actions/runs/9001`,
    OVERFLOW_GITHUB_WORKFLOW_RUN_EVENT: "workflow_run",
    OVERFLOW_GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "main",
    ...over.env,
  };
  return {
    requests,
    posts,
    run: () => runRelay({ env, fetchFn, delayFn: async () => {}, readPinMap: async () => over.pinMap ?? PIN_MAP }),
  };
}

describe("API-backed workflow_run verify", () => {
  // Adding workflow_run to the legacy main-branch allowlist must break this.
  it("does not trust a fork-shaped workflow_run solely because its branch is named main", () => {
    expect(isTrustedProducerRun("workflow_run", "main")).toBe(false);
    expect(isTrustedProducerRun("pull_request", "main")).toBe(false);
  });

  it.each(["workflow_run", "dispatch"])(
    "posts verify from a good upstream on the PR SHA through %s, never the producer's main SHA",
    async (mode) => {
      const h = harness({ env: mode === "dispatch" ? {
        OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "",
        OVERFLOW_LEDGER_DISPATCH_RUN_ID: "9001",
      } : {} });
      const result = await h.run();
      expect(result.posted).toEqual(["verify"]);
      expect(h.posts).toHaveLength(1);
      expect(h.posts[0]).toMatchObject({
        name: "verify", head_sha: PR_SHA, conclusion: "success",
        details_url: `https://github.com/${REPO}/actions/runs/9001`,
      });
      expect(h.posts.some((body) => body.head_sha === MAIN_SHA)).toBe(false);
      expect(h.requests.filter((url) => url === runUrl(9001))).toHaveLength(1);
      expect(h.requests.indexOf(runUrl(9001))).toBeLessThan(h.requests.indexOf(runUrl(8001)));
    },
  );

  it.each([
    ["own path not ci-pr.yml", { path: ".github/workflows/ci.yml" }, /producer.*path/],
    ["own event not workflow_run", { event: "pull_request" }, /producer.*event/],
    ["own repository id mismatch", { repository: { id: 654321 } }, /producer.*repository/],
    ["own repository absent", { repository: null }, /producer.*repository/],
    ["own id mismatch", { id: 9002 }, /producer.*id/],
    ["own id missing", { id: undefined }, /producer.*id/],
    ["own branch not main", { head_branch: "feature/verify" }, /producer.*branch/],
    ["own branch missing", { head_branch: undefined }, /producer.*branch/],
    ["malformed display_title", { display_title: "verify for pr suite run 08001" }, /display_title/],
    ["missing display_title", { display_title: undefined }, /display_title/],
    ["title suffix", { display_title: "verify for pr suite run 8001 extra" }, /display_title/],
    ["title trailing newline", { display_title: "verify for pr suite run 8001\n" }, /display_title/],
    ["title zero id", { display_title: "verify for pr suite run 0" }, /display_title/],
  ] as const)("throws for %s before posting", async (_name, changes, error) => {
    const h = harness({ producer: producer(changes) });
    await expect(h.run()).rejects.toThrow(error);
    expect(h.requests).toContain(runsUrl);
    expect(h.posts).toEqual([]);
    expect(h.requests).not.toContain(runUrl(8001));
  });

  it("refuses a fork run named main when the fetched event is pull_request", async () => {
    const h = harness({ producer: producer({
      event: "pull_request",
      head_repository: { id: 654321, full_name: "contributor/Overflow", owner: { login: "contributor" } },
    }) });
    await expect(h.run()).rejects.toThrow(/producer.*event/);
    expect(h.requests).toContain(runsUrl);
    expect(h.posts).toEqual([]);
  });

  it.each([9002, undefined])("binds dispatch recovery to the requested id when the API reports %s", async (id) => {
    const h = harness({
      producer: producer({ id }),
      env: { OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "", OVERFLOW_LEDGER_DISPATCH_RUN_ID: "9001" },
    });
    await expect(h.run()).rejects.toThrow(/producer.*id/);
    expect(h.requests).toContain(runsUrl);
    expect(h.posts).toEqual([]);
    expect(h.requests).not.toContain(runUrl(8001));
  });

  it("throws for an unpinned workflow_run producer path instead of silently returning", async () => {
    const h = harness({
      env: { OVERFLOW_GITHUB_WORKFLOW_RUN_PATH: ".github/workflows/other.yml" },
      producer: producer({ path: ".github/workflows/other.yml" }),
    });
    await expect(h.run()).rejects.toThrow(/producer.*path/);
    expect(h.requests).toContain(runsUrl);
    expect(h.posts).toEqual([]);
  });

  it.each([
    ["missing", undefined], ["malformed", "Overflow"],
  ])("throws when the relay's repository id is %s", async (_name, id) => {
    const h = harness({ env: { GITHUB_REPOSITORY_ID: id } });
    await expect(h.run()).rejects.toThrow(/GITHUB_REPOSITORY_ID/);
    expect(h.requests).toContain(runsUrl);
    expect(h.posts).toEqual([]);
  });

  it.each([
    ["wrong upstream path", { path: ".github/workflows/ci.yml" }, /upstream.*path/],
    ["wrong upstream event", { event: "pull_request_target" }, /upstream.*event/],
    ["upstream not completed", { status: "in_progress" }, /upstream.*completed/],
    ["malformed upstream SHA", { head_sha: "invalid" }, /upstream.*40-hex/],
    ["missing upstream SHA", { head_sha: undefined }, /upstream.*40-hex/],
  ] as const)("throws for %s before posting", async (_name, changes, error) => {
    const h = harness({ upstream: suite(changes) });
    await expect(h.run()).rejects.toThrow(error);
    expect(h.requests).toContain(runsUrl);
    expect(h.posts).toEqual([]);
    expect(h.requests).not.toContain(jobsUrl(9001));
  });

  it.each([
    ["HTTP", { httpStatus: 404 }], ["network", new Error("network unavailable")],
  ])("throws on upstream %s read failure", async (_name, failure) => {
    const h = harness({ upstream: failure });
    await expect(h.run()).rejects.toThrow(/workflow run 8001.*failed/);
    expect(h.requests).toContain(runsUrl);
    expect(h.posts).toEqual([]);
  });

  it("throws on a producer API read failure", async () => {
    const h = harness({ producer: { httpStatus: 404 } });
    await expect(h.run()).rejects.toThrow(/workflow run 9001.*failed/);
    expect(h.requests).toContain(runsUrl);
    expect(h.posts).toEqual([]);
  });

  it("does not rerun-heal a cancelled workflow_run producer", async () => {
    const h = harness({ producer: producer({ conclusion: "cancelled" }), handlers: {
      [jobsUrl(9001)]: { jobs: [] },
    } });
    const result = await h.run();
    expect(result.rerunDispatched).toBe(false);
    expect(h.posts[0]).toMatchObject({ head_sha: PR_SHA, conclusion: "failure" });
    expect(h.requests.some((url) => url.endsWith("/rerun"))).toBe(false);
  });
});

describe("workflow_run orphan sweep", () => {
  const sweepEnv = { OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "", OVERFLOW_LEDGER_SWEEP_ONLY: "true" };

  it("resolves orphaned verify onto the PR head before attestation and posting", async () => {
    const h = harness({ env: sweepEnv, handlers: {
      [runsUrl]: { workflow_runs: [producer()] },
      // A green context on main must not hide the PR's orphan.
      [checksUrl(MAIN_SHA)]: {
        check_runs: [{ name: "verify", status: "completed", app: { id: 5118623 } }],
      },
    } });
    const result = await h.run();
    expect(result.sweep).toEqual({ examined: 1, relayed: [{ context: "verify", runId: "9001" }] });
    expect(h.posts[0]).toMatchObject({ name: "verify", head_sha: PR_SHA });
    expect(h.requests).toContain(checksUrl(PR_SHA));
    expect(h.requests).not.toContain(checksUrl(MAIN_SHA));
  });

  it("uses the PR head's existing attestation to dedupe, never main's", async () => {
    const h = harness({ env: sweepEnv, handlers: {
      [runsUrl]: { workflow_runs: [producer()] },
      [checksUrl(PR_SHA)]: {
        check_runs: [{
          name: "verify", status: "completed", app: { id: 5118623 },
          details_url: `https://github.com/${REPO}/actions/runs/9001`,
          external_id: "9001:1",
        }],
      },
    } });
    const result = await h.run();
    expect(result.sweep).toEqual({ examined: 1, relayed: [] });
    expect(h.posts).toEqual([]);
    expect(h.requests).not.toContain(jobsUrl(9001));
    expect(h.requests).not.toContain(checksUrl(MAIN_SHA));
  });

  it("dedupes two verify runs by resolved PR SHA even when their own main SHAs differ", async () => {
    const other = producer({ id: 9002, head_sha: OTHER_PR_SHA });
    const h = harness({ env: sweepEnv, handlers: {
      [runsUrl]: { workflow_runs: [producer(), other] },
      [runUrl(9002)]: other,
      [jobsUrl(9002)]: { jobs: [] },
    } });
    const result = await h.run();
    expect(result.sweep.examined).toBe(2);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.head_sha).toBe(PR_SHA);
    expect(h.requests.filter((url) => url === checksUrl(PR_SHA))).toHaveLength(1);
  });

  it("keeps distinct PR heads separate even when verify runs have the same own main SHA", async () => {
    const other = producer({ id: 9002, display_title: "verify for pr suite run 8002" });
    const h = harness({ env: sweepEnv, handlers: {
      [runsUrl]: { workflow_runs: [producer(), other] },
      [runUrl(9002)]: other,
      [runUrl(8002)]: suite({ id: 8002, head_sha: OTHER_PR_SHA }),
      [jobsUrl(9002)]: { jobs: [] },
    } });
    const result = await h.run();
    expect(result.sweep.relayed).toHaveLength(2);
    expect(h.posts.map((body) => body.head_sha)).toEqual([OTHER_PR_SHA, PR_SHA]);
  });

  it.each([
    ["upstream fetch fails", suite(), { httpStatus: 404 }, /workflow run 8001.*failed/],
    ["upstream path is wrong", suite({ path: VERIFY_PATH }), undefined, /upstream.*path/],
  ] as const)("throws loudly when %s, with no main attestation", async (_name, upstream, failure, error) => {
    const h = harness({ env: sweepEnv, upstream: failure ?? upstream, handlers: {
      [runsUrl]: { workflow_runs: [producer()] },
    } });
    await expect(h.run()).rejects.toThrow(error);
    expect(h.requests).toContain(runsUrl);
    expect(h.posts).toEqual([]);
    expect(h.requests).not.toContain(checksUrl(MAIN_SHA));
  });

  it("revalidates the candidate's producer body rather than trusting the run listing", async () => {
    const h = harness({ env: sweepEnv, producer: producer({ repository: { id: 654321 } }), handlers: {
      [runsUrl]: { workflow_runs: [producer()] },
    } });
    await expect(h.run()).rejects.toThrow(/producer.*repository/);
    expect(h.requests).toContain(runsUrl);
    expect(h.posts).toEqual([]);
  });
});


describe("superseded verification never publishes", () => {
  it.each(["failure", "in_progress"])("newer same-SHA suite %s skips old mirror and orphan", async (state) => {
    const newer = suite({ id: 8002, status: state === "in_progress" ? state : "completed", conclusion: state === "failure" ? state : null });
    for (const orphan of [false, true]) {
      const h = harness({
        env: orphan ? { OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "", OVERFLOW_LEDGER_SWEEP_ONLY: "true" } : {},
        handlers: {
          [suiteRunsUrl()]: { total_count: 2, workflow_runs: [suite(), newer] },
          ...(orphan ? { [runsUrl]: { workflow_runs: [producer()] } } : {}),
        },
      });
      const result = await h.run();
      expect(h.posts).toEqual([]);
      expect(renderRelayResult(result).join("\n")).toContain("superseded by run 8002; that run's verify attests");
    }
  });

  it("a rerun begun after verify was created skips mirror and orphan", async () => {
    for (const orphan of [false, true]) {
      const h = harness({
        upstream: suite({ run_attempt: 2, run_started_at: "2026-10-12T10:00:00Z" }),
        env: orphan ? { OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "", OVERFLOW_LEDGER_SWEEP_ONLY: "true" } : {},
        handlers: orphan ? { [runsUrl]: { workflow_runs: [producer()] } } : {},
      });
      const result = await h.run();
      expect(h.posts).toEqual([]);
      expect(renderRelayResult(result).join("\n")).toContain("superseded by run 8001; that run's verify attests");
    }
  });

  it.each([false, true])("supersession read failure throws, orphan=%s", async (orphan) => {
    const h = harness({
      env: orphan ? { OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "", OVERFLOW_LEDGER_SWEEP_ONLY: "true" } : {},
      handlers: {
        [suiteRunsUrl()]: { httpStatus: 404 },
        ...(orphan ? { [runsUrl]: { workflow_runs: [producer()] } } : {}),
      },
    });
    await expect(h.run()).rejects.toThrow(/suite.*failed/);
    expect(h.requests).toContain(runsUrl);
    expect(h.posts).toEqual([]);
  });
});


describe("publication rechecks supersession after reading job results", () => {
  it.each([false, true])("a newer failure appearing just before POST suppresses publication, orphan=%s", async (orphan) => {
    let reads = 0;
    const h = harness({
      env: orphan ? { OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "", OVERFLOW_LEDGER_SWEEP_ONLY: "true" } : {},
      handlers: {
        [suiteRunsUrl()]: () => {
          reads += 1;
          return reads === 1 ? { total_count: 1, workflow_runs: [suite()] }
            : { total_count: 2, workflow_runs: [suite(), suite({ id: 8002, conclusion: "failure" })] };
        },
        ...(orphan ? { [runsUrl]: { workflow_runs: [producer()] } } : {}),
      },
    });
    const result = await h.run();
    expect(h.requests).toContain(jobsUrl(9001));
    expect(h.posts).toEqual([]);
    expect(renderRelayResult(result).join("\n")).toContain("superseded by run 8002");
  });
});


describe("complete listing for mirror and orphan supersession", () => {
  const newest = suite({ id: 8101 });
  const verify = producer({ id: 9101, display_title: "verify for pr suite run 8101" });
  const history = Array.from({ length: 101 }, (_, n) => suite({ id: 8101 - n }));
  const pageUrl = (page: number) => `${API}/actions/workflows/pr-suite.yml/runs?head_sha=${PR_SHA}&event=pull_request&per_page=100&page=${page}`;
  function paged(orphan: boolean, second: unknown = { total_count: 101, workflow_runs: history.slice(100) }, first: unknown = { total_count: 101, workflow_runs: history.slice(0, 100) }) {
    return harness({
      env: orphan ? { OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "", OVERFLOW_LEDGER_SWEEP_ONLY: "true" } : { OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "9101" },
      handlers: {
        [runUrl(8101)]: newest, [runUrl(9101)]: verify,
        [jobsUrl(9101)]: { jobs: [{ name: "verify", status: "completed", conclusion: "success" }] },
        [runsUrl]: { workflow_runs: orphan ? [verify] : [] },
        [suiteRunsUrl()]: first, [pageUrl(1)]: first, [pageUrl(2)]: second,
      },
    });
  }

  it.each([false, true])("newest legitimate verify posts with 101 runs, orphan=%s", async (orphan) => {
    const h = paged(orphan);
    const result = await h.run();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({ name: "verify", head_sha: PR_SHA, conclusion: "success" });
    expect(h.requests).toContain(pageUrl(2));
    if (orphan) expect(result.sweep.relayed).toContainEqual({ context: "verify", runId: "9101" });
  });

  it.each([false, true])("page-2 newer failure suppresses the old certificate, orphan=%s", async (orphan) => {
    const h = paged(orphan, { total_count: 101, workflow_runs: [suite({ id: 8102, conclusion: "failure" })] });
    const result = await h.run();
    expect(h.posts).toEqual([]);
    expect(renderRelayResult(result).join("\n")).toContain("superseded by run 8102");
  });

  it.each([
    ["changed total", { total_count: 102, workflow_runs: [history[100]] }, /total_count.*changed/],
    ["short page", { total_count: 101, workflow_runs: [] }, /short|expected/],
    ["duplicate id", { total_count: 101, workflow_runs: [history[0]] }, /duplicate/],
    ["read failure", { httpStatus: 503 }, /suite.*failed/],
  ])("%s fails closed for both mirror and sweep", async (_label, second, message) => {
    for (const orphan of [false, true]) {
      const h = paged(orphan, second);
      await expect(h.run()).rejects.toThrow(message as RegExp);
      expect(h.requests).toContain(runsUrl);
      expect(h.posts).toEqual([]);
      expect(h.requests.filter((url) => url === pageUrl(2))).toHaveLength(1);
    }
  });

  it.each([false, true])("page cap fails closed, orphan=%s", async (orphan) => {
    const h = paged(orphan, undefined, { total_count: 1001, workflow_runs: history.slice(0, 100) });
    await h.run();
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({ name: "verify", head_sha: PR_SHA, conclusion: "failure", external_id: "9101:1" });
    expect((h.posts[0].output as Record<string, unknown>).summary).toMatch(/1000 runs/);
  });
});


describe("superseded mirror keeps orphan recovery available", () => {
  it.each(["initial", "after-jobs"])("%s supersession skips only its own posting", async (phase) => {
    let reads = 0;
    const orphan = producer({ id: 9002, display_title: "verify for pr suite run 8002", html_url: `https://github.com/${REPO}/actions/runs/9002` });
    const h = harness({ handlers: {
      [suiteRunsUrl()]: () => {
        reads += 1;
        return phase === "after-jobs" && reads === 1
          ? { total_count: 1, workflow_runs: [suite()] }
          : { total_count: 2, workflow_runs: [suite(), suite({ id: 8003, conclusion: "failure" })] };
      },
      [runsUrl]: { workflow_runs: [orphan] },
      [runUrl(9002)]: orphan,
      [runUrl(8002)]: suite({ id: 8002, head_sha: OTHER_PR_SHA }),
      [jobsUrl(9002)]: { jobs: [{ name: "verify", status: "completed", conclusion: "success" }] },
    } });
    const result = await h.run();
    expect(result.posted).toEqual([]);
    expect(result.sweep.relayed).toContainEqual({ context: "verify", runId: "9002" });
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({ name: "verify", head_sha: OTHER_PR_SHA, conclusion: "success" });
    expect(h.posts.some((post) => post.head_sha === PR_SHA)).toBe(false);
    const output = renderRelayResult(result).join("\n");
    expect(output).toContain("superseded by run 8003");
    expect(output).toContain("orphan-sweep: relayed verify from run 9002");
  });

  it("recovers the newer same-SHA certificate instead of the superseded mirror", async () => {
    const orphan = producer({ id: 9002, display_title: "verify for pr suite run 8002", html_url: `https://github.com/${REPO}/actions/runs/9002` });
    const h = harness({ handlers: {
      [suiteRunsUrl()]: { total_count: 2, workflow_runs: [suite(), suite({ id: 8002 })] },
      [runsUrl]: { workflow_runs: [orphan] },
      [runUrl(9002)]: orphan, [runUrl(8002)]: suite({ id: 8002 }),
      [jobsUrl(9002)]: { jobs: [{ name: "verify", status: "completed", conclusion: "success" }] },
    } });
    const result = await h.run();
    expect(result.posted).toEqual([]);
    expect(result.sweep.relayed).toEqual([{ context: "verify", runId: "9002" }]);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]).toMatchObject({ head_sha: PR_SHA, details_url: `https://github.com/${REPO}/actions/runs/9002` });
  });
});

describe("producer-bound workflow_run sweep attestation", () => {
  it.each(["mirror", "sweep"])("selects a completed producer through %s when a newer listed completion is now rerunning", async (mode) => {
    const newer = producer({ id: 9002, conclusion: "failure" });
    const h = harness({
      env: mode === "sweep" ? { OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "", OVERFLOW_LEDGER_SWEEP_ONLY: "true" } : {},
      handlers: {
        [runsUrl]: { workflow_runs: [newer, producer()] },
        [runUrl(9002)]: { ...newer, status: "in_progress", conclusion: null, run_attempt: 2 },
        [jobsUrl(9002)]: { jobs: [{ name: "verify", status: "completed", conclusion: "failure" }] },
      },
    });
    await h.run();
    expect(h.posts.map((post) => post.external_id)).toEqual(["9001:1"]);
    expect(h.requests).not.toContain(jobsUrl(9002));
  });

  it("replaces the real older green with an orphaned newer failed verify on the same PR head", async () => {
    const initial = harness();
    await initial.run();
    const green = { ...initial.posts[0], app: { id: 5118623 } };
    expect(green).toMatchObject({ name: "verify", head_sha: PR_SHA, conclusion: "success" });
    const failedSuite = suite({
      id: 8002, conclusion: "failure", run_started_at: "2026-10-12T10:00:00Z",
    });
    const failedVerify = producer({
      id: 9002, created_at: "2026-10-12T10:01:00Z", conclusion: "failure",
      display_title: "verify for pr suite run 8002",
      html_url: `https://github.com/${REPO}/actions/runs/9002`,
    });
    const recovery = harness({
      env: { OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "", OVERFLOW_LEDGER_SWEEP_ONLY: "true" },
      handlers: {
        [runsUrl]: { workflow_runs: [failedVerify, producer()] },
        [runUrl(9002)]: failedVerify,
        [runUrl(8002)]: failedSuite,
        [suiteRunsUrl()]: { total_count: 2, workflow_runs: [failedSuite, suite()] },
        [jobsUrl(9002)]: {
          jobs: [{ name: "verify", run_attempt: 1, status: "completed", conclusion: "failure" }],
        },
        [checksUrl(PR_SHA)]: { check_runs: [green] },
      },
    });
    const result = await recovery.run();
    expect(result.sweep.examined).toBe(2);
    expect(result.sweep.relayed).toEqual([{ context: "verify", runId: "9002" }]);
    expect(recovery.posts).toHaveLength(1);
    expect(recovery.posts[0]).toMatchObject({
      name: "verify", head_sha: PR_SHA, conclusion: "failure",
      details_url: `https://github.com/${REPO}/actions/runs/9002`,
    });
    expect(recovery.requests).toContain(jobsUrl(9002));
    expect(recovery.requests).not.toContain(jobsUrl(9001));
    expect(result.sweep.superseded).toContainEqual({ runId: "9001", supersededBy: 8002 });
  });
});

describe("trigger recency and attempt attestation", () => {
  it.each([true, false])("does not overwrite the mirror's 9003 actionlint failure with 9002 success, trigger listed=%s", async (listed) => {
    const path = ".github/workflows/actionlint.yml";
    const older = producer({ id: 9002, path, event: "pull_request_target", head_sha: PR_SHA });
    const current = producer({ id: 9003, path, event: "pull_request_target", head_sha: PR_SHA, conclusion: "failure" });
    const h = harness({
      pinMap: { actionlint: path },
      env: {
        OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "9003", OVERFLOW_GITHUB_WORKFLOW_RUN_PATH: path,
        OVERFLOW_GITHUB_WORKFLOW_RUN_EVENT: "pull_request_target", OVERFLOW_GITHUB_WORKFLOW_RUN_HEAD_SHA: PR_SHA,
        OVERFLOW_GITHUB_WORKFLOW_RUN_CONCLUSION: "failure", OVERFLOW_GITHUB_WORKFLOW_RUN_ATTEMPT: "1",
        OVERFLOW_GITHUB_WORKFLOW_RUN_HTML_URL: `https://github.com/${REPO}/actions/runs/9003`,
      },
      handlers: {
        [runsUrl]: { workflow_runs: listed ? [current, older] : [older] },
        [jobsUrl(9003)]: { jobs: [{ name: "actionlint", run_attempt: 1, status: "completed", conclusion: "failure" }] },
        [jobsUrl(9002)]: { jobs: [{ name: "actionlint", run_attempt: 1, status: "completed", conclusion: "success" }] },
        [checksUrl(PR_SHA)]: (): Record<string, unknown> => ({ check_runs: [{ ...h.posts[0], app: { id: 5118623 } }] }),
      },
    });
    const result = await h.run();
    expect(h.posts.map((post) => post.conclusion)).toEqual(["failure"]);
    expect(h.posts[0]).toMatchObject({ name: "actionlint", head_sha: PR_SHA, external_id: "9003:1" });
    expect(result.sweep.relayed).toEqual([]);
    expect(h.requests).not.toContain(jobsUrl(9002));
  });

  it.each(["initial", "after-jobs"])("a newest superseded trigger blocks older verify even without a mirror post, %s", async (phase) => {
    let reads = 0;
    const trigger = producer({ id: 9003 });
    const older = producer({ id: 9002, event: "pull_request_target", head_sha: PR_SHA });
    const h = harness({
      env: { OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "9003" },
      handlers: {
        [runUrl(9003)]: trigger,
        [jobsUrl(9003)]: { jobs: [{ name: "verify", run_attempt: 1, status: "completed", conclusion: "success" }] },
        [jobsUrl(9002)]: { jobs: [{ name: "verify", run_attempt: 1, status: "completed", conclusion: "success" }] },
        [runsUrl]: { workflow_runs: [trigger, older] },
        [suiteRunsUrl()]: () => {
          reads += 1;
          return phase === "after-jobs" && reads === 1
            ? { total_count: 1, workflow_runs: [suite()] }
            : { total_count: 2, workflow_runs: [suite(), suite({ id: 8002, conclusion: "failure" })] };
        },
      },
    });
    const result = await h.run();
    expect(result.supersededBy).toBe(8002);
    expect(result.posted).toEqual([]);
    expect(h.posts).toEqual([]);
    expect(h.requests).not.toContain(jobsUrl(9002));
  });

  it("replaces attempt 1's real green at the same URL with orphaned attempt 2's failure", async () => {
    const first = producer({ id: 9002 });
    const initial = harness({ env: { OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "9002" }, handlers: {
      [runUrl(9002)]: first,
      [jobsUrl(9002)]: { jobs: [{ name: "verify", run_attempt: 1, status: "completed", conclusion: "success" }] },
    } });
    await initial.run();
    const green = { ...initial.posts[0], external_id: "9002:1", app: { id: 5118623 } };
    const rerun = producer({ id: 9002, run_attempt: 2, conclusion: "failure" });
    const recovery = harness({
      env: { OVERFLOW_GITHUB_WORKFLOW_RUN_ID: "", OVERFLOW_LEDGER_SWEEP_ONLY: "true" },
      handlers: {
        [runsUrl]: { workflow_runs: [rerun] }, [runUrl(9002)]: rerun,
        [jobsUrl(9002)]: { jobs: [{ name: "verify", run_attempt: 2, status: "completed", conclusion: "failure" }] },
        [checksUrl(PR_SHA)]: { check_runs: [green] },
      },
    });
    const result = await recovery.run();
    expect(result.sweep.relayed).toEqual([{ context: "verify", runId: "9002" }]);
    expect(recovery.posts).toHaveLength(1);
    expect(recovery.posts[0]).toMatchObject({
      name: "verify", head_sha: PR_SHA, conclusion: "failure", external_id: "9002:2",
      details_url: `https://github.com/${REPO}/actions/runs/9002`,
    });
  });
});
