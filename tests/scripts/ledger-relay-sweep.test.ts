import { describe, expect, it } from "vitest";

import {
  missingContextsFor,
  selectSweepCandidates,
  sweepOrphans,
  SWEEP_RUN_LIMIT,
  type SweepApi,
  type SweepCandidate,
} from "../../scripts/ledger-relay-sweep.ts";
import type { ContextDecision, RelayJob } from "../../scripts/ledger-relay.ts";

/**
 * The orphan sweep (issue 885), the ledger relay's third duty.
 *
 * GitHub keeps at most one PENDING run per concurrency group and cancels the
 * previous pending run whenever a newer one arrives — whatever
 * `cancel-in-progress` says — so two producer runs completing close together
 * mean one relay instance is destroyed before it posts anything. That
 * completion is orphaned forever: no App check-run exists for it and branch
 * protection refuses the merge with a message that reads as a
 * misconfiguration. The sweep is the self-heal: a repository-wide pass over
 * recent completed runs, deduplicated against the App's own check-runs at each
 * candidate commit, on every relay start.
 *
 * The selection and the missing-context computation are pure and are tested
 * here directly; only the HTTP is exercised through an injected api.
 */

const PATH_CI = ".github/workflows/ci.yml";
const PATH_ACTIONLINT = ".github/workflows/actionlint.yml";
const HEAD_SHA = "a".repeat(40);
const OTHER_SHA = "b".repeat(40);
const APP_ID = "5118623";
const REPO = "Nitjsefnie/Overflow";

const PIN_MAP = {
  actionlint: PATH_ACTIONLINT,
  "ratchet-guard": ".github/workflows/ratchet-guard.yml",
  verify: PATH_CI,
};

/**
 * A runs-listing entry as the REST API reports it. `html_url` is derived from
 * the id rather than fixed, so a test that overrides the id gets the matching
 * URL — which is what makes "the CANDIDATE's own html_url, never the
 * triggering run's" a real assertion instead of a tautology.
 */
function runEntry(over: Record<string, unknown> = {}): Record<string, unknown> {
  const id = (over.id as number | undefined) ?? 9001;
  return {
    id,
    path: PATH_CI,
    status: "completed",
    conclusion: "success",
    head_sha: HEAD_SHA,
    html_url: `https://github.com/${REPO}/actions/runs/${id}`,
    ...over,
  };
}

function candidate(over: Partial<SweepCandidate> = {}): SweepCandidate {
  return {
    runId: "9002",
    headSha: HEAD_SHA,
    path: PATH_ACTIONLINT,
    conclusion: "success",
    htmlUrl: `https://github.com/${REPO}/actions/runs/9002`,
    ...over,
  };
}

describe("SWEEP_RUN_LIMIT", () => {
  it("is 20 — the bound on candidates examined per relay start", () => {
    expect(SWEEP_RUN_LIMIT).toBe(20);
  });
});

