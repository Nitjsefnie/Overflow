import { collectCursorPages, GitHubGraphqlClient, type GitHubGraphqlPage } from "@/lib/github/graphql";
import type {
  GitHubIssue,
  GitHubPullRequest,
  GitHubPullRequestReview,
  GitHubRepository,
  GitHubRepositoryReference,
  GitHubWebhook,
  GitHubWebhookConfiguration,
} from "@/lib/github/types";

const defaultApiUrl = "https://api.github.com";
const defaultTimeoutMs = 10_000;
const githubApiVersion = "2022-11-28";

export type GitHubGatewayOptions = {
  accessToken: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type GitHubRestRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  owner: { login: string };
  permissions?: { admin?: boolean };
};

export class GitHubGateway {
  private readonly accessToken: string;
  private readonly apiUrl: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly graphql: GitHubGraphqlClient;
  private readonly timeoutMs: number;

  public constructor(options: GitHubGatewayOptions) {
    this.accessToken = options.accessToken;
    this.apiUrl = (options.apiUrl ?? defaultApiUrl).replace(/\/$/, "");
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
    this.graphql = new GitHubGraphqlClient({
      accessToken: options.accessToken,
      endpoint: `${this.apiUrl}/graphql`,
      fetch: this.fetchImplementation,
      timeoutMs: this.timeoutMs,
    });
  }

  public async getRepository(repository: GitHubRepositoryReference): Promise<GitHubRepository> {
    const response = await this.request(`/repos/${segment(repository.owner)}/${segment(repository.name)}`);
    const payload = await responseJson<GitHubRestRepository>(response);

    return {
      id: payload.id,
      owner: payload.owner.login,
      name: payload.name,
      fullName: payload.full_name,
      visibility: payload.private ? "PRIVATE" : "PUBLIC",
      url: payload.html_url,
      canAdminister: payload.permissions?.admin === true,
    };
  }

  public async listIssues(repository: GitHubRepositoryReference): Promise<GitHubIssue[]> {
    const nodes = await collectCursorPages((cursor) =>
      this.getIssuesPage(repository, cursor),
    );
    return nodes.map(toGitHubIssue);
  }

  public async getIssueClosingPullRequests(
    repository: GitHubRepositoryReference,
    issueNumber: number,
  ): Promise<GitHubPullRequest[]> {
    const nodes = await collectCursorPages((cursor) =>
      this.getClosingPullRequestsPage(repository, issueNumber, cursor),
    );
    return nodes.map(toGitHubPullRequest);
  }

