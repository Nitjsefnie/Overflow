// Workflow-run publication has two supersession boundaries: before POST and
// after the server has committed it. The latter repairs a delayed stale write
// with at most one corrective POST; ordinary API failures still throw.

import { decideContexts, type ContextDecision } from "./ledger-relay-decisions.ts";
import {
  attestedContexts, checkRunBody, newestProducersFor, selectSweepCandidates,
  validateJobs, type ProducerDeps, type SweepCandidate,
} from "./ledger-relay-producers.ts";
import { resolveWorkflowRunHead } from "./ledger-relay-upstream.ts";
import { readSuiteRuns, SuiteHistoryBoundError, suiteRunsUrl } from "./pr-suite-supersession.ts";

export type SupersessionCheck = () => Promise<number | undefined>;
export interface PublicationState { supersededBy?: number; historyBound?: string }
export interface Correction { runId: string; decision: ContextDecision }

/** Classify only deterministic history exhaustion; never convert a read error to a result. */
export async function publicationState(check?: SupersessionCheck): Promise<PublicationState> {
  try {
    return { supersededBy: await check?.() };
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

/** All workflow_run writes, including a cap failure, get a fresh post-write read. */
export async function postProducerCheck(
  deps: ProducerDeps,
  decision: ContextDecision,
  run: SweepCandidate,
  check?: SupersessionCheck,
): Promise<Correction | undefined> {
  await writeCheck(deps, decision, run);
  if (check === undefined) return;
  return repairAfterPost(deps, decision, run, check, await publicationState(check));
}

async function writeCheck(deps: ProducerDeps, decision: ContextDecision, run: SweepCandidate): Promise<void> {
  await deps.api.postCheckRun(checkRunBody(decision, run), `the check-run for ${decision.context}`);
}

/** One original write, at most one correction. A corrective recheck never starts another correction. */
async function repairAfterPost(
  deps: ProducerDeps,
  original: ContextDecision,
  run: SweepCandidate,
  check: SupersessionCheck,
  state: PublicationState,
): Promise<Correction | undefined> {
  if (state.historyBound !== undefined) {
    // The original negative cap certificate already names this bound.
    if (original.conclusion === "failure" && original.summary.includes(state.historyBound)) return;
    const decision = historyBoundDecision(state.historyBound);
    await writeCheck(deps, decision, run);
    await publicationState(check); // The cap certificate remains failure; read errors still throw.
    return { runId: run.runId, decision };
  }
  if (state.supersededBy === undefined) return;
  const newest = await newestCandidate(deps, run.headSha, original.context);
  // A queued/running or not-yet-created replacement is attested by its own completion relay.
  if (newest === undefined || newest.run.status !== "completed") return;
  if (newest.historyBound === undefined) {
    const attested = await attestedContexts(deps, run.headSha, new Map([[original.context, newest.run]]));
    if (attested.has(original.context)) return;
  }
  const decision = newest.historyBound === undefined
    ? decideContexts(deps.pinMap, newest.run.path, newest.run.conclusion, validateJobs(
      await deps.api.get<Record<string, unknown>>(
        `${deps.apiRoot}/repos/${deps.repo}/actions/runs/${newest.run.runId}/jobs?filter=latest&per_page=100`,
        `the corrective job listing of run ${newest.run.runId}`,
      ),
    )).find((entry) => entry.context === original.context)
    : historyBoundDecision(newest.historyBound);
  if (decision === undefined) throw new Error("the newest producer has no pinned corrective context");
  await writeCheck(deps, decision, newest.run);
  const afterCorrection = await publicationState(newest.check);
  // No second corrective POST. A newly exhausted history after a positive
  // correction is red so the next sweep can publish the bound's failure.
  if (afterCorrection.historyBound !== undefined && decision.conclusion !== "failure") {
    throw new SuiteHistoryBoundError();
  }
  return { runId: newest.run.runId, decision };
}

interface ResolvedCandidate { run: SweepCandidate; check?: SupersessionCheck; historyBound?: string }

/** Resolve the same eligible producer class and id/attempt order as the sweep, including live blockers. */
async function newestCandidate(deps: ProducerDeps, headSha: string, context: string): Promise<ResolvedCandidate | undefined> {
  const listing = await deps.api.get<Record<string, unknown>>(
    `${deps.apiRoot}/repos/${deps.repo}/actions/runs?per_page=100`, "the post-write producer listing",
  );
  if (!Array.isArray(listing?.workflow_runs)) throw new Error("the post-write producer listing returned no runs array");
  const contextPins = { [context]: deps.pinMap[context] };
  const eligible: SweepCandidate[] = [];
  const resolved = new Map<SweepCandidate, ResolvedCandidate>();
  for (const candidate of selectSweepCandidates(listing.workflow_runs, contextPins, "", true)) {
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
      entry = { run: candidate, check: upstream.recheckSupersession, historyBound: upstream.historyBound };
    }
    if (candidate.headSha !== headSha) continue;
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
  check?: SupersessionCheck,
  initialBound?: string,
): Promise<{ decisions: ContextDecision[]; posted: string[]; supersededBy?: number }> {
  const jobs = initialBound === undefined ? validateJobs(jobsBody) : [];
  const state = await publicationState(check);
  const bound = state.historyBound ?? initialBound;
  if (state.supersededBy !== undefined && bound === undefined) return { decisions: [], posted: [], supersededBy: state.supersededBy };
  const decisions = bound === undefined
    ? decideContexts(deps.pinMap, run.path, run.conclusion, jobs)
    : [historyBoundDecision(bound)];
  const posted: string[] = [];
  for (let index = 0; index < decisions.length; index += 1) {
    const decision = decisions[index];
    const correction = await postProducerCheck(deps, decision, run, check);
    posted.push(decision.context);
    if (correction !== undefined) decisions[index] = correction.decision;
  }
  return { decisions, posted };
}
