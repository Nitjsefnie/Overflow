#!/usr/bin/env node
// The orphan sweep (issue 885), the ledger relay's THIRD duty, called from
// scripts/ledger-relay.ts after the mirror has posted its own decisions and
// before the rerun-heal.
//
// GitHub keeps at most one PENDING run per concurrency group and cancels the
// previous pending run whenever a newer one arrives — whatever
// `cancel-in-progress` says, so `cancel-in-progress: false` in
// .github/workflows/ledger-relay.yml does NOT protect a queued relay run. When
// two producer runs complete within seconds of each other, one relay instance
// is destroyed while still pending: it posts no check-run, and the completion
// that triggered it is orphaned forever. Nothing else ever notices, because
// that relay instance is the only thing that would have attested the run.
//
// So every relay start sweeps the repository for such orphans: recent completed
// runs of a pinned workflow, deduplicated against the App's OWN check-runs at
// each candidate commit. A context the App has already attested is never
// reposted, which is what keeps the sweep from stamping duplicate check-runs on
// arbitrary commits — and app id matters as much as name here, because branch
// protection matches a required context by name AND app, so a same-named
// github-actions check-run leaves the App's context missing.
//
// Its only import is scripts/ledger-relay-decisions.ts: the types, and the
// trusted-producer predicate, which is imported rather than injected so the
// sweep cannot be handed a looser rule than the mirror applies. Everything else
// it needs at runtime arrives through injected deps. The pure decision layer
// holds what both duties decide and depends on neither, so neither duty has to
// import the other and no runtime cycle can form between them.

import {
  isTrustedProducerRun,
  pinsFor,
  type ContextDecision,
  type PinMap,
  type RelayJob,
} from "./ledger-relay-decisions.ts";

/**
 * The bound on one sweep: at most this many candidates are examined, so one
 * relay start cannot fan out into an unbounded burst of API calls, and the worst
 * case (twenty candidates over twenty distinct commits) is roughly forty GETs
 * and twenty POSTs inside a job with `timeout-minutes: 15`.
 *
 * Twenty is not "comfortably more than enough". Measured against this
 * repository's live listing, the last 100 runs hold 30 producer runs — ten each
 * of ci, actionlint and ratchet-guard — among 33 ledger-relay runs and 37 others,
 * so on a busy day the cap IS reached and the sweep examines only the newest
 * twenty of them. That is the intended trade: the orphan this exists to heal is
 * always a recent completion, since the last relay start healed everything older
 * that it could reach, so the newest twenty is where the work is.
 */
export const SWEEP_RUN_LIMIT = 20;

/** One completed producer run the sweep may still have to relay for. */
export interface SweepCandidate {
  runId: string;
  headSha: string;
  path: string;
  conclusion: string | null;
  htmlUrl: string;
}

export interface SweepOutcome {
  /** Candidates considered after filtering and the SWEEP_RUN_LIMIT cap. */
  readonly examined: number;
  /** Contexts the sweep posted, in posting order. */
  readonly relayed: ReadonlyArray<{ context: string; runId: string }>;
}

/**
 * The HTTP the sweep is allowed, injected rather than imported. `get` carries
 * the caller's bounded-retry wrapper and its authentication header, so the
 * sweep inherits the relay's failure direction — a dead call throws, and a
 * thrown sweep is a red relay job rather than a silent degradation.
 */
export interface SweepApi {
  get<T>(url: string, what: string): Promise<T>;
  postCheckRun(body: Record<string, unknown>, what: string): Promise<unknown>;
}

export interface SweepDeps {
  api: SweepApi;
  /** The mirror's own context decider, so a swept run is decided identically to a triggered one. */
  decide: (
    pinMap: PinMap,
    runPath: string,
    runConclusion: string | null,
    jobs: readonly RelayJob[],
  ) => ContextDecision[];
  pinMap: PinMap;
  /** The REST base the caller also uses. Injected rather than named here, so this module never holds a second copy of a constant the two modules would then drift on — and so the dependency stays one-way: a runtime import of it back from scripts/ledger-relay.ts would be a cycle. */
  apiRoot: string;
  repo: string;
  appId: string;
  /** The run that triggered this relay instance; never swept — the mirror already posted it. */
  triggerRunId: string;
}