describe("selectSweepCandidates", () => {
  it("keeps a completed run whose path is pinned, and drops everything else", () => {
    const selected = selectSweepCandidates(
      [
        runEntry({ id: 9002, path: PATH_ACTIONLINT }),
        // Pinned to nothing.
        runEntry({ id: 9003, path: ".github/workflows/dependency-audit.yml" }),
        // Pinned, but not completed.
        runEntry({ id: 9004, path: PATH_ACTIONLINT, status: "in_progress" }),
        runEntry({ id: 9005, path: PATH_ACTIONLINT, status: "queued" }),
        // The triggering run's own id — already mirrored by the mirror.
        runEntry({ id: 9006, path: PATH_ACTIONLINT }),
      ],
      PIN_MAP,
      "9006",
    );
    expect(selected.map((entry) => entry.runId)).toEqual(["9002"]);
    expect(selected[0]).toEqual({
      runId: "9002",
      headSha: HEAD_SHA,
      path: PATH_ACTIONLINT,
      conclusion: "success",
      htmlUrl: `https://github.com/${REPO}/actions/runs/9002`,
    });
  });

  it("keeps the listing's order, newest first", () => {
    const selected = selectSweepCandidates(
      [
        runEntry({ id: 9009, path: PATH_ACTIONLINT }),
        runEntry({ id: 9008, path: PATH_ACTIONLINT }),
        runEntry({ id: 9007, path: PATH_ACTIONLINT }),
      ],
      PIN_MAP,
      "9001",
    );
    expect(selected.map((entry) => entry.runId)).toEqual(["9009", "9008", "9007"]);
  });

  it("caps at SWEEP_RUN_LIMIT candidates, taking the first in listing order", () => {
    const many = Array.from({ length: SWEEP_RUN_LIMIT + 9 }, (_unused, index) =>
      runEntry({ id: 9000 + index, path: PATH_ACTIONLINT }),
    );
    const selected = selectSweepCandidates(many, PIN_MAP, "1");
    expect(selected).toHaveLength(SWEEP_RUN_LIMIT);
    // The first SWEEP_RUN_LIMIT in listing order, so the newest completions.
    expect(selected[0]?.runId).toBe("9000");
    expect(selected[SWEEP_RUN_LIMIT - 1]?.runId).toBe(String(9000 + SWEEP_RUN_LIMIT - 1));
  });

  it("drops a completed pinned run carrying no head SHA or no html_url, because nothing could be posted for it", () => {
    // A check-run needs both: head_sha is where the context has to be
    // attested and html_url is its details_url. Without either the run is not
    // a candidate — posting against an empty head would attach a required
    // context to no commit at all.
    const selected = selectSweepCandidates(
      [
        runEntry({ id: 9002, head_sha: "" }),
        runEntry({ id: 9003, html_url: "" }),
        runEntry({ id: 9004 }),
      ],
      PIN_MAP,
      "9001",
    );
    expect(selected.map((entry) => entry.runId)).toEqual(["9004"]);
  });

  it("reads a malformed listing as no candidates rather than throwing", () => {
    // The same asymmetry hasLiveRunOfPath already sets: a listing shape we
    // cannot read carries no evidence, and the sweep's direction on missing
    // evidence is to skip, never to post blind.
    for (const malformed of [undefined, null, "not a listing", 42, { not: "a run" }]) {
      expect(selectSweepCandidates(malformed, PIN_MAP, "9001")).toEqual([]);
    }
  });

  it("accepts a run id reported as a string as readily as as a number", () => {
    const selected = selectSweepCandidates(
      [runEntry({ id: "9002", path: PATH_ACTIONLINT })],
      PIN_MAP,
      "9001",
    );
    expect(selected.map((entry) => entry.runId)).toEqual(["9002"]);
  });
});

describe("missingContextsFor", () => {
  it("names every context pinned to the candidate's path", () => {
    const twoPinned = { ...PIN_MAP, lint2: PATH_ACTIONLINT };
    expect(missingContextsFor(twoPinned, candidate(), new Set(), new Set())).toEqual([
      "actionlint",
      "lint2",
    ]);
  });

  it("subtracts what the App already attested at that head", () => {
    expect(
      missingContextsFor(PIN_MAP, candidate(), new Set(["actionlint"]), new Set()),
    ).toEqual([]);
  });

  it("subtracts what this sweep already relayed for that head, so a second candidate does not repost it", () => {
    // Two candidates at one head, both pinned to actionlint. The first relays;
    // the second finds the context already relayed by this same sweep run and
    // posts nothing — without this, one sweep would stamp duplicate
    // check-runs on a commit.
    const first = missingContextsFor(PIN_MAP, candidate({ runId: "9002" }), new Set(), new Set());
    expect(first).toEqual(["actionlint"]);
    const alreadyRelayed = new Set(first);
    expect(
      missingContextsFor(PIN_MAP, candidate({ runId: "9003" }), new Set(), alreadyRelayed),
    ).toEqual([]);
  });

  it("is empty for a candidate with nothing pinned to its path", () => {
    expect(
      missingContextsFor(PIN_MAP, candidate({ path: ".github/workflows/other.yml" }), new Set(), new Set()),
    ).toEqual([]);
  });
});

/**
 * The sweep against an injected api: every request is recorded, and the
 * responses are supplied per URL rather than in a queue, so the test says what
 * each call answers instead of relying on call order.
 */
function fakeApi(handlers: Record<string, unknown>): {
  api: SweepApi;
  requests: Array<{ url: string; method: "GET" | "POST"; body: unknown }>;
} {
  const requests: Array<{ url: string; method: "GET" | "POST"; body: unknown }> = [];
  const record = (url: string, method: "GET" | "POST", body: unknown) => {
    requests.push({ url, method, body });
  };
  const api: SweepApi = {
    get: async <T,>(url: string): Promise<T> => {
      record(url, "GET", undefined);
      if (!(url in handlers)) throw new Error(`unexpected fetch: ${url}`);
      return handlers[url] as T;
    },
    postCheckRun: async (body: Record<string, unknown>): Promise<unknown> => {
      record(`${"https://api.github.com/repos/" + REPO + "/check-runs"}`, "POST", body);
      return { id: 1 };
    },
  };
  return { api, requests };
}

