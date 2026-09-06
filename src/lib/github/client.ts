import { collectCursorPages, GitHubGraphqlClient, type GitHubGraphqlPage } from "@/lib/github/graphql";
import { classifyGitHubRateLimit, GitHubApiError } from "@/lib/github/errors";
export { GitHubApiError } from "@/lib/github/errors";
import type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueHistoryEvent,
  GitHubPullRequest,
  GitHubPullRequestReview,
  GitHubPullRequestReviewDismissal,
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

/** Omit these options to read every timeline exactly. Supplying them opts into
 * targeted reads: other nested timelines can still silently omit history/comments.
 */
export type GitHubIssueListOptions = {
  /** Always reread the full timeline when one of these labels is standing. */
  timelineCriticalLabels: ReadonlySet<string>;
  /** Reread when a standing label has no corresponding label event. */
  timelineWatchedLabels: ReadonlySet<string>;
};

type GitHubRestRepository = {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  owner: { login: string; type?: string };
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

    return toGitHubRepository(await responseJson<GitHubRestRepository>(response));
  }

  public async getRepositoryById(githubRepositoryId: number): Promise<GitHubRepository | null> {
    if (!Number.isSafeInteger(githubRepositoryId) || githubRepositoryId <= 0) {
      throw new Error("GitHub repository id must be a positive safe integer.");
    }

    let response: Response;
    try {
      response = await this.request(`/repositories/${githubRepositoryId}`);
    } catch (error) {
      // Only 404 answers "this id is unreachable". Every other failure is an upstream
      // problem, and reading one as a deleted repository would retire a live one.
      if (error instanceof GitHubApiError && error.status === 404) {
        return null;
      }
      throw error;
    }

    return toGitHubRepository(await responseJson<GitHubRestRepository>(response));
  }

  public async listIssues(
    repository: GitHubRepositoryReference,
    options?: GitHubIssueListOptions,
  ): Promise<GitHubIssue[]> {
    const nodes = await collectCursorPages((cursor) =>
      this.getIssuesPage(repository, cursor),
    );
    const issues: GitHubIssue[] = [];
    for (const node of nodes) {
      const [labels, timeline, closingPullRequests] = await Promise.all([
        this.getIssueLabels(repository, node.number, node.labels),
        this.getIssueTimeline(repository, node.number, options === undefined ? undefined : node.timelineItems),
        this.getIssueClosingPullRequests(repository, node.number, node.closedByPullRequestsReferences),
      ]);
      // Check both fully assembled connections. A nested timeline can claim it is
      // complete while omitting events or comments, even when totalCount agrees.
      const labeled = new Set(timeline.history.flatMap((event) => event.kind === "LABELED" ? [event.label] : []));
      const suspect = options !== undefined && node.timelineItems !== undefined && labels.some((label) =>
        options.timelineCriticalLabels.has(label)
        || (options.timelineWatchedLabels.has(label) && !labeled.has(label)),
      );
      const authoritativeTimeline = suspect ? await this.getIssueTimeline(repository, node.number) : timeline;
      issues.push(toGitHubIssue(node, labels, authoritativeTimeline, closingPullRequests));
    }
    return issues;
  }

  public async getIssueClosingPullRequests(
    repository: GitHubRepositoryReference,
    issueNumber: number,
    initialPage?: GitHubGraphqlPage<GitHubGraphqlPullRequestNode>,
  ): Promise<GitHubPullRequest[]> {
    const nodes = await collectCursorPages((cursor) =>
      cursor === null && initialPage !== undefined
        ? Promise.resolve(initialPage)
        : this.getClosingPullRequestsPage(repository, issueNumber, cursor),
    );
    return nodes.map(toGitHubPullRequest);
  }

  public async getPullRequestReviews(
    repository: GitHubRepositoryReference,
    pullRequestNumber: number,
  ): Promise<GitHubPullRequestReview[]> {
    // Keep one HTTP request per reconciliation worker, including continuation pages.
    const reviewNodes = await collectCursorPages((cursor) =>
      this.getPullRequestReviewsPage(repository, pullRequestNumber, cursor));
    const dismissalNodes = await collectCursorPages((cursor) =>
      this.getPullRequestReviewDismissalsPage(repository, pullRequestNumber, cursor));
    const dismissals = new Map<number, GitHubPullRequestReviewDismissal>();
    for (const node of dismissalNodes) {
      if (node.__typename !== "ReviewDismissedEvent" || node.review?.databaseId == null) {
        continue;
      }
      dismissals.set(node.review.databaseId, {
        at: node.createdAt,
        previousState: node.previousReviewState ?? null,
      });
    }
    return reviewNodes.map((node) => toGitHubPullRequestReview(node, dismissals.get(node.databaseId ?? -1) ?? null));
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
      rateLimit?: { cost: number; remaining: number } | null;
    }>(issuesQuery, { owner: repository.owner, name: repository.name, cursor });
    if (process.env.DEBUG_GITHUB_COST && data.rateLimit != null) {
      console.info("GitHub RepositoryIssues cost", {
        repository: `${repository.owner}/${repository.name}`,
        cursor,
        cost: data.rateLimit.cost,
        remaining: data.rateLimit.remaining,
      });
    }
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

  private async getIssueLabels(
    repository: GitHubRepositoryReference,
    issueNumber: number,
    initialPage: GitHubGraphqlLabelConnection,
  ): Promise<string[]> {
    return this.collectLabels(initialPage, (cursor) =>
      this.getIssueLabelsPage(repository, issueNumber, cursor),
    );
  }

  private async getIssueLabelsPage(
    repository: GitHubRepositoryReference,
    issueNumber: number,
    cursor: string,
  ): Promise<GitHubGraphqlLabelConnection> {
    const data = await this.graphql.query<{
      repository: { issue: { labels: GitHubGraphqlLabelConnection } | null } | null;
    }>(issueLabelsQuery, {
      owner: repository.owner,
      name: repository.name,
      issueNumber,
      cursor,
    });
    const page = data.repository?.issue?.labels;
    if (page === undefined) {
      throw new Error("GitHub GraphQL response was invalid.");
    }
    return page;
  }

  private async getIssueTimeline(
    repository: GitHubRepositoryReference,
    issueNumber: number,
    initialPage?: GitHubGraphqlIssueTimelineConnection,
  ): Promise<{ history: GitHubIssueHistoryEvent[]; comments: GitHubIssueComment[] }> {
    const nodes = await collectCursorPages((cursor) =>
      cursor === null && initialPage !== undefined
        ? Promise.resolve(initialPage)
        : this.getIssueTimelinePage(repository, issueNumber, cursor),
    );
    const history: GitHubIssueHistoryEvent[] = [];
    const comments: GitHubIssueComment[] = [];
    for (const node of nodes) {
      const mapped = toGitHubIssueTimelineItem(node);
      if (mapped === null) {
        continue;
      }
      if (mapped.kind === "COMMENT") {
        comments.push(mapped.comment);
      } else {
        history.push(mapped.event);
      }
    }
    history.sort(compareIssueHistoryItems);
    comments.sort(compareIssueHistoryItems);
    return { history, comments };
  }

  private async getIssueTimelinePage(
    repository: GitHubRepositoryReference,
    issueNumber: number,
    cursor: string | null,
  ): Promise<GitHubGraphqlIssueTimelineConnection> {
    const data = await this.graphql.query<{
      repository: { issue: { timelineItems: GitHubGraphqlIssueTimelineConnection } | null } | null;
    }>(issueTimelineQuery, {
      owner: repository.owner,
      name: repository.name,
      issueNumber,
      cursor,
    });
    const page = data.repository?.issue?.timelineItems;
    if (page === undefined) {
      throw new Error("GitHub GraphQL response was invalid.");
    }
    return page;
  }

  private async collectLabels(
    initialPage: GitHubGraphqlLabelConnection,
    getNextPage: (cursor: string) => Promise<GitHubGraphqlLabelConnection>,
  ): Promise<string[]> {
    const labels = await collectCursorPages((cursor) =>
      cursor === null ? Promise.resolve(initialPage) : getNextPage(cursor),
    );
    return labels.map((label) => label.name);
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

  private async getPullRequestReviewDismissalsPage(
    repository: GitHubRepositoryReference,
    pullRequestNumber: number,
    cursor: string | null,
  ): Promise<GitHubGraphqlPage<GitHubGraphqlReviewDismissedEventNode>> {
    const data = await this.graphql.query<{
      repository: {
        pullRequest: { timelineItems: GitHubGraphqlPage<GitHubGraphqlReviewDismissedEventNode> } | null;
      } | null;
    }>(pullRequestReviewDismissalsQuery, {
      owner: repository.owner,
      name: repository.name,
      pullRequestNumber,
      cursor,
    });
    const page = data.repository?.pullRequest?.timelineItems;
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
        const body = await response.text().catch(() => null);
        const { rateLimited, retryAfterSeconds } = classifyGitHubRateLimit(response.status, response.headers, body);
        throw new GitHubApiError(response.status, rateLimited, retryAfterSeconds, body);
      }

      return response;
    } catch (error) {
      if (error instanceof Error && error.message === "GitHub request timed out.") {
        throw error;
      }

      if (error instanceof GitHubApiError) {
        throw error;
      }

      if (timedOut) {
        throw new Error("GitHub request timed out.");
      }

      throw new Error("GitHub request failed.");
    } finally {
      clearTimeout(timeout);
    }
  }
}