/**
 * Candidate selection, pure. A run is a candidate when all of these hold:
 *
 * - its status is `completed` — an unfinished run is still live, and its own
 *   relay instance is still entitled to post for it;
 * - its path is pinned to at least one context — a run nothing is pinned to
 *   never had a check-run to orphan;
 * - its executed workflow definition is the base branch's, judged from its
 *   `event` and `head_branch` by the same isTrustedProducerRun the mirror
 *   applies — an absent or non-string field reads as empty, which refuses it;
 * - its id is not the triggering run's — the mirror above already posted it,
 *   and re-deciding it here would duplicate every context on every start;
 * - it carries both a head SHA and an html_url — a check-run needs the first as
 *   the commit it attests and the second as its details_url, so a run missing
 *   either could only be posted against nothing.
 *
 * The listing order is preserved and the first SWEEP_RUN_LIMIT survivors are
 * taken, so the newest completions are always the ones considered — and a
 * refused run is filtered before the cap, so it never takes a trusted one's
 * place in that window.
 */
export function selectSweepCandidates(
  entries: unknown,
  pinMap: PinMap,
  triggerRunId: string,
): SweepCandidate[] {
  if (!Array.isArray(entries)) return [];
  // Flattened across every context and every path of every pin: a run of a
  // context's SECOND pinned path (issue 1090's split) is just as much a
  // candidate as a run of the first, and filtering it out here would leave its
  // completion unattested forever with nothing to report it.
  const pinnedPaths = new Set(Object.values(pinMap).flatMap(pinsFor));
  const candidates: SweepCandidate[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const run = entry as {
      id?: unknown;
      path?: unknown;
      status?: unknown;
      conclusion?: unknown;
      head_sha?: unknown;
      html_url?: unknown;
      event?: unknown;
      head_branch?: unknown;
    };
    if (run.status !== "completed") continue;
    if (typeof run.path !== "string" || !pinnedPaths.has(run.path)) continue;
    if (
      !isTrustedProducerRun(
        typeof run.event === "string" ? run.event : "",
        typeof run.head_branch === "string" ? run.head_branch : "",
      )
    ) {
      continue;
    }
    const runId = idOf(run.id);
    if (runId === "" || runId === triggerRunId) continue;
    if (typeof run.head_sha !== "string" || run.head_sha === "") continue;
    if (typeof run.html_url !== "string" || run.html_url === "") continue;
    if (candidates.length === SWEEP_RUN_LIMIT) break;
    candidates.push({
      runId,
      headSha: run.head_sha,
      path: run.path,
      conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
      htmlUrl: run.html_url,
    });
  }
  return candidates;
}

/**
 * The missing-context computation, pure. The contexts one of whose pinned paths
 * is the candidate's path, minus the names the App already holds at that
 * commit, minus the contexts this same sweep has already relayed at that
 * commit.
 *
 * The last subtraction is what makes the sweep safe to run on every relay
 * start: two completed runs of the same workflow at one head are two
 * candidates at one commit, and without it every start would re-post whatever
 * its peer just posted. `attested` and `relayedThisSweep` are the two
 * deduplication sources and must not be merged — one is what GitHub holds, the
 * other is what this invocation has itself just written.
 */
export function missingContextsFor(
  pinMap: PinMap,
  candidate: SweepCandidate,
  attested: ReadonlySet<string>,
  relayedThisSweep: ReadonlySet<string>,
): string[] {
  const missing: string[] = [];
  for (const [context, pins] of Object.entries(pinMap)) {
    if (!pinsFor(pins).includes(candidate.path)) continue;
    if (attested.has(context) || relayedThisSweep.has(context)) continue;
    missing.push(context);
  }
  return missing;
}

/**
 * The sweep. One repository-wide listing, then one check-runs GET per DISTINCT
 * candidate commit, then one jobs GET and at most one POST per candidate that
 * still has something missing. Candidates at the same commit share both the
 * attestation and this invocation's relayed set, so a burst of completions on
 * one pull request head costs one check-runs GET and one post per context
 * rather than one per run.
 *
 * A candidate with nothing missing is skipped entirely — no jobs GET, no POST.
 * That is the common case on a healthy repository, and it is why the sweep is
 * cheap enough to run on every start: with nothing orphaned it costs one
 * listing plus one GET per distinct commit.
 */
