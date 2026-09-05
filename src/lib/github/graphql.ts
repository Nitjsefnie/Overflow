import { classifyGitHubGraphqlRateLimit, classifyGitHubRateLimit, GitHubApiError, type GitHubRateLimitDetails } from "@/lib/github/errors";

const defaultGraphqlEndpoint = "https://api.github.com/graphql";
const defaultTimeoutMs = 10_000;
const githubApiVersion = "2022-11-28";

// Summarize the first five distinct (type, message) pairs, using each pair's
// first path. Fields retain up to 512 UTF-16 units and paths up to ten segments.
// Further entries contribute deduplicated types only while the total fits in
// 8,000 units, including counts and an explicit budget-overflow marker. Counts
// distinguish repeats of full pairs from entries without full details. This is
// a bounded summary, not universal per-entry retention. Truncation preserves
// well-formed source text; it does not repair malformed source Unicode.
const maxErrorEntries = 5;
const maxErrorSummaryLength = 8_000;
const maxErrorFieldLength = 512;
const maxErrorPathSegments = 10;
// Ten serialized segments of at most 48 units, commas, brackets and an optional
// omission marker fit in 495 units, while retaining every previewed position.
const maxSerializedPathSegmentLength = 48;

class GitHubGraphqlRequestError extends Error implements GitHubRateLimitDetails {
  public constructor(
    message: string,
    public readonly rateLimited: boolean = false,
    public readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
  }
}

function boundedErrorText(value: string, accessToken: string): string {
  const redacted = accessToken.length > 0 ? value.replaceAll(accessToken, "[REDACTED]") : value;
  const text = redacted.slice(0, maxErrorFieldLength).replace(/\s/g, " ");
  if (redacted.length <= maxErrorFieldLength) return text;
  // Do not leave half of a surrogate pair at the retained-prefix boundary.
  const prefix = text.slice(0, -1).replace(/[\uD800-\uDBFF]$/u, "");
  return `${prefix}…`;
}

function boundedErrorPath(path: unknown[], accessToken: string): string {
  const segments = path.slice(0, maxErrorPathSegments).map((segment: unknown) => {
    if (typeof segment === "number") return JSON.stringify(segment);
    if (typeof segment !== "string") return "null";

    const text = boundedErrorText(segment, accessToken);
    const serialized = JSON.stringify(text);
    if (serialized.length <= maxSerializedPathSegmentLength) return serialized;

    let prefix = "";
    let length = 3; // Reserve the JSON quotes and truncation ellipsis.
    for (const character of text) {
      const encodedLength = JSON.stringify(character).length - 2;
      if (length + encodedLength > maxSerializedPathSegmentLength) break;
      prefix += character;
      length += encodedLength;
    }
    return JSON.stringify(`${prefix}…`);
  });
  if (path.length > maxErrorPathSegments) segments.push('"…"');
  return `[${segments.join(",")}]`;
}

