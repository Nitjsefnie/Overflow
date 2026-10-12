// Shared producer selection and App check plumbing. The mirror, sweep and
// post-write correction use one identity formatter and one recency rule.

import { isTrustedProducerRun, pinsFor, type ContextDecision, type PinMap, type RelayJob } from "./ledger-relay-decisions.ts";
import { normalizedAttempt } from "./ledger-relay-trigger.ts";

/** A bounded recent-producer window; the trigger is retained independently. */
export const SWEEP_RUN_LIMIT = 20;

export interface SweepCandidate {
  runId: string;
  runAttempt: number;
  headSha: string;
  path: string;
  conclusion: string | null;
  htmlUrl: string;
  workflowRun?: true;
  /** Present when selection admits unfinished producers as recency blockers. */
  status?: string;
}

export interface SweepApi {
  get<T>(url: string, what: string, retryTransient?: boolean): Promise<T>;
  postCheckRun(body: Record<string, unknown>, what: string): Promise<unknown>;
}

export interface ProducerDeps {
  api: SweepApi;
  pinMap: PinMap;
  apiRoot: string;
  repo: string;
  appId: string;
  repositoryId?: string;
}

/** Select eligible pinned runs. Correction admits live producers so they block older writes. */
export function selectSweepCandidates(
  entries: unknown,
  pinMap: PinMap,
  triggerRunId: string,
  includeUnfinished = false,
): SweepCandidate[] {
  if (!Array.isArray(entries)) return [];
  const pinnedPaths = new Set(Object.values(pinMap).flatMap(pinsFor));
  const candidates: SweepCandidate[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const run = entry as {
      id?: unknown; path?: unknown; status?: unknown; conclusion?: unknown;
      head_sha?: unknown; html_url?: unknown; event?: unknown; head_branch?: unknown; run_attempt?: unknown;
    };
    if (!includeUnfinished && run.status !== "completed") continue;
    if (typeof run.path !== "string" || !pinnedPaths.has(run.path)) continue;
    if (
      run.event !== "workflow_run" && !isTrustedProducerRun(
        typeof run.event === "string" ? run.event : "",
        typeof run.head_branch === "string" ? run.head_branch : "",
      )
    ) continue;
    const runId = idOf(run.id);
    if (runId === "" || runId === triggerRunId) continue;
    if (typeof run.head_sha !== "string" || run.head_sha === "") continue;
    if (typeof run.html_url !== "string" || run.html_url === "") continue;
    if (candidates.length === SWEEP_RUN_LIMIT) break;
    candidates.push({
      runId,
      runAttempt: normalizedAttempt(
        typeof run.run_attempt === "number" || typeof run.run_attempt === "string" ? run.run_attempt : undefined,
      ),
      headSha: run.head_sha,
      path: run.path,
      conclusion: typeof run.conclusion === "string" ? run.conclusion : null,
      htmlUrl: run.html_url,
      ...(run.event === "workflow_run" ? { workflowRun: true as const } : {}),
      ...(includeUnfinished ? { status: typeof run.status === "string" ? run.status : "" } : {}),
    });
  }
  return candidates;
}

/** Highest numeric producer id, then attempt, across every pinned path at one resolved SHA. */
export function newestProducersFor(pinMap: PinMap, candidates: readonly SweepCandidate[]): Map<string, SweepCandidate> {
  const newest = new Map<string, SweepCandidate>();
  for (const candidate of candidates) {
    for (const [context, pins] of Object.entries(pinMap)) {
      if (!pinsFor(pins).includes(candidate.path)) continue;
      const previous = newest.get(context);
      if (
        previous === undefined || BigInt(candidate.runId) > BigInt(previous.runId) ||
        (BigInt(candidate.runId) === BigInt(previous.runId) && candidate.runAttempt > previous.runAttempt)
      ) newest.set(context, candidate);
    }
  }
  return newest;
}

/** Latest concluded App checks must carry the selected producer's exact id:attempt identity. */
export async function attestedContexts(
  deps: ProducerDeps,
  headSha: string,
  newest: ReadonlyMap<string, SweepCandidate>,
): Promise<Set<string>> {
  const body = await deps.api.get<Record<string, unknown>>(
    `${deps.apiRoot}/repos/${deps.repo}/commits/${headSha}/check-runs?app_id=${deps.appId}&filter=latest&per_page=100`,
    `the ledger App's check-runs at ${headSha}`,
  );
  const attested = new Set<string>();
  if (!Array.isArray(body.check_runs)) return attested;
  for (const entry of body.check_runs) {
    if (typeof entry !== "object" || entry === null) continue;
    const checkRun = entry as {
      name?: unknown; status?: unknown; external_id?: unknown; app?: { id?: unknown };
    };
    if (typeof checkRun.name !== "string") continue;
    if (String(checkRun.app?.id ?? "") !== deps.appId) continue;
    if (checkRun.status === "queued" || checkRun.status === "in_progress") continue;
    const producer = newest.get(checkRun.name);
    if (producer === undefined || checkRun.external_id !== producerExternalId(producer)) continue;
    attested.add(checkRun.name);
  }
  return attested;
}

/** Both duties pass the resolved PR SHA for workflow_run; never the producer's main tip. */
export function checkRunBody(
  decision: ContextDecision,
  run: { runId: string; runAttempt: number; headSha: string; htmlUrl: string },
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: decision.context, head_sha: run.headSha, status: decision.status,
    output: { title: decision.title, summary: decision.summary },
    details_url: run.htmlUrl, external_id: producerExternalId(run),
  };
  if (decision.conclusion !== undefined) body.conclusion = decision.conclusion;
  return body;
}

export function producerExternalId(run: { runId: string; runAttempt: number }): string {
  return `${run.runId}:${run.runAttempt}`;
}

export function validateJobs(body: Record<string, unknown>): RelayJob[] {
  if (!Array.isArray(body.jobs)) throw new Error("the job listing returned no jobs array");
  const jobs: RelayJob[] = [];
  for (const entry of body.jobs) {
    const job = entry as Partial<RelayJob> | null;
    if (typeof job?.name !== "string") throw new Error("the job listing holds an entry without a name");
    jobs.push({
      name: job.name,
      run_attempt: typeof job.run_attempt === "number" ? job.run_attempt : 1,
      status: job.status === "in_progress" || job.status === "completed" ? job.status : "queued",
      conclusion: typeof job.conclusion === "string" ? job.conclusion : null,
    });
  }
  return jobs;
}

export function idOf(value: unknown): string {
  if (typeof value === "number" && Number.isInteger(value)) return String(value);
  if (typeof value === "string" && value !== "") return value;
  return "";
}