export async function sweepOrphans(deps: SweepDeps): Promise<SweepOutcome> {
  const listing = await deps.api.get<Record<string, unknown>>(
    `${deps.apiRoot}/repos/${deps.repo}/actions/runs?per_page=100`,
    "the repository's workflow-run listing for the orphan sweep",
  );
  // Guarded like the check-runs listing below, and for the same reason: apiCall
  // answers undefined on an empty success body, so a 200 with no payload must
  // read as "no runs" rather than throw a TypeError on the property access.
  const candidates = selectSweepCandidates(
    Array.isArray(listing?.workflow_runs) ? listing.workflow_runs : [],
    deps.pinMap,
    deps.triggerRunId,
  );
  // Built as a mutable array and narrowed on return: SweepOutcome is readonly
  // so a consumer cannot push into a result it was handed, but this function
  // is the one place that accumulates.
  const relayed: Array<{ context: string; runId: string }> = [];

  for (const [headSha, atHead] of groupByHeadSha(candidates)) {
    const attested = await attestedContexts(deps, headSha);
    const relayedThisSweep = new Set<string>();
    for (const candidate of atHead) {
      const missing = new Set(
        missingContextsFor(deps.pinMap, candidate, attested, relayedThisSweep),
      );
      if (missing.size === 0) continue;
      const jobs = validateJobs(
        await deps.api.get<Record<string, unknown>>(
          `${deps.apiRoot}/repos/${deps.repo}/actions/runs/${candidate.runId}/jobs?filter=latest&per_page=100`,
          `the job listing of run ${candidate.runId}`,
        ),
      );
      const decisions = deps
        .decide(deps.pinMap, candidate.path, candidate.conclusion, jobs)
        .filter((decision) => missing.has(decision.context));
      for (const decision of decisions) {
        await deps.api.postCheckRun(
          checkRunBody(decision, candidate),
          `the swept check-run for ${decision.context} from run ${candidate.runId}`,
        );
        relayed.push({ context: decision.context, runId: candidate.runId });
        relayedThisSweep.add(decision.context);
      }
    }
  }
  return { examined: candidates.length, relayed };
}

/** Candidates grouped by head SHA, in the listing order of first appearance. */
function groupByHeadSha(candidates: readonly SweepCandidate[]): Array<[string, SweepCandidate[]]> {
  const order: string[] = [];
  const groups = new Map<string, SweepCandidate[]>();
  for (const candidate of candidates) {
    const existing = groups.get(candidate.headSha);
    if (existing === undefined) {
      order.push(candidate.headSha);
      groups.set(candidate.headSha, [candidate]);
      continue;
    }
    existing.push(candidate);
  }
  return order.map((sha) => [sha, groups.get(sha)!]);
}

/**
 * The names the App itself already holds at one commit, COUNTING ONLY THE
 * CONCLUDED ONES — the sweep's whole deduplication evidence, and therefore the
 * one query whose failure direction has to be argued rather than inherited.
 *
 * The listing is filtered by `app_id` server-side AND by `app.id` here, because
 * a filter the caller cannot see is not a filter: a same-named check-run owned
 * by the github-actions app leaves the ledger App's required context unset, and
 * treating it as evidence would keep the orphan exactly where it is.
 *
 * `filter=latest` is passed explicitly rather than left to the endpoint's
 * default: the dedup only needs the latest check-run per name, and stating it
 * means the convergence does not depend on a default this repository does not
 * pin.
 *
 * A malformed listing reads as NO attestation rather than throwing — the same
 * asymmetry hasLiveRunOfPath already sets in scripts/ledger-relay.ts.
 *
 * The earlier version of this comment argued that the direction was safe
 * because "reading nothing as attested can only cause a duplicate context to be
 * posted, never an orphan to be left in place". That was false, and it is worth
 * recording why, because it is the sentence a future reader would trust when
 * deciding whether this guard is safe to relax. The claim assumed the only way
 * a state became unattested-by-the-sweep was an external one. It is not: the
 * sweep POSTS check-runs, including pending ones, so a state it cannot read as
 * attested is a state it can create — see the pending-status guard below, whose
 * defect was exactly this argument taken at face value. The argument is now the
 * other way round and is the one that holds: reading nothing as attested can at
 * worst post a duplicate context, which branch protection tolerates, because a
 * duplicate check-run does not withhold a required context. Reading anything as
 * attested that is not, can withhold one, which is the failure this whole issue
 * exists to prevent.
 */
