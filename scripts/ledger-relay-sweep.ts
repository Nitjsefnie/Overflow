#!/usr/bin/env node
// The orphan sweep (issue 885), the ledger relay's THIRD duty, called from
// scripts/ledger-relay.ts in a finally after every mirror path, including
// refusals. The sweep also carries the rerun-heal for displaced starts.
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
// each candidate commit. Only the newest eligible producer per context is
// considered, and its latest App check must identify that producer's attempt
// to count as attestation — app id matters as much as name here, because branch
// protection matches a required context by name AND app, so a same-named
// github-actions check-run leaves the App's context missing.
//
// Trust predicates and workflow_run resolution are imported rather than
// injected so the sweep cannot be handed a looser rule than the mirror applies.
// Everything else
// it needs at runtime arrives through injected deps. The pure decision layer
// holds what both duties decide and depends on neither, so neither duty has to
// import the other and no runtime cycle can form between them.

import {
  anyJobStartedOf, decideRerun, isHealableEvent, openPullRequestsAtHead, RERUN_ATTEMPT_CAP,
  pinsFor,
  type ContextDecision,
  type PinMap,
  type RelayJob,
} from "./ledger-relay-decisions.ts";
import { readSuiteRuns, suiteRunsUrl, supersessionMessage } from "./pr-suite-supersession.ts";
import { resolveWorkflowRunHead, type UpstreamPublicationCheck } from "./ledger-relay-upstream.ts";

import {
  publicationBlockedContexts, idOf, newestProducersFor,
  selectSweepCandidates, validateJobs, type ProducerDeps, type SweepCandidate,
} from "./ledger-relay-producers.ts";
import { historyBoundDecision, postProducerCheck, publicationState } from "./ledger-relay-publication.ts";
export { checkRunBody, selectSweepCandidates, validateJobs, SWEEP_RUN_LIMIT } from "./ledger-relay-producers.ts";
export type { SweepApi, SweepCandidate } from "./ledger-relay-producers.ts";

export interface SweepOutcome {
  readonly superseded?: ReadonlyArray<{ runId: string; supersededBy: number }>;
  /** Producer run ids whose rerun POSTs succeeded, in dispatch order. */
  readonly rerunDispatched?: readonly string[];
  readonly examined: number;
  readonly relayed: ReadonlyArray<{ context: string; runId: string }>;
}

export interface SweepDeps extends ProducerDeps {
  decide: (
    pinMap: PinMap, runPath: string, runConclusion: string | null, jobs: readonly RelayJob[],
  ) => ContextDecision[];
  triggerRunId: string;
  triggerRun?: SweepCandidate;
  triggerJobs?: Record<string, unknown>;
  /** A refused trigger cannot participate in producer selection or healing. */
  skipTrigger?: boolean;
  rerunToken?: string;
  rerun?: (runId: string, token: string) => Promise<unknown>;
}

/**
 * The missing-context computation, pure. The contexts one of whose pinned paths
 * is the candidate's path, minus contexts blocked by newer App identities or
 * an attestation of the selected producer, minus the contexts this same sweep
 * has already relayed at that commit.
 *
 * The caller restricts each context to its newest eligible producer before
 * reading jobs. `blocked` holds the producer-bound evidence GitHub returned;
 * `relayedThisSweep` records successful writes by this invocation. They stay
 * separate so a successful POST cannot be mistaken for an API attestation.
 */
export function missingContextsFor(
  pinMap: PinMap,
  candidate: SweepCandidate,
  blocked: ReadonlySet<string>,
  relayedThisSweep: ReadonlySet<string>,
): string[] {
  const missing: string[] = [];
  for (const [context, pins] of Object.entries(pinMap)) {
    if (!pinsFor(pins).includes(candidate.path)) continue;
    if (blocked.has(context) || relayedThisSweep.has(context)) continue;
    missing.push(context);
  }
  return missing;
}

