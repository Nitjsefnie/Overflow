const defaultGraphqlEndpoint = "https://api.github.com/graphql";
const defaultTimeoutMs = 10_000;
const githubApiVersion = "2022-11-28";

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
        throw new Error("GitHub request timed out.");
      }

      if (!response.ok) {
        throw new Error(`GitHub API request failed with status ${response.status}.`);
      }

      const payload = (await response.json()) as { data?: TData; errors?: unknown };
      if (payload.data === undefined || payload.errors !== undefined) {
        throw new Error("GitHub GraphQL request failed.");
      }

      return payload.data;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message === "GitHub request timed out." ||
          error.message === "GitHub GraphQL request failed." ||
          /^GitHub API request failed with status \d+\.$/.test(error.message))
      ) {
        throw error;
      }

      if (timedOut) {
        throw new Error("GitHub request timed out.");
      }

      throw new Error("GitHub GraphQL request failed.");
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
