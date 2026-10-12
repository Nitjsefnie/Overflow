import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it, vi } from "vitest";

import {
  decideContexts,
  pinsFor,
  runRelay,
  validatePinMap,
  type PinMap,
  type RelayJob,
} from "../../scripts/ledger-relay.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const PATH_DEP_AUDIT = ".github/workflows/dependency-audit.yml";
const PATH_DEP_AUDIT_PR = ".github/workflows/pr-gates.yml";
/** The job name both producer files ship, and the required context itself. */
const CONTEXT = "dependency-audit";

function job(over: Partial<RelayJob>): RelayJob {
  return {
    name: CONTEXT,
    run_attempt: 1,
    status: "completed",
    conclusion: "success",
    ...over,
  };
}

const PR_CONTEXTS = ["actionlint", "ratchet-guard", "secret-scan", "dependency-audit"];

/** A real aggregate run reports all four jobs, with only this gate failing. */
function producerJobs(path: string): RelayJob[] {
  const contexts = path === PATH_DEP_AUDIT_PR ? PR_CONTEXTS : [CONTEXT];
  return contexts.map((name) => job({ name, conclusion: name === CONTEXT ? "failure" : "success" }));
}

let committed: PinMap;

beforeAll(async () => {
  committed = validatePinMap(
    JSON.parse(await readFile(resolve(ROOT, ".github/required-checks.json"), "utf8")) as unknown,
  );
});

describe("the committed pin (issue 1149)", () => {
  it("names dependency-audit and only its two producer files", () => {
    expect(Object.keys(committed)).toContain(CONTEXT);
    expect([...pinsFor(committed[CONTEXT]!)].sort()).toEqual(
      [PATH_DEP_AUDIT, PATH_DEP_AUDIT_PR].sort(),
    );
  });
});

describe("a red audit relays as a failing ledger check-run (issue 1149)", () => {

  it.each([PATH_DEP_AUDIT, PATH_DEP_AUDIT_PR])(
    "maps a failing dependency-audit job to a completed/failure decision for a run of %s",
    (runPath) => {
      const decisions = decideContexts(committed, runPath, "failure", producerJobs(runPath));
      expect(decisions.map((decision) => decision.context)).toEqual(
        runPath === PATH_DEP_AUDIT_PR ? PR_CONTEXTS : [CONTEXT],
      );
      expect(decisions.filter((decision) => decision.context === CONTEXT)).toEqual([
        {
          context: CONTEXT,
          status: "completed",
          conclusion: "failure",
          title: expect.any(String),
          summary: expect.any(String),
        },
      ]);
    },
  );
});

