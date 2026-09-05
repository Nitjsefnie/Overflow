const defaultGraphqlEndpoint = "https://api.github.com/graphql";
const defaultTimeoutMs = 10_000;
const githubApiVersion = "2022-11-28";

// Bound log output to five errors, 512 characters per field and ten path
// segments (under 8,000 characters total). Mark omitted text and entries.
const maxErrorEntries = 5;
const maxErrorFieldLength = 512;
const maxErrorPathSegments = 10;

class GitHubGraphqlRequestError extends Error {}

function boundedErrorText(value: string): string {
  const text = value.slice(0, maxErrorFieldLength).replace(/\s/g, " ");
  return value.length > maxErrorFieldLength ? `${text.slice(0, -1)}…` : text;
}

function graphqlFailureMessage(errors: unknown): string {
  const message = "GitHub GraphQL request failed.";
  if (!Array.isArray(errors) || errors.length === 0) {
    return message;
  }

  const details = errors.slice(0, maxErrorEntries).map((entry: unknown) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return "Unknown error";
    }

    const error = entry as Record<string, unknown>;
    const type = typeof error.type === "string" && error.type.length > 0
      ? boundedErrorText(error.type) : "UNKNOWN";
    const detail = typeof error.message === "string" && error.message.length > 0
      ? boundedErrorText(error.message) : "No message supplied";
    let path = "";
    if (Array.isArray(error.path)) {
      const segments = error.path.slice(0, maxErrorPathSegments).map((segment: unknown) => {
        if (typeof segment === "string") return boundedErrorText(segment);
        if (typeof segment === "number") return segment;
        return "?";
      });
      if (error.path.length > maxErrorPathSegments) segments.push("…");
      path = ` path=${boundedErrorText(JSON.stringify(segments))}`;
    }
    return `${type}: ${detail}${path}`;
  });
  if (errors.length > maxErrorEntries) {
    details.push(`… ${errors.length - maxErrorEntries} more error(s)`);
  }
  return `${message} ${details.join("; ")}`;
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
        throw new GitHubGraphqlRequestError(`GitHub API request failed with status ${response.status}.`);
      }

      const payload = (await response.json()) as { data?: TData; errors?: unknown };
      if (payload?.data === undefined || payload.errors !== undefined) {
        throw new GitHubGraphqlRequestError(graphqlFailureMessage(payload?.errors));
      }

      return payload.data;
    } catch (error) {
      if (error instanceof GitHubGraphqlRequestError) {
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
