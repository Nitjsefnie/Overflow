import { createVerify, generateKeyPairSync } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  decideContexts,
  decideRerun,
  isTrustedProducerRun,
  mintAppJwt,
  RERUN_ATTEMPT_CAP,
  renderRelayResult,
  runRelay,
  validatePinMap,
  type ContextDecision,
  type RelayJob,
} from "../../scripts/ledger-relay.ts";
import { SWEEP_RUN_LIMIT } from "../../scripts/ledger-relay-sweep.ts";

/**
 * The ledger relay (issue 708): decideContexts mirrors the triggering run's
 * producing jobs into per-context decisions; mintAppJwt shapes the GitHub App
 * JWT; runRelay mints an installation token, reads the jobs listing and posts
 * one check-run per pinned context — all through an injected fetch, never the
 * network. Issue 861 adds the rerun-heal: decideRerun is the pure decision,
 * and runRelay dispatches the rerun for a cancelled pending PR run at a live,
 * unmatched head.
 */

const PATH_CI = ".github/workflows/ci.yml";
const PATH_ACTIONLINT = ".github/workflows/actionlint.yml";
/** The second producer path of the split shape. Not a committed pin. */
const PATH_CI_PR = ".github/workflows/ci-pr.yml";

const PIN_MAP = {
  verify: PATH_CI,
  "ratchet-guard": ".github/workflows/ratchet-guard.yml",
  actionlint: PATH_ACTIONLINT,
};

/**
 * One context pinned to TWO workflow paths — the shape issue 1090's workflow
 * split produces, where a required context's pull-request leg and its push leg
 * live in separate files. Neither path here is a committed pin: the real
 * .github/required-checks.json stays all-strings until the split lands, so
 * every assertion below runs against a test-local map.
 */
const TWO_PATH_PIN_MAP = {
  verify: [PATH_CI, PATH_CI_PR],
  "ratchet-guard": ".github/workflows/ratchet-guard.yml",
};

function job(over: Partial<RelayJob>): RelayJob {
  return {
    name: "verify",
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    ...over,
  };
}

describe("isTrustedProducerRun", () => {
  // The allowlist of runs whose executed workflow definition is the base
  // branch's. pull_request_target runs the base branch's definition whatever
  // the head branch is called; push, workflow_dispatch and schedule run the
  // definition at the ref they name, which is the protected one only when that
  // ref is main; every other event, and any event not listed, is refused.
  it.each([
    ["pull_request_target", "main", true],
    ["pull_request_target", "feature/some-branch", true],
    ["pull_request_target", "", true],
    ["push", "main", true],
    ["push", "feature/some-branch", false],
    ["push", "", false],
    ["workflow_dispatch", "main", true],
    ["workflow_dispatch", "feature/some-branch", false],
    ["schedule", "main", true],
    ["schedule", "feature/some-branch", false],
    ["pull_request", "main", false],
    ["pull_request", "feature/some-branch", false],
    ["issue_comment", "main", false],
    ["issue_comment", "feature/some-branch", false],
    ["pull_request_review", "main", false],
    ["pull_request_review_comment", "main", false],
    ["merge_group", "main", false],
    ["workflow_run", "main", false],
    ["", "main", false],
    ["", "", false],
    ["some_future_event", "main", false],
    // Near misses: the comparison is exact, never a prefix or a case fold.
    ["Push", "main", false],
    ["push", "Main", false],
    ["push", "refs/heads/main", false],
    ["push", "main ", false],
    ["pull_request_target ", "main", false],
  ])("event %j on head branch %j is trusted: %s", (event, headBranch, expected) => {
    expect(isTrustedProducerRun(event, headBranch)).toBe(expected);
  });
});

/**
 * The pin map's shape, as the relay reads it. Two forms are legal per context:
 * the string every committed entry uses today, and a non-empty list of paths,
 * which is what a required context whose pull-request and push legs live in
 * separate workflow files has to name (issue 1090). An EMPTY list is refused:
 * it is the shape that reads as "this context has no producer", which is the
 * condition the deploy gate refuses a map for and the relay must not mint a
 * token over.
 */
describe("validatePinMap", () => {
  it("accepts today's single-string form, unchanged", () => {
    expect(validatePinMap(PIN_MAP)).toEqual(PIN_MAP);
  });

  it("accepts a non-empty list of workflow paths for one context", () => {
    expect(validatePinMap({ verify: [PATH_CI, PATH_CI_PR] })).toEqual({
      verify: [PATH_CI, PATH_CI_PR],
    });
  });

  it("accepts a map mixing a string pin and a list pin", () => {
    expect(validatePinMap({ verify: [PATH_CI, PATH_CI_PR], actionlint: PATH_ACTIONLINT })).toEqual({
      verify: [PATH_CI, PATH_CI_PR],
      actionlint: PATH_ACTIONLINT,
    });
  });

  it.each([
    ["an empty list", { verify: [] }],
    ["a list holding a path outside .github/workflows/", { verify: [PATH_CI, "scripts/ci.yml"] }],
    ["a list holding a nested list", { verify: [PATH_CI, [PATH_CI_PR]] }],
    ["a list holding a number", { verify: [PATH_CI, 7] }],
    ["a list holding null", { verify: [PATH_CI, null] }],
    ["a bare number", { verify: 7 }],
    ["null", { verify: null }],
    ["a top-level array", [PATH_CI]],
    ["a top-level string", PATH_CI],
    ["a top-level array of objects", [{ verify: PATH_CI }]],
  ])("refuses %s", (_name, value) => {
    expect(() => validatePinMap(value)).toThrow(/required-checks\.json/);
  });

  it("names the offending context, so the refusal is actionable", () => {
    expect(() => validatePinMap({ verify: PATH_CI, actionlint: [] })).toThrow(/actionlint/);
  });
});

describe("decideRerun", () => {
  const HEAD = "c".repeat(40);

  function healRun(
    over: Partial<{ conclusion: string | null; event: string; runAttempt: number; headSha: string }> = {},
  ) {
    return { conclusion: "cancelled", event: "pull_request_target", runAttempt: 1, headSha: HEAD, ...over };
  }

  it.each([
    [
      "heals a cancelled pull_request_target run at a live, unmatched head",
      healRun({ event: "pull_request_target" }),
      { state: "open", headSha: HEAD },
      false,
      true,
    ],
    [
      "does not heal a cancelled pull_request run — it is never relayed, so a rerun heals nothing",
      healRun({ event: "pull_request" }),
      { state: "open", headSha: HEAD },
      false,
      false,
    ],
    [
      "does not heal a superseded head — the open PR's tip has moved on",
      healRun(),
      { state: "open", headSha: "d".repeat(40) },
      false,
      false,
    ],
    [
      "does not heal a closed PR at the head",
      healRun(),
      { state: "closed", headSha: HEAD },
      false,
      false,
    ],
    [
      "does not heal when no PR is associated with the head",
      healRun(),
      null,
      false,
      false,
    ],
    [
      "does not heal a push run",
      healRun({ event: "push" }),
      { state: "open", headSha: HEAD },
      false,
      false,
    ],
    [
      "does not heal a workflow_dispatch run",
      healRun({ event: "workflow_dispatch" }),
      { state: "open", headSha: HEAD },
      false,
      false,
    ],
    [
      "does not heal a successful run",
      healRun({ conclusion: "success" }),
      { state: "open", headSha: HEAD },
      false,
      false,
    ],
    [
      "does not heal a failed run",
      healRun({ conclusion: "failure" }),
      { state: "open", headSha: HEAD },
      false,
      false,
    ],
    [
      "does not heal a run without a conclusion",
      healRun({ conclusion: null }),
      { state: "open", headSha: HEAD },
      false,
      false,
    ],
    [
      "does not heal a run at the attempt cap",
      healRun({ runAttempt: 5 }),
      { state: "open", headSha: HEAD },
      false,
      false,
    ],
    [
      "heals a run just under the attempt cap",
      healRun({ runAttempt: 4 }),
      { state: "open", headSha: HEAD },
      false,
      true,
    ],
    [
      "does not heal when a live run of the same workflow already holds the head",
      healRun(),
      { state: "open", headSha: HEAD },
      true,
      false,
    ],
  ])("%s", (_name, run, pr, liveRunExists, expected) => {
    expect(decideRerun(run, pr, liveRunExists)).toBe(expected);
  });

  it("caps exactly at RERUN_ATTEMPT_CAP, which is 5", () => {
    expect(RERUN_ATTEMPT_CAP).toBe(5);
    const live = { state: "open", headSha: HEAD };
    expect(decideRerun(healRun({ runAttempt: RERUN_ATTEMPT_CAP }), live, false)).toBe(false);
    expect(decideRerun(healRun({ runAttempt: RERUN_ATTEMPT_CAP - 1 }), live, false)).toBe(true);
  });
});

describe("renderRelayResult", () => {
  const decision: ContextDecision = {
    context: "verify",
    status: "completed",
    conclusion: "failure",
    title: "verify: workflow-level failure",
    summary: "summary",
  };

  it("renders one line per posted decision and names the rerun-heal when it dispatched", () => {
    const lines = renderRelayResult({
      decisions: [decision],
      posted: ["verify"],
      rerunDispatched: true,
      sweep: { examined: 0, relayed: [] },
    });
    expect(lines).toEqual([
      "[ledger-relay] verify: failure",
      "[ledger-relay] rerun-heal: the cancelled run was re-dispatched; " +
        "its completion event will mirror the real conclusion",
    ]);
  });

  it("renders no rerun-heal line when the heal did not dispatch", () => {
    const lines = renderRelayResult({
      decisions: [decision],
      posted: ["verify"],
      rerunDispatched: false,
      sweep: { examined: 0, relayed: [] },
    });
    expect(lines).toEqual(["[ledger-relay] verify: failure"]);
    expect(lines.some((line) => line.includes("rerun-heal"))).toBe(false);
  });

  it("appends the sweep summary and one line per relayed context, after the rerun-heal line", () => {
    const lines = renderRelayResult({
      decisions: [decision],
      posted: ["verify"],
      rerunDispatched: true,
      sweep: {
        examined: 3,
        relayed: [
          { context: "actionlint", runId: "36822699261" },
          { context: "ratchet-guard", runId: "36822699262" },
        ],
      },
    });
    expect(lines).toEqual([
      "[ledger-relay] verify: failure",
      "[ledger-relay] rerun-heal: the cancelled run was re-dispatched; " +
        "its completion event will mirror the real conclusion",
      "[ledger-relay] orphan-sweep: examined 3 completed run(s), relayed 2 context(s)",
      "[ledger-relay] orphan-sweep: relayed actionlint from run 36822699261 " +
        "(no App check-run existed for it)",
      "[ledger-relay] orphan-sweep: relayed ratchet-guard from run 36822699262 " +
        "(no App check-run existed for it)",
    ]);
  });

  it("renders the sweep summary alone when the sweep examined candidates and healed nothing", () => {
    // The line an operator reads to tell "the sweep ran and there was nothing
    // to heal" from "the sweep never ran" — so it is pinned, not left to the
    // sweep module's own tests.
    const lines = renderRelayResult({
      decisions: [decision],
      posted: ["verify"],
      rerunDispatched: false,
      sweep: { examined: 4, relayed: [] },
    });
    expect(lines).toEqual([
      "[ledger-relay] verify: failure",
      "[ledger-relay] orphan-sweep: examined 4 completed run(s), relayed 0 context(s)",
    ]);
  });

  it("renders no sweep line at all when nothing was examined", () => {
    // A healthy repository sweeps clean on every relay start; a line printed
    // every time would be noise an operator learns to skip.
    const lines = renderRelayResult({
      decisions: [decision],
      posted: ["verify"],
      rerunDispatched: false,
      sweep: { examined: 0, relayed: [] },
    });
    expect(lines).toEqual(["[ledger-relay] verify: failure"]);
    expect(lines.some((line) => line.includes("orphan-sweep"))).toBe(false);
  });

  it("renders only the nothing-to-relay line when nothing was posted", () => {
    const lines = renderRelayResult({
      decisions: [],
      posted: [],
      rerunDispatched: false,
      sweep: { examined: 0, relayed: [] },
    });
    expect(lines).toEqual([
      "[ledger-relay] nothing to relay: no required context is pinned to the triggering run's workflow",
    ]);
  });
});

