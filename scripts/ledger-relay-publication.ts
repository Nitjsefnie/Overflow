// The mirror selects the newest completed eligible producer before writing.
// Both duties recheck suite supersession and upstream success before each POST;
// deterministic history exhaustion becomes a negative certificate at that point.
// Serialized relay starts need no post-write correction.

import { decideContexts, pinsFor, type ContextDecision } from "./ledger-relay-decisions.ts";
import {
  publicationBlockedContexts, checkRunBody, newestProducersFor, selectSweepCandidates,
  validateJobs, producerExternalId, type CheckRunPostResult, type CheckRunSuppression,
  type ProducerDeps, type SweepCandidate,
} from "./ledger-relay-producers.ts";
import { resolveWorkflowRunHead, type UpstreamPublicationCheck } from "./ledger-relay-upstream.ts";
import { readSuiteRuns, SuiteHistoryBoundError, suiteRunsUrl } from "./pr-suite-supersession.ts";

export interface PublicationState { supersededBy?: number; historyBound?: string; upstreamConclusion?: string | null }

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

/** Return the posted decision, a newer App floor, or no decision after an upstream refusal. */
export async function postProducerCheck(
  deps: ProducerDeps,
  decision: ContextDecision,
  run: SweepCandidate,
  check?: UpstreamPublicationCheck,
): Promise<ContextDecision | CheckRunSuppression | undefined> {
  const checked = publicationDecision(decision, await publicationState(check), run);
  if (checked === undefined) return;
  const posted = await writeCheck(deps, checked, run);
  if (posted !== undefined && "suppressedBy" in posted) return {
    context: checked.context, headSha: run.headSha, externalId: producerExternalId(run), suppressedBy: posted.suppressedBy,
  };
  return checked;
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

async function writeCheck(deps: ProducerDeps, decision: ContextDecision, run: SweepCandidate): Promise<CheckRunPostResult> {
  return deps.api.postCheckRun(checkRunBody(decision, run), `the check-run for ${decision.context}`);
}

interface ResolvedCandidate { run: SweepCandidate; check?: UpstreamPublicationCheck; historyBound?: string }

/** Resolve completed eligible producers in the sweep's id/attempt order; unfinished runs are ignored. */
async function newestCandidate(
  deps: ProducerDeps, headSha: string, context: string, trigger: ResolvedCandidate,
): Promise<ResolvedCandidate | undefined> {
  const listing = await deps.api.get<Record<string, unknown>>(
    `${deps.apiRoot}/repos/${deps.repo}/actions/runs?per_page=100`, "the pre-write producer listing",
  );
  if (!Array.isArray(listing?.workflow_runs)) throw new Error("the pre-write producer listing returned no runs array");
  const contextPins = { [context]: deps.pinMap[context] };
  // Retain the completed trigger even if the bounded listing omits it.
  const completed = trigger.run.status === "completed";
  const eligible: SweepCandidate[] = completed ? [trigger.run] : [];
  const resolved = new Map<SweepCandidate, ResolvedCandidate>(completed ? [[trigger.run, trigger]] : []);
  for (const candidate of selectSweepCandidates(listing.workflow_runs, contextPins, "")) {
    if (candidate.runId === trigger.run.runId && candidate.runAttempt === trigger.run.runAttempt) continue;
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
): Promise<{ decisions: ContextDecision[]; posted: string[]; suppressed?: CheckRunSuppression[]; supersededBy?: number }> {
  const jobs = initialBound === undefined ? validateJobs(jobsBody) : [];
  const state = await publicationState(check);
  const bound = state.historyBound ?? initialBound;
  if (state.supersededBy !== undefined && bound === undefined) return { decisions: [], posted: [], supersededBy: state.supersededBy };
  const contexts = Object.entries(deps.pinMap)
    .filter(([, pins]) => pinsFor(pins).includes(run.path)).map(([context]) => context);
  const decisions: ContextDecision[] = [];
  const posted: string[] = [];
  const suppressed: CheckRunSuppression[] = [];
  for (const context of contexts) {
    const newest = await newestCandidate(deps, run.headSha, context, {
      run: { ...run, status: run.status ?? "completed" }, check, historyBound: bound,
    });
    if (newest === undefined) continue;
    const blocked = await publicationBlockedContexts(deps, run.headSha, new Map([[context, newest.run]]),
      new Map(newest.historyBound === undefined ? [] : [[context, newest.historyBound]]));
    if (blocked.has(context)) continue;
    const selectedJobs = newest.run.runId === run.runId && newest.run.runAttempt === run.runAttempt
      ? jobs : newest.historyBound !== undefined ? [] : validateJobs(
        await deps.api.get<Record<string, unknown>>(
          `${deps.apiRoot}/repos/${deps.repo}/actions/runs/${newest.run.runId}/jobs?filter=latest&per_page=100`,
          `the job listing of run ${newest.run.runId}`,
        ),
      );
    const proposed = newest.historyBound === undefined
      ? decideContexts(deps.pinMap, newest.run.path, newest.run.conclusion, selectedJobs)
        .find((entry) => entry.context === context)
      : historyBoundDecision(newest.historyBound);
    if (proposed === undefined) throw new Error("the newest producer has no pinned context");
    const decision = await postProducerCheck(deps, proposed, newest.run, newest.check);
    if (decision === undefined) continue;
    if ("suppressedBy" in decision) {
      suppressed.push(decision);
      continue;
    }
    posted.push(context);
    decisions.push(decision);
  }
  return { decisions, posted, ...(suppressed.length > 0 ? { suppressed } : {}) };
}
