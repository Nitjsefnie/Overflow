export class GitHubApiError extends Error {
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
): { rateLimited: boolean; retryAfterSeconds: number | null } {
  const retryAfter = headers.get("retry-after");
  const rateLimited = (status === 403 || status === 429)
    && (headers.get("x-ratelimit-remaining") === "0"
      || retryAfter !== null
      || /secondary rate limit|abuse detection/i.test(body ?? ""));
  const retryAfterSeconds = retryAfter !== null && /^\d+$/.test(retryAfter) && Number.isSafeInteger(Number(retryAfter))
    ? Number(retryAfter)
    : null;
  return { rateLimited, retryAfterSeconds };
}