describe("decideContexts", () => {
  it("returns decisions only for the contexts pinned to the triggering run's path", () => {
    const decisions = decideContexts(PIN_MAP, PATH_CI, "success", [
      job({}),
      job({ name: "actionlint" }),
    ]);
    expect(decisions.map((decision) => decision.context)).toEqual(["verify"]);
  });

  it("keeps pin-map order for several contexts sharing one path", () => {
    const decisions = decideContexts(
      { "z-context": PATH_CI, "a-context": PATH_CI },
      PATH_CI,
      "success",
      [job({}), job({ name: "a-context" })],
    );
    expect(decisions.map((decision) => decision.context)).toEqual(["z-context", "a-context"]);
  });

  // Issue 1090. Before the split every context had exactly one producing
  // workflow, so pinning it to a single path was the whole contract. The split
  // gives one context two producing workflows, and a pin that names only the
  // first leaves the second path's runs relaying NOTHING — a silent no-op, not
  // a red relay, because the second run's path simply matches no pin.
  it("resolves the context from EITHER path a list pin names", () => {
    for (const runPath of [PATH_CI, PATH_CI_PR]) {
      const decisions = decideContexts(TWO_PATH_PIN_MAP, runPath, "success", [job({})]);
      expect(decisions.map((decision) => decision.context), runPath).toEqual(["verify"]);
    }
  });

  it("still resolves today's single-string form", () => {
    const decisions = decideContexts(PIN_MAP, PATH_ACTIONLINT, "success", [
      job({ name: "actionlint" }),
    ]);
    expect(decisions.map((decision) => decision.context)).toEqual(["actionlint"]);
  });

  it("gives a list pin no reach beyond its own paths", () => {
    expect(decideContexts(TWO_PATH_PIN_MAP, PATH_ACTIONLINT, "success", [job({})])).toEqual([]);
  });

  it("decides a list pin once per context, never once per path", () => {
    const decisions = decideContexts(TWO_PATH_PIN_MAP, PATH_CI_PR, "success", [job({})]);
    expect(decisions).toHaveLength(1);
  });

  it("keeps two different contexts naming the same path", () => {
    const decisions = decideContexts(
      { verify: PATH_CI, actionlint: [PATH_CI, PATH_CI_PR] },
      PATH_CI,
      "success",
      [job({}), job({ name: "actionlint" })],
    );
    expect(decisions.map((decision) => decision.context)).toEqual(["verify", "actionlint"]);
  });

  it.each([
    ["success", "success"],
    ["failure", "failure"],
    ["cancelled", "cancelled"],
    ["skipped", "skipped"],
  ])("mirrors a completed job's %s conclusion", (jobConclusion, expected) => {
    const decisions = decideContexts(PIN_MAP, PATH_CI, "success", [
      job({ status: "completed", conclusion: jobConclusion }),
    ]);
    expect(decisions).toEqual([
      {
        context: "verify",
        status: "completed",
        conclusion: expected,
        title: expect.any(String),
        summary: expect.any(String),
      },
    ]);
  });

  it.each(["queued", "in_progress"] as const)(
    "posts the pending %s status without a conclusion",
    (pendingStatus) => {
      const decisions = decideContexts(PIN_MAP, PATH_CI, "success", [
        job({ status: pendingStatus, conclusion: null }),
      ]);
      expect(decisions).toEqual([
        {
          context: "verify",
          status: pendingStatus,
          title: expect.any(String),
          summary: expect.any(String),
        },
      ]);
      expect(Object.hasOwn(decisions[0] ?? {}, "conclusion")).toBe(false);
    },
  );

  it("picks the job with the highest run_attempt, whatever it concluded", () => {
    const decisions = decideContexts(PIN_MAP, PATH_CI, "success", [
      job({ run_attempt: 1, status: "completed", conclusion: "success" }),
      job({ run_attempt: 2, status: "completed", conclusion: "failure" }),
    ]);
    expect(decisions[0]?.conclusion).toBe("failure");
  });

  it("prefers a non-success over a success on an attempt tie, in either listing order", () => {
    for (const order of ["failure-first", "success-first"] as const) {
      const jobs =
        order === "failure-first"
          ? [
              job({ run_attempt: 2, status: "completed", conclusion: "failure" }),
              job({ run_attempt: 2, status: "completed", conclusion: "success" }),
            ]
          : [
              job({ run_attempt: 2, status: "completed", conclusion: "success" }),
              job({ run_attempt: 2, status: "completed", conclusion: "failure" }),
            ];
      const decisions = decideContexts(PIN_MAP, PATH_CI, "success", jobs);
      expect(decisions[0]?.conclusion, order).toBe("failure");
    }
  });

  it("reports failure naming the missing job when the run has jobs but none matches the context", () => {
    const decisions = decideContexts(PIN_MAP, PATH_CI, "success", [
      job({ name: "renamed-verify" }),
    ]);
    expect(decisions).toEqual([
      {
        context: "verify",
        status: "completed",
        conclusion: "failure",
        title: expect.any(String),
        summary: expect.any(String),
      },
    ]);
    // The renamed producer must be visible to the operator debugging the
    // blocked merge: the summary names the context the run failed to produce.
    expect(decisions[0]?.summary).toContain("verify");
  });

  it("fails every pinned context when the run concluded non-success with no jobs", () => {
    for (const conclusion of ["failure", "cancelled", null]) {
      const decisions = decideContexts(PIN_MAP, PATH_CI, conclusion, []);
      expect(decisions.map((decision) => decision.context)).toEqual(["verify"]);
      expect(decisions.every((decision) => decision.status === "completed")).toBe(true);
      expect(decisions.every((decision) => decision.conclusion === "failure")).toBe(true);
    }
  });

  it("mirrors a run-level success when the run concluded success with no jobs", () => {
    const decisions = decideContexts(PIN_MAP, PATH_CI, "success", []);
    expect(decisions.map((decision) => decision.conclusion)).toEqual(["success"]);
  });

  it("decides only from jobs named exactly the context", () => {
    const decisions = decideContexts(PIN_MAP, PATH_CI, "success", [
      job({ name: "Verify" }),
      job({ name: "verify " }),
      job({ name: "verify (false)" }),
    ]);
    expect(decisions[0]?.conclusion).toBe("failure");
  });
});

describe("mintAppJwt", () => {
  let keyPem = "";
  let publicKeyPem = "";

  beforeAll(() => {
    const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    publicKeyPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  });

  function decodeSegment(segment: string): Record<string, unknown> {
    return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
  }

  function verifies(jwt: string, pem: string): boolean {
    const [header, payload, signature] = jwt.split(".");
    if (header === undefined || payload === undefined || signature === undefined) return false;
    return createVerify("RSA-SHA256")
      .update(`${header}.${payload}`)
      .verify(pem, Buffer.from(signature, "base64url"));
  }

  it("carries the RS256 header, the iat/exp offsets and the app id as iss", () => {
    const nowMs = 1_793_000_000_000;
    const jwt = mintAppJwt("5118623", keyPem, nowMs);
    const [header, payload, signature] = jwt.split(".");
    expect(header).toBeDefined();
    expect(payload).toBeDefined();
    expect(signature).toBeDefined();
    expect(decodeSegment(header ?? "")).toEqual({ alg: "RS256", typ: "JWT" });
    expect(decodeSegment(payload ?? "")).toEqual({
      iat: Math.floor(nowMs / 1000) - 60,
      exp: Math.floor(nowMs / 1000) + 540,
      iss: "5118623",
    });
  });

  it("produces a signature that verifies against the minting key's public half", () => {
    const jwt = mintAppJwt("5118623", keyPem, Date.now());
    expect(verifies(jwt, publicKeyPem)).toBe(true);
  });

  it("fails verification when the payload is tampered with or the key differs", () => {
    const nowMs = Date.now();
    const jwt = mintAppJwt("5118623", keyPem, nowMs);
    const [header, , signature] = jwt.split(".");
    const forged = `${header}.${Buffer.from(
      JSON.stringify({ iat: 1, exp: 2, iss: "someone-else" }),
    ).toString("base64url")}.${signature}`;
    expect(verifies(forged, publicKeyPem)).toBe(false);

    const other = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const otherPem = other.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    expect(verifies(mintAppJwt("5118623", otherPem, nowMs), publicKeyPem)).toBe(false);
  });
});

/**
 * The posting half, against an injected fetch. Every response is queued
 * up front; a request past the queue fails the test instead of the run.
 */