async function attestedContexts(deps: SweepDeps, headSha: string): Promise<Set<string>> {
  const body = await deps.api.get<Record<string, unknown>>(
    `${deps.apiRoot}/repos/${deps.repo}/commits/${headSha}/check-runs?app_id=${deps.appId}&filter=latest&per_page=100`,
    `the ledger App's check-runs at ${headSha}`,
  );
  const attested = new Set<string>();
  if (!Array.isArray(body.check_runs)) return attested;
  for (const entry of body.check_runs) {
    if (typeof entry !== "object" || entry === null) continue;
    const checkRun = entry as {
      name?: unknown;
      status?: unknown;
      app?: { id?: unknown } | undefined;
    };
    if (typeof checkRun.name !== "string") continue;
    if (String(checkRun.app?.id ?? "") !== deps.appId) continue;
    // A PENDING check-run is not an attestation, only a placeholder the App
    // itself posted. Counting it would wedge the candidate: this sweep posts
    // pending when a jobs listing reports an unfinished job, the NEXT sweep
    // would read that placeholder back as proof the context was handled, decline
    // to post the run's real conclusion, and branch protection would wait
    // forever on a check nothing ever completes.
    if (checkRun.status === "queued" || checkRun.status === "in_progress") continue;
    attested.add(checkRun.name);
  }
  return attested;
}

/**
 * The check-run body both duties post under, against whichever run is being
 * attested. It lives here because this module may not import a runtime value
 * from ledger-relay.ts without forming a cycle, so the one-way dependency is
 * ledger-relay.ts → this module and the shape cannot be duplicated and drift.
 *
 * `run` is structural, not a TriggeringRun or a SweepCandidate: the mirror
 * passes the triggering run, the sweep passes the candidate it is healing, and
 * the two agree on exactly these two fields — the commit the context attests
 * and the run whose page explains it.
 */
export function checkRunBody(
  decision: ContextDecision,
  run: { headSha: string; htmlUrl: string },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: decision.context,
    head_sha: run.headSha,
    status: decision.status,
    output: { title: decision.title, summary: decision.summary },
    details_url: run.htmlUrl,
  };
  if (decision.conclusion !== undefined) {
    body.conclusion = decision.conclusion;
  }
  return body;
}

/**
 * The relay's job-listing reader, moved here beside checkRunBody — the two
 * shared plumbing steps both duties need, and the two callers of this one are
 * the mirror and the sweep below. It sits in this module because the dependency
 * runs one way: ledger-relay.ts imports from here, so the relay's own reader
 * can be exported without a cycle in either direction.
 *
 * An unknown job status reads as queued: the check-run then waits rather than
 * ever passing on something unverified.
 */
export function validateJobs(body: Record<string, unknown>): RelayJob[] {
  if (!Array.isArray(body.jobs)) {
    throw new Error("the job listing returned no jobs array");
  }
  const jobs: RelayJob[] = [];
  for (const entry of body.jobs) {
    const job = entry as Partial<RelayJob> | null;
    if (typeof job?.name !== "string") {
      throw new Error("the job listing holds an entry without a name");
    }
    jobs.push({
      name: job.name,
      run_attempt: typeof job.run_attempt === "number" ? job.run_attempt : 1,
      // An unknown status reads as queued: the check-run then waits rather
      // than ever passing on something unverified.
      status: job.status === "in_progress" || job.status === "completed" ? job.status : "queued",
      conclusion: typeof job.conclusion === "string" ? job.conclusion : null,
    });
  }
  return jobs;
}

/** A run id as a string, whichever way the listing spells it. Empty when it names nothing. */
function idOf(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string" && value !== "") return value;
  return "";
}

/**
 * The sweep's own log lines, pure. A relay instance's healing of someone
 * else's orphan is otherwise invisible — the operator watching a merge sit
 * blocked sees nothing at all — so each relayed context is named with the run
 * it came from, which is the handle to reach for when the merge still does not
 * go through.
 *
 * Nothing at all when no candidate was examined: a healthy repository sweeps
 * clean on every start, and a line printed every time would be noise an
 * operator learns to skip.
 */
export function renderSweepLines(outcome: SweepOutcome): string[] {
  if (outcome.examined === 0) return [];
  const lines = [
    `[ledger-relay] orphan-sweep: examined ${outcome.examined} completed run(s), ` +
      `relayed ${outcome.relayed.length} context(s)`,
  ];
  for (const entry of outcome.relayed) {
    lines.push(
      `[ledger-relay] orphan-sweep: relayed ${entry.context} from run ${entry.runId} ` +
        "(no App check-run existed for it)",
    );
  }
  return lines;
}