  public async getPullRequestReviews(
    repository: GitHubRepositoryReference,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestReview[]> {
    const nodes = await collectCursorPages((cursor) =>
      this.getPullRequestReviewsPage(repository, pullRequestNumber, cursor),
    );
    return nodes.map(toGitHubPullRequestReview);
  }

  public async createWebhook(
    repository: GitHubRepositoryReference,
    configuration: GitHubWebhookConfiguration,
  ): Promise<GitHubWebhook> {
    const response = await this.request(
      `/repos/${segment(repository.owner)}/${segment(repository.name)}/hooks`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: "web",
          active: true,
          events: ["issues", "pull_request", "pull_request_review"],
          config: {
            url: configuration.callbackUrl,
            content_type: "json",
            secret: configuration.secret,
          },
        }),
      },
    );
    const payload = await responseJson<{ id: number }>(response);
    if (!Number.isSafeInteger(payload.id) || payload.id <= 0) {
      throw new Error("GitHub API response was invalid.");
    }

    return { id: payload.id };
  }

  public async deleteWebhook(
    repository: GitHubRepositoryReference,
    webhookId: number,
  ): Promise<void> {
    await this.request(`/repos/${segment(repository.owner)}/${segment(repository.name)}/hooks/${webhookId}`, {
      method: "DELETE",
    });
  }

  public async ensureDifficultyLabels(
    repository: GitHubRepositoryReference,
    configuredLabels: readonly string[],
  ): Promise<void> {
    const existingLabels = await this.listLabelNames(repository);
    const labelsToCreate = [...new Set(configuredLabels)].filter((label) => !existingLabels.has(label));

    for (const label of labelsToCreate) {
      await this.request(`/repos/${segment(repository.owner)}/${segment(repository.name)}/labels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: label, color: "0E8A16" }),
      });
    }
  }

  public async getPullRequestDiff(
    repository: GitHubRepositoryReference,
    pullRequestNumber: number,
  ): Promise<string> {
    const response = await this.request(
      `/repos/${segment(repository.owner)}/${segment(repository.name)}/pulls/${pullRequestNumber}`,
      { headers: { Accept: "application/vnd.github.v3.diff" } },
    );
    return response.text();
  }

  private async getIssuesPage(
    repository: GitHubRepositoryReference,
    cursor: string | null,
  ): Promise<GitHubGraphqlPage<GitHubGraphqlIssueNode>> {
    const data = await this.graphql.query<{
      repository: { issues: GitHubGraphqlPage<GitHubGraphqlIssueNode> } | null;
    }>(issuesQuery, { owner: repository.owner, name: repository.name, cursor });
    const page = data.repository?.issues;
    if (page === undefined) {
      throw new Error("GitHub GraphQL response was invalid.");
    }
    return page;
  }

  private async getClosingPullRequestsPage(
    repository: GitHubRepositoryReference,
    issueNumber: number,
    cursor: string | null,
  ): Promise<GitHubGraphqlPage<GitHubGraphqlPullRequestNode>> {
    const data = await this.graphql.query<{
      repository: {
        issue: {
          closedByPullRequestsReferences: GitHubGraphqlPage<GitHubGraphqlPullRequestNode>;
        } | null;
      } | null;
    }>(closingPullRequestsQuery, {
      owner: repository.owner,
      name: repository.name,
      issueNumber,
      cursor,
    });
    const page = data.repository?.issue?.closedByPullRequestsReferences;
    if (page === undefined) {
      throw new Error("GitHub GraphQL response was invalid.");
    }
    return page;
  }

  private async getPullRequestReviewsPage(
    repository: GitHubRepositoryReference,
    pullRequestNumber: number,
    cursor: string | null,
  ): Promise<GitHubGraphqlPage<GitHubGraphqlPullRequestReviewNode>> {
    const data = await this.graphql.query<{
      repository: {
        pullRequest: { reviews: GitHubGraphqlPage<GitHubGraphqlPullRequestReviewNode> } | null;
      } | null;
    }>(pullRequestReviewsQuery, {
      owner: repository.owner,
      name: repository.name,
      pullRequestNumber,
      cursor,
    });
    const page = data.repository?.pullRequest?.reviews;
    if (page === undefined) {
      throw new Error("GitHub GraphQL response was invalid.");
    }
    return page;
  }

  private async listLabelNames(repository: GitHubRepositoryReference): Promise<Set<string>> {
    const labels = new Set<string>();
    let page = 1;
    let hasNextPage = true;

    while (hasNextPage) {
      const response = await this.request(
        `/repos/${segment(repository.owner)}/${segment(repository.name)}/labels?per_page=100&page=${page}`,
      );
      const payload = await responseJson<Array<{ name: string }>>(response);
      for (const label of payload) {
        if (typeof label.name === "string") {
          labels.add(label.name);
        }
      }
      hasNextPage = hasNextLink(response.headers.get("link"));
      page += 1;
    }

    return labels;
  }

  private async request(path: string, init: RequestInit = {}): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeoutMs);

    try {
      const response = await this.fetchImplementation(`${this.apiUrl}${path}`, {
        ...init,
        headers: githubHeaders(this.accessToken, init.headers),
        signal: controller.signal,
      });

      if (timedOut) {
        throw new Error("GitHub request timed out.");
      }

      if (!response.ok) {
        throw new Error(`GitHub API request failed with status ${response.status}.`);
      }

      return response;
    } catch (error) {
      if (error instanceof Error && error.message === "GitHub request timed out.") {
        throw error;
      }

      if (timedOut) {
        throw new Error("GitHub request timed out.");
      }

      if (error instanceof Error && /^GitHub API request failed with status \d+\.$/.test(error.message)) {
        throw error;
      }

      throw new Error("GitHub request failed.");
    } finally {
      clearTimeout(timeout);
    }
  }
}

type GitHubGraphqlIssueNode = {
  databaseId: number | null;
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED";
  labels: { nodes: Array<{ name: string }> };
};

type GitHubGraphqlPullRequestNode = {
  databaseId: number | null;
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
  author: { login: string } | null;
  labels: { nodes: Array<{ name: string }> };
};

type GitHubGraphqlPullRequestReviewNode = {
  databaseId: number | null;
  state: GitHubPullRequestReview["state"];
  submittedAt: string | null;
};

const issuesQuery = `
  query RepositoryIssues($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      issues(first: 100, after: $cursor) {
        nodes {
          databaseId
          number
          title
          body
          url
          state
          labels(first: 100) { nodes { name } }
        }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const closingPullRequestsQuery = `
  query ClosingPullRequests($owner: String!, $name: String!, $issueNumber: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      issue(number: $issueNumber) {
        closedByPullRequestsReferences(first: 100, includeClosedPrs: true, after: $cursor) {
          nodes {
            databaseId
            number
            title
            body
            url
            state
            mergedAt
            author { login }
            labels(first: 100) { nodes { name } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const pullRequestReviewsQuery = `
  query PullRequestReviews($owner: String!, $name: String!, $pullRequestNumber: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pullRequestNumber) {
        reviews(first: 100, after: $cursor) {
          nodes { databaseId state submittedAt }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

function toGitHubIssue(node: GitHubGraphqlIssueNode): GitHubIssue {
  if (node.databaseId === null) {
    throw new Error("GitHub GraphQL response was invalid.");
  }

  return {
    id: node.databaseId,
    number: node.number,
    title: node.title,
    body: node.body,
    url: node.url,
    state: node.state,
    labels: node.labels.nodes.map((label) => label.name),
  };
}

function toGitHubPullRequest(node: GitHubGraphqlPullRequestNode): GitHubPullRequest {
  if (node.databaseId === null) {
    throw new Error("GitHub GraphQL response was invalid.");
  }

  return {
    id: node.databaseId,
    number: node.number,
    title: node.title,
    body: node.body,
    url: node.url,
    state: node.state,
    mergedAt: node.mergedAt,
    authorLogin: node.author?.login ?? null,
    labels: node.labels.nodes.map((label) => label.name),
  };
}

function toGitHubPullRequestReview(
  node: GitHubGraphqlPullRequestReviewNode,
): GitHubPullRequestReview {
  if (node.databaseId === null) {
    throw new Error("GitHub GraphQL response was invalid.");
  }

  return {
    id: node.databaseId,
    state: node.state,
    submittedAt: node.submittedAt,
  };
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

function githubHeaders(accessToken: string, additionalHeaders: HeadersInit | undefined): Headers {
  const headers = new Headers(additionalHeaders);
  if (!headers.has("Accept")) {
    headers.set("Accept", "application/vnd.github+json");
  }
  headers.set("Authorization", `Bearer ${accessToken}`);
  headers.set("X-GitHub-Api-Version", githubApiVersion);
  return headers;
}

async function responseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new Error("GitHub API response was invalid.");
  }
}

function hasNextLink(linkHeader: string | null): boolean {
  return linkHeader?.split(",").some((link) => /rel="?next"?/.test(link)) ?? false;
}
