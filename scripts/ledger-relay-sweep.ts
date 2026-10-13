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
  publicationBlockedContexts, idOf, newestProducersFor, compareProducerIdentities,
  selectSweepCandidates, validateJobs, SWEEP_RUN_LIMIT, SWEEP_RUN_PAGE_LIMIT,
  type CheckRunSuppression, type ProducerDeps, type SweepCandidate,
} from "./ledger-relay-producers.ts";
import { historyBoundDecision, postProducerCheck, publicationState } from "./ledger-relay-publication.ts";
export { checkRunBody, selectSweepCandidates, validateJobs, SWEEP_RUN_LIMIT, SWEEP_RUN_PAGE_LIMIT } from "./ledger-relay-producers.ts";
export type { SweepApi, SweepCandidate } from "./ledger-relay-producers.ts";

export interface SweepOutcome {
  readonly suppressed?: readonly CheckRunSuppression[];
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
 * Resolve and publish candidates newest-first, caching App checks per resolved
 * head. A handled context excludes older producers even after a no-op. The
 * mirror's resolved trigger participates in selection and healing but is never
 * reposted. Superseded non-trigger workflow_run candidates remain excluded.
 * Attestation skips publication jobs and writes, never cancellation healing.
 */
export async function sweepOrphans(deps: SweepDeps): Promise<SweepOutcome> {
  const entries: unknown[] = [];
  for (let page = 1; page <= SWEEP_RUN_PAGE_LIMIT; page += 1) {
    const listing = await deps.api.get<Record<string, unknown>>(
      `${deps.apiRoot}/repos/${deps.repo}/actions/runs?per_page=100${page === 1 ? "" : `&page=${page}`}`,
      "the repository's workflow-run listing for the orphan sweep",
    );
    // An empty success body is an empty listing, never a property-access error.
    const runs = Array.isArray(listing?.workflow_runs) ? listing.workflow_runs : [];
    entries.push(...runs);
    if (selectSweepCandidates(entries, deps.pinMap, "").length >= SWEEP_RUN_LIMIT || runs.length < 100 ||
      (typeof listing.total_count === "number" && page * 100 >= listing.total_count)) break;
  }
  // Count the trigger inside the eligible window before excluding its mirror
  // work. The mirror still retains a resolved trigger outside this window.
  const candidates = selectSweepCandidates(entries, deps.pinMap, "")
    .filter((candidate) => candidate.runId !== deps.triggerRunId);
  let triggerRun = deps.triggerRun;
  // The mirror supplies resolved identity even if the trigger is absent from
  // this bounded listing. Other callers can recover a listed trigger through
  // the same validation/resolution path as orphans, without posting it.
  const listedTrigger = deps.skipTrigger !== true && deps.triggerRunId !== ""
    ? selectSweepCandidates(
      entries.filter((entry: unknown) =>
        typeof entry === "object" && entry !== null &&
        idOf((entry as { id?: unknown }).id) === deps.triggerRunId,
      ), deps.pinMap, "",
    )[0]
    : undefined;
  // Built as a mutable array and narrowed on return: SweepOutcome is readonly
  // so a consumer cannot push into a result it was handed, but this function
  // is the one place that accumulates.
  const relayed: Array<{ context: string; runId: string }> = [];
  const suppressed: CheckRunSuppression[] = [];
  const superseded: Array<{ runId: string; supersededBy: number }> = [];
  const rerunDispatched: string[] = [];
  const handled = new Map<string, Set<string>>();
  const appReads = new Map<string, unknown[] | undefined>();
  if (triggerRun !== undefined && listedTrigger?.runAttempt === triggerRun.runAttempt) {
    triggerRun.runStartedAt = listedTrigger.runStartedAt ?? triggerRun.runStartedAt;
  }
  const listed = listedTrigger === undefined || (triggerRun !== undefined && listedTrigger.runAttempt === triggerRun.runAttempt)
    ? [] : [listedTrigger];
  // Resolve and publish one producer at a time. Deadline exhaustion drops the
  // oldest tail, and never discards already-resolved newest work unwritten.
  const ordered = [...candidates, ...listed, ...(triggerRun === undefined ? [] : [triggerRun])]
    .sort((first, second) => compareProducerIdentities(second, first));
  for (const candidate of ordered) {
    const isTrigger = candidate === triggerRun || (triggerRun === undefined && candidate.runId === deps.triggerRunId);
    let recheck: UpstreamPublicationCheck | undefined;
    let initialBound: string | undefined;
    if (candidate.workflowRun === true && candidate !== triggerRun) {
      const resolved = await resolveWorkflowRunHead(
        candidate.runId, deps.repositoryId,
        (id) => deps.api.get(`${deps.apiRoot}/repos/${deps.repo}/actions/runs/${id}`, `the workflow run ${id}`),
        undefined,
        (sha) => readSuiteRuns((page) => deps.api.get(suiteRunsUrl(deps.apiRoot, deps.repo, sha, page), "the suite supersession listing", false)),
      );
      Object.assign(candidate, {
        headSha: resolved.headSha, path: resolved.run.path, conclusion: resolved.run.conclusion,
        htmlUrl: resolved.run.htmlUrl, runAttempt: resolved.run.runAttempt, status: resolved.producerStatus,
      });
      if (!isTrigger && resolved.supersededBy !== undefined) {
        superseded.push({ runId: candidate.runId, supersededBy: resolved.supersededBy });
        continue;
      }
      recheck = resolved.recheckPublication;
      initialBound = resolved.historyBound;
    }
    if (isTrigger && triggerRun === undefined) triggerRun = candidate;
    const atHead = handled.get(candidate.headSha) ?? new Set<string>();
    handled.set(candidate.headSha, atHead);
    const newest = newestProducersFor(deps.pinMap, [candidate]);
    for (const context of atHead) newest.delete(context);
    if (newest.size === 0) continue;
    // Even a newest no-op or upstream refusal excludes an older producer for
    // these contexts in this start. A trigger's mirror already attempted them.
    for (const context of newest.keys()) atHead.add(context);
    let jobsBody = isTrigger ? deps.triggerJobs : undefined;
    if (!isTrigger) {
      const historyBounds = new Map(initialBound === undefined ? [] : [...newest.keys()].map((context) => [context, initialBound]));
      const blocked = await publicationBlockedContexts(deps, candidate.headSha, newest, historyBounds, appReads);
      const missing = new Set(missingContextsFor(deps.pinMap, candidate, blocked, new Set())
        .filter((context) => newest.has(context)));
      if (missing.size > 0) {
        jobsBody = initialBound !== undefined ? { jobs: [] } : await deps.api.get<Record<string, unknown>>(
          `${deps.apiRoot}/repos/${deps.repo}/actions/runs/${candidate.runId}/jobs?filter=latest&per_page=100`,
          `the job listing of run ${candidate.runId}`,
        );
        const jobs = validateJobs(jobsBody);
        const state = await publicationState(recheck);
        const bound = state.historyBound ?? initialBound;
        if (state.supersededBy !== undefined && bound === undefined) {
          superseded.push({ runId: candidate.runId, supersededBy: state.supersededBy });
          continue;
        }
        const decisions = (bound === undefined
          ? deps.decide(deps.pinMap, candidate.path, candidate.conclusion, jobs)
          : [historyBoundDecision(bound)]).filter((decision) => missing.has(decision.context));
        for (const decision of decisions) {
          if (decision.status !== "completed") continue;
          const posted = await postProducerCheck(deps, decision, candidate, recheck, bound);
          if (posted === undefined) continue;
          if ("suppressedBy" in posted) { suppressed.push(posted); continue; }
          relayed.push({ context: decision.context, runId: candidate.runId });
        }
      }
    }
    // An already-attested newest cancellation can still require healing.
    if (await healCandidate(deps, candidate, jobsBody)) rerunDispatched.push(candidate.runId);
  }
  return { examined: candidates.length, relayed, ...(superseded.length > 0 ? { superseded } : {}),
    ...(suppressed.length > 0 ? { suppressed } : {}),
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