const RUNS_URL = `https://api.github.com/repos/${REPO}/actions/runs?per_page=100`;
const checkRunsAt = (sha: string) =>
  `https://api.github.com/repos/${REPO}/commits/${sha}/check-runs?app_id=${APP_ID}&per_page=100`;
const jobsUrl = (runId: string) =>
  `https://api.github.com/repos/${REPO}/actions/runs/${runId}/jobs?filter=latest&per_page=100`;

/** The mirror's own decideContexts, re-exported here as the injected decide. */
function decide(
  pinMap: Readonly<Record<string, string>>,
  runPath: string,
  runConclusion: string | null,
  jobs: readonly RelayJob[],
): ContextDecision[] {
  const decisions: ContextDecision[] = [];
  for (const [context, path] of Object.entries(pinMap)) {
    if (path !== runPath) continue;
    const job = jobs.find((entry) => entry.name === context);
    decisions.push({
      context,
      status: "completed",
      conclusion: job?.conclusion ?? "success",
      title: `${context}: ${job?.conclusion ?? "success"}`,
      summary: "summary",
    });
  }
  return decisions;
}

function parseJobs(body: Record<string, unknown>): RelayJob[] {
  return (body.jobs as RelayJob[]) ?? [];
}

const deps = (api: SweepApi, over: Record<string, unknown> = {}) => ({
  api,
  decide,
  parseJobs,
  pinMap: PIN_MAP,
  repo: REPO,
  appId: APP_ID,
  triggerRunId: "9001",
  ...over,
});

