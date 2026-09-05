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

export class GitHubApiError extends Error implements GitHubRateLimitDetails {
  public readonly body: string | null;

  public constructor(
    public readonly status: number,
    public readonly rateLimited: boolean = false,
    public readonly retryAfterSeconds: number | null = null,
    body: string | null = null,
  ) {
    super(`GitHub API request failed with status ${status}.`);
    this.name = "GitHubApiError";
    this.body = body === null ? null : body.slice(0, 500);
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