/** What every actor/author selection reports: a `login`, plus a `databaseId` when the account is a User. */
type GitHubGraphqlAccount = { login: string; databaseId?: number | null };

type GitHubGraphqlLabel = { name: string };
type GitHubGraphqlLabelConnection = GitHubGraphqlPage<GitHubGraphqlLabel>;

type GitHubGraphqlIssueNode = {
  databaseId: number | null;
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED";
  createdAt: string;
  closedAt: string | null;
  author: GitHubGraphqlAccount | null;
  labels: GitHubGraphqlLabelConnection;
  assignees: { nodes: GitHubGraphqlAssignee[] };
  timelineItems: GitHubGraphqlIssueTimelineConnection;
  closedByPullRequestsReferences: GitHubGraphqlPage<GitHubGraphqlPullRequestNode>;
};

type GitHubGraphqlAssignee = { login: string };

type GitHubGraphqlPullRequestNode = {
  databaseId: number | null;
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  mergedAt: string | null;
  mergeCommit: { oid: string } | null;
  commits: { nodes: Array<{ commit: { committedDate: string } }> };
  author: GitHubGraphqlAccount | null;
  repository: { databaseId: unknown; nameWithOwner: unknown } | null;
};

type GitHubGraphqlIssueTimelineNode =
  | {
      __typename: "LabeledEvent" | "UnlabeledEvent";
      id: string;
      createdAt: string;
      actor: GitHubGraphqlAccount | null;
      label: { name: string };
    }
  | {
      __typename: "AssignedEvent" | "UnassignedEvent";
      id: string;
      createdAt: string;
      actor: GitHubGraphqlAccount | null;
      assignee: { login?: string } | null;
    }
  | {
      __typename: "IssueComment";
      id: string;
      databaseId: number | null;
      createdAt: string;
      lastEditedAt: string | null;
      author: GitHubGraphqlAccount | null;
      body: string;
    };