/**
 * The sweep. One repository-wide listing, API-backed workflow_run resolution,
 * then one check-runs GET per distinct orphan commit, one jobs GET per missing
 * producer, and one POST per missing completed context. Recency includes the trigger and orders by run
 * id then attempt. A winning trigger is never reposted, and blocks older runs
 * even when its mirror posted nothing. Superseded non-trigger workflow_run
 * candidates remain excluded.
 * Candidates at the same commit share the attestation and this invocation's
 * relayed set, so a burst of completions on
 * one pull request head costs one check-runs GET and one post per context
 * rather than one per run.
 *
 * An attested candidate needs no publication jobs GET or POST. A newest
 * cancelled pull_request_target candidate can still need the jobs fallback
 * and heal queries, so attestation never suppresses the rerun-heal. Other
 * candidates incur no heal requests.
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
  let triggerRun = deps.triggerRun;
  // The mirror supplies resolved identity even if the trigger is absent from
  // this bounded listing. Other callers can recover a listed trigger through
  // the same validation/resolution path as orphans, without posting it.
  const listedTrigger = deps.skipTrigger !== true && deps.triggerRunId !== ""
    ? selectSweepCandidates(
      Array.isArray(listing?.workflow_runs) ? listing.workflow_runs.filter((entry: unknown) =>
        typeof entry === "object" && entry !== null &&
        idOf((entry as { id?: unknown }).id) === deps.triggerRunId,
      ) : [], deps.pinMap, "",
    )[0]
    : undefined;
  // Built as a mutable array and narrowed on return: SweepOutcome is readonly
  // so a consumer cannot push into a result it was handed, but this function
  // is the one place that accumulates.
  const relayed: Array<{ context: string; runId: string }> = [];
  const superseded: Array<{ runId: string; supersededBy: number }> = [];
  const active: SweepCandidate[] = [];
  const rerunDispatched: string[] = [];
  const rechecks = new Map<string, UpstreamPublicationCheck>();
  const bounds = new Map<string, string>();

  // Resolve BEFORE grouping: both attestation and this sweep's dedupe key are
  // the upstream PR SHA. A refusal propagates, never falling back to main.
  for (const candidate of [...candidates, ...(listedTrigger === undefined ? [] : [listedTrigger])]) {
    const isTrigger = candidate.runId === deps.triggerRunId &&
      (triggerRun === undefined || candidate.runAttempt === triggerRun.runAttempt);
    if (isTrigger && triggerRun !== undefined) {
      // The resolved trigger identity stays authoritative. Use the listing's
      // primary started-at evidence only for that same attempt.
      triggerRun.runStartedAt = candidate.runStartedAt ?? triggerRun.runStartedAt;
      continue;
    }
    if (candidate.workflowRun !== true) {
      if (isTrigger) triggerRun = candidate;
      else active.push(candidate);
      continue;
    }
    const resolved = await resolveWorkflowRunHead(
      candidate.runId,
      deps.repositoryId,
      (id) => deps.api.get(`${deps.apiRoot}/repos/${deps.repo}/actions/runs/${id}`, `the workflow run ${id}`),
      undefined,
      (sha) => readSuiteRuns((page) => deps.api.get(suiteRunsUrl(deps.apiRoot, deps.repo, sha, page), "the suite supersession listing", false)),
    );
    candidate.headSha = resolved.headSha;
    candidate.path = resolved.run.path;
    candidate.conclusion = resolved.run.conclusion;
    candidate.htmlUrl = resolved.run.htmlUrl;
    candidate.runAttempt = resolved.run.runAttempt;
    candidate.status = resolved.producerStatus;
    if (isTrigger) { triggerRun = candidate; continue; }
    if (resolved.supersededBy !== undefined) {
      superseded.push({ runId: candidate.runId, supersededBy: resolved.supersededBy });
      continue;
    }
    active.push(candidate);
    rechecks.set(candidate.runId, resolved.recheckPublication);
    if (resolved.historyBound !== undefined) bounds.set(candidate.runId, resolved.historyBound);
  }

  for (const [headSha, atHead] of groupByHeadSha([
    ...active, ...(triggerRun === undefined ? [] : [triggerRun]),
  ])) {
    const newest = newestProducersFor(deps.pinMap, atHead);
    const historyBounds = new Map<string, string>();
    for (const [context, producer] of newest) {
      const bound = bounds.get(producer.runId);
      if (bound !== undefined) historyBounds.set(context, bound);
    }
    const hasOrphans = atHead.some((candidate) => candidate !== triggerRun);
    const blocked = hasOrphans ? await publicationBlockedContexts(deps, headSha, newest, historyBounds) : new Set<string>();
    const relayedThisSweep = new Set<string>();
    const jobsBodies = new Map<SweepCandidate, Record<string, unknown>>();
    if (triggerRun !== undefined && deps.triggerJobs !== undefined) jobsBodies.set(triggerRun, deps.triggerJobs);
    for (const candidate of atHead) {
      if (candidate === triggerRun) continue;
      const missing = new Set(
        missingContextsFor(deps.pinMap, candidate, blocked, relayedThisSweep)
          .filter((context) => newest.get(context) === candidate),
      );
      if (missing.size === 0) continue;
      const jobsBody = bounds.has(candidate.runId) ? { jobs: [] } : await deps.api.get<Record<string, unknown>>(
        `${deps.apiRoot}/repos/${deps.repo}/actions/runs/${candidate.runId}/jobs?filter=latest&per_page=100`,
        `the job listing of run ${candidate.runId}`,
      );
      jobsBodies.set(candidate, jobsBody);
      const jobs = validateJobs(jobsBody);
      const state = await publicationState(rechecks.get(candidate.runId));
      const bound = state.historyBound ?? bounds.get(candidate.runId);
      if (state.supersededBy !== undefined && bound === undefined) {
        superseded.push({ runId: candidate.runId, supersededBy: state.supersededBy });
        continue;
      }
      const decisions = (bound === undefined
        ? deps.decide(deps.pinMap, candidate.path, candidate.conclusion, jobs)
        : [historyBoundDecision(bound)]).filter((decision) => missing.has(decision.context));
      for (const decision of decisions) {
        // Only completed decisions are attested. An unfinished decision gets
        // no POST and remains eligible for a later sweep once it concludes.
        if (decision.status !== "completed") continue;
        const posted = await postProducerCheck(deps, decision, candidate, rechecks.get(candidate.runId));
        if (posted === undefined) continue;
        relayed.push({ context: decision.context, runId: candidate.runId });
        relayedThisSweep.add(decision.context);
      }
    }
    // Attestation does not suppress healing: an already-attested cancellation
    // can still be the newest producer whose pending relay start was displaced.
    for (const candidate of new Set(newest.values())) {
      if (await healCandidate(deps, candidate, jobsBodies.get(candidate))) rerunDispatched.push(candidate.runId);
    }
  }
  return { examined: candidates.length, relayed, ...(superseded.length > 0 ? { superseded } : {}),
    ...(rerunDispatched.length > 0 ? { rerunDispatched } : {}) };
}

const LIVE_RUN_STATUSES = new Set(["queued", "in_progress", "pending", "waiting", "requested"]);

/** Heal only newest producers, preserving the cheap guards and query order. */
async function healCandidate(deps: SweepDeps, run: SweepCandidate, jobsBody?: Record<string, unknown>): Promise<boolean> {
  if (run.conclusion !== "cancelled" || !isHealableEvent(run.event ?? "")) return false;
  // Require the workflow credential before the cap and queries, but never for
  // a non-cancelled or non-healable producer.
  const token = deps.rerunToken ?? "";
  if (token === "") throw new Error("RELAY_RERUN_TOKEN is required");
  if (run.runAttempt >= RERUN_ATTEMPT_CAP) return false;
  if (run.runStartedAt != null) return false;
  const evidence = { runStartedAt: null, anyJobStarted: anyJobStartedOf(jobsBody ?? await deps.api.get(
    `${deps.apiRoot}/repos/${deps.repo}/actions/runs/${run.runId}/jobs?filter=latest&per_page=100`,
    `the job listing of run ${run.runId}`,
  )) };
  if (evidence.anyJobStarted) return false;
  const pulls = await deps.api.get<unknown>(
    `${deps.apiRoot}/repos/${deps.repo}/commits/${run.headSha}/pulls?per_page=100`,
    `the pull requests associated with commit ${run.headSha}`,
  );
  const pr = openPullRequestsAtHead(pulls, run.headSha)[0] ?? null;
  if (pr === null) return false;
  const listing = await deps.api.get<Record<string, unknown>>(
    `${deps.apiRoot}/repos/${deps.repo}/actions/runs?head_sha=${run.headSha}&per_page=100`,
    `the workflow-run listing at ${run.headSha}`,
  );
  // A malformed live-run listing reads as absent; GitHub's own rerun guard
  // bounds this direction by refusing a live duplicate with a visible 4xx.
  const live = (Array.isArray(listing.workflow_runs) ? listing.workflow_runs : []).some((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) return false;
    const candidate = entry as { path?: unknown; status?: unknown };
    return candidate.path === run.path && LIVE_RUN_STATUSES.has(String(candidate.status));
  });
  if (!decideRerun({ ...run, event: run.event ?? "" }, pr, live, evidence)) return false;
  if (deps.rerun === undefined) throw new Error("the rerun transport is required");
  await deps.rerun(run.runId, token);
  return true;
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
  const healLines = (outcome.rerunDispatched ?? []).map((id) =>
    `[ledger-relay] rerun-heal: cancelled run ${id} was re-dispatched; its completion event will mirror the real conclusion`);
  if (outcome.examined === 0) return healLines;
  const lines = [...healLines,
    `[ledger-relay] orphan-sweep: examined ${outcome.examined} completed run(s), ` +
      `relayed ${outcome.relayed.length} context(s)`,
  ];
  for (const entry of outcome.superseded ?? []) {
    lines.push(`[ledger-relay] orphan-sweep: run ${entry.runId} ${supersessionMessage(entry.supersededBy)}`);
  }
  for (const entry of outcome.relayed) {
    lines.push(
      `[ledger-relay] orphan-sweep: relayed ${entry.context} from run ${entry.runId} ` +
        "(no App check-run existed for it)",
    );
  }
  return lines;
}
