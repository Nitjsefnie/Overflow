// All relay requests share a run deadline, per-attempt timeout and bounded
// retries. An ambiguous check-run write is read back before another write.
import { type SweepApi } from "./ledger-relay-producers.ts";

export const API_ROOT = "https://api.github.com";
export const API_HEADERS = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "cache-control": "no-cache",
};
const BACKOFF_MS = [1_000, 2_000];
const REQUEST_TIMEOUT_MS = 30_000;
export const RUN_DEADLINE_MS = 10 * 60_000;

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

/** Three attempts, 1s then 2s backoff; other 4xx responses fail immediately. */
export async function apiCall<T>(
  deps: RelayHttpDeps, request: ApiRequest, what: string, retryTransient = true,
  committed?: () => Promise<boolean>,
): Promise<T> {
  let lastMessage = "";
  const retryCount = retryTransient ? BACKOFF_MS.length : 0;
  for (let attempt = 0; attempt <= retryCount; attempt += 1) {
    assertRunDeadline(deps, what);
    if (attempt > 0) {
      await deps.delayFn(BACKOFF_MS[attempt - 1] ?? 0);
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
      if (request.method === "POST" && committed !== undefined && await committed()) return undefined as T;
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
    if (response.status < 500 && response.status !== 429) throw new Error(`${what} failed: ${lastMessage}`);
  }
  throw new Error(`${what} failed after ${retryCount + 1} attempts: ${lastMessage}`);
}

/** Mirror and sweep writes use the same read-back rule under the App token. */
export function sweepApi(deps: RelayHttpDeps, repo: string, appId: string, auth: Record<string, string>): SweepApi {
  const headers = { ...API_HEADERS, ...auth };
  const get: SweepApi["get"] = (url, what, retryTransient = true) =>
    apiCall(deps, { url, method: "GET", headers }, what, retryTransient);
  return {
    get,
    postCheckRun: (body, what) => apiCall<unknown>(deps, {
      url: `${API_ROOT}/repos/${repo}/check-runs`, method: "POST", headers, body: JSON.stringify(body),
    }, what, true, async () => {
      const latest = await get<{ check_runs?: unknown }>(
        `${API_ROOT}/repos/${repo}/commits/${body.head_sha}/check-runs?app_id=${appId}&filter=latest&per_page=100`,
        `the ledger App's latest check-runs after an ambiguous write of ${body.name}`,
      );
      if (!Array.isArray(latest?.check_runs)) throw new Error("the ambiguous-write re-read returned no check_runs array");
      return latest.check_runs.some((entry: unknown) => {
        if (typeof entry !== "object" || entry === null) return false;
        const check = entry as {
          name?: unknown; external_id?: unknown; status?: unknown; conclusion?: unknown; app?: { id?: unknown };
        };
        return String(check.app?.id ?? "") === appId && check.name === body.name &&
          check.external_id === body.external_id && check.status === body.status && check.conclusion === body.conclusion;
      });
    }),
  };
}

function truncate(text: string): string {
  const trimmed = text.trim();
  return trimmed.length <= 300 ? trimmed : `${trimmed.slice(0, 300)}…`;
}
