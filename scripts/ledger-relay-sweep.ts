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
// This module imports only TYPES from ledger-relay.ts and receives every
// runtime value it needs through injected deps, so the two files cannot form a
// runtime import cycle in either direction.

import type { ContextDecision, RelayJob } from "./ledger-relay.ts";

const API_ROOT = "https://api.github.com";

/**
 * The bound on one sweep: at most this many candidates are examined, so one
 * relay start cannot fan out into an unbounded burst of API calls. Twenty is
 * several times the completions a single relay start can plausibly have
 * missed — GitHub cancels only the previous PENDING run, so a handful of
 * rapid arrivals is the realistic ceiling — while keeping the worst case
 * (twenty candidates over twenty distinct commits) at roughly forty GETs and
 * twenty POSTs.
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
  examined: number;
  /** Contexts the sweep posted, in posting order. */
  relayed: Array<{ context: string; runId: string }>;
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
    pinMap: Readonly<Record<string, string>>,
    runPath: string,
    runConclusion: string | null,
    jobs: readonly RelayJob[],
  ) => ContextDecision[];
  /** The relay's own job-listing reader, so a swept run's jobs are read identically. */
  parseJobs: (body: Record<string, unknown>) => RelayJob[];
  pinMap: Readonly<Record<string, string>>;
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
 * - its id is not the triggering run's — the mirror above already posted it,
 *   and re-deciding it here would duplicate every context on every start;
 * - it carries both a head SHA and an html_url — a check-run needs the first as
 *   the commit it attests and the second as its details_url, so a run missing
 *   either could only be posted against nothing.
 *
 * The listing order is preserved and the first SWEEP_RUN_LIMIT survivors are
 * taken, so the newest completions are always the ones considered.
 */
export function selectSweepCandidates(
  entries: unknown,
  pinMap: Readonly<Record<string, string>>,
  triggerRunId: string,
): SweepCandidate[] {
  if (!Array.isArray(entries)) return [];
  const pinnedPaths = new Set(Object.values(pinMap));
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
    };
    if (run.status !== "completed") continue;
    if (typeof run.path !== "string" || !pinnedPaths.has(run.path)) continue;
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
 * The missing-context computation, pure. The contexts pinned to the
 * candidate's path, minus the names the App already holds at that commit, minus
 * the contexts this same sweep has already relayed at that commit.
 *
 * The last subtraction is what makes the sweep safe to run on every relay
 * start: two completed runs of the same workflow at one head are two
 * candidates at one commit, and without it every start would re-post whatever
 * its peer just posted. `attested` and `relayedThisSweep` are the two
 * deduplication sources and must not be merged — one is what GitHub holds, the
 * other is what this invocation has itself just written.
 */
export function missingContextsFor(
  pinMap: Readonly<Record<string, string>>,
  candidate: SweepCandidate,
  attested: ReadonlySet<string>,
  relayedThisSweep: ReadonlySet<string>,
): string[] {
  const missing: string[] = [];
  for (const [context, path] of Object.entries(pinMap)) {
    if (path !== candidate.path) continue;
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
    `${API_ROOT}/repos/${deps.repo}/actions/runs?per_page=100`,
    "the repository's workflow-run listing for the orphan sweep",
  );
  const candidates = selectSweepCandidates(listing.workflow_runs, deps.pinMap, deps.triggerRunId);
  const relayed: SweepOutcome["relayed"] = [];

  for (const [headSha, atHead] of groupByHeadSha(candidates)) {
    const attested = await attestedContexts(deps, headSha);
    const relayedThisSweep = new Set<string>();
    for (const candidate of atHead) {
      const missing = new Set(
        missingContextsFor(deps.pinMap, candidate, attested, relayedThisSweep),
      );
      if (missing.size === 0) continue;
      const jobs = deps.parseJobs(
        await deps.api.get<Record<string, unknown>>(
          `${API_ROOT}/repos/${deps.repo}/actions/runs/${candidate.runId}/jobs?filter=latest&per_page=100`,
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
 * The names the App itself already holds at one commit — the sweep's whole
 * deduplication evidence, and therefore the one query whose failure direction
 * has to be argued rather than inherited.
 *
 * The listing is filtered by `app_id` server-side AND by `app.id` here, because
 * a filter the caller cannot see is not a filter: a same-named check-run owned
 * by the github-actions app leaves the ledger App's required context unset, and
 * treating it as evidence would keep the orphan exactly where it is.
 *
 * A malformed listing reads as NO attestation rather than throwing — the same
 * asymmetry hasLiveRunOfPath already sets in scripts/ledger-relay.ts. The
 * direction is the safe one here: reading nothing as attested can only cause a
 * duplicate context to be posted, never an orphan to be left in place, and a
 * throw on this query would red a relay job over a response shape GitHub does
 * not document as stable.
 */
async function attestedContexts(deps: SweepDeps, headSha: string): Promise<Set<string>> {
  const body = await deps.api.get<Record<string, unknown>>(
    `${API_ROOT}/repos/${deps.repo}/commits/${headSha}/check-runs?app_id=${deps.appId}&per_page=100`,
    `the ledger App's check-runs at ${headSha}`,
  );
  const attested = new Set<string>();
  if (!Array.isArray(body.check_runs)) return attested;
  for (const entry of body.check_runs) {
    if (typeof entry !== "object" || entry === null) continue;
    const checkRun = entry as { name?: unknown; app?: { id?: unknown } | undefined };
    if (typeof checkRun.name !== "string") continue;
    if (String(checkRun.app?.id ?? "") !== deps.appId) continue;
    attested.add(checkRun.name);
  }
  return attested;
}

/**
 * The mirror's check-run body shape (see checkRunBody in ledger-relay.ts),
 * carried by the CANDIDATE's own head SHA and the CANDIDATE's own html_url.
 *
 * It is rebuilt here rather than imported because importing it would be a
 * runtime import of ledger-relay.ts, which this module may not take without
 * forming a cycle; the parity is pinned from outside instead — the acceptance
 * case in tests/scripts/ledger-relay.test.ts asserts the swept body field for
 * field against the mirror's own, so the two cannot drift apart silently.
 */
function checkRunBody(
  decision: ContextDecision,
  candidate: SweepCandidate,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: decision.context,
    head_sha: candidate.headSha,
    status: decision.status,
    output: { title: decision.title, summary: decision.summary },
    details_url: candidate.htmlUrl,
  };
  if (decision.conclusion !== undefined) {
    body.conclusion = decision.conclusion;
  }
  return body;
}

/** A run id as a string, whichever way the listing spells it. Empty when it names nothing. */
function idOf(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string" && value !== "") return value;
  return "";
}