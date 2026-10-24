// All relay requests share a run deadline, per-attempt timeout and bounded
// retries. An ambiguous check-run write is read back before another write.
import { attestsConcludedCheck, compareProducerIdentities, identityFromExternalId,
  readAppCheckRuns, type CheckRunPostResult, type SweepApi } from "./ledger-relay-producers.ts";

export const API_ROOT = "https://api.github.com";
export const API_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "cache-control": "no-cache",
};
export const BACKOFF_MS = [1_000, 2_000];
export const REQUEST_TIMEOUT_MS = 30_000;
export const RUN_DEADLINE_MS = 10 * 60_000;
/** Kept between a rate limit's reset and the run deadline before waiting it out (issue 1355). */
export const RATE_LIMIT_RESET_MARGIN_MS = 5_000;

/** A response GitHub answered with an exhausted rate limit; a sweep-only relay defers on it (issue 1355). */
export class RateLimitExceededError extends Error {
  readonly resetMs: number;

  constructor(message: string, resetMs: number) {
    super(message);
    this.name = "RateLimitExceededError";
    this.resetMs = resetMs;
  }
}

export interface RelayHttpOptions {
  fetchFn: typeof fetch;
  delayFn: (ms: number) => Promise<void>;
  /** Per fetch attempt; production defaults to 30 seconds. */
  requestTimeoutMs?: number;
  /** The run deadline's clock; production defaults to Date.now. */
  nowFn?: () => number;
}

export interface RelayHttpDeps extends RelayHttpOptions {
  deadlineMs: number;
}

export function assertRunDeadline(deps: RelayHttpDeps, what: string): void {
  if ((deps.nowFn ?? Date.now)() >= deps.deadlineMs) {
    throw new Error(`the ledger relay run deadline (${new Date(deps.deadlineMs).toISOString()}) was reached before ${what}`);
  }
}

interface ApiRequest {
  url: string;
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
}

/**
 * Three attempts, 1s then 2s backoff; other 4xx responses fail immediately. A
 * rate-limited 403 or 429 (issue 1355) waits out its named reset inside the run
 * deadline, or throws RateLimitExceededError.
 */
export async function apiCall<T>(
  deps: RelayHttpDeps, request: ApiRequest, what: string, retryTransient = true,
  reconcile?: () => Promise<{ retry: true } | { retry: false; value: T }>,
): Promise<T> {
  let lastMessage = "";
  let rateLimitWaited = false;
  const retryCount = retryTransient ? BACKOFF_MS.length : 0;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    assertRunDeadline(deps, what);
    if (attempt > 0) {
      // The reset wait takes the backoff slot of the attempt it bought.
      if (!rateLimitWaited) await deps.delayFn(BACKOFF_MS[attempt - 1] ?? 0);
      rateLimitWaited = false;
      assertRunDeadline(deps, what);
    }
    let response: Response;
    let text: string;
    try {
      response = await deps.fetchFn(request.url, {
        method: request.method,
        headers: request.headers,
        ...(request.body === undefined ? {} : { body: request.body }),
        signal: AbortSignal.timeout(deps.requestTimeoutMs ?? REQUEST_TIMEOUT_MS),
      });
      // The same signal also bounds consumption of the response body.
      text = await response.text();
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
      if (request.method === "POST" && reconcile !== undefined) {
        const outcome = await reconcile();
        if (!outcome.retry) return outcome.value;
      }
      continue;
    }
    if (response.ok) {
      // The rerun endpoint answers 202 with an empty body.
      if (text === "") return undefined as T;
      try {
        return JSON.parse(text) as T;
      } catch {
        throw new Error(`${what} returned a body that is not JSON`);
      }
    }
    lastMessage = `HTTP ${response.status}: ${truncate(text)}`;
    const nowMs = (deps.nowFn ?? Date.now)();
    const resetMs = rateLimitResetMs(response, text, nowMs);
    if (resetMs !== undefined) {
      if (attempt < retryCount && resetMs + RATE_LIMIT_RESET_MARGIN_MS <= deps.deadlineMs) {
        rateLimitWaited = true;
        await deps.delayFn(Math.max(0, resetMs - nowMs));
        continue;
      }
      throw new RateLimitExceededError(
        `${what} failed: GitHub rate limit exhausted; the limit resets at ` +
          `${new Date(resetMs).toISOString()} and the run deadline is ${new Date(deps.deadlineMs).toISOString()}`,
        resetMs,
      );
    }
    if (response.status < 500 && response.status !== 429) throw new Error(`${what} failed: ${lastMessage}`);
  }
  throw new Error(`${what} failed after ${retryCount + 1} attempts: ${lastMessage}`);
}

/** The reset instant a rate-limited 403/429 names (issue 1355), or undefined when none: the existing behaviour stands. */
function rateLimitResetMs(response: Response, text: string, nowMs: number): number | undefined {
  if (response.status !== 403 && response.status !== 429) return undefined;
  const rateLimited = response.headers.get("x-ratelimit-remaining") === "0" ||
    response.headers.get("retry-after") !== null || /rate limit/i.test(text);
  if (!rateLimited) return undefined;
  const retryAfter = Number.parseInt(response.headers.get("retry-after") ?? "", 10);
  if (!Number.isNaN(retryAfter)) return nowMs + retryAfter * 1_000;
  const resetHeader = response.headers.get("x-ratelimit-reset");
  const resetEpoch = resetHeader === null ? NaN : Number(resetHeader);
  return Number.isFinite(resetEpoch) ? resetEpoch * 1_000 : undefined;
}

/** Mirror and sweep writes use the same read-back rule under the App token. */
export function sweepApi(deps: RelayHttpDeps, repo: string, appId: string, auth: Record<string, string>): SweepApi {
  const headers = { ...API_HEADERS, ...auth };
  const get: SweepApi["get"] = (url, what, retryTransient = true) =>
    apiCall(deps, { url, method: "GET", headers }, what, retryTransient);
  return {
    get,
    postCheckRun: (body, what, historyBound) => apiCall<CheckRunPostResult>(deps, {
      url: `${API_ROOT}/repos/${repo}/check-runs`, method: "POST", headers, body: JSON.stringify(body),
    }, what, true, async () => {
      const latest = await readAppCheckRuns({ api: { get }, apiRoot: API_ROOT, repo, appId }, String(body.head_sha));
      if (latest === undefined) throw new Error("the ambiguous-write re-read returned no check_runs array");
      const intended = identityFromExternalId(body.external_id);
      if (intended === undefined) throw new Error("the ambiguous write has no intended producer identity");
      let committed = false;
      for (const entry of latest) {
        if (typeof entry !== "object" || entry === null) continue;
        const check = entry as {
          name?: unknown; external_id?: unknown; status?: unknown; conclusion?: unknown; app?: { id?: unknown };
          output?: { summary?: unknown } | null;
        };
        if (String(check.app?.id ?? "") !== appId || check.name !== body.name) continue;
        const identity = identityFromExternalId(check.external_id);
        if (identity === undefined) continue;
        const ordering = compareProducerIdentities(identity, intended);
        if (ordering > 0) return { retry: false, value: { suppressedBy: String(check.external_id) } };
        if (ordering === 0 && attestsConcludedCheck(check, {
          status: body.status, conclusion: body.conclusion, historyBound,
        })) committed = true;
      }
      return committed ? { retry: false, value: undefined } : { retry: true };
    }),
  };
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 300 ? trimmed : `${trimmed.slice(0, 300)}…`;
}
