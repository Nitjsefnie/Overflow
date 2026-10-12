import { generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";

import { isTrustedProducerRun, runRelay } from "../../scripts/ledger-relay.ts";

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
const runUrl = (id: number) => `${API}/actions/runs/${id}`;
const jobsUrl = (id: number) => `${runUrl(id)}/jobs?filter=latest&per_page=100`;
const checksUrl = (sha: string) =>
  `${API}/commits/${sha}/check-runs?app_id=5118623&filter=latest&per_page=100`;

let keyPem: string;
beforeAll(() => {
  keyPem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey
    .export({ type: "pkcs8", format: "pem" }).toString();
});

function producer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 9001,
    path: VERIFY_PATH,
    event: "workflow_run",
    repository: { id: Number(REPO_ID), full_name: REPO },
    head_repository: { id: Number(REPO_ID), full_name: REPO, owner: { login: "Nitjsefnie" } },
    head_branch: "main",
    head_sha: MAIN_SHA,
    display_title: "verify for pr suite run 8001",
    status: "completed",
    conclusion: "success",
    html_url: `https://github.com/${REPO}/actions/runs/9001`,
    run_attempt: 1,
    ...over,
  };
}

function suite(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 8001,
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
    if (url.endsWith("/access_tokens")) {
      return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
    }
    if (url === `${API}/check-runs` && init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ id: posts.length }), { status: 201 });
    }
    if (!(url in handlers)) throw new Error(`unexpected fetch: ${url}`);
    const result = handlers[url];
    if (result instanceof Error) throw result;
    if (typeof result === "object" && result !== null && "httpStatus" in result) {
      return new Response("upstream unavailable", { status: Number(result.httpStatus) });
    }
    return new Response(JSON.stringify(result));
  }) as typeof fetch;
  const env: Record<string, string | undefined> = {
    LEDGER_APP_ID: "5118623",
    LEDGER_INSTALLATION_ID: "166057493",
    LEDGER_APP_KEY: keyPem,
    GITHUB_REPOSITORY: REPO,
    GITHUB_REPOSITORY_ID: REPO_ID,
    GITHUB_WORKFLOW_RUN_ID: "9001",
    GITHUB_WORKFLOW_RUN_HEAD_SHA: MAIN_SHA,
    GITHUB_WORKFLOW_RUN_PATH: VERIFY_PATH,
    GITHUB_WORKFLOW_RUN_CONCLUSION: "success",
    GITHUB_WORKFLOW_RUN_HTML_URL: `https://github.com/${REPO}/actions/runs/9001`,
    GITHUB_WORKFLOW_RUN_EVENT: "workflow_run",
    GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "main",
    ...over.env,
  };
  return {
    requests,
    posts,
    run: () => runRelay({ env, fetchFn, delayFn: async () => {}, readPinMap: async () => PIN_MAP }),
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
        GITHUB_WORKFLOW_RUN_ID: "",
        LEDGER_DISPATCH_RUN_ID: "9001",
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
    expect(h.posts).toEqual([]);
    expect(h.requests).not.toContain(runUrl(8001));
  });

  it("refuses a fork run named main when the fetched event is pull_request", async () => {
    const h = harness({ producer: producer({
      event: "pull_request",
      head_repository: { id: 654321, full_name: "contributor/Overflow", owner: { login: "contributor" } },
    }) });
    await expect(h.run()).rejects.toThrow(/producer.*event/);
    expect(h.posts).toEqual([]);
  });

  it.each([9002, undefined])("binds dispatch recovery to the requested id when the API reports %s", async (id) => {
    const h = harness({
      producer: producer({ id }),
      env: { GITHUB_WORKFLOW_RUN_ID: "", LEDGER_DISPATCH_RUN_ID: "9001" },
    });
    await expect(h.run()).rejects.toThrow(/producer.*id/);
    expect(h.posts).toEqual([]);
    expect(h.requests).not.toContain(runUrl(8001));
  });

  it("throws for an unpinned workflow_run producer path instead of silently returning", async () => {
    const h = harness({
      env: { GITHUB_WORKFLOW_RUN_PATH: ".github/workflows/other.yml" },
      producer: producer({ path: ".github/workflows/other.yml" }),
    });
    await expect(h.run()).rejects.toThrow(/producer.*path/);
    expect(h.posts).toEqual([]);
  });

  it.each([
    ["missing", undefined], ["malformed", "Overflow"],
  ])("throws when the relay's repository id is %s", async (_name, id) => {
    const h = harness({ env: { GITHUB_REPOSITORY_ID: id } });
    await expect(h.run()).rejects.toThrow(/GITHUB_REPOSITORY_ID/);
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
    expect(h.posts).toEqual([]);
    expect(h.requests).not.toContain(jobsUrl(9001));
  });

  it.each([
    ["HTTP", { httpStatus: 404 }], ["network", new Error("network unavailable")],
  ])("throws on upstream %s read failure", async (_name, failure) => {
    const h = harness({ upstream: failure });
    await expect(h.run()).rejects.toThrow(/workflow run 8001.*failed/);
    expect(h.posts).toEqual([]);
  });

  it("throws on a producer API read failure", async () => {
    const h = harness({ producer: { httpStatus: 404 } });
    await expect(h.run()).rejects.toThrow(/workflow run 9001.*failed/);
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
  const sweepEnv = { GITHUB_WORKFLOW_RUN_ID: "", LEDGER_SWEEP_ONLY: "true" };

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
        check_runs: [{ name: "verify", status: "completed", app: { id: 5118623 } }],
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
    expect(h.posts.map((body) => body.head_sha)).toEqual([PR_SHA, OTHER_PR_SHA]);
  });

  it.each([
    ["upstream fetch fails", suite(), { httpStatus: 404 }, /workflow run 8001.*failed/],
    ["upstream path is wrong", suite({ path: VERIFY_PATH }), undefined, /upstream.*path/],
  ] as const)("throws loudly when %s, with no main attestation", async (_name, upstream, failure, error) => {
    const h = harness({ env: sweepEnv, upstream: failure ?? upstream, handlers: {
      [runsUrl]: { workflow_runs: [producer()] },
    } });
    await expect(h.run()).rejects.toThrow(error);
    expect(h.posts).toEqual([]);
    expect(h.requests).not.toContain(checksUrl(MAIN_SHA));
  });

  it("revalidates the candidate's producer body rather than trusting the run listing", async () => {
    const h = harness({ env: sweepEnv, producer: producer({ repository: { id: 654321 } }), handlers: {
      [runsUrl]: { workflow_runs: [producer()] },
    } });
    await expect(h.run()).rejects.toThrow(/producer.*repository/);
    expect(h.posts).toEqual([]);
  });
});
