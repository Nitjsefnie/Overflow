export interface GitHubRateLimitDetails {
  readonly rateLimited: boolean;
  readonly retryAfterSeconds: number | null;
  /** Absolute deadline already computed by reconciliation before persisting its cooldown. */
  readonly notBefore?: Date;
}

export function isGitHubRateLimitError(error: unknown): error is Error & GitHubRateLimitDetails {
  try {
    return error instanceof Error
      && "rateLimited" in error && error.rateLimited === true
      && "retryAfterSeconds" in error
      && (error.retryAfterSeconds === null || (typeof error.retryAfterSeconds === "number"
        && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds >= 0));
  } catch {
    return false;
  }
}

// Includes the root and the logger's six-link preview; fresh causes cannot expand work.
export const MAX_ERROR_CAUSE_READS = 64;

// A large repository can exhaust an hourly GitHub budget; without retry guidance,
// allow a full hour before spending points on another full fold.
export const DEFAULT_RECONCILIATION_COOLDOWN_SECONDS = 60 * 60;

// https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#exceeding-the-primary-rate-limit
// https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api#about-secondary-rate-limits
// https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api#handle-rate-limit-errors-appropriately
// https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api#exceeding-the-rate-limit
// Honour both signals when present, with the documented one-minute minimum.
export function githubRateLimitNotBefore(error: GitHubRateLimitDetails, now: Date): Date {
  const nowMs = now.getTime();
  const retryMs = error.retryAfterSeconds === null ? NaN : nowMs + error.retryAfterSeconds * 1000;
  const retryAt = Number.isFinite(new Date(retryMs).getTime()) ? retryMs : null;
  const headers = error instanceof GitHubApiError || error instanceof GitHubGraphqlRequestError
    ? error.headers : undefined;
  const reset = headers?.["x-ratelimit-remaining"] === "0" ? headers["x-ratelimit-reset"] : undefined;
  const resetMs = reset !== undefined && /^\d+$/.test(reset) && Number.isSafeInteger(Number(reset))
    ? Number(reset) * 1000 : NaN;
  const resetAt = Number.isFinite(new Date(resetMs).getTime()) ? resetMs : null;
  return new Date(Math.max(
    nowMs + 60_000,
    retryAt ?? resetAt ?? nowMs + DEFAULT_RECONCILIATION_COOLDOWN_SECONDS * 1000,
    resetAt ?? 0,
  ));
}

export function findGitHubRateLimitError(error: unknown): (Error & GitHubRateLimitDetails) | null {
  const visited = new Set<unknown>();
  try {
    for (let cause = error, depth = 0; depth < MAX_ERROR_CAUSE_READS && cause !== null && typeof cause === "object" && !visited.has(cause); depth += 1) {
      if (isGitHubRateLimitError(cause)) return cause;
      visited.add(cause);
      cause = "cause" in cause ? cause.cause : undefined;
    }
  } catch {
    // Unreadable exception evidence must not escape ordinary failure bookkeeping.
  }
  return null;
}

// GitHub answers a lookup of a number that names nothing upstream with a
// NOT_FOUND GraphQL error ("Could not resolve to an Issue/PullRequest ...").
// The client flattens the structured errors into a bounded summary before the
// error escapes, so the payload's message text is the durable marker; a rate
// limit on the same response keeps the failure transient, and a transient
// failure must never classify as a missing subject.
export function isGitHubSubjectNotFoundError(error: unknown): boolean {
  return error instanceof Error
    && !isGitHubRateLimitError(error)
    && (error.message.includes("Could not resolve to an Issue")
      || error.message.includes("Could not resolve to a PullRequest"));
}

// Only transport failures and server refusals can recover within the same run.
// GraphQL payload errors share the network wrapper's prefix but carry status
// 200; body-phase transport failures carry null instead. Payload verdicts stay
// definitive, and rate limits keep the run-level cooldown path.
export function isTransientGitHubRequestError(error: unknown): boolean {
  if (!(error instanceof Error) || isGitHubRateLimitError(error)) return false;
  if (error instanceof GitHubApiError) return error.status >= 500;
  return error.message === "GitHub request timed out."
    || error.message.startsWith("GitHub request failed: ")
    || (error instanceof GitHubGraphqlRequestError && error.status !== 200
      && error.message.startsWith("GitHub GraphQL request failed."));
}

export class GitHubApiError extends Error implements GitHubRateLimitDetails {
  public readonly body: string | null;
  public readonly headers: Readonly<Record<string, string>>;

  public constructor(
    public readonly status: number,
    public readonly rateLimited: boolean = false,
    public readonly retryAfterSeconds: number | null = null,
    body: string | null = null,
    headers: HeadersInit = {},
    credentials: string | readonly string[] = "",
  ) {
    super(`GitHub API request failed with status ${status}.`);
    this.name = "GitHubApiError";
    this.body = body === null ? null : redactCredentials(body, credentials).slice(0, 500);
    this.headers = diagnosticHeaders(headers, credentials);
  }