describe("the committed pin drives runRelay end to end (issue 1149)", () => {
  const HEAD_SHA = "a".repeat(40);
  const RUN_ID = "1149";
  const HTML_URL = `https://github.com/Nitjsefnie/Overflow/actions/runs/${RUN_ID}`;
  const TOKEN_URL = "https://api.github.com/app/installations/166057493/access_tokens";
  const JOBS_URL = `https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs/${RUN_ID}/jobs?filter=latest&per_page=100`;
  const CHECK_RUNS_URL = "https://api.github.com/repos/Nitjsefnie/Overflow/check-runs";
  const SWEEP_RUNS_URL = "https://api.github.com/repos/Nitjsefnie/Overflow/actions/runs?per_page=100";

  // The relay signs the App JWT with this key before any network call, so the
  // env fixture has to carry a structurally valid PEM; mintAppJwt throws on a
  // placeholder string.
  let keyPem = "";
  beforeAll(() => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    keyPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  });

  interface Recorded {
    url: string;
    init: RequestInit;
  }
  type Outcome = { status: number; body: unknown };

  function makeFetch(outcomes: Outcome[]) {
    const requests: Recorded[] = [];
    const fn = vi.fn(async (url: unknown, init?: RequestInit) => {
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

  function relayEnv(over: Record<string, string>): Record<string, string> {
    return {
      LEDGER_APP_ID: "5118623",
      LEDGER_INSTALLATION_ID: "166057493",
      LEDGER_APP_KEY: keyPem,
      GITHUB_REPOSITORY: "Nitjsefnie/Overflow",
      GITHUB_WORKFLOW_RUN_ID: RUN_ID,
      GITHUB_WORKFLOW_RUN_HEAD_SHA: HEAD_SHA,
      GITHUB_WORKFLOW_RUN_CONCLUSION: "failure",
      GITHUB_WORKFLOW_RUN_HTML_URL: HTML_URL,
      ...over,
    };
  }

  it.each([
    [
      "the pull_request_target leg (pr-gates.yml)",
      {
        GITHUB_WORKFLOW_RUN_PATH: PATH_DEP_AUDIT_PR,
        GITHUB_WORKFLOW_RUN_EVENT: "pull_request_target",
        GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "feature/some-branch",
      },
    ],
    [
      "the push leg on main (dependency-audit.yml)",
      {
        GITHUB_WORKFLOW_RUN_PATH: PATH_DEP_AUDIT,
        GITHUB_WORKFLOW_RUN_EVENT: "push",
        GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "main",
      },
    ],
  ])("posts the failing dependency-audit check-run for a red run of %s", async (_name, over) => {
    const jobs = producerJobs(over.GITHUB_WORKFLOW_RUN_PATH);
    const contexts = over.GITHUB_WORKFLOW_RUN_PATH === PATH_DEP_AUDIT_PR ? PR_CONTEXTS : [CONTEXT];
    const fetchStub = makeFetch([
      { status: 201, body: { token: "installation-token" } },
      { status: 200, body: { total_count: jobs.length, jobs } },
      ...contexts.map((_, index) => ({ status: 201, body: { id: index + 1 } })),
      { status: 200, body: { total_count: 0, workflow_runs: [] } },
    ]);
    const result = await runRelay({
      env: relayEnv(over),
      fetchFn: fetchStub.fn,
      delayFn: async () => {},
      readPinMap: async () => committed,
    });

    expect(result.posted).toEqual(contexts);
    expect(fetchStub.requests.map((request) => request.url)).toEqual([
      TOKEN_URL,
      JOBS_URL,
      ...contexts.map(() => CHECK_RUNS_URL),
      SWEEP_RUNS_URL,
    ]);
    const checkRuns = fetchStub.requests.filter((request) => request.url === CHECK_RUNS_URL);
    expect(checkRuns.map((request) => JSON.parse(String(request.init.body)))).toEqual(
      contexts.map((context) => ({
        name: context,
        head_sha: HEAD_SHA,
        status: "completed",
        conclusion: context === CONTEXT ? "failure" : "success",
        details_url: HTML_URL,
        output: { title: expect.any(String), summary: expect.any(String) },
      })),
    );
  });

  it("refuses a red run of the push leg that did not execute main's definition", async () => {
    // isTrustedProducerRun gates every pinned path alike, the second leg
    // included: a push of dependency-audit.yml on a feature branch is not
    // main's definition. With the head provably dead (no open PR at it) the
    // refusal downgrades to the visible exit-0 no-op — nothing is posted.
    const fetchStub = makeFetch([
      { status: 201, body: { token: "installation-token" } },
      {
        status: 200,
        body: {
          id: Number(RUN_ID),
          head_sha: HEAD_SHA,
          path: PATH_DEP_AUDIT,
          conclusion: "failure",
          html_url: HTML_URL,
          event: "push",
          head_branch: "feature/some-branch",
          run_attempt: 1,
          head_repository: { full_name: "Nitjsefnie/Overflow" },
        },
      },
      { status: 200, body: [] },
    ]);
    const result = await runRelay({
      env: relayEnv({
        GITHUB_WORKFLOW_RUN_PATH: PATH_DEP_AUDIT,
        GITHUB_WORKFLOW_RUN_EVENT: "push",
        GITHUB_WORKFLOW_RUN_HEAD_BRANCH: "feature/some-branch",
      }),
      fetchFn: fetchStub.fn,
      delayFn: async () => {},
      readPinMap: async () => committed,
    });

    expect(result.posted).toEqual([]);
    expect(result.refusedDeadHead).toMatch(/did not execute the base branch's workflow/);
  });
});

describe("the conclusion mapping, independent of the committed map", () => {
  // The committed-map tests above die if the pin is ever removed; this block
  // keeps the relay's own mapping contract pinned even then. It runs on a
  // synthetic list pin of the same shape the committed entry uses.
  const SYNTHETIC: PinMap = { [CONTEXT]: [PATH_DEP_AUDIT, PATH_DEP_AUDIT_PR] };

  it.each(["success", "failure", "cancelled", "skipped"])(
    "mirrors a completed dependency-audit job's %s conclusion",
    (conclusion) => {
      const decisions = decideContexts(SYNTHETIC, PATH_DEP_AUDIT_PR, "success", [
        job({ conclusion }),
      ]);
      expect(decisions).toEqual([
        {
          context: CONTEXT,
          status: "completed",
          conclusion,
          title: expect.any(String),
          summary: expect.any(String),
        },
      ]);
    },
  );

  it.each(["queued", "in_progress"] as const)(
    "posts the pending %s status without a conclusion while the audit runs",
    (pendingStatus) => {
      const decisions = decideContexts(SYNTHETIC, PATH_DEP_AUDIT_PR, "success", [
        job({ status: pendingStatus, conclusion: null }),
      ]);
      expect(decisions).toEqual([
        {
          context: CONTEXT,
          status: pendingStatus,
          title: expect.any(String),
          summary: expect.any(String),
        },
      ]);
      expect(Object.hasOwn(decisions[0] ?? {}, "conclusion")).toBe(false);
    },
  );
});