function graphqlFailureMessage(errors: unknown, accessToken: string): string {
  const message = "GitHub GraphQL request failed.";
  if (!Array.isArray(errors) || errors.length === 0) {
    return message;
  }

  const fullPairs: Array<{ type: string; message: string }> = [];
  const renderedTypes = new Set<string>();
  let summary = message;
  let collapsed = 0;
  let withoutDetails = 0;
  let overflow = false;
  const overflowMarker = "; … summary budget exceeded";
  const counts = (duplicates: number, omitted: number) =>
    (duplicates > 0 ? `; … ${duplicates} duplicate error(s) collapsed` : "")
    + (omitted > 0 ? `; … ${omitted} more error(s) without full details` : "");
  // Reserve the largest possible suffix before appending complete entries;
  // never cut through a path, redaction marker, or surrogate pair at the cap.
  const detailBudget = maxErrorSummaryLength
    - counts(errors.length, errors.length).length - overflowMarker.length;

  for (const entry of errors) {
    const error = entry !== null && typeof entry === "object" && !Array.isArray(entry)
      ? entry as Record<string, unknown> : {};
    const type = typeof error.type === "string" && error.type.length > 0 ? error.type : "UNKNOWN";
    const detail = typeof error.message === "string" && error.message.length > 0
      ? error.message : "No message supplied";
    if (fullPairs.some((pair) => pair.type === type && pair.message === detail)) {
      collapsed++;
      continue;
    }

    // Five full previews use at most 7,674 units, so even the maximum count
    // suffix fits. Only the type-only tail can exhaust the remaining budget.
    if (fullPairs.length < maxErrorEntries) {
      const path = Array.isArray(error.path) ? ` path=${boundedErrorPath(error.path, accessToken)}` : "";
      summary += `${fullPairs.length === 0 ? " " : "; "}${boundedErrorText(type, accessToken)}: ${boundedErrorText(detail, accessToken)}${path}`;
      fullPairs.push({ type, message: detail });
      renderedTypes.add(boundedErrorText(type, accessToken));
      continue;
    }

    withoutDetails++;
    if (overflow) continue;
    const renderedType = boundedErrorText(type, accessToken);
    if (renderedTypes.has(renderedType)) continue;
    if (summary.length + 2 + renderedType.length > detailBudget) {
      overflow = true;
      continue;
    }
    summary += `; ${renderedType}`;
    renderedTypes.add(renderedType);
  }
  return summary + counts(collapsed, withoutDetails) + (overflow ? overflowMarker : "");
}

export type GitHubGraphqlClientOptions = {
  accessToken: string;
  endpoint?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export type GitHubGraphqlPage<TNode> = {
  nodes: TNode[];
  pageInfo: {
    hasNextPage: boolean;
    endCursor: string | null;
  };
};

export class GitHubGraphqlClient {
  private readonly accessToken: string;
  private readonly endpoint: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(options: GitHubGraphqlClientOptions) {
    this.accessToken = options.accessToken;
    this.endpoint = options.endpoint ?? defaultGraphqlEndpoint;
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  }

  public async query<TData>(query: string, variables: Record<string, unknown>): Promise<TData> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImplementation(this.endpoint, {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.accessToken}`,
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": githubApiVersion,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      });

      if (timedOut) {
        throw new GitHubGraphqlRequestError("GitHub request timed out.");
      }

      if (!response.ok) {
        const body = await response.text().catch(() => null);
        const { rateLimited, retryAfterSeconds } = classifyGitHubRateLimit(response.status, response.headers, body);
        throw new GitHubApiError(response.status, rateLimited, retryAfterSeconds, body);
      }

      const payload = (await response.json()) as { data?: TData; errors?: unknown };
      if (payload?.data === undefined || payload.errors !== undefined) {
        const { rateLimited, retryAfterSeconds } = classifyGitHubGraphqlRateLimit(payload?.errors, response.headers);
        throw new GitHubGraphqlRequestError(graphqlFailureMessage(payload?.errors, this.accessToken), rateLimited, retryAfterSeconds);
      }

      return payload.data;
    } catch (error) {
      if (error instanceof GitHubApiError || error instanceof GitHubGraphqlRequestError) {
        throw error;
      }

      if (timedOut) {
        throw new GitHubGraphqlRequestError("GitHub request timed out.");
      }

      throw new GitHubGraphqlRequestError("GitHub GraphQL request failed.");
    } finally {
      clearTimeout(timeout);
    }
  }
}

export async function collectCursorPages<TNode>(
  getPage: (cursor: string | null) => Promise<GitHubGraphqlPage<TNode>>,
): Promise<TNode[]> {
  const nodes: TNode[] = [];
  let cursor: string | null = null;

  do {
    const page = await getPage(cursor);
    nodes.push(...page.nodes);

    if (!page.pageInfo.hasNextPage) {
      return nodes;
    }

    if (page.pageInfo.endCursor === null || page.pageInfo.endCursor.length === 0) {
      throw new Error("GitHub GraphQL response was invalid.");
    }

    cursor = page.pageInfo.endCursor;
  } while (true);
}
