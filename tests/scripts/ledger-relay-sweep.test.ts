import { describe, expect, it } from "vitest";

import {
  missingContextsFor,
  selectSweepCandidates,
  sweepOrphans,
  SWEEP_RUN_LIMIT,
  type SweepApi,
  type SweepCandidate,
} from "../../scripts/ledger-relay-sweep.ts";
import { decideContexts } from "../../scripts/ledger-relay.ts";

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
    event: "pull_request_target",
    head_branch: "feature/some-branch",
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

  it("keeps only runs whose executed workflow definition is the base branch's", () => {
    const selected = selectSweepCandidates(
      [
        runEntry({ id: 9010, event: "pull_request_target", head_branch: "feature/some-branch" }),
        runEntry({ id: 9011, event: "push", head_branch: "main" }),
        runEntry({ id: 9012, event: "workflow_dispatch", head_branch: "main" }),
        runEntry({ id: 9013, event: "schedule", head_branch: "main" }),
        runEntry({ id: 9020, event: "pull_request", head_branch: "main" }),
        runEntry({ id: 9021, event: "pull_request", head_branch: "feature/some-branch" }),
        runEntry({ id: 9022, event: "issue_comment", head_branch: "main" }),
        runEntry({ id: 9023, event: "push", head_branch: "feature/some-branch" }),
        runEntry({ id: 9024, event: "workflow_dispatch", head_branch: "feature/some-branch" }),
        runEntry({ id: 9025, event: "merge_group", head_branch: "main" }),
      ],
      PIN_MAP,
      "9001",
    );
    expect(selected.map((entry) => entry.runId)).toEqual(["9010", "9011", "9012", "9013"]);
  });

  it("fails closed on a run whose event or head branch is absent or not a string", () => {
    const selected = selectSweepCandidates(
      [
        runEntry({ id: 9030, event: undefined }),
        runEntry({ id: 9031, event: null }),
        runEntry({ id: 9032, event: 7 }),
        runEntry({ id: 9033, event: "push", head_branch: undefined }),
        runEntry({ id: 9034, event: "push", head_branch: null }),
        runEntry({ id: 9035, event: "push", head_branch: ["main"] }),
      ],
      PIN_MAP,
      "9001",
    );
    expect(selected).toEqual([]);
  });

  it("does not let untrusted runs consume the SWEEP_RUN_LIMIT cap", () => {
    // The filter runs before the cap, so a burst of refused runs at the top of
    // the listing cannot crowd a trusted orphan out of the examined window.
    const refused = Array.from({ length: SWEEP_RUN_LIMIT }, (_unused, index) =>
      runEntry({ id: 9100 + index, event: "pull_request" }),
    );
    const selected = selectSweepCandidates(
      [...refused, runEntry({ id: 9200, event: "pull_request_target" })],
      PIN_MAP,
      "9001",
    );
    expect(selected.map((entry) => entry.runId)).toEqual(["9200"]);
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
 *
 * A POST records `url: null`. The injected `postCheckRun` receives only the
 * body — it never sees an endpoint — so writing one here would be a fabricated
 * URL asserting a fact this seam cannot carry. The endpoint is pinned for real
 * in tests/scripts/ledger-relay.test.ts, where the production constructor is in
 * play and the full request URL is on the record.
 */
function fakeApi(handlers: Record<string, unknown>): {
  api: SweepApi;
  requests: Array<{ url: string | null; method: "GET" | "POST"; body: unknown }>;
} {
  const requests: Array<{ url: string | null; method: "GET" | "POST"; body: unknown }> = [];
  const record = (url: string | null, method: "GET" | "POST", body: unknown) => {
    requests.push({ url, method, body });
  };
  const api: SweepApi = {
    get: async <T,>(url: string): Promise<T> => {
      record(url, "GET", undefined);
      if (!(url in handlers)) throw new Error(`unexpected fetch: ${url}`);
      return handlers[url] as T;
    },
    postCheckRun: async (body: Record<string, unknown>): Promise<unknown> => {
      record(null, "POST", body);
      return { id: 1 };
    },
  };
  return { api, requests };
}

/**
 * One App-owned check-run as the listing reports it. Every fixture goes through
 * this so that `status` cannot be forgotten on the entries that are meant to
 * count as attestations — the sweep skips PENDING ones, so a fixture without a
 * status silently means "concluded" for the wrong reason.
 */
function appCheckRun(name: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { name, status: "completed", app: { id: Number(APP_ID) }, ...over };
}

const RUNS_URL = `https://api.github.com/repos/${REPO}/actions/runs?per_page=100`;
const checkRunsAt = (sha: string) =>
  `https://api.github.com/repos/${REPO}/commits/${sha}/check-runs?app_id=${APP_ID}&filter=latest&per_page=100`;
const jobsUrl = (runId: string) =>
  `https://api.github.com/repos/${REPO}/actions/runs/${runId}/jobs?filter=latest&per_page=100`;

/**
 * The sweep under test with the MIRROR'S OWN `decideContexts` injected, not a
 * local stand-in.
 *
 * A hand-written decide that ignores `runConclusion` cannot catch the sweep
 * passing the wrong conclusion — and that is exactly the mutant that survived
 * this suite in review: hardcoding `"success"` into the decide call left every
 * test green, because every fixture's conclusion was `"success"` and the stand-in
 * never read the field at all. The real decider reads it on the no-jobs branch,
 * which is where a producer run cancelled before it created any job lands.
 */
const deps = (api: SweepApi, over: Record<string, unknown> = {}) => ({
  api,
  decide: decideContexts,
  pinMap: PIN_MAP,
  apiRoot: "https://api.github.com",
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

  it.each([
    ["a completed pull_request run", { event: "pull_request", head_branch: "main" }],
    ["a completed issue_comment run", { event: "issue_comment", head_branch: "main" }],
    ["a push run on a branch other than main", { event: "push", head_branch: "feature/some-branch" }],
  ])("posts nothing for %s, however unattested its context is", async (_name, over) => {
    // Every later call a wrongly selected candidate would make is answered, so
    // the absence of a POST is the predicate's doing and not a missing handler.
    const { api, requests } = fakeApi({
      [RUNS_URL]: { workflow_runs: [runEntry({ id: 9002, path: PATH_ACTIONLINT, ...over })] },
      [checkRunsAt(HEAD_SHA)]: { check_runs: [] },
      [jobsUrl("9002")]: {
        jobs: [{ name: "actionlint", run_attempt: 1, status: "completed", conclusion: "success" }],
      },
    });
    const outcome = await sweepOrphans(deps(api));
    expect(outcome).toEqual({ examined: 0, relayed: [] });
    expect(requests.filter((request) => request.method === "POST")).toEqual([]);
    expect(requests.map((request) => request.url)).toEqual([RUNS_URL]);
  });

  it("relays the context no App check-run exists for, against the candidate's own head SHA and its own run URL", async () => {
    const { api, requests } = fakeApi({
      [RUNS_URL]: { workflow_runs: [runEntry({ id: 9002, path: PATH_ACTIONLINT })] },
      [checkRunsAt(HEAD_SHA)]: { check_runs: [appCheckRun("verify")] },
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
    // `url` is null on a POST by construction: this seam never sees the
    // endpoint, and the endpoint is pinned at the runRelay level instead.
    expect(requests.at(-1)).toEqual({
      url: null,
      method: "POST",
      body: {
        name: "actionlint",
        head_sha: HEAD_SHA,
        status: "completed",
        conclusion: "success",
        output: {
          title: "actionlint: success",
          summary:
            'Job "actionlint" (attempt 1) in .github/workflows/actionlint.yml concluded success; ' +
            "the outcome is relayed to branch protection.",
        },
        details_url: `https://github.com/${REPO}/actions/runs/9002`,
      },
    });
  });

  it("decides a candidate whose jobs are empty from the LISTING's conclusion, so a cancelled producer relays failure and not success", async () => {
    // The branch this guards is decideOne's no-jobs fallback, and the run that
    // lands there is a producer cancelled before it created any job: the runs
    // listing still carries its conclusion, and that is the only evidence
    // there is. Hardcoding `"success"` into the sweep's decide call passes
    // every other case in this file — each of their fixtures concludes
    // "success" — and turns a required context GREEN on a run that failed,
    // which is the direction that silently unblocks a merge that must not go
    // through.
    const { api, requests } = fakeApi({
      [RUNS_URL]: {
        workflow_runs: [
          runEntry({ id: 9002, path: PATH_ACTIONLINT, conclusion: "failure" }),
        ],
      },
      [checkRunsAt(HEAD_SHA)]: { check_runs: [] },
      [jobsUrl("9002")]: { jobs: [] },
    });
    const outcome = await sweepOrphans(deps(api));

    expect(outcome.relayed).toEqual([{ context: "actionlint", runId: "9002" }]);
    expect(requests.at(-1)?.body).toMatchObject({
      name: "actionlint",
      head_sha: HEAD_SHA,
      status: "completed",
      conclusion: "failure",
    });
  });

  it("mirrors a no-jobs candidate that concluded success as success, so the conclusion is read rather than assumed", async () => {
    // The other half of the same branch: without this case a decider that
    // hardcoded "failure" would satisfy the case above, and the sweep would be
    // just as wrong in the opposite direction — failing a check that passed.
    const { api, requests } = fakeApi({
      [RUNS_URL]: {
        workflow_runs: [runEntry({ id: 9002, path: PATH_ACTIONLINT, conclusion: "success" })],
      },
      [checkRunsAt(HEAD_SHA)]: { check_runs: [] },
      [jobsUrl("9002")]: { jobs: [] },
    });
    const outcome = await sweepOrphans(deps(api));

    expect(outcome.relayed).toEqual([{ context: "actionlint", runId: "9002" }]);
    expect(requests.at(-1)?.body).toMatchObject({ name: "actionlint", conclusion: "success" });
  });

  it("skips a candidate whose contexts are all attested, without reading its jobs", async () => {
    const { api, requests } = fakeApi({
      [RUNS_URL]: { workflow_runs: [runEntry({ id: 9002, path: PATH_ACTIONLINT })] },
      [checkRunsAt(HEAD_SHA)]: {
        check_runs: [appCheckRun("actionlint")],
      },
    });
    const outcome = await sweepOrphans(deps(api));
    expect(outcome).toEqual({ examined: 1, relayed: [] });
    expect(requests.map((request) => request.url)).toEqual([
      RUNS_URL,
      checkRunsAt(HEAD_SHA),
    ]);
  });

  it("still relays the real conclusion when the App holds only a PENDING check-run for that context", async () => {
    // The defect this pins, end to end across two sweeps. A completed
    // producer run whose jobs listing reports an unfinished job is decided as
    // PENDING, and the sweep posts that pending check-run. On the next relay
    // start the same run is honestly completed, so the sweep must post the
    // real conclusion — but if it counted its own pending placeholder as an
    // attestation it would relay nothing, and branch protection would wait
    // forever on a check nothing ever completes. That is the same failure this
    // issue exists to prevent, reintroduced through the sweep's own output.
    const pending = { check_runs: [appCheckRun("actionlint", { status: "queued" })] };
    const jobsPending = {
      jobs: [{ name: "actionlint", run_attempt: 1, status: "queued", conclusion: null }],
    };
    const jobsDone = {
      jobs: [{ name: "actionlint", run_attempt: 1, status: "completed", conclusion: "success" }],
    };

    // Sweep #1: nothing attested, the job has not finished. Posts pending.
    const first = fakeApi({
      [RUNS_URL]: { workflow_runs: [runEntry({ id: 9002, path: PATH_ACTIONLINT })] },
      [checkRunsAt(HEAD_SHA)]: { check_runs: [] },
      [jobsUrl("9002")]: jobsPending,
    });
    const firstOutcome = await sweepOrphans(deps(first.api));
    expect(firstOutcome.relayed).toEqual([{ context: "actionlint", runId: "9002" }]);
    expect(first.requests.at(-1)?.body).toMatchObject({
      name: "actionlint",
      status: "queued",
    });
    expect(Object.hasOwn(first.requests.at(-1)?.body as object, "conclusion")).toBe(false);

    // Sweep #2: the App now holds only that pending placeholder, and the job
    // has concluded. The placeholder must not be read as an attestation.
    const second = fakeApi({
      [RUNS_URL]: { workflow_runs: [runEntry({ id: 9002, path: PATH_ACTIONLINT })] },
      [checkRunsAt(HEAD_SHA)]: pending,
      [jobsUrl("9002")]: jobsDone,
    });
    const secondOutcome = await sweepOrphans(deps(second.api));
    expect(secondOutcome.relayed).toEqual([{ context: "actionlint", runId: "9002" }]);
    expect(second.requests.at(-1)?.body).toMatchObject({
      name: "actionlint",
      status: "completed",
      conclusion: "success",
    });
  });

  it("reads an in_progress App check-run as a placeholder too, not an attestation", async () => {
    const { api, requests } = fakeApi({
      [RUNS_URL]: { workflow_runs: [runEntry({ id: 9002, path: PATH_ACTIONLINT })] },
      [checkRunsAt(HEAD_SHA)]: {
        check_runs: [appCheckRun("actionlint", { status: "in_progress" })],
      },
      [jobsUrl("9002")]: { jobs: [] },
    });
    const outcome = await sweepOrphans(deps(api));
    expect(outcome.relayed).toEqual([{ context: "actionlint", runId: "9002" }]);
    expect(requests.at(-1)?.body).toMatchObject({ name: "actionlint", conclusion: "success" });
  });

  it("still skips a candidate whose contexts hold a CONCLUDED App check-run", async () => {
    // The control against over-correcting. The pending-status fix must not
    // degrade into "re-post everything": a concluded check-run is an
    // attestation and stays one, so this case relays nothing and never reads
    // the candidate's jobs.
    const { api, requests } = fakeApi({
      [RUNS_URL]: { workflow_runs: [runEntry({ id: 9002, path: PATH_ACTIONLINT })] },
      [checkRunsAt(HEAD_SHA)]: { check_runs: [appCheckRun("actionlint")] },
    });
    const outcome = await sweepOrphans(deps(api));
    expect(outcome).toEqual({ examined: 1, relayed: [] });
    expect(requests.map((request) => request.url)).toEqual([RUNS_URL, checkRunsAt(HEAD_SHA)]);
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
          { name: "actionlint", status: "completed", app: { id: 15368 } },
          { name: "actionlint", status: "completed" },
          { name: "other", status: "completed", app: { id: Number(APP_ID) } },
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
    const headsRead = requests.filter(
      (request) => request.url?.startsWith(`https://api.github.com/repos/${REPO}/commits/`) ?? false,
    );
    expect(headsRead.map((request) => request.url)).toEqual([
      checkRunsAt(HEAD_SHA),
      checkRunsAt(OTHER_SHA),
    ]);
    // Two jobs listings, four candidates.
    expect(requests.filter((request) => request.url?.includes("/jobs?") ?? false)).toHaveLength(2);
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

  it("reads a malformed runs listing as no candidates rather than throwing", async () => {
    const { api } = fakeApi({ [RUNS_URL]: { workflow_runs: "not an array" } });
    // A listing shape we cannot read carries no evidence, so it cannot orphan a
    // completion it never read. The THROW path is the next case: a failed GET
    // propagates, and a dead sweep is a red relay job.
    const outcome = await sweepOrphans(deps(api));
    expect(outcome).toEqual({ examined: 0, relayed: [] });
  });

  it("reads an EMPTY success body on the runs listing as no candidates, not a crash", async () => {
    // Same family as the malformed listing above, and a distinct input: apiCall
    // answers `undefined` for an empty 200 body, so the runs listing is not a
    // bad object here, it is no object at all. Reading `workflow_runs` off that
    // unguarded throws a TypeError, which turns an ordinary empty response into
    // a red relay job over a shape GitHub is entitled to send.
    const { api, requests } = fakeApi({ [RUNS_URL]: undefined });
    const outcome = await sweepOrphans(deps(api));
    expect(outcome).toEqual({ examined: 0, relayed: [] });
    // It read the listing and stopped: no second call, nothing posted.
    expect(requests).toHaveLength(1);
    expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  });

  it("propagates a failed GET rather than posting blind, so a dead sweep is a red relay job", async () => {
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
