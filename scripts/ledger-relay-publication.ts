// Every producer refreshes recency after its App write commits and can make
// one producer correction. Deterministic exhaustion requires a negative bound
// certificate even after that correction. Workflow-run producers retain suite checks
// before/after publication; ordinary API failures still throw.

import { decideContexts, type ContextDecision } from "./ledger-relay-decisions.ts";
import {
  attestedContexts, checkRunBody, newestProducersFor, selectSweepCandidates,
  validateJobs, type ProducerDeps, type SweepCandidate,
} from "./ledger-relay-producers.ts";
import { resolveWorkflowRunHead, type UpstreamPublicationCheck } from "./ledger-relay-upstream.ts";
import { readSuiteRuns, SuiteHistoryBoundError, suiteRunsUrl } from "./pr-suite-supersession.ts";

export interface PublicationState { supersededBy?: number; historyBound?: string; upstreamConclusion?: string | null }
export interface Correction { runId: string; decision: ContextDecision }

/** Classify only deterministic history exhaustion; never convert a read error to a result. */
export async function publicationState(check?: UpstreamPublicationCheck): Promise<PublicationState> {
  try {
    return await check?.() ?? {};
  } catch (error) {
    if (!(error instanceof SuiteHistoryBoundError)) throw error;
    return { historyBound: error.message };
  }
}

export function historyBoundDecision(bound: string): ContextDecision {
  return {
    context: "verify", status: "completed", conclusion: "failure",
    title: "verify: suite history bound exceeded",
    summary: `${bound}; supersession cannot be established, so verify fails closed at this head.`,
  };
}

/** Recheck before every write; null means suppressed, undefined means posted without correction. */
export async function postProducerCheck(
  deps: ProducerDeps,
  decision: ContextDecision,
  run: SweepCandidate,
  check?: UpstreamPublicationCheck,
): Promise<Correction | undefined | null> {
  const checked = publicationDecision(decision, await publicationState(check), run);
  if (checked === undefined) return null;
  await writeCheck(deps, checked, run);
  const correction = await repairAfterPost(deps, checked, run, check, await publicationState(check));
  return correction ?? (checked === decision ? undefined : { runId: run.runId, decision: checked });
}

/** A successful verify job may be a cancellation no-op, never an App certificate. */
function publicationDecision(decision: ContextDecision, state: PublicationState, run: SweepCandidate): ContextDecision | undefined {
  if (state.historyBound !== undefined) return historyBoundDecision(state.historyBound);
  if (state.supersededBy !== undefined) return undefined;
  if (decision.conclusion === "success" && "upstreamConclusion" in state && state.upstreamConclusion !== "success") {
    console.log(`[ledger-relay] run ${run.runId}: upstream ${state.upstreamConclusion ?? "unknown"}; no success posted`);
    return undefined;
  }
  return decision;
}

async function writeCheck(deps: ProducerDeps, decision: ContextDecision, run: SweepCandidate): Promise<void> {
  await deps.api.postCheckRun(checkRunBody(decision, run), `the check-run for ${decision.context}`);
}

/** One producer correction, plus any mandatory bound certificate. Never reselect or loop after correction. */
async function repairAfterPost(
  deps: ProducerDeps,
  original: ContextDecision,
  run: SweepCandidate,
  check: UpstreamPublicationCheck | undefined,
  state: PublicationState,
): Promise<Correction | undefined> {
  const newest = await newestCandidate(deps, run.headSha, original.context,
    state.supersededBy === undefined ? {
      run: { ...run, status: run.status ?? original.status }, check, historyBound: state.historyBound,
    } : undefined);
  if (state.historyBound !== undefined && (newest === undefined || newest.run.status !== "completed")) {
    // Keep the bound's negative direction without a completed replacement.
    if (original.conclusion === "failure" && original.summary.includes(state.historyBound)) return;
    const decision = historyBoundDecision(state.historyBound);
    await writeCheck(deps, decision, run);
    await publicationState(check);
    return { runId: run.runId, decision };
  }
  // A replacement without a completed eligible producer waits for its own completion relay.
  if (newest === undefined || newest.run.status !== "completed") return;
  const attested = await attestedContexts(deps, run.headSha, new Map([[original.context, newest.run]]));
  const boundAlreadyPublished = newest.historyBound !== undefined && newest.run.runId === run.runId
    && newest.run.runAttempt === run.runAttempt && original.conclusion === "failure"
    && original.summary.includes(newest.historyBound);
  // Identity alone cannot preserve a green certificate when history is exhausted.
  if (attested.has(original.context) && (newest.historyBound === undefined || boundAlreadyPublished)) return;
  const proposed = newest.historyBound === undefined
    ? decideContexts(deps.pinMap, newest.run.path, newest.run.conclusion, validateJobs(
      await deps.api.get<Record<string, unknown>>(
        `${deps.apiRoot}/repos/${deps.repo}/actions/runs/${newest.run.runId}/jobs?filter=latest&per_page=100`,
        `the corrective job listing of run ${newest.run.runId}`,
      ),
    )).find((entry) => entry.context === original.context)
    : historyBoundDecision(newest.historyBound);
  if (proposed === undefined) throw new Error("the newest producer has no pinned corrective context");
  const decision = publicationDecision(proposed, await publicationState(newest.check), newest.run);
  if (decision === undefined) return;
  await writeCheck(deps, decision, newest.run);
  const afterCorrection = await publicationState(newest.check);
  // A deterministic bound must leave its negative certificate, even after a correction.
  // No new producer selection: the corrective-write race remains for the next scheduled sweep.
  if (afterCorrection.historyBound !== undefined && (decision.conclusion !== "failure"
    || !decision.summary.includes(afterCorrection.historyBound))) {
    const failure = historyBoundDecision(afterCorrection.historyBound);
    await writeCheck(deps, failure, newest.run);
    await publicationState(newest.check); // Transient read errors still throw; a repeated bound never loops.
    return { runId: newest.run.runId, decision: failure };
  }
  return { runId: newest.run.runId, decision };
}