  // Keep response diagnostics in service logs, out of serialized API errors.
  public toJSON() {
    return {
      name: this.name,
      status: this.status,
      rateLimited: this.rateLimited,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}

const responseDiagnosticHeaders = [
  "retry-after", "x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-used",
  "x-ratelimit-reset", "x-ratelimit-resource", "x-github-request-id",
] as const;

function diagnosticHeaders(source: HeadersInit, credentials: string | readonly string[]): Readonly<Record<string, string>> {
  const headers = new Headers(source);
  const captured: Record<string, string> = {};
  for (const name of responseDiagnosticHeaders) {
    const value = headers.get(name);
    if (value !== null) captured[name] = redactCredentials(value, credentials).slice(0, 256);
  }
  return Object.freeze(captured);
}

function redactCredentials(value: string, credentials: string | readonly string[]): string {
  const tokens = typeof credentials === "string" ? [credentials] : credentials;
  const spans: Array<{ start: number; end: number }> = [];
  // Locate matches in the original text: replacing one credential first can
  // destroy a partially overlapping match and leave its unmatched suffix.
  for (const token of new Set(tokens)) {
    if (token.length === 0) continue;
    let start = value.indexOf(token);
    while (start !== -1) {
      spans.push({ start, end: start + token.length });
      // Include overlapping occurrences of the same credential too.
      start = value.indexOf(token, start + 1);
    }
  }
  spans.sort((left, right) => left.start - right.start);
  let redacted = "";
  let cursor = 0;
  for (let index = 0; index < spans.length; index++) {
    const span = spans[index]!;
    let end = span.end;
    while (index + 1 < spans.length && spans[index + 1]!.start <= end) {
      end = Math.max(end, spans[++index]!.end);
    }
    redacted += `${value.slice(cursor, span.start)}[REDACTED]`;
    cursor = end;
  }
  return redacted + value.slice(cursor);
}

export class GitHubGraphqlRequestError extends Error implements GitHubRateLimitDetails {
  public readonly requestId: string | null;
  public readonly headers: Readonly<Record<string, string>>;

  public constructor(
    message: string,
    public readonly rateLimited: boolean = false,
    public readonly retryAfterSeconds: number | null = null,
    public readonly status: number | null = null,
    requestId: string | null = null,
    accessToken: string = "",
    headers: HeadersInit = {},
  ) {
    super(message);
    this.name = "GitHubGraphqlRequestError";
    this.requestId = requestId === null ? null : redactCredentials(requestId, accessToken).slice(0, 256);
    this.headers = diagnosticHeaders(headers, accessToken);
    // Response diagnostics stay in memory for scheduling, out of serialized errors.
    Object.defineProperty(this, "headers", { enumerable: false });
  }
}

/**
 * A GraphQL payload whose shape violated the reader's contract; `fieldPath`
 * names the failed field so a caller can mark one subject's unreadable
 * connection instead of failing a whole walk; the other invalid-response
 * throws are not per-subject and stay plain `Error`s.
 */
export class GitHubGraphqlInvalidResponseError extends Error {
  public constructor(
    message: string,
    public readonly fieldPath: string,
  ) {
    super(message);
    this.name = "GitHubGraphqlInvalidResponseError";
  }
}

/**
 * Which arm of a caller's status classification one GitHub failure reaches.
 *
 * The classification is ORDERED, not a set of statuses: rate-limit evidence
 * outranks the bare access arm, so a 403 carrying it is `RATE_LIMITED` rather
 * than `ACCESS`, and 429 is reachable through either the evidence or the status.
 * `UNCLASSIFIED` is whatever reached no arm — a status GitHub answered with that
 * carries none of the three kinds of evidence the arms read.
 */
export type GitHubApiFailure = "CREDENTIALS" | "ACCESS" | "RATE_LIMITED" | "UNCLASSIFIED";

export function classifyGitHubApiFailure(error: GitHubApiError): GitHubApiFailure {
  if (error.status === 401) return "CREDENTIALS";
  if (!error.rateLimited && (error.status === 403 || error.status === 404)) return "ACCESS";
  if (error.rateLimited || error.status === 429) return "RATE_LIMITED";
  return "UNCLASSIFIED";
}

/**
 * Whether no arm classified this failure, and it is therefore worth recording:
 * a failure no arm classified reaches its caller as a fixed generic answer
 * naming nothing but the step that failed, so this gate is what lets the error
 * reach an operator's log; a classified failure's message already named the
 * remedy for what GitHub reported. The arms are read from
 * `classifyGitHubApiFailure`, so this gate cannot drift from the
 * classification it mirrors.
 */
export function isUnclassifiedGitHubFailure(error: unknown): boolean {
  return !(error instanceof GitHubApiError) || classifyGitHubApiFailure(error) === "UNCLASSIFIED";
}

export function classifyGitHubRateLimit(
  status: number,
  headers: Headers,
  body: string | null,
): GitHubRateLimitDetails {
  const retryAfter = headers.get("retry-after");
  const rateLimited = (status === 403 || status === 429)
    && (headers.get("x-ratelimit-remaining") === "0"
      || retryAfter !== null
      || /secondary rate limit|abuse detection/i.test(body ?? ""));
  return { rateLimited, retryAfterSeconds: parseRetryAfterSeconds(headers) };
}

export function classifyGitHubGraphqlRateLimit(errors: unknown, headers: Headers): GitHubRateLimitDetails {
  // Structured markers alone classify successful HTTP responses. Budget/retry
  // headers and free-form messages must not hide schema or permission failures.
  const rateLimited = Array.isArray(errors) && errors.some((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const error = entry as Record<string, unknown>;
    return [error.type, error.code].some((marker) => typeof marker === "string"
      && ["RATE_LIMIT", "RATE_LIMITED", "GRAPHQL_RATE_LIMIT"].includes(marker.toUpperCase()));
  });
  return { rateLimited, retryAfterSeconds: parseRetryAfterSeconds(headers) };
}

function parseRetryAfterSeconds(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  return retryAfter !== null && /^\d+$/.test(retryAfter) && Number.isSafeInteger(Number(retryAfter))
    ? Number(retryAfter)
    : null;
}