describe("runRelay", () => {
  let keyPem = "";

  beforeAll(() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  });

  const HEAD_SHA = "a".repeat(40);
  const RUN_ID = "9001";
  const HTML_URL = `https://github.com/Nitjsefnie/Overflow/actions/runs/${RUN_ID}`;
  const TOKEN_URL = "https://api.github.com/app/installations/166057493/access_tokens";
  const JOBS_URL = `https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs/${RUN_ID}/jobs?filter=latest&per_page=100`;
  const CHECK_RUNS_URL = "https://api.github.com/repos/Nitjsefnie/Overflow/check-runs";
  const RUN_URL = `https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs/${RUN_ID}`;

  interface Recorded {
    url: string;
    init: RequestInit;
  }

  type Outcome = { status: number; body: unknown } | { fail: Error };

  function makeFetch(outcomes: Outcome[]) {
    const requests: Recorded[] = [];
    const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
      const rendered = typeof url === "string" ? url : String(url);
      requests.push({ url: rendered, init: init ?? {} });
      const outcome = outcomes.shift();
      if (!outcome) throw new Error(`unexpected fetch: ${rendered}`);
      if ("fail" in outcome) throw outcome.fail;
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

  function token(): Outcome {
    return { status: 201, body: { token: "installation-token" } };
  }

  function jobsListing(jobs: RelayJob[]): Outcome {
    return { status: 200, body: { total_count: jobs.length, jobs } };
  }

  function headersOf(request: Recorded): Record<string, string> {
    return request.init.headers as Record<string, string>;
  }

  function bodiesOf(requests: Recorded[]): Array<Record<string, unknown>> {
    return requests
      .filter((request) => request.url === CHECK_RUNS_URL)
      .map((request) => JSON.parse(String(request.init.body)) as Record<string, unknown>);
  }

  it("mints the installation token, reads the jobs and posts one check-run per pinned context", async () => {
    const fetchStub = makeFetch([
      token(),
      jobsListing([job({ run_attempt: 3 })]),
      { status: 201, body: { id: 1 } },
      noSweepRuns(),
    ]);
    const delay = makeDelay();
    const result = await runRelay({
      env: relayEnv(),
      fetchFn: fetchStub.fn,
      delayFn: delay.fn,
      readPinMap: async () => PIN_MAP,
    });

    expect(result.posted).toEqual(["verify"]);
    expect(fetchStub.requests.map((request) => request.url)).toEqual([
      TOKEN_URL,
      JOBS_URL,
      CHECK_RUNS_URL,
      SWEEP_RUNS_URL,
    ]);

    const [mint, jobsRequest] = fetchStub.requests;
    // The App JWT authenticates the mint; the minted token authenticates
    // everything after it.
    expect(mint?.init.method).toBe("POST");
    expect(headersOf(mint ?? { url: "", init: {} }).authorization).toMatch(/^Bearer /);
    const mintJwt = String(headersOf(mint ?? { url: "", init: {} }).authorization).slice(7);
    const payload = JSON.parse(
      Buffer.from(mintJwt.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(payload.iss).toBe("5118623");
    expect(JSON.parse(String(mint?.init.body))).toEqual({ repositories: ["Overflow"] });

    expect(jobsRequest?.init.method).toBe("GET");
    expect(headersOf(jobsRequest ?? { url: "", init: {} }).authorization).toBe(
      "Bearer installation-token",
    );

    expect(bodiesOf(fetchStub.requests)).toEqual([
      {
        name: "verify",
        head_sha: HEAD_SHA,
        status: "completed",
        conclusion: "success",
        details_url: HTML_URL,
        output: { title: expect.any(String), summary: expect.any(String) },
      },
    ]);
    expect(delay.delays).toEqual([]);
  });

  it("sends the GitHub API media type and api-version headers on every call", async () => {
    const fetchStub = makeFetch([token(), jobsListing([job({})]), { status: 201, body: { id: 1 } }, noSweepRuns()]);
    await runRelay({
      env: relayEnv(),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => PIN_MAP,
    });
    for (const request of fetchStub.requests) {
      expect(headersOf(request)).toMatchObject({
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
      });
    }
  });

  it("posts a pending status without a conclusion while the producing job runs", async () => {
    const fetchStub = makeFetch([
      token(),
      jobsListing([job({ status: "in_progress", conclusion: null })]),
      { status: 201, body: { id: 1 } },
      noSweepRuns(),
    ]);
    const result = await runRelay({
      env: relayEnv(),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => PIN_MAP,
    });
    expect(result.posted).toEqual(["verify"]);
    const [body] = bodiesOf(fetchStub.requests);
    expect(body).toMatchObject({ name: "verify", status: "in_progress", head_sha: HEAD_SHA });
    expect(Object.hasOwn(body ?? {}, "conclusion")).toBe(false);
  });

  it("posts against the triggering run's head SHA, never a merge ref", async () => {
    const prHeadSha = "b".repeat(40);
    const fetchStub = makeFetch([
      token(),
      jobsListing([job({})]),
      { status: 201, body: { id: 1 } },
      noSweepRuns(),
    ]);
    await runRelay({
      env: relayEnv({ GITHUB_WORKFLOW_RUN_HEAD_SHA: prHeadSha }),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => PIN_MAP,
    });
    expect(bodiesOf(fetchStub.requests).every((body) => body.head_sha === prHeadSha)).toBe(true);
  });

  it("retries a 500 once, with the recorded backoff, and succeeds", async () => {
    const fetchStub = makeFetch([
      token(),
      jobsListing([job({})]),
      { status: 500, body: { message: "boom" } },
      { status: 201, body: { id: 1 } },
      noSweepRuns(),
    ]);
    const delay = makeDelay();
    const result = await runRelay({
      env: relayEnv(),
      fetchFn: fetchStub.fn,
      delayFn: delay.fn,
      readPinMap: async () => PIN_MAP,
    });
    expect(result.posted).toEqual(["verify"]);
    const postings = fetchStub.requests.filter((request) => request.url === CHECK_RUNS_URL);
    expect(postings).toHaveLength(2);
    expect(delay.delays).toEqual([1000]);
  });

  it("retries a network error once and succeeds", async () => {
    const fetchStub = makeFetch([
      token(),
      jobsListing([job({})]),
      { fail: new TypeError("fetch failed") },
      { status: 201, body: { id: 1 } },
      noSweepRuns(),
    ]);
    const delay = makeDelay();
    const result = await runRelay({
      env: relayEnv(),
      fetchFn: fetchStub.fn,
      delayFn: delay.fn,
      readPinMap: async () => PIN_MAP,
    });
    expect(result.posted).toEqual(["verify"]);
    expect(delay.delays).toEqual([1000]);
  });

  it("fails immediately on a non-retryable 422", async () => {
    const fetchStub = makeFetch([
      token(),
      jobsListing([job({})]),
      { status: 422, body: { message: "invalid" } },
    ]);
    const delay = makeDelay();
    await expect(
      runRelay({
        env: relayEnv(),
        fetchFn: fetchStub.fn,
        delayFn: delay.fn,
        readPinMap: async () => PIN_MAP,
      }),
    ).rejects.toThrow(/422/);
    const postings = fetchStub.requests.filter((request) => request.url === CHECK_RUNS_URL);
    expect(postings).toHaveLength(1);
    expect(delay.delays).toEqual([]);
  });

  it("exhausts three attempts on a 500 and rejects loudly without leaking the key", async () => {
    const fetchStub = makeFetch([
      token(),
      jobsListing([job({})]),
      { status: 500, body: { message: "boom" } },
      { status: 500, body: { message: "boom" } },
      { status: 500, body: { message: "boom" } },
    ]);
    const delay = makeDelay();
    const error = await runRelay({
      env: relayEnv(),
      fetchFn: fetchStub.fn,
      delayFn: delay.fn,
      readPinMap: async () => PIN_MAP,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("verify");
    expect((error as Error).message).toContain("HTTP 500");
    // The failure names what failed, never the material that authenticated it.
    expect((error as Error).message).not.toContain(keyPem);
    const postings = fetchStub.requests.filter((request) => request.url === CHECK_RUNS_URL);
    expect(postings).toHaveLength(3);
    expect(delay.delays).toEqual([1000, 2000]);
  });

  it("recovers a dead posting through the dispatch path, re-reading the named run", async () => {
    const fetchStub = makeFetch([
      token(),
      {
        status: 200,
        body: {
          id: Number(RUN_ID),
          head_sha: HEAD_SHA,
          path: PATH_CI,
          conclusion: "success",
          html_url: HTML_URL,
          event: "push",
          head_branch: "main",
        },
      },
      jobsListing([job({})]),
      { status: 201, body: { id: 1 } },
      noSweepRuns(),
    ]);
    const delay = makeDelay();
    const result = await runRelay({
      env: relayEnv({
        GITHUB_WORKFLOW_RUN_ID: "",
        GITHUB_WORKFLOW_RUN_HEAD_SHA: "",
        GITHUB_WORKFLOW_RUN_PATH: "",
        GITHUB_WORKFLOW_RUN_CONCLUSION: "",
        GITHUB_WORKFLOW_RUN_HTML_URL: "",
        GITHUB_WORKFLOW_RUN_EVENT: "",
        LEDGER_DISPATCH_RUN_ID: RUN_ID,
      }),
      fetchFn: fetchStub.fn,
      delayFn: delay.fn,
      readPinMap: async () => PIN_MAP,
    });
    expect(result.posted).toEqual(["verify"]);
    expect(fetchStub.requests.map((request) => request.url)).toEqual([
      TOKEN_URL,
      RUN_URL,
      JOBS_URL,
      CHECK_RUNS_URL,
      SWEEP_RUNS_URL,
    ]);
    expect(bodiesOf(fetchStub.requests).every((body) => body.head_sha === HEAD_SHA)).toBe(true);
  });

  it("rejects before any network call when the triggering-run env is absent", async () => {
    const fetchStub = makeFetch([]);
    await expect(
      runRelay({
        env: relayEnv({
          GITHUB_WORKFLOW_RUN_ID: "",
          GITHUB_WORKFLOW_RUN_HEAD_SHA: "",
          GITHUB_WORKFLOW_RUN_PATH: "",
          GITHUB_WORKFLOW_RUN_CONCLUSION: "",
          GITHUB_WORKFLOW_RUN_HTML_URL: "",
          GITHUB_WORKFLOW_RUN_EVENT: "",
        }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      }),
    ).rejects.toThrow(/LEDGER_DISPATCH_RUN_ID/);
    expect(fetchStub.requests).toHaveLength(0);
  });

  it("rejects before any network call on a malformed head SHA", async () => {
    const fetchStub = makeFetch([]);
    await expect(
      runRelay({
        env: relayEnv({ GITHUB_WORKFLOW_RUN_HEAD_SHA: "deadbeef" }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      }),
    ).rejects.toThrow(/GITHUB_WORKFLOW_RUN_HEAD_SHA/);
    expect(fetchStub.requests).toHaveLength(0);
  });

  it("rejects before any network call when a pin is not a workflow path", async () => {
    const fetchStub = makeFetch([]);
    await expect(
      runRelay({
        env: relayEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => ({ verify: "workflows/ci.yml" }),
      }),
    ).rejects.toThrow(/verify/);
    expect(fetchStub.requests).toHaveLength(0);
  });

  it("relays nothing when no required context is pinned to the triggering run's path", async () => {
    const fetchStub = makeFetch([]);
    const result = await runRelay({
      env: relayEnv({ GITHUB_WORKFLOW_RUN_PATH: PATH_ACTIONLINT }),
      fetchFn: fetchStub.fn,
      delayFn: makeDelay().fn,
      readPinMap: async () => ({ verify: PATH_CI }),
    });
    expect(result.decisions).toEqual([]);
    expect(result.posted).toEqual([]);
    expect(fetchStub.requests).toHaveLength(0);
  });

  // --- Trusted producer runs: a required context is relayed only from a run
  // whose executed workflow definition is the base branch's ---

  /** The workflow_dispatch recovery's environment: no workflow_run fields, only the run id. */
  function dispatchEnv(over: Record<string, string> = {}): Record<string, string> {
    return relayEnv({
      GITHUB_WORKFLOW_RUN_ID: "",
      GITHUB_WORKFLOW_RUN_HEAD_SHA: "",
      GITHUB_WORKFLOW_RUN_PATH: "",
      GITHUB_WORKFLOW_RUN_CONCLUSION: "",
      GITHUB_WORKFLOW_RUN_HTML_URL: "",
      GITHUB_WORKFLOW_RUN_EVENT: "",
      GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "",
      LEDGER_DISPATCH_RUN_ID: RUN_ID,
      ...over,
    });
  }

  /** The run the dispatch recovery re-reads, as GET actions/runs/{id} returns it. */
  function fetchedRunBody(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: Number(RUN_ID),
      head_sha: HEAD_SHA,
      path: PATH_CI,
      conclusion: "success",
      html_url: HTML_URL,
      event: "push",
      head_branch: "main",
      head_repository: { full_name: "Nitjsefnie/Overflow" },
      ...over,
    };
  }

  function fetchedRun(over: Record<string, unknown> = {}): Outcome {
    return { status: 200, body: fetchedRunBody(over) };
  }

  /** Everything a relay that wrongly accepted the run would go on to ask for. */
  function acceptingOutcomes(): Outcome[] {
    return [jobsListing([job({})]), { status: 201, body: { id: 1 } }, noSweepRuns()];
  }

  async function caughtError(promise: Promise<unknown>): Promise<Error | undefined> {
    return promise.then(
      () => undefined,
      (caught: unknown) => (caught instanceof Error ? caught : new Error(String(caught))),
    );
  }

  describe("trusted producer runs", () => {
    it.each([
      ["pull_request", "main"],
      ["pull_request", "feature/some-branch"],
      ["issue_comment", "main"],
      ["issue_comment", "feature/some-branch"],
      ["push", "feature/some-branch"],
      ["workflow_dispatch", "feature/some-branch"],
      ["", "main"],
    ])(
      "refuses a pinned %j run on head branch %j before anything is posted: no check-run, no sweep, no heal",
      async (event, headBranch) => {
        // The env carries no head repository, so the gate fetches the run
        // body; the LIVE listing is the case that keeps the throw.
        const fetchStub = makeFetch([
          token(),
          fetchedRun({ event, head_branch: headBranch }),
          pullsListing([pullEntry()]),
        ]);
        const error = await caughtError(
          runRelay({
            env: relayEnv({
              GITHUB_WORKFLOW_RUN_EVENT: event,
              GITHUB_WORKFLOW_RUN_HEAD_BRANCH: headBranch,
            }),
            fetchFn: fetchStub.fn,
            delayFn: makeDelay().fn,
            readPinMap: async () => PIN_MAP,
          }),
        );

        expect(error, "an untrusted pinned run must fail the relay visibly").toBeInstanceOf(Error);
        expect(error?.message).toContain(`run ${RUN_ID}`);
        expect(error?.message).toContain(`event ${JSON.stringify(event)}`);
        expect(error?.message).toContain(`head branch ${JSON.stringify(headBranch)}`);
        expect(error?.message).toContain("no required context was relayed");
        // Learn the head repository, then read liveness: three requests, nothing else.
        expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL, PULLS_URL]);
        expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(0);
      },
    );

    it("refuses a cancelled pinned pull_request run without attempting the heal", async () => {
      // The listing is served LIVE so the throw survives; the heal is unreachable.
      const fetchStub = makeFetch([
        token(),
        fetchedRun(),
        pullsListing([pullEntry()]),
      ]);
      const error = await caughtError(
        runRelay({
          env: cancelledPrEnv({ GITHUB_WORKFLOW_RUN_EVENT: "pull_request" }),
          fetchFn: fetchStub.fn,
          delayFn: makeDelay().fn,
          readPinMap: async () => PIN_MAP,
        }),
      );
      expect(error, "an untrusted pinned run must fail the relay visibly").toBeInstanceOf(Error);
      expect(error?.message).toContain("no required context was relayed");
      expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL, PULLS_URL]);
    });

    it("reads an absent GITHUB_WORKFLOW_RUN_HEAD_BRANCH as no branch, so a push run is refused", async () => {
      const env = relayEnv();
      delete env.GITHUB_WORKFLOW_RUN_HEAD_BRANCH;
      const fetchStub = makeFetch([token(), fetchedRun(), pullsListing([pullEntry()])]);
      const error = await caughtError(
        runRelay({
          env,
          fetchFn: fetchStub.fn,
          delayFn: makeDelay().fn,
          readPinMap: async () => PIN_MAP,
        }),
      );
      expect(error, "an untrusted pinned run must fail the relay visibly").toBeInstanceOf(Error);
      expect(error?.message).toContain('head branch ""');
      expect(error?.message).toContain("no required context was relayed");
      expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL, PULLS_URL]);
    });

    it("reads an absent GITHUB_WORKFLOW_RUN_EVENT as no event, so the pinned run is refused", async () => {
      // An event the relay was not told is not evidence of any event: the
      // missing value must read as the empty string, which no rule trusts.
      const env = relayEnv({ GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "main" });
      delete env.GITHUB_WORKFLOW_RUN_EVENT;
      const fetchStub = makeFetch([token(), fetchedRun(), pullsListing([pullEntry()])]);
      const error = await caughtError(
        runRelay({
          env,
          fetchFn: fetchStub.fn,
          delayFn: makeDelay().fn,
          readPinMap: async () => PIN_MAP,
        }),
      );
      expect(error, "an untrusted pinned run must fail the relay visibly").toBeInstanceOf(Error);
      expect(error?.message).toContain('event ""');
      expect(error?.message).toContain("no required context was relayed");
      expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(0);
      expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL, PULLS_URL]);
    });

    it("reads a fetched run with no event field as no event, so the pinned run is refused", async () => {
      const body = fetchedRunBody();
      delete body.event;
      const fetchStub = makeFetch([
        token(),
        { status: 200, body },
        pullsListing([pullEntry()]),
      ]);
      const error = await caughtError(
        runRelay({
          env: dispatchEnv(),
          fetchFn: fetchStub.fn,
          delayFn: makeDelay().fn,
          readPinMap: async () => PIN_MAP,
        }),
      );
      expect(error, "an untrusted pinned run must fail the relay visibly").toBeInstanceOf(Error);
      expect(error?.message).toContain('event ""');
      expect(error?.message).toContain("no required context was relayed");
      expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(0);
      expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL, PULLS_URL]);
    });

    it.each([
      ["pull_request", "main"],
      ["issue_comment", "feature/some-branch"],
      ["push", "feature/some-branch"],
    ])(
      "refuses through the dispatch path when the fetched run is %j on head branch %j",
      async (event, headBranch) => {
        // A LIVE listing is the case that keeps the throw (issue 1115).
        const fetchStub = makeFetch([
          token(),
          fetchedRun({ event, head_branch: headBranch }),
          pullsListing([pullEntry()]),
        ]);
        const error = await caughtError(
          runRelay({
            env: dispatchEnv(),
            fetchFn: fetchStub.fn,
            delayFn: makeDelay().fn,
            readPinMap: async () => PIN_MAP,
          }),
        );

        expect(error, "an untrusted pinned run must fail the relay visibly").toBeInstanceOf(Error);
        expect(error?.message).toContain(`run ${RUN_ID}`);
        expect(error?.message).toContain(`event ${JSON.stringify(event)}`);
        expect(error?.message).toContain(`head branch ${JSON.stringify(headBranch)}`);
        expect(error?.message).toContain("no required context was relayed");
        // The recovery needs the token to read the run; the refusal then reads
        // the head's liveness before throwing.
        expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL, PULLS_URL]);
      },
    );

    it.each([
      ["absent", {}],
      ["null", { head_branch: null }],
      ["not a string", { head_branch: 42 }],
    ])(
      "reads a fetched run whose head_branch is %s as no branch, so a push run is refused",
      async (_name, over) => {
        const body = fetchedRunBody();
        delete body.head_branch;
        const fetchStub = makeFetch([
          token(),
          { status: 200, body: { ...body, ...over } },
          pullsListing([pullEntry()]),
        ]);
        const error = await caughtError(
          runRelay({
            env: dispatchEnv(),
            fetchFn: fetchStub.fn,
            delayFn: makeDelay().fn,
            readPinMap: async () => PIN_MAP,
          }),
        );
        expect(error, "an untrusted pinned run must fail the relay visibly").toBeInstanceOf(Error);
        expect(error?.message).toContain('head branch ""');
        expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL, PULLS_URL]);
      },
    );

    it.each([
      ["pull_request_target", "feature/some-branch"],
      ["pull_request_target", "main"],
      ["push", "main"],
      ["workflow_dispatch", "main"],
      ["schedule", "main"],
    ])("still relays a pinned %j run on head branch %j", async (event, headBranch) => {
      const fetchStub = makeFetch([token(), ...acceptingOutcomes()]);
      const result = await runRelay({
        env: relayEnv({
          GITHUB_WORKFLOW_RUN_EVENT: event,
          GITHUB_WORKFLOW_RUN_HEAD_BRANCH: headBranch,
        }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });
      expect(result.posted).toEqual(["verify"]);
      expect(fetchStub.requests.map((request) => request.url)).toEqual([
        TOKEN_URL,
        JOBS_URL,
        CHECK_RUNS_URL,
        SWEEP_RUNS_URL,
      ]);
    });

    it("still relays a pull_request_target run through the dispatch path", async () => {
      const fetchStub = makeFetch([
        token(),
        fetchedRun({ event: "pull_request_target", head_branch: "feature/some-branch" }),
        ...acceptingOutcomes(),
      ]);
      const result = await runRelay({
        env: dispatchEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });
      expect(result.posted).toEqual(["verify"]);
      expect(fetchStub.requests.map((request) => request.url)).toEqual([
        TOKEN_URL,
        RUN_URL,
        JOBS_URL,
        CHECK_RUNS_URL,
        SWEEP_RUNS_URL,
      ]);
    });

    it("relays nothing and does not fail for an untrusted run of a workflow nothing is pinned to", async () => {
      // The refusal is about required contexts; a run that could not produce
      // one keeps the existing quiet no-op, on both trigger paths.
      const viaWorkflowRun = makeFetch([]);
      const result = await runRelay({
        env: relayEnv({
          GITHUB_WORKFLOW_RUN_PATH: PATH_ACTIONLINT,
          GITHUB_WORKFLOW_RUN_EVENT: "pull_request",
          GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "feature/some-branch",
        }),
        fetchFn: viaWorkflowRun.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => ({ verify: PATH_CI }),
      });
      expect(result.posted).toEqual([]);
      expect(viaWorkflowRun.requests).toHaveLength(0);

      const viaDispatch = makeFetch([
        token(),
        fetchedRun({ path: PATH_ACTIONLINT, event: "pull_request" }),
      ]);
      const recovered = await runRelay({
        env: dispatchEnv(),
        fetchFn: viaDispatch.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => ({ verify: PATH_CI }),
      });
      expect(recovered.posted).toEqual([]);
      expect(viaDispatch.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL]);
    });
  });

  // --- A context pinned to two workflow paths (issue 1090) ---

  describe("a context pinned to two workflow paths", () => {
    it("relays the context for a run of EITHER path", async () => {
      for (const runPath of [PATH_CI, PATH_CI_PR]) {
        const fetchStub = makeFetch([
          token(),
          jobsListing([job({})]),
          { status: 201, body: { id: 1 } },
          noSweepRuns(),
        ]);
        const result = await runRelay({
          env: relayEnv({ GITHUB_WORKFLOW_RUN_PATH: runPath }),
          fetchFn: fetchStub.fn,
          delayFn: makeDelay().fn,
          readPinMap: async () => TWO_PATH_PIN_MAP,
        });

        expect(result.posted, runPath).toEqual(["verify"]);
        expect(fetchStub.requests.map((request) => request.url), runPath).toEqual([
          TOKEN_URL,
          JOBS_URL,
          CHECK_RUNS_URL,
          SWEEP_RUNS_URL,
        ]);
        const [body] = bodiesOf(fetchStub.requests);
        expect(body?.name, runPath).toBe("verify");
        expect(body?.head_sha, runPath).toBe(HEAD_SHA);
      }
    });

    it("keeps the trusted-producer refusal for a run of the SECOND path", async () => {
      // The narrowness pin, and the reason it is written against the SECOND
      // path rather than the first. Widening the pin map is a change to WHICH
      // runs relay a context; it must not become a change to WHICH runs may.
      // Before this map existed, a pull_request run could never even reach the
      // predicate — contextsFor matched nothing, so the relay returned quietly.
      // Now that the second path matches, the predicate is the only thing
      // between a run that executed a definition a pull request could shape
      // and an App-owned check-run branch protection would merge on.
      // LIVE listing: a live head keeps the throw (issue 1115).
      const fetchStub = makeFetch([token(), fetchedRun(), pullsListing([pullEntry()])]);
      const error = await caughtError(
        runRelay({
          env: relayEnv({
            GITHUB_WORKFLOW_RUN_PATH: PATH_CI_PR,
            GITHUB_WORKFLOW_RUN_EVENT: "pull_request",
            GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "feature/some-branch",
          }),
          fetchFn: fetchStub.fn,
          delayFn: makeDelay().fn,
          readPinMap: async () => TWO_PATH_PIN_MAP,
        }),
      );

      expect(error, "an untrusted run of a second pinned path must fail the relay visibly").toBeInstanceOf(
        Error,
      );
      expect(error?.message).toContain(`run ${RUN_ID}`);
      expect(error?.message).toContain('event "pull_request"');
      expect(error?.message).toContain('head branch "feature/some-branch"');
      expect(error?.message).toContain("no required context was relayed");
      // Learn the head repository, then read liveness before throwing.
      expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL, PULLS_URL]);
      expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(0);
    });

    it("still refuses an untrusted run of a path TWO contexts are pinned to", async () => {
      // The same wiring, reached the other way: not a second path but a second
      // context. A relay that grew to skip its trusted-producer check for a
      // run resolving "more than one" context would be skipped here, and this
      // repository has two contexts naming one path today.
      // LIVE listing: a live head keeps the throw (issue 1115).
      const fetchStub = makeFetch([token(), fetchedRun(), pullsListing([pullEntry()])]);
      const error = await caughtError(
        runRelay({
          env: relayEnv({
            GITHUB_WORKFLOW_RUN_PATH: PATH_CI,
            GITHUB_WORKFLOW_RUN_EVENT: "pull_request",
            GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "feature/some-branch",
          }),
          fetchFn: fetchStub.fn,
          delayFn: makeDelay().fn,
          readPinMap: async () => ({ verify: [PATH_CI, PATH_CI_PR], "ratchet-guard": PATH_CI }),
        }),
      );

      expect(
        requestsTo(fetchStub.requests, CHECK_RUNS_URL),
        "the trusted-producer check must precede any posting, however many contexts the path resolves",
      ).toHaveLength(0);
      expect(error?.message).toContain("no required context was relayed");
      expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL, PULLS_URL]);
    });

    it("still relays nothing for a path neither pin names", async () => {
      const fetchStub = makeFetch([]);
      const result = await runRelay({
        env: relayEnv({
          GITHUB_WORKFLOW_RUN_PATH: PATH_ACTIONLINT,
          GITHUB_WORKFLOW_RUN_EVENT: "pull_request",
          GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "feature/some-branch",
        }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => TWO_PATH_PIN_MAP,
      });

      expect(result.posted).toEqual([]);
      expect(fetchStub.requests).toHaveLength(0);
    });

    it("validates the map before it decides, so an unusable list pin never mints a token", async () => {
      const fetchStub = makeFetch([]);
      const error = await caughtError(
        runRelay({
          env: relayEnv(),
          fetchFn: fetchStub.fn,
          delayFn: makeDelay().fn,
          readPinMap: async () => ({ verify: [] }),
        }),
      );

      expect(error).toBeInstanceOf(Error);
      expect(error?.message).toContain(".github/required-checks.json");
      expect(error?.message).toContain("verify");
      expect(fetchStub.requests).toHaveLength(0);
    });
  });

  // --- The rerun-heal (issue 861) ---

  const PULLS_URL = `https://api.github.com/repos/Nitjsefnie/Overflow/commits/${HEAD_SHA}/pulls?per_page=100`;
  const RUNS_AT_HEAD_URL = `https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs?head_sha=${HEAD_SHA}&per_page=100`;
  const RERUN_URL = `https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs/${RUN_ID}/rerun`;

  function pullEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { state: "open", head: { sha: HEAD_SHA }, ...over };
  }

  function pullsListing(pulls: Array<Record<string, unknown>>): Outcome {
    return { status: 200, body: pulls };
  }

  function runEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
    return { path: PATH_CI, status: "queued", conclusion: null, ...over };
  }

  function runsListing(runs: Array<Record<string, unknown>>): Outcome {
    return { status: 200, body: { total_count: runs.length, workflow_runs: runs } };
  }

  function cancelledPrEnv(over: Record<string, string> = {}): Record<string, string> {
    return relayEnv({
      GITHUB_WORKFLOW_RUN_CONCLUSION: "cancelled",
      GITHUB_WORKFLOW_RUN_EVENT: "pull_request_target",
      GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "feature/some-branch",
      GITHUB_WORKFLOW_RUN_ATTEMPT: "1",
      RELAY_RERUN_TOKEN: "rerun-token",
      ...over,
    });
  }

  function requestTo(requests: Recorded[], url: string): Recorded | undefined {
    return requests.find((request) => request.url === url);
  }

  function requestsTo(requests: Recorded[], url: string): Recorded[] {
    return requests.filter((request) => request.url === url);
  }

  function authHeaderOf(request: Recorded | undefined): string {
    if (request === undefined) return "";
    const headers = request.init.headers as Record<string, string>;
    return String(headers.authorization ?? "");
  }

  describe("rerun-heal", () => {
    it("heals a cancelled pending PR run: posts the mirror as today, then issues the rerun POST under the workflow token", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        noSweepRuns(),
        pullsListing([pullEntry()]),
        runsListing([runEntry({ path: PATH_ACTIONLINT, status: "in_progress" })]),
        { status: 202, body: undefined },
      ]);
      const result = await runRelay({
        env: cancelledPrEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.posted).toEqual(["verify"]);
      expect(result.rerunDispatched).toBe(true);

      // The rerun: exactly one POST to the rerun endpoint, authenticated by
      // the workflow token — never the App token.
      const rerun = requestTo(fetchStub.requests, RERUN_URL);
      expect(rerun?.init.method).toBe("POST");
      expect(authHeaderOf(rerun)).toBe("Bearer rerun-token");

      // The mirror: the no-jobs branch still mirrors failure, exactly as
      // today, under the App installation token.
      const [checkRun] = bodiesOf(fetchStub.requests);
      expect(checkRun).toMatchObject({
        name: "verify",
        status: "completed",
        conclusion: "failure",
        head_sha: HEAD_SHA,
      });
      expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(1);
      expect(authHeaderOf(requestTo(fetchStub.requests, CHECK_RUNS_URL))).toBe(
        "Bearer installation-token",
      );

      // The heal queries themselves carry the App installation token.
      expect(authHeaderOf(requestTo(fetchStub.requests, PULLS_URL))).toBe(
        "Bearer installation-token",
      );
      expect(authHeaderOf(requestTo(fetchStub.requests, RUNS_AT_HEAD_URL))).toBe(
        "Bearer installation-token",
      );
    });

    it("does not heal at a superseded head and stops the heal queries there", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        noSweepRuns(),
        pullsListing([{ state: "open", head: { sha: "d".repeat(40) } }]),
      ]);
      const result = await runRelay({
        env: cancelledPrEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.rerunDispatched).toBe(false);
      // The mirror is unchanged: failure, exactly as today.
      const [checkRun] = bodiesOf(fetchStub.requests);
      expect(checkRun).toMatchObject({ name: "verify", conclusion: "failure" });
      // The guards are evaluated in order: condition (d) failed, so the
      // live-run listing behind condition (e) is never fetched.
      expect(fetchStub.requests.map((request) => request.url)).toEqual([
        TOKEN_URL,
        JOBS_URL,
        CHECK_RUNS_URL,
        SWEEP_RUNS_URL,
        PULLS_URL,
      ]);
    });

    it("does not heal when a live run of the same workflow is already at the head", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        noSweepRuns(),
        pullsListing([pullEntry()]),
        runsListing([
          runEntry({ path: PATH_ACTIONLINT, status: "in_progress" }),
          runEntry({ path: PATH_CI, status: "completed" }),
          runEntry({ path: PATH_CI, status: "queued" }),
        ]),
      ]);
      const result = await runRelay({
        env: cancelledPrEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.rerunDispatched).toBe(false);
      expect(requestTo(fetchStub.requests, RERUN_URL)).toBeUndefined();
      // The mirror is unchanged: failure, exactly as today.
      const [checkRun] = bodiesOf(fetchStub.requests);
      expect(checkRun).toMatchObject({ name: "verify", conclusion: "failure" });
    });

    // Issue 952: a cancelled attempt whose successor sat at `pending` got a
    // rerun POST GitHub refused with 403 "This workflow is already running",
    // and the relay run went red. Every status GitHub's workflow-run `status`
    // enum can report while the run is live is pinned here, not just the two
    // the queued/in_progress-only check knew about.
    for (const liveStatus of ["queued", "in_progress", "pending", "waiting", "requested"]) {
      it(`does not heal, and does not fail, when a newer attempt of the same workflow at the head is ${liveStatus}`, async () => {
        const fetchStub = makeFetch([
          token(),
          jobsListing([]),
          { status: 201, body: { id: 1 } },
          noSweepRuns(),
          pullsListing([pullEntry()]),
          runsListing([
            runEntry({ path: PATH_CI, status: "completed", run_attempt: 4 }),
            runEntry({ path: PATH_CI, status: liveStatus, run_attempt: 5 }),
          ]),
          // The observed refusal, for the direction where the heal fires into a
          // live run. Once the guard counts every live status this outcome is
          // never reached: the POST is not issued at all.
          { status: 403, body: { message: "This workflow is already running" } },
        ]);
        const result = await runRelay({
          env: cancelledPrEnv(),
          fetchFn: fetchStub.fn,
          delayFn: makeDelay().fn,
          readPinMap: async () => PIN_MAP,
        });

        // The listing was consulted, so the verdicts below are not vacuous.
        expect(requestTo(fetchStub.requests, RUNS_AT_HEAD_URL)).toBeDefined();
        expect(result.rerunDispatched).toBe(false);
        expect(requestTo(fetchStub.requests, RERUN_URL)).toBeUndefined();
        // The mirror is unchanged: failure, exactly as today — the relay run
        // neither heals nor goes red.
        expect(result.posted).toEqual(["verify"]);
      });
    }

    // Negative space for the allowlist above. The triggering run's OWN entry
    // sits in this listing with status `completed`, so `completed` must not
    // read as live — folding it into LIVE_RUN_STATUSES would silently
    // disable the whole rerun-heal, and no other fixture in this file carries
    // a completed same-path entry without also carrying a live one.
    it("still heals when the only same-workflow run at the head is completed", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        noSweepRuns(),
        pullsListing([pullEntry()]),
        runsListing([runEntry({ path: PATH_CI, status: "completed", run_attempt: 1 })]),
        { status: 202, body: undefined },
      ]);
      const result = await runRelay({
        env: cancelledPrEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(requestTo(fetchStub.requests, RUNS_AT_HEAD_URL)).toBeDefined();
      expect(result.rerunDispatched).toBe(true);
      expect(requestsTo(fetchStub.requests, RERUN_URL)).toHaveLength(1);
    });

    it("rejects loudly, before any heal query, when RELAY_RERUN_TOKEN is missing on a cancelled PR run", async () => {
      const fetchStub = makeFetch([token(), jobsListing([]), { status: 201, body: { id: 1 } }, noSweepRuns()]);
      await expect(
        runRelay({
          env: relayEnv({
            GITHUB_WORKFLOW_RUN_CONCLUSION: "cancelled",
            GITHUB_WORKFLOW_RUN_EVENT: "pull_request_target",
            GITHUB_WORKFLOW_RUN_ATTEMPT: "1",
          }),
          fetchFn: fetchStub.fn,
          delayFn: makeDelay().fn,
          readPinMap: async () => PIN_MAP,
        }),
      ).rejects.toThrow(/RELAY_RERUN_TOKEN/);
      // The token is checked before any heal API call: no query for the PR
      // and none for the live-run listing.
      expect(requestTo(fetchStub.requests, PULLS_URL)).toBeUndefined();
      expect(requestTo(fetchStub.requests, RUNS_AT_HEAD_URL)).toBeUndefined();
    });

    it("hits the rerun endpoint exactly once and keeps App-token auth on the check-runs when several contexts are pinned", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        { status: 201, body: { id: 2 } },
      noSweepRuns(),
        pullsListing([pullEntry()]),
        runsListing([]),
        { status: 202, body: undefined },
      ]);
      const result = await runRelay({
        env: cancelledPrEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => ({
          verify: PATH_CI,
          actionlint: PATH_CI,
        }),
      });

      expect(result.posted).toEqual(["verify", "actionlint"]);
      expect(
        fetchStub.requests.filter((request) => request.url === RERUN_URL),
      ).toHaveLength(1);
      expect(authHeaderOf(requestTo(fetchStub.requests, RERUN_URL))).toBe("Bearer rerun-token");
      for (const posting of requestsTo(fetchStub.requests, CHECK_RUNS_URL)) {
        expect(authHeaderOf(posting)).toBe("Bearer installation-token");
      }
    });

    it("does not heal at the attempt cap and never queries the head", async () => {
      const fetchStub = makeFetch([token(), jobsListing([]), { status: 201, body: { id: 1 } }, noSweepRuns()]);
      const result = await runRelay({
        env: cancelledPrEnv({ GITHUB_WORKFLOW_RUN_ATTEMPT: "5" }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.rerunDispatched).toBe(false);
      // The attempt guard precedes the queries: no PR lookup, no run listing.
      expect(fetchStub.requests.map((request) => request.url)).toEqual([
        TOKEN_URL,
        JOBS_URL,
        CHECK_RUNS_URL,
        SWEEP_RUNS_URL,
      ]);
    });

    it("reads a missing or non-numeric attempt as 1 and heals", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        noSweepRuns(),
        pullsListing([pullEntry()]),
        runsListing([]),
        { status: 202, body: undefined },
      ]);
      const result = await runRelay({
        env: cancelledPrEnv({ GITHUB_WORKFLOW_RUN_ATTEMPT: "banana" }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });
      expect(result.rerunDispatched).toBe(true);
      expect(requestTo(fetchStub.requests, RERUN_URL)).toBeDefined();
    });

    it("never heals a cancelled push run", async () => {
      const fetchStub = makeFetch([token(), jobsListing([]), { status: 201, body: { id: 1 } }, noSweepRuns()]);
      const result = await runRelay({
        env: cancelledPrEnv({
          GITHUB_WORKFLOW_RUN_EVENT: "push",
          GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "main",
          GITHUB_WORKFLOW_RUN_ATTEMPT: "",
        }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.rerunDispatched).toBe(false);
      expect(requestTo(fetchStub.requests, RERUN_URL)).toBeUndefined();
      expect(fetchStub.requests.map((request) => request.url)).toEqual([
        TOKEN_URL,
        JOBS_URL,
        CHECK_RUNS_URL,
        SWEEP_RUNS_URL,
      ]);
    });

    it("still posts the mirrored decisions before rejecting when a heal query fails", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        noSweepRuns(),
        { fail: new TypeError("fetch failed") },
        { fail: new TypeError("fetch failed") },
        { fail: new TypeError("fetch failed") },
      ]);
      const delay = makeDelay();
      await expect(
        runRelay({
          env: cancelledPrEnv(),
          fetchFn: fetchStub.fn,
          delayFn: delay.fn,
          readPinMap: async () => PIN_MAP,
        }),
      ).rejects.toThrow(/pull requests associated/);

      // The mirror — the relay's primary duty — is already on GitHub when the
      // heal's PR lookup dies: the check-run POST preceded the rejection.
      const [checkRun] = bodiesOf(fetchStub.requests);
      expect(checkRun).toMatchObject({
        name: "verify",
        status: "completed",
        conclusion: "failure",
        head_sha: HEAD_SHA,
      });
      // No rerun was dispatched, and the heal's bounded retry was spent.
      expect(requestTo(fetchStub.requests, RERUN_URL)).toBeUndefined();
      expect(delay.delays).toEqual([1000, 2000]);
    });

    it("rejects when the PR listing is not an array", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        noSweepRuns(),
        { status: 200, body: { message: "not an array" } },
      ]);
      await expect(
        runRelay({
          env: cancelledPrEnv(),
          fetchFn: fetchStub.fn,
          delayFn: makeDelay().fn,
          readPinMap: async () => PIN_MAP,
        }),
      ).rejects.toThrow(/returned no array/);
      // The heal never reached a decision, so no rerun.
      expect(requestTo(fetchStub.requests, RERUN_URL)).toBeUndefined();
    });

    it("treats a non-array workflow-run listing as no live run and heals, bounded by the rerun endpoint's own guard", async () => {
      // Asymmetry, pinned as the code stands: findOpenPullRequestAtHead
      // THROWS on a non-array listing, while hasLiveRunOfPath reads one as
      // "no live run" and lets the heal proceed. The direction is bounded:
      // GitHub's rerun endpoint refuses a run that is still live — queued,
      // in_progress, pending, waiting or requested — with a 4xx, which
      // apiCall throws, so the worst case is a visible red relay job, never a
      // duplicate dispatch.
      const fetchStub = makeFetch([
        token(),
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        noSweepRuns(),
        pullsListing([pullEntry()]),
        { status: 200, body: { total_count: 1, workflow_runs: { not: "an array" } } },
        { status: 202, body: undefined },
      ]);
      const result = await runRelay({
        env: cancelledPrEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });
      expect(result.rerunDispatched).toBe(true);
      expect(authHeaderOf(requestTo(fetchStub.requests, RERUN_URL))).toBe("Bearer rerun-token");
    });

    it("heals through the dispatch path using the fetched run's run_attempt", async () => {
      const fetchStub = makeFetch([
        token(),
        {
          status: 200,
          body: {
            id: Number(RUN_ID),
            head_sha: HEAD_SHA,
            path: PATH_CI,
            conclusion: "cancelled",
            html_url: HTML_URL,
            event: "pull_request_target",
            head_branch: "feature/some-branch",
            run_attempt: 2,
          },
        },
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        noSweepRuns(),
        pullsListing([pullEntry()]),
        runsListing([]),
        { status: 202, body: undefined },
      ]);
      const result = await runRelay({
        env: relayEnv({
          GITHUB_WORKFLOW_RUN_ID: "",
          GITHUB_WORKFLOW_RUN_HEAD_SHA: "",
          GITHUB_WORKFLOW_RUN_PATH: "",
          GITHUB_WORKFLOW_RUN_CONCLUSION: "",
          GITHUB_WORKFLOW_RUN_HTML_URL: "",
          GITHUB_WORKFLOW_RUN_EVENT: "",
          LEDGER_DISPATCH_RUN_ID: RUN_ID,
          RELAY_RERUN_TOKEN: "rerun-token",
        }),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.rerunDispatched).toBe(true);
      const rerun = requestTo(fetchStub.requests, RERUN_URL);
      expect(rerun?.init.method).toBe("POST");
      expect(authHeaderOf(rerun)).toBe("Bearer rerun-token");
      expect(fetchStub.requests.map((request) => request.url)).toEqual([
        TOKEN_URL,
        RUN_URL,
        JOBS_URL,
        CHECK_RUNS_URL,
        SWEEP_RUNS_URL,
        PULLS_URL,
        RUNS_AT_HEAD_URL,
        RERUN_URL,
      ]);
    });
  });

  // --- Dead-head refusals (issue 1115) ---

  describe("dead-head refusals (issue 1115)", () => {
    const REFUSAL =
      `run ${RUN_ID} (event "pull_request", head branch "feature/some-branch") ` +
      "did not execute the base branch's workflow definition; no required context was relayed";

    /** The incident's shape: a stale pull_request run of a closed same-repo PR. */
    function untrustedWorkflowRunEnv(): Record<string, string> {
      return relayEnv({
        GITHUB_WORKFLOW_RUN_EVENT: "pull_request",
        GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "feature/some-branch",
      });
    }

    /** The dispatch-path run body for the same refused run. */
    function untrustedFetchedRun(over: Record<string, unknown> = {}): Outcome {
      return fetchedRun({
        event: "pull_request",
        head_branch: "feature/some-branch",
        ...over,
      });
    }

    /** The refused run through this describe's one env and fetch shape. */
    function relay(env: Record<string, string>, stub: ReturnType<typeof makeFetch>): ReturnType<typeof runRelay> {
      return runRelay({ env, fetchFn: stub.fn, delayFn: makeDelay().fn, readPinMap: async () => PIN_MAP });
    }

    it("exits 0 through the workflow_run path when the refused run's head is dead, relaying nothing", async () => {
      // The incident (issue 1115): a stale pull_request run of a closed
      // same-repo PR, refused on the workflow_run path; a definitively empty
      // liveness listing downgrades the refusal to the exit-0 no-op.
      const fetchStub = makeFetch([
        token(),
        fetchedRun({ event: "pull_request", head_branch: "feature/some-branch" }),
        pullsListing([]),
      ]);
      const result = await relay(untrustedWorkflowRunEnv(), fetchStub);

      expect(result.posted).toEqual([]);
      expect(result.decisions).toEqual([]);
      expect(result.rerunDispatched).toBe(false);
      expect(result.sweep.examined).toBe(0);
      expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL, PULLS_URL]);
      expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(0);
      expect(renderRelayResult(result)).toEqual([
        `[ledger-relay] ${REFUSAL}`,
        "[ledger-relay] no open pull request is waiting at this head",
      ]);
    });

    it("exits 0 through the dispatch path when the fetched run's head repository is this repository and the head is dead", async () => {
      const fetchStub = makeFetch([
        token(),
        untrustedFetchedRun({ head_repository: { full_name: "Nitjsefnie/Overflow" } }),
        pullsListing([]),
      ]);
      const result = await relay(dispatchEnv(), fetchStub);

      expect(result.posted).toEqual([]);
      expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL, PULLS_URL]);
      expect(renderRelayResult(result)).toEqual([
        `[ledger-relay] ${REFUSAL}`,
        "[ledger-relay] no open pull request is waiting at this head",
      ]);
    });

    it("keeps the byte-identical throw when the fetched body names no head repository, even with a dead listing", async () => {
      // The unknown limb fails closed: no name to compare, so the gate
      // re-fetches the run body; a name still missing keeps the throw.
      const body = fetchedRunBody({ event: "pull_request", head_branch: "feature/some-branch" });
      delete body.head_repository;
      const fetchStub = makeFetch([token(), { status: 200, body }, { status: 200, body }, pullsListing([])]);
      const error = await caughtError(relay(dispatchEnv(), fetchStub));

      expect(error, "a nameless head must keep the refusal visible").toBeInstanceOf(Error);
      expect(error?.message, "the message stays byte-identical").toBe(REFUSAL);
      // Re-fetched, still no name: the listing was never consulted.
      expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL, RUN_URL]);
      expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(0);
    });

    it("keeps the byte-identical throw when the refused head is live at an open pull request", async () => {
      const fetchStub = makeFetch([
        token(),
        untrustedFetchedRun({ head_repository: { full_name: "Nitjsefnie/Overflow" } }),
        pullsListing([pullEntry()]),
      ]);
      const error = await caughtError(relay(dispatchEnv(), fetchStub));

      expect(error, "a live head must keep the refusal visible").toBeInstanceOf(Error);
      expect(error?.message, "the message stays byte-identical").toBe(REFUSAL);
      expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL, PULLS_URL]);
      expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(0);
    });

    it("keeps the byte-identical throw for a fork head even when the liveness listing would say dead", async () => {
      // A known fork name throws before the listing is consulted: whether
      // commits/{sha}/pulls surfaces a fork PR's head is unverified.
      const fetchStub = makeFetch([
        token(),
        untrustedFetchedRun({ head_repository: { full_name: "someone-else/fork" } }),
        pullsListing([]),
      ]);
      const error = await caughtError(relay(dispatchEnv(), fetchStub));

      expect(error, "a fork head must keep the refusal visible").toBeInstanceOf(Error);
      expect(error?.message, "the message stays byte-identical").toBe(REFUSAL);
      // The listing was never consulted: the fork is decided from the run body.
      expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL]);
    });

    it("throws for a workflow_run fork head: the run body is fetched to learn the head repository, and the listing is never consulted", async () => {
      // PM-measured: a fork head's commit resolves in this repository
      // (the listing reads 200, count 0), so the gate fetches the run body
      // to learn the head repository and a fork name keeps the throw.
      const fetchStub = makeFetch([
        token(),
        fetchedRun({
          event: "pull_request",
          head_branch: "feature/some-branch",
          head_repository: { full_name: "someone-else/fork" },
        }),
        pullsListing([]),
      ]);
      const error = await caughtError(relay(untrustedWorkflowRunEnv(), fetchStub));

      expect(error, "a fork head must keep the refusal visible").toBeInstanceOf(Error);
      expect(error?.message, "the message stays byte-identical").toBe(REFUSAL);
      // Token mint and run fetch only: the listing was never consulted.
      expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL]);
      expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(0);
    });

    it.each([
      ["an API error", { status: 404, body: { message: "No Commit Found" } }, /pull requests associated with commit/],
      ["a non-array listing", { status: 200, body: { total_count: 0 } }, /returned no array/],
    ])("throws when the liveness read is %s, never exiting 0", async (_name, listing, expected) => {
      const fetchStub = makeFetch([
        token(),
        untrustedFetchedRun({ head_repository: { full_name: "Nitjsefnie/Overflow" } }),
        listing,
      ]);
      const error = await caughtError(relay(dispatchEnv(), fetchStub));

      expect(error, "an ambiguous liveness read must fail closed").toBeInstanceOf(Error);
      expect(error?.message).toMatch(expected);
      expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(0);
    });

    it("throws when the workflow_run path's liveness read fails after a same-repo head is confirmed", async () => {
      // Same-repo head confirmed from the fetched body; the listing decides.
      const fetchStub = makeFetch([
        token(),
        fetchedRun({ event: "pull_request", head_branch: "feature/some-branch" }),
        { status: 404, body: { message: "No Commit Found" } },
      ]);
      const error = await caughtError(relay(untrustedWorkflowRunEnv(), fetchStub));

      expect(error, "an unresolvable liveness read must fail closed").toBeInstanceOf(Error);
      expect(error?.message).toMatch(/pull requests associated with commit/);
      expect(fetchStub.requests.map((request) => request.url)).toEqual([TOKEN_URL, RUN_URL, PULLS_URL]);
    });
  });

  // --- The orphan sweep (issue 885) ---

  const SWEEP_RUNS_URL = "https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs?per_page=100";
  const CHECK_RUNS_AT_HEAD_URL = `https://api.github.com/repos/Nitjsefnie/Overflow/commits/${HEAD_SHA}/check-runs?app_id=5118623&filter=latest&per_page=100`;
  const APP_ID = "5118623";

  /**
   * A repository-wide listing entry. `id` is numeric exactly as the REST API
   * reports it, so the candidate filter has to compare it as a string.
   */
  function sweepRun(
    id: number,
    over: Record<string, unknown> = {},
  ): Record<string, unknown> {
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

  /** The runs listing the sweep reads: newest first, as the REST API returns it. */
  function sweepListing(runs: Array<Record<string, unknown>>): Outcome {
    return { status: 200, body: { total_count: runs.length, workflow_runs: runs } };
  }

  /** The App's own check-runs at a commit, as the filtered listing returns them. */
  function checkRunsListing(names: Array<string>): Outcome {
    return {
      status: 200,
      body: {
        total_count: names.length,
        check_runs: names.map((name) => ({ name, app: { id: Number(APP_ID) } })),
      },
    };
  }

  /** A listing that answers the runs sweep with nothing at all. */
  function noSweepRuns(): Outcome {
    return sweepListing([]);
  }

  describe("orphan sweep (issue 885)", () => {
    it("heals an orphan whose run is at a context's SECOND pinned path", async () => {
      // The sweep keeps its own pin map, so the second path has to reach it too
      // — not only the mirror's contextsFor. A split that leaves the sweep
      // blind to the new path does not break the mirror and does break the
      // orphan heal, silently: the candidate is filtered out as "a run nothing
      // is pinned to" and the completion stays unattested forever.
      const fetchStub = makeFetch([
        token(),
        jobsListing([job({})]),
        { status: 201, body: { id: 1 } },
        sweepListing([sweepRun(9001, { path: PATH_CI }), sweepRun(9002, { path: PATH_CI_PR })]),
        checkRunsListing([]),
        jobsListing([job({})]),
        { status: 201, body: { id: 2 } },
      ]);
      const result = await runRelay({
        env: relayEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => TWO_PATH_PIN_MAP,
      });

      expect(result.sweep.examined).toBe(1);
      expect(result.sweep.relayed).toEqual([{ context: "verify", runId: "9002" }]);
      expect(bodiesOf(fetchStub.requests)).toContainEqual(
        expect.objectContaining({ name: "verify", head_sha: HEAD_SHA }),
      );
    });

    it("relays the context whose own relay instance was cancelled, at the orphan's own head SHA", async () => {
      // Two producer runs complete within seconds of each other. GitHub keeps
      // one PENDING run per concurrency group and cancels the previous pending
      // run whatever `cancel-in-progress` says, so the relay instance triggered
      // by run 9002 is destroyed before it posts anything — and 9002's
      // completion is orphaned forever: no App check-run for it exists, and
      // branch protection refuses the merge with a message that reads as a
      // misconfiguration. This is the case the sweep exists for.
      const fetchStub = makeFetch([
        token(),
        jobsListing([job({ run_attempt: 3 })]),
        { status: 201, body: { id: 1 } },
        // The sweep: the repository-wide listing, holding both completions.
        sweepListing([
          sweepRun(9001, { path: PATH_CI }),
          sweepRun(9002, { path: PATH_ACTIONLINT }),
        ]),
        // At HEAD_SHA the App holds only verify — nothing ever attested
        // actionlint, because the relay instance that would have posted it was
        // cancelled while pending.
        checkRunsListing(["verify"]),
        jobsListing([job({ name: "actionlint" })]),
        { status: 201, body: { id: 2 } },
      ]);
      const result = await runRelay({
        env: relayEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      // The mirror is untouched: the triggering run still posts exactly its own
      // context, under its own head SHA.
      expect(result.posted).toEqual(["verify"]);

      // The orphan is healed. This assertion is placed before the outcome
      // assertion on purpose: with no sweep in place, `result.sweep` does not
      // exist at all, and a TypeError reading it would reproduce "the sweep is
      // missing" rather than the defect this issue filed — that no App
      // check-run exists for the orphaned completion, which branch protection
      // reads as "was not set by the expected GitHub app".
      expect(
        bodiesOf(fetchStub.requests),
        "the orphaned completion 9002 must get its own actionlint check-run at its own head SHA",
      ).toContainEqual(
        expect.objectContaining({ name: "actionlint", head_sha: HEAD_SHA }),
      );
      expect(result.sweep.relayed).toEqual([{ context: "actionlint", runId: "9002" }]);
    });

    it("leaves a normal single-completion relay unchanged and reads no check-runs", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([job({})]),
        { status: 201, body: { id: 1 } },
        noSweepRuns(),
      ]);
      const result = await runRelay({
        env: relayEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.posted).toEqual(["verify"]);
      expect(result.sweep).toEqual({ examined: 0, relayed: [] });
      // Nothing to dedupe against: with no candidate at all the sweep issues no
      // check-runs GET, so the mirror's own request set grows by exactly one.
      expect(fetchStub.requests.map((request) => request.url)).toEqual([
        TOKEN_URL,
        JOBS_URL,
        CHECK_RUNS_URL,
        SWEEP_RUNS_URL,
      ]);
    });

    it("authenticates every sweep call as the App, the same as the mirror's", async () => {
      // The sweep's HTTP is assembled by sweepApi() in scripts/ledger-relay.ts,
      // and the sweep's own unit tests cannot see it: they inject their own
      // SweepApi from a URL map, so the headers the production constructor
      // puts on the wire were unasserted — dropping `...auth` from that
      // constructor left every test green and would send each sweep read and
      // write unauthenticated. This is the runRelay-level seam where the real
      // constructor is in play, and it is where the neighbour the rerun-heal
      // already pins (RUNS_AT_HEAD_URL) is pinned too.
      const fetchStub = makeFetch([
        token(),
        jobsListing([job({})]),
        { status: 201, body: { id: 1 } },
        sweepListing([sweepRun(9002, { path: PATH_ACTIONLINT })]),
        checkRunsListing([]),
        jobsListing([job({ name: "actionlint" })]),
        { status: 201, body: { id: 2 } },
      ]);
      const result = await runRelay({
        env: relayEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.sweep.relayed).toEqual([{ context: "actionlint", runId: "9002" }]);
      expect(authHeaderOf(requestTo(fetchStub.requests, SWEEP_RUNS_URL))).toBe(
        "Bearer installation-token",
      );
      // The sweep's own POST, read off the request that followed it rather than
      // off CHECK_RUNS_URL, which the mirror also posts to.
      expect(authHeaderOf(requestsTo(fetchStub.requests, CHECK_RUNS_URL)[1])).toBe(
        "Bearer installation-token",
      );
    });

    it("does not repost a context the App already attested at that head", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([job({})]),
        { status: 201, body: { id: 1 } },
        sweepListing([
          sweepRun(9001, { path: PATH_CI }),
          sweepRun(9002, { path: PATH_ACTIONLINT }),
        ]),
        checkRunsListing(["verify", "actionlint"]),
      ]);
      const result = await runRelay({
        env: relayEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.sweep.examined).toBe(1);
      expect(result.sweep.relayed).toEqual([]);
      // The candidate is examined but skipped entirely: no jobs GET, no POST.
      expect(fetchStub.requests.map((request) => request.url)).toEqual([
        TOKEN_URL,
        JOBS_URL,
        CHECK_RUNS_URL,
        SWEEP_RUNS_URL,
        CHECK_RUNS_AT_HEAD_URL,
      ]);
      expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(1);
    });

    it("reads the App's check-runs once per distinct head SHA however many candidates sit at it", async () => {
      const otherSha = "e".repeat(40);
      const fetchStub = makeFetch([
        token(),
        jobsListing([job({})]),
        { status: 201, body: { id: 1 } },
        // Four candidates over two head SHAs.
        sweepListing([
          sweepRun(9002, { path: PATH_ACTIONLINT }),
          sweepRun(9003, { path: PATH_ACTIONLINT }),
          sweepRun(9004, { path: PATH_ACTIONLINT, head_sha: otherSha }),
          sweepRun(9005, { path: PATH_ACTIONLINT, head_sha: otherSha }),
        ]),
        checkRunsListing([]),
        jobsListing([job({ name: "actionlint" })]),
        { status: 201, body: { id: 2 } },
        // The first candidate at HEAD_SHA already relayed actionlint there, so
        // the second is skipped without a second jobs GET.
        { status: 200, body: { total_count: 0, check_runs: [] } },
        jobsListing([job({ name: "actionlint" })]),
        { status: 201, body: { id: 3 } },
      ]);
      const result = await runRelay({
        env: relayEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.sweep.examined).toBe(4);
      // Two posts: one per head SHA, not one per candidate. The second
      // candidate at each SHA finds its context already relayed by the first.
      expect(result.sweep.relayed).toEqual([
        { context: "actionlint", runId: "9002" },
        { context: "actionlint", runId: "9004" },
      ]);
      expect(requestsTo(fetchStub.requests, CHECK_RUNS_AT_HEAD_URL)).toHaveLength(1);
      expect(
        requestsTo(
          fetchStub.requests,
          `https://api.github.com/repos/Nitjsefnie/Overflow/commits/${otherSha}/check-runs?app_id=${APP_ID}&filter=latest&per_page=100`,
        ),
      ).toHaveLength(1);
    });

    it("never sweeps a run nothing is pinned to, a run that has not completed, or the triggering run itself", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([job({})]),
        { status: 201, body: { id: 1 } },
        sweepListing([
          // The triggering run's own id, as a completed pinned run.
          sweepRun(9001, { path: PATH_CI }),
          // Pinned to nothing.
          sweepRun(9002, { path: ".github/workflows/dependency-audit.yml" }),
          // Pinned, but still running.
          sweepRun(9003, { path: PATH_ACTIONLINT, status: "in_progress" }),
          // Pinned, completed, but with no head SHA and no html_url: nothing
          // could be posted for it.
          sweepRun(9004, { path: PATH_ACTIONLINT, head_sha: "", html_url: "" }),
          sweepRun(9005, { path: PATH_ACTIONLINT }),
        ]),
        checkRunsListing(["actionlint"]),
      ]);
      const result = await runRelay({
        env: relayEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.sweep.examined).toBe(1);
      expect(result.sweep.relayed).toEqual([]);
      expect(fetchStub.requests.map((request) => request.url)).toEqual([
        TOKEN_URL,
        JOBS_URL,
        CHECK_RUNS_URL,
        SWEEP_RUNS_URL,
        CHECK_RUNS_AT_HEAD_URL,
      ]);
    });

    it("never sweeps a run whose executed definition was not the base branch's", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([job({})]),
        { status: 201, body: { id: 1 } },
        sweepListing([
          sweepRun(9002, { path: PATH_ACTIONLINT, event: "pull_request", head_branch: "main" }),
          sweepRun(9003, { path: PATH_ACTIONLINT, event: "issue_comment" }),
          sweepRun(9004, { path: PATH_ACTIONLINT, event: "push", head_branch: "feature/some-branch" }),
          sweepRun(9005, { path: PATH_ACTIONLINT, event: undefined, head_branch: undefined }),
        ]),
        // What a sweep that wrongly selected any of them would ask for next.
        checkRunsListing([]),
        jobsListing([job({ name: "actionlint" })]),
        { status: 201, body: { id: 2 } },
      ]);
      const result = await runRelay({
        env: relayEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(result.sweep).toEqual({ examined: 0, relayed: [] });
      expect(fetchStub.requests.map((request) => request.url)).toEqual([
        TOKEN_URL,
        JOBS_URL,
        CHECK_RUNS_URL,
        SWEEP_RUNS_URL,
      ]);
    });

    it("caps the sweep at SWEEP_RUN_LIMIT candidates however many the listing holds", async () => {
      const many = Array.from({ length: SWEEP_RUN_LIMIT + 7 }, (_unused, index) =>
        sweepRun(9000 + index, {
          path: PATH_ACTIONLINT,
          head_sha: index.toString(16).padStart(40, "0"),
        }),
      );
      const outcomes: Outcome[] = [
        token(),
        jobsListing([job({})]),
        { status: 201, body: { id: 1 } },
        sweepListing(many),
      ];
      // Every distinct head SHA is read once, and the cap bounds the rest.
      for (let index = 0; index < SWEEP_RUN_LIMIT; index += 1) {
        outcomes.push(checkRunsListing([]), jobsListing([job({ name: "actionlint" })]));
        outcomes.push({ status: 201, body: { id: 100 + index } });
      }
      const fetchStub = makeFetch(outcomes);
      const result = await runRelay({
        env: relayEnv(),
        fetchFn: fetchStub.fn,
        delayFn: makeDelay().fn,
        readPinMap: async () => PIN_MAP,
      });

      expect(SWEEP_RUN_LIMIT).toBe(20);
      expect(result.sweep.examined).toBe(SWEEP_RUN_LIMIT);
      // Exactly the capped candidates, and one post each.
      expect(result.sweep.relayed).toHaveLength(SWEEP_RUN_LIMIT);
      expect(requestsTo(fetchStub.requests, CHECK_RUNS_URL)).toHaveLength(
        SWEEP_RUN_LIMIT + 1,
      );
    });

    it("is visible when it dies, and never costs the mirror its posting", async () => {
      const fetchStub = makeFetch([
        token(),
        jobsListing([job({})]),
        { status: 201, body: { id: 1 } },
        { status: 500, body: { message: "boom" } },
        { status: 500, body: { message: "boom" } },
        { status: 500, body: { message: "boom" } },
      ]);
      const delay = makeDelay();
      await expect(
        runRelay({
          env: relayEnv(),
          fetchFn: fetchStub.fn,
          delayFn: delay.fn,
          readPinMap: async () => PIN_MAP,
        }),
      ).rejects.toThrow(/workflow-run listing/);

      // The mirror — the relay's primary duty — is already on GitHub when the
      // sweep dies: its check-run POST preceded the rejection.
      expect(bodiesOf(fetchStub.requests)).toContainEqual(
        expect.objectContaining({ name: "verify", head_sha: HEAD_SHA }),
      );
      expect(delay.delays).toEqual([1000, 2000]);
    });

    it("still runs the rerun-heal when the sweep dies, and still rejects", async () => {
      // The sweep and the heal are independent duties that both follow the
      // mirror. Awaiting the sweep before the heal made the heal hostage to a
      // much larger failure surface: every relay start issues a repository-wide
      // listing plus up to SWEEP_RUN_LIMIT check-runs GETs, where the heal
      // issues at most three queries on a rare path. So a dead sweep must cost
      // the heal nothing — and must still cost the job its nonzero exit, or a
      // sweep that quietly stopped running would be indistinguishable from a
      // relay with nothing to do, which is the failure this issue is about.
      const fetchStub = makeFetch([
        token(),
        jobsListing([]),
        { status: 201, body: { id: 1 } },
        // The sweep's runs listing exhausts its retry and throws…
        { status: 500, body: { message: "boom" } },
        { status: 500, body: { message: "boom" } },
        { status: 500, body: { message: "boom" } },
        // …and the heal's own queries still run afterwards.
        pullsListing([pullEntry()]),
        runsListing([]),
        { status: 202, body: undefined },
      ]);
      const delay = makeDelay();
      await expect(
        runRelay({
          env: cancelledPrEnv(),
          fetchFn: fetchStub.fn,
          delayFn: delay.fn,
          readPinMap: async () => PIN_MAP,
        }),
      ).rejects.toThrow(/workflow-run listing/);

      // The heal ran, and it dispatched the rerun.
      expect(requestTo(fetchStub.requests, PULLS_URL)).toBeDefined();
      expect(requestTo(fetchStub.requests, RERUN_URL)).toBeDefined();
      expect(authHeaderOf(requestTo(fetchStub.requests, RERUN_URL))).toBe("Bearer rerun-token");
      // The sweep ran exactly once, so it spent its own bounded retry and no
      // more: three 500s, and the heal added none.
      expect(delay.delays).toEqual([1000, 2000]);
    });
  });

});