interface ResolvedCandidate { run: SweepCandidate; check?: UpstreamPublicationCheck; historyBound?: string }

/** Resolve completed eligible producers in the sweep's id/attempt order; unfinished runs are ignored. */
async function newestCandidate(
  deps: ProducerDeps, headSha: string, context: string, posted?: ResolvedCandidate,
): Promise<ResolvedCandidate | undefined> {
  const listing = await deps.api.get<Record<string, unknown>>(
    `${deps.apiRoot}/repos/${deps.repo}/actions/runs?per_page=100`, "the post-write producer listing",
  );
  if (!Array.isArray(listing?.workflow_runs)) throw new Error("the post-write producer listing returned no runs array");
  const contextPins = { [context]: deps.pinMap[context] };
  // Keep the completed just-posted producer even if the listing omits it.
  const completedPosted = posted?.run.status === "completed" ? posted : undefined;
  const eligible: SweepCandidate[] = completedPosted === undefined ? [] : [completedPosted.run];
  const resolved = new Map<SweepCandidate, ResolvedCandidate>(completedPosted === undefined ? [] : [[completedPosted.run, completedPosted]]);
  for (const candidate of selectSweepCandidates(listing.workflow_runs, contextPins, "")) {
    candidate.status = "completed";
    let entry: ResolvedCandidate = { run: candidate };
    if (candidate.workflowRun === true) {
      const upstream = await resolveWorkflowRunHead(
        candidate.runId, deps.repositoryId,
        (id) => deps.api.get(`${deps.apiRoot}/repos/${deps.repo}/actions/runs/${id}`, `the workflow run ${id}`),
        undefined,
        (sha) => readSuiteRuns((page) => deps.api.get(
          suiteRunsUrl(deps.apiRoot, deps.repo, sha, page), "the suite supersession listing", false,
        )),
      );
      if (upstream.supersededBy !== undefined) continue;
      Object.assign(candidate, {
        headSha: upstream.headSha, runAttempt: upstream.run.runAttempt,
        path: upstream.run.path, conclusion: upstream.run.conclusion,
        htmlUrl: upstream.run.htmlUrl, status: upstream.producerStatus,
      });
      entry = { run: candidate, check: upstream.recheckPublication, historyBound: upstream.historyBound };
    }
    if (candidate.status !== "completed" || candidate.headSha !== headSha) continue;
    eligible.push(candidate);
    resolved.set(candidate, entry);
  }
  const winner = newestProducersFor(contextPins, eligible).get(context);
  return winner === undefined ? undefined : resolved.get(winner);
}

/** Cohesive mirror publication keeps ledger-relay.ts below its module ceiling. */
export async function publishProducerContexts(
  deps: ProducerDeps,
  run: SweepCandidate,
  jobsBody: Record<string, unknown>,
  check?: UpstreamPublicationCheck,
  initialBound?: string,
): Promise<{ decisions: ContextDecision[]; posted: string[]; supersededBy?: number }> {
  const jobs = initialBound === undefined ? validateJobs(jobsBody) : [];
  const state = await publicationState(check);
  const bound = state.historyBound ?? initialBound;
  if (state.supersededBy !== undefined && bound === undefined) return { decisions: [], posted: [], supersededBy: state.supersededBy };
  const proposed = bound === undefined
    ? decideContexts(deps.pinMap, run.path, run.conclusion, jobs)
    : [historyBoundDecision(bound)];
  const decisions: ContextDecision[] = [];
  const posted: string[] = [];
  for (const decision of proposed) {
    const correction = await postProducerCheck(deps, decision, run, check);
    if (correction === null) continue;
    posted.push(decision.context);
    decisions.push(correction?.decision ?? decision);
  }
  return { decisions, posted };
}
