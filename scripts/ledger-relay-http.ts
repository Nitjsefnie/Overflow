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
/**
 * Kept between a rate limit's reset instant and the run deadline before the
 * relay commits to waiting out an exhausted limit (issue 1355): a wait that
 * ends at the deadline itself would leave the retried request no time.
 */
export const RATE_LIMIT_RESET_MARGIN_MS = 5_000;

/**
 * A response GitHub answered with an exhausted rate limit, classified by
 * `apiCall` (issue 1355). `resetMs` is the reset instant the response named;
 * a sweep-only relay defers on this error instead of failing red.
 */
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
 * rate-limited 403 or 429 (issue 1355) instead waits for the reset its
 * `retry-after` or `x-ratelimit-reset` names — inside the run deadline — and
 * throws `RateLimitExceededError` when the wait does not fit, the caller takes
 * one attempt only, or the attempts run out.
 */
export async function apiCall<T>(
  deps: RelayHttpDeps, request: ApiRequest, what: string, retryTransient = true,
  reconcile?: () => Promise<{ retry: true } | { retry: false; value: T }>,
): Promise<T> {
  let lastMessage = "";
  let lastRateLimitResetMs: number | undefined;
  let rateLimitWaited = false;
  const retryCount = retryTransient ? BACKOFF_MS.length : 0;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    assertRunDeadline(deps, what);
    if (attempt > 0) {
      // A rate-limit wait replaces the backoff for the attempt it bought: the
      // reset wait already covered the spacing.
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
      lastRateLimitResetMs = undefined;
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
      if (retryTransient && resetMs + RATE_LIMIT_RESET_MARGIN_MS <= deps.deadlineMs) {
        lastRateLimitResetMs = resetMs;
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
    lastRateLimitResetMs = undefined;
    if (response.status < 500 && response.status !== 429) throw new Error(`${what} failed: ${lastMessage}`);
  }
  if (lastRateLimitResetMs !== undefined) {
    throw new RateLimitExceededError(
      `${what} failed: GitHub rate limit exhausted after ${retryCount + 1} attempts; the limit resets at ` +
        `${new Date(lastRateLimitResetMs).toISOString()} and the run deadline is ${new Date(deps.deadlineMs).toISOString()}`,
      lastRateLimitResetMs,
    );
  }
  throw new Error(`${what} failed after ${retryCount + 1} attempts: ${lastMessage}`);
}

/**
 * The reset instant a 403 or 429 carries when GitHub is rate limiting the
 * relay (issue 1355): judged in the order the design pins —
 * `x-ratelimit-remaining` at 0, then a `retry-after` header, then the body
 * naming the rate limit — and read from `retry-after` (integer seconds from
 * now) first, else `x-ratelimit-reset` (UTC epoch seconds). Undefined when the
 * response is not rate-limited or names no parsable reset, leaving the
 * existing behaviour in force.
 */
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
