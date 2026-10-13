// The mirror selects the newest completed eligible producer before writing,
// resolving only producers newer than its trigger.
// Both duties recheck suite supersession and upstream success before each POST;
// deterministic history exhaustion becomes a negative certificate at that point.
// Serialized relay starts need no post-write correction.

import { decideContexts, pinsFor, type ContextDecision } from "./ledger-relay-decisions.ts";
import {
  publicationBlockedContexts, checkRunBody, compareProducerIdentities, selectSweepCandidates,
  validateJobs, producerExternalId, type CheckRunPostResult, type CheckRunSuppression,
  type ProducerDeps, type SweepCandidate,
} from "./ledger-relay-producers.ts";
import { BACKOFF_MS, REQUEST_TIMEOUT_MS } from "./ledger-relay-http.ts";
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
  initialBound?: string,
): Promise<ContextDecision | CheckRunSuppression | undefined> {
  const state = await publicationState(check);
  const checked = publicationDecision(decision, state, run);
  if (checked === undefined) return;
  const posted = await writeCheck(deps, checked, run, state.historyBound ?? initialBound);
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

async function writeCheck(
  deps: ProducerDeps, decision: ContextDecision, run: SweepCandidate, historyBound?: string,
): Promise<CheckRunPostResult> {
  return deps.api.postCheckRun(checkRunBody(decision, run), `the check-run for ${decision.context}`, historyBound);
}

interface ResolvedCandidate { run: SweepCandidate; check?: UpstreamPublicationCheck; historyBound?: string }

/**
 * Rule: the mirror starts a selection request (the listing or a newer
 * candidate's resolution) only while the remaining run budget exceeds this
 * reserve; publication never consults it. It holds the chosen producer's
 * publication path with every request at the 30 s bound: App floor read
 * (check-suites + check-runs, 2), jobs read (1), upstream recheck (upstream
 * run + one suite-history page, 2), POST (1), one ambiguous-POST read-back
 * (a second floor read, 2) and one retry POST (1), plus the selection request
 * in flight when the reserve is crossed (1) and the retry backoff:
 * 10 x 30 s + (1 s + 2 s) = 303 s. Not held: suite-history pages 2-10, an
 * App floor over more than one suite or page, per-request transient
 * retries, and a second ambiguous POST; a reserve holding all of them would
 * be 573 s or more of a 600 s run and would stop selection almost at once.
 */
export const MIRROR_TRIGGER_RESERVE_MS = 10 * REQUEST_TIMEOUT_MS + BACKOFF_MS.reduce((sum, delay) => sum + delay, 0);

/** The mirror's dependencies; `remainingMs` reads the effective run deadline's remaining budget. */
export type MirrorDeps = ProducerDeps & { remainingMs?: () => number };

class MirrorReserveReached extends Error {}

/**
 * The newest completed eligible producer at this head and context. Only
 * candidates strictly newer than the trigger are resolved, newest-first and
 * one at a time, stopping at the first that resolves to this head or at the
 * budget reserve; older candidates are left to the sweep. Unfinished runs are
 * ignored.
 */
async function newestCandidate(
  deps: MirrorDeps, headSha: string, context: string, trigger: ResolvedCandidate,
): Promise<ResolvedCandidate | undefined> {
  const triggerResult = trigger.run.status === "completed" ? trigger : undefined;
  // The winner's upstream recheck captures `get`; it runs during publication,
  // after selection ends, under the ordinary run deadline only.
  let selecting = true;
  const get = async <T>(url: string, what: string, retryTransient?: boolean): Promise<T> => {
    if (selecting && deps.remainingMs !== undefined && deps.remainingMs() <= MIRROR_TRIGGER_RESERVE_MS) {
      throw new MirrorReserveReached();
    }
    return deps.api.get<T>(url, what, retryTransient);
  };
  try {
    return await selectNewer(deps, headSha, context, trigger, get, triggerResult);
  } finally {
    selecting = false;
  }
}

/** The selection itself; `get` refuses new requests at the reserve only while it runs. */
async function selectNewer(
  deps: MirrorDeps, headSha: string, context: string, trigger: ResolvedCandidate,
  get: <T>(url: string, what: string, retryTransient?: boolean) => Promise<T>,
  triggerResult: ResolvedCandidate | undefined,
): Promise<ResolvedCandidate | undefined> {
  let listing: Record<string, unknown>;
  try {
    listing = await get(`${deps.apiRoot}/repos/${deps.repo}/actions/runs?per_page=100`, "the pre-write producer listing");
  } catch (error) {
    if (error instanceof MirrorReserveReached) return triggerResult;
    throw error;
  }
  if (!Array.isArray(listing?.workflow_runs)) throw new Error("the pre-write producer listing returned no runs array");
  // selectSweepCandidates orders by run id, then attempt, newest first.
  const newer = selectSweepCandidates(listing.workflow_runs, { [context]: deps.pinMap[context] }, "")
    .filter((candidate) => compareProducerIdentities(candidate, trigger.run) > 0);
  for (const candidate of newer) {
    candidate.status = "completed";
    let entry: ResolvedCandidate = { run: candidate };
    if (candidate.workflowRun === true) {
      let upstream: Awaited<ReturnType<typeof resolveWorkflowRunHead>>;
      try {
        upstream = await resolveWorkflowRunHead(
          candidate.runId, deps.repositoryId,
          (id) => get(`${deps.apiRoot}/repos/${deps.repo}/actions/runs/${id}`, `the workflow run ${id}`),
          undefined,
          (sha) => readSuiteRuns((page) => get(
            suiteRunsUrl(deps.apiRoot, deps.repo, sha, page), "the suite supersession listing", false,
          )),
        );
      } catch (error) {
        // The reserve stops selection; the trigger's decision is posted instead.
        if (error instanceof MirrorReserveReached) break;
        throw error;
      }
      if (upstream.supersededBy !== undefined) continue;
      Object.assign(candidate, {
        headSha: upstream.headSha, runAttempt: upstream.run.runAttempt,
        path: upstream.run.path, conclusion: upstream.run.conclusion,
        htmlUrl: upstream.run.htmlUrl, status: upstream.producerStatus,
      });
      entry = { run: candidate, check: upstream.recheckPublication, historyBound: upstream.historyBound };
    }
    if (candidate.status !== "completed" || candidate.headSha !== headSha) continue;
    // Resolution reads the run's current attempt, which may equal the trigger's.
    if (compareProducerIdentities(candidate, trigger.run) > 0) return entry;
  }
  // The completed trigger is retained even if the bounded listing omits it.
  return triggerResult;
}

/** Cohesive mirror publication keeps ledger-relay.ts below its module ceiling. */
export async function publishProducerContexts(
  deps: MirrorDeps,
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
    const decision = await postProducerCheck(deps, proposed, newest.run, newest.check, newest.historyBound);
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
