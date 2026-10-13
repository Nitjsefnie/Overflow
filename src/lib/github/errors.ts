export interface GitHubRateLimitDetails {
  readonly rateLimited: boolean;
  readonly retryAfterSeconds: number | null;
}

export function isGitHubRateLimitError(error: unknown): error is Error & GitHubRateLimitDetails {
  return error instanceof Error
    && "rateLimited" in error && error.rateLimited === true
    && "retryAfterSeconds" in error
    && (error.retryAfterSeconds === null || (typeof error.retryAfterSeconds === "number"
      && Number.isSafeInteger(error.retryAfterSeconds) && error.retryAfterSeconds >= 0));
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

export class GitHubApiError extends Error implements GitHubRateLimitDetails {
  public readonly body: string | null;
  public readonly headers: Readonly<Record<string, string>>;

  public constructor(
    public readonly status: number,
    public readonly rateLimited: boolean = false,
    public readonly retryAfterSeconds: number | null = null,
    body: string | null = null,
    headers: HeadersInit = {},
    accessToken: string = "",
  ) {
    super(`GitHub API request failed with status ${status}.`);
    this.name = "GitHubApiError";
    this.body = body === null ? null : redactToken(body, accessToken).slice(0, 500);
    this.headers = diagnosticHeaders(headers, accessToken);
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

function diagnosticHeaders(source: HeadersInit, accessToken: string): Readonly<Record<string, string>> {
  const headers = new Headers(source);
  const captured: Record<string, string> = {};
  for (const name of responseDiagnosticHeaders) {
    const value = headers.get(name);
    if (value !== null) captured[name] = redactToken(value, accessToken).slice(0, 256);
  }
  return Object.freeze(captured);
}

function redactToken(value: string, accessToken: string): string {
  return accessToken.length > 0 ? value.replaceAll(accessToken, "[REDACTED]") : value;
}

export class GitHubGraphqlRequestError extends Error implements GitHubRateLimitDetails {
  public readonly requestId: string | null;

  public constructor(
    message: string,
    public readonly rateLimited: boolean = false,
    public readonly retryAfterSeconds: number | null = null,
    public readonly status: number | null = null,
    requestId: string | null = null,
    accessToken: string = "",
  ) {
    super(message);
    this.name = "GitHubGraphqlRequestError";
    this.requestId = requestId === null ? null : redactToken(requestId, accessToken).slice(0, 256);
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
 * Whether no arm classified this failure, and it is therefore worth recording.
 *
 * A failure no arm classified reaches its caller as a fixed generic answer that
 * names nothing but the step that failed — the collection-walk bound's collection
 * and ceiling, or a GitHub status nothing here can explain, a 500 among them — so
 * this is the gate that lets the error reach an operator's log. A classified
 * failure is not silent by omission: the message the caller answered with already
 * named the remedy for what GitHub reported about its own authorization or its own
 * availability.
 *
 * The three status arms are read from `classifyGitHubApiFailure` rather than
 * restated here, so this gate cannot drift from the classification it mirrors.
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