type GitHubGraphqlIssueTimelineConnection = GitHubGraphqlPage<GitHubGraphqlIssueTimelineNode>;

type GitHubGraphqlPullRequestReviewNode = {
  databaseId: number | null;
  state: GitHubPullRequestReview["state"];
  submittedAt: string | null;
};

type GitHubGraphqlReviewDismissedEventNode = {
  __typename: "ReviewDismissedEvent" | string;
  createdAt: string;
  previousReviewState: GitHubPullRequestReview["state"] | null;
  review: { databaseId: number | null } | null;
};

const issuesQuery = `
  query RepositoryIssues($owner: String!, $name: String!, $cursor: String) {
    rateLimit { cost remaining }
    repository(owner: $owner, name: $name) {
      issues(first: 100, after: $cursor) {
        nodes {
          databaseId
          number
          title
          body
          url
          state
          createdAt
          closedAt
          author { login ... on User { databaseId } }
          labels(first: 20) {
            nodes { name }
            pageInfo { hasNextPage endCursor }
          }
          closedByPullRequestsReferences(first: 20, includeClosedPrs: true) {
            nodes {
              databaseId
              number
              title
              body
              url
              state
              mergedAt
              mergeCommit { oid }
              commits(last: 1) {
                nodes { commit { committedDate } }
              }
              author { login ... on User { databaseId } }
              repository { databaseId nameWithOwner }
            }
            pageInfo { hasNextPage endCursor }
          }
          assignees(first: 2) {
            nodes { login }
          }
          timelineItems(
            first: 50
            itemTypes: [LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, ISSUE_COMMENT]
          ) {
            nodes {
              __typename
              ... on LabeledEvent { id createdAt actor { login ... on User { databaseId } } label { name } }
              ... on UnlabeledEvent { id createdAt actor { login ... on User { databaseId } } label { name } }
              ... on AssignedEvent { id createdAt actor { login ... on User { databaseId } } assignee { ... on User { login } } }
              ... on UnassignedEvent { id createdAt actor { login ... on User { databaseId } } assignee { ... on User { login } } }
              ... on IssueComment { id databaseId createdAt lastEditedAt author { login ... on User { databaseId } } body }
            }
            pageInfo { hasNextPage endCursor }
          }
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
            mergeCommit { oid }
            commits(last: 1) {
              nodes { commit { committedDate } }
            }
            author { login ... on User { databaseId } }
            repository { databaseId nameWithOwner }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const issueLabelsQuery = `
  query IssueLabels($owner: String!, $name: String!, $issueNumber: Int!, $cursor: String!) {
    repository(owner: $owner, name: $name) {
      issue(number: $issueNumber) {
        labels(first: 100, after: $cursor) {
          nodes { name }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const issueTimelineQuery = `
  query IssueTimeline($owner: String!, $name: String!, $issueNumber: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      issue(number: $issueNumber) {
        timelineItems(
          first: 100
          after: $cursor
          itemTypes: [LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, ISSUE_COMMENT]
        ) {
          nodes {
            __typename
            ... on LabeledEvent { id createdAt actor { login ... on User { databaseId } } label { name } }
            ... on UnlabeledEvent { id createdAt actor { login ... on User { databaseId } } label { name } }
            ... on AssignedEvent { id createdAt actor { login ... on User { databaseId } } assignee { ... on User { login } } }
            ... on UnassignedEvent { id createdAt actor { login ... on User { databaseId } } assignee { ... on User { login } } }
            ... on IssueComment { id databaseId createdAt lastEditedAt author { login ... on User { databaseId } } body }
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

const pullRequestReviewDismissalsQuery = `
  query PullRequestReviewDismissals($owner: String!, $name: String!, $pullRequestNumber: Int!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pullRequestNumber) {
        timelineItems(first: 100, after: $cursor, itemTypes: [REVIEW_DISMISSED_EVENT]) {
          nodes {
            __typename
            ... on ReviewDismissedEvent { createdAt previousReviewState review { databaseId } }
          }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

function toGitHubRepository(payload: GitHubRestRepository): GitHubRepository {
  return {
    id: payload.id,
    owner: payload.owner.login,
    ownerType: payload.owner.type === "Organization" ? "ORGANIZATION" : "USER",
    name: payload.name,
    fullName: payload.full_name,
    visibility: payload.private ? "PRIVATE" : "PUBLIC",
    url: payload.html_url,
    canAdminister: payload.permissions?.admin === true,
  };
}

function toGitHubIssue(
  node: GitHubGraphqlIssueNode,
  labels: string[],
  timeline: { history: GitHubIssueHistoryEvent[]; comments: GitHubIssueComment[] },
  closingPullRequests: GitHubPullRequest[],
): GitHubIssue {
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
    createdAt: node.createdAt,
    closedAt: node.closedAt,
    authorLogin: node.author?.login ?? null,
    authorGitHubUserId: accountGitHubUserId(node.author),
    labels,
    claimAssigneeGitHubLogin: claimAssigneeLogin(node.assignees.nodes),
    history: timeline.history,
    comments: timeline.comments,
    closingPullRequests,
  };
}

function claimAssigneeLogin(assignees: readonly GitHubGraphqlAssignee[]): string | null {
  if (assignees.length !== 1) {
    return null;
  }
  const login = assignees[0]?.login.trim();
  return login === undefined || login.length === 0 ? null : login;
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
    mergeCommitOid: node.mergeCommit?.oid ?? null,
    finalCommitAt: node.commits.nodes.at(-1)?.commit.committedDate ?? null,
    authorLogin: node.author?.login ?? null,
    authorGitHubUserId: accountGitHubUserId(node.author),
    repositoryGitHubId: repositoryGitHubId(node),
    repositoryNameWithOwner: repositoryNameWithOwner(node),
  };
}

/**
 * The owning repository's stable identity. Absent or unusable, the pull request
 * cannot be attributed to a repository at all, which is the same standing a null
 * `databaseId` has for the pull request itself.
 */
function repositoryGitHubId(node: GitHubGraphqlPullRequestNode): number {
  const databaseId = node.repository?.databaseId;
  if (typeof databaseId !== "number" || !Number.isSafeInteger(databaseId) || databaseId <= 0) {
    throw new Error("GitHub GraphQL response was invalid.");
  }
  return databaseId;
}

/**
 * A closing reference can name a pull request in another repository, so the
 * owning repository is as load-bearing as the number and must be present.
 */
function repositoryNameWithOwner(node: GitHubGraphqlPullRequestNode): string {
  const nameWithOwner = node.repository?.nameWithOwner;
  if (typeof nameWithOwner !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(nameWithOwner)) {
    throw new Error("GitHub GraphQL response was invalid.");
  }
  return nameWithOwner;
}

/**
 * The account's immutable numeric identity, which survives a login rename.
 * Null whenever GitHub reported no usable one: an absent account, or one that
 * is not a User (Bot, Mannequin, Organization) and so has no `User.databaseId`.
 */
function accountGitHubUserId(account: GitHubGraphqlAccount | null): number | null {
  const databaseId = account?.databaseId;
  return typeof databaseId === "number" && Number.isSafeInteger(databaseId) && databaseId > 0 ? databaseId : null;
}

function toGitHubIssueTimelineItem(
  node: GitHubGraphqlIssueTimelineNode,
): { kind: "EVENT"; event: GitHubIssueHistoryEvent } | { kind: "COMMENT"; comment: GitHubIssueComment } | null {
  if (typeof node.id !== "string" || node.id.length === 0) {
    throw new Error("GitHub GraphQL response was invalid.");
  }
  switch (node.__typename) {
    case "LabeledEvent":
    case "UnlabeledEvent":
      return {
        kind: "EVENT",
        event: {
          kind: node.__typename === "LabeledEvent" ? "LABELED" : "UNLABELED",
          id: node.id,
          actorLogin: node.actor?.login ?? null,
          actorGitHubUserId: accountGitHubUserId(node.actor),
          label: node.label.name,
          createdAt: node.createdAt,
        },
      };
    case "AssignedEvent":
    case "UnassignedEvent":
      return {
        kind: "EVENT",
        event: {
          kind: node.__typename === "AssignedEvent" ? "ASSIGNED" : "UNASSIGNED",
          id: node.id,
          actorLogin: node.actor?.login ?? null,
          actorGitHubUserId: accountGitHubUserId(node.actor),
          assigneeLogin: node.assignee?.login ?? null,
          createdAt: node.createdAt,
        },
      };
    case "IssueComment":
      return {
        kind: "COMMENT",
        comment: {
          id: node.id,
          databaseId: node.databaseId,
          authorLogin: node.author?.login ?? null,
          authorGitHubUserId: accountGitHubUserId(node.author),
          body: node.body,
          createdAt: node.createdAt,
          lastEditedAt: node.lastEditedAt ?? null,
        },
      };
    default:
      return null;
  }
}

function compareIssueHistoryItems(
  left: Pick<GitHubIssueHistoryEvent | GitHubIssueComment, "createdAt" | "id">,
  right: Pick<GitHubIssueHistoryEvent | GitHubIssueComment, "createdAt" | "id">,
): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

function toGitHubPullRequestReview(
  node: GitHubGraphqlPullRequestReviewNode,
  dismissal: GitHubPullRequestReviewDismissal | null,
): GitHubPullRequestReview {
  if (node.databaseId === null) {
    throw new Error("GitHub GraphQL response was invalid.");
  }

  return {
    id: node.databaseId,
    state: node.state,
    submittedAt: node.submittedAt,
    dismissal,
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