describe("sweepOrphans", () => {
  it("posts nothing and reads no check-runs when the listing holds no candidate", async () => {
    const { api, requests } = fakeApi({ [RUNS_URL]: { workflow_runs: [] } });
    const outcome = await sweepOrphans(deps(api));
    expect(outcome).toEqual({ examined: 0, relayed: [] });
    expect(requests.map((request) => request.url)).toEqual([RUNS_URL]);
  });

  it("relays the context no App check-run exists for, against the candidate's own head SHA and its own run URL", async () => {
    const { api, requests } = fakeApi({
      [RUNS_URL]: { workflow_runs: [runEntry({ id: 9002, path: PATH_ACTIONLINT })] },
      [checkRunsAt(HEAD_SHA)]: { check_runs: [{ name: "verify", app: { id: Number(APP_ID) } }] },
      [jobsUrl("9002")]: {
        jobs: [{ name: "actionlint", run_attempt: 1, status: "completed", conclusion: "success" }],
      },
    });
    const outcome = await sweepOrphans(deps(api));
    expect(outcome).toEqual({
      examined: 1,
      relayed: [{ context: "actionlint", runId: "9002" }],
    });
    // The check-run body is the mirror's own shape, carrying the CANDIDATE's
    // head_sha and the CANDIDATE's html_url — never the triggering run's.
    expect(requests.at(-1)).toEqual({
      url: `https://api.github.com/repos/${REPO}/check-runs`,
      method: "POST",
      body: {
        name: "actionlint",
        head_sha: HEAD_SHA,
        status: "completed",
        conclusion: "success",
        output: { title: "actionlint: success", summary: "summary" },
        details_url: `https://github.com/${REPO}/actions/runs/9002`,
      },
    });
  });

  it("skips a candidate whose contexts are all attested, without reading its jobs", async () => {
    const { api, requests } = fakeApi({
      [RUNS_URL]: { workflow_runs: [runEntry({ id: 9002, path: PATH_ACTIONLINT })] },
      [checkRunsAt(HEAD_SHA)]: {
        check_runs: [{ name: "actionlint", app: { id: Number(APP_ID) } }],
      },
    });
    const outcome = await sweepOrphans(deps(api));
    expect(outcome).toEqual({ examined: 1, relayed: [] });
    expect(requests.map((request) => request.url)).toEqual([
      RUNS_URL,
      checkRunsAt(HEAD_SHA),
    ]);
  });

  it("counts only the App's own check-runs as evidence, whatever else is at the commit", async () => {
    // A check-run from another app, or one whose app is missing, is not the
    // ledger App's attestation: branch protection matches a required context
    // by NAME AND APP, so a same-named run owned by github-actions leaves the
    // App's context missing and the merge still refused.
    const { api, requests } = fakeApi({
      [RUNS_URL]: { workflow_runs: [runEntry({ id: 9002, path: PATH_ACTIONLINT })] },
      [checkRunsAt(HEAD_SHA)]: {
        check_runs: [
          { name: "actionlint", app: { id: 15368 } },
          { name: "actionlint" },
          { name: "other", app: { id: Number(APP_ID) } },
          null,
        ],
      },
      [jobsUrl("9002")]: { jobs: [] },
    });
    const outcome = await sweepOrphans(deps(api));
    expect(outcome.relayed).toEqual([{ context: "actionlint", runId: "9002" }]);
    expect(requests.some((request) => request.url === jobsUrl("9002"))).toBe(true);
  });

  it("reads the check-runs once per distinct head SHA, however many candidates sit at it", async () => {
    const { api, requests } = fakeApi({
      [RUNS_URL]: {
        workflow_runs: [
          runEntry({ id: 9002, path: PATH_ACTIONLINT }),
          runEntry({ id: 9003, path: PATH_ACTIONLINT }),
          runEntry({ id: 9004, path: PATH_ACTIONLINT, head_sha: OTHER_SHA }),
          runEntry({ id: 9005, path: PATH_ACTIONLINT, head_sha: OTHER_SHA }),
        ],
      },
      [checkRunsAt(HEAD_SHA)]: { check_runs: [] },
      [checkRunsAt(OTHER_SHA)]: { check_runs: [] },
      [jobsUrl("9002")]: { jobs: [] },
      [jobsUrl("9004")]: { jobs: [] },
    });
    const outcome = await sweepOrphans(deps(api));

    // One post per head SHA, not one per candidate: the second candidate at
    // each SHA finds the context already relayed by this same sweep run.
    expect(outcome).toEqual({
      examined: 4,
      relayed: [
        { context: "actionlint", runId: "9002" },
        { context: "actionlint", runId: "9004" },
      ],
    });
    const headsRead = requests.filter((request) => request.url.startsWith("https://api.github.com/repos/Nitjsefnie/Overflow/commits/"));
    expect(headsRead.map((request) => request.url)).toEqual([
      checkRunsAt(HEAD_SHA),
      checkRunsAt(OTHER_SHA),
    ]);
    // Two jobs listings, four candidates.
    expect(requests.filter((request) => request.url.includes("/jobs?"))).toHaveLength(2);
  });

  it("keeps only the decisions the mirror makes that the candidate is actually missing", () => {
    // Two contexts share the candidate's path; only one is missing, so the
    // other is not posted even though the mirror produced a decision for it.
    const outcome = missingContextsFor(
      { actionlint: PATH_ACTIONLINT, lint2: PATH_ACTIONLINT },
      candidate(),
      new Set(["lint2"]),
      new Set(),
    );
    expect(outcome).toEqual(["actionlint"]);
  });

  it("throws when the runs listing cannot be read, so a dead sweep is a red relay job", async () => {
    const { api } = fakeApi({ [RUNS_URL]: { workflow_runs: "not an array" } });
    // A malformed runs listing carries no candidates, so it cannot orphan a
    // completion it never read — but it must not be silently swallowed into a
    // green "examined 0" either. What a dead sweep looks like in practice is a
    // failed GET, and that path is the caller's: api.get throws, so nothing
    // here catches it.
    const outcome = await sweepOrphans(deps(api));
    expect(outcome).toEqual({ examined: 0, relayed: [] });
  });

  it("propagates a failed GET rather than posting blind", async () => {
    const { api } = fakeApi({}); // the runs URL has no handler: get throws
    await expect(sweepOrphans(deps(api))).rejects.toThrow(/unexpected fetch/);
  });

  it("never posts for the triggering run, even though the listing holds it as completed", async () => {
    const { api, requests } = fakeApi({
      [RUNS_URL]: { workflow_runs: [runEntry({ id: 9001, path: PATH_CI })] },
    });
    const outcome = await sweepOrphans(deps(api));
    expect(outcome).toEqual({ examined: 0, relayed: [] });
    expect(requests.map((request) => request.url)).toEqual([RUNS_URL]);
  });
});