// The relay's job-start budget. The job's timeout-minutes also covers the
// runner's "Set up job" phase (action downloads), which no step timeout
// bounds, so a deadline measured from the script's own entry cannot keep a
// write inside the job. The run deadline is therefore also measured from the
// job's own started_at, read before any write; an unknown start fails red.
import { API_HEADERS, API_ROOT, REQUEST_TIMEOUT_MS, apiCall, type RelayHttpDeps } from "./ledger-relay-http.ts";

/** The relay job's id in ledger-relay.yml; with no `name:` it is also the job's API name. */
export const RELAY_JOB_NAME = "relay-required-checks";
/** ledger-relay.yml's job timeout-minutes; tests/ci/ledger-relay-workflow.test.ts ties the two. */
export const RELAY_JOB_TIMEOUT_MINUTES = 16;
/**
 * Slack after the last request's own bound: its retry backoff, process
 * teardown, and skew between the runner's clock and the API's started_at.
 */
export const JOB_DEADLINE_MARGIN_MS = 60_000;

export interface RelayJobIdentity {
  repo: string;
  runId: string;
  runAttempt: string;
  workflowToken: string;
}

/** The started_at of the one job named RELAY_JOB_NAME in a run-attempt job listing; throws otherwise. */
export function relayJobStartedAt(body: unknown): number {
  const jobs = typeof body === "object" && body !== null ? (body as { jobs?: unknown }).jobs : undefined;
  if (!Array.isArray(jobs)) throw new Error("the relay's own job listing has no jobs array");
  const matches = jobs.filter((job): job is { started_at?: unknown } =>
    typeof job === "object" && job !== null && (job as { name?: unknown }).name === RELAY_JOB_NAME);
  if (matches.length !== 1) {
    throw new Error(`the relay's own job listing must name exactly one ${RELAY_JOB_NAME} job, found ${matches.length}`);
  }
  const startedAt = matches[0].started_at;
  const ms = typeof startedAt === "string" ? Date.parse(startedAt) : Number.NaN;
  if (!Number.isFinite(ms)) {
    throw new Error(`the relay's own ${RELAY_JOB_NAME} job has no valid started_at (${JSON.stringify(startedAt)})`);
  }
  return ms;
}

/** The last instant a request may start and still finish, with margin, inside the job. */
export function jobStartDeadline(startedAtMs: number): number {
  return startedAtMs + RELAY_JOB_TIMEOUT_MINUTES * 60_000 - REQUEST_TIMEOUT_MS - JOB_DEADLINE_MARGIN_MS;
}

/**
 * The effective run deadline: the earlier of the entry deadline already in
 * `deps` and the job-start deadline. Throws, having made no write, when the
 * listing cannot be read or proven, or when no request may start any more.
 */
export async function readEffectiveDeadline(deps: RelayHttpDeps, job: RelayJobIdentity): Promise<number> {
  const body = await apiCall<unknown>(deps, {
    url: `${API_ROOT}/repos/${job.repo}/actions/runs/${job.runId}/attempts/${job.runAttempt}/jobs?per_page=100`,
    method: "GET",
    headers: { ...API_HEADERS, authorization: `Bearer ${job.workflowToken}` },
  }, `the relay's own job listing (run ${job.runId}, attempt ${job.runAttempt})`);
  const startedAtMs = relayJobStartedAt(body);
  const deadlineMs = Math.min(deps.deadlineMs, jobStartDeadline(startedAtMs));
  if ((deps.nowFn ?? Date.now)() >= deadlineMs) {
    throw new Error(
      `the ledger relay job-start budget is consumed: job ${RELAY_JOB_NAME} started at ` +
        `${new Date(startedAtMs).toISOString()}, so no request may start after ` +
        `${new Date(deadlineMs).toISOString()} (the ${RELAY_JOB_TIMEOUT_MINUTES}-minute job timeout less ` +
        `the ${REQUEST_TIMEOUT_MS / 1000} s request bound and a ${JOB_DEADLINE_MARGIN_MS / 1000} s margin); nothing was written`,
    );
  }
  return deadlineMs;
}
