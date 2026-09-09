import { z } from "zod";
import type { ClaimPathEvidence } from "@/lib/domain/claim-path";
import { githubWebhookEvents } from "@/lib/github/webhook-schema";
import { collectCursorPages, GitHubGraphqlClient, type GitHubGraphqlPage } from "@/lib/github/graphql";
import { checkGraphqlRequestBudget } from "@/lib/github/graphql-request-budget";
import { classifyGitHubRateLimit, GitHubApiError } from "@/lib/github/errors";
import type { GitHubGraphqlBudgetStore } from "@/lib/github/rate-limit-budget";
export { GitHubApiError } from "@/lib/github/errors";
import { AMBIGUOUS_CLAIM_ASSIGNEE_LOGIN } from "@/lib/github/types";
import type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueHistoryEvent,
  GitHubIssueReference,
  GitHubSubject,
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
const maxWorkflowBytes = 256 * 1024;

export type GitHubGatewayOptions = {
  accessToken: string;
  apiUrl?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  budget?: GitHubGraphqlBudgetStore;
  /** Account id owning the OAuth quota; never a credential. Unowned reads are not recorded. */
  owner?: string;
};

/** Label controls opt into bulk timelines checked against independent counts and REST event/comment IDs.
 * A since-only scan reads every timeline exactly.
 */
export type GitHubIssueListOptions = {
  since?: string;
  /** Always reread the full timeline when one of these labels is standing. */
  timelineCriticalLabels?: ReadonlySet<string>;
  /** Reread when a standing label has no corresponding label event. */
  timelineWatchedLabels?: ReadonlySet<string>;
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

type GitHubRestWorkflowFile = {
  type: "file";
  name: string;
  path: string;
  size: number;
};

type GitHubRestResponse = {
  status: number;
  headers: Headers;
  body: string;
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
      budget: options.budget,
      owner: options.owner,
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

    let response: GitHubRestResponse;
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
      this.getIssuesPage(repository, cursor, options?.since),
    );
    const unique = new Map<number | null, GitHubGraphqlIssueNode>();
    for (const node of nodes) {
      const previous = unique.get(node.databaseId);
      if (previous === undefined || Date.parse(node.updatedAt) >= Date.parse(previous.updatedAt)) {
        unique.set(node.databaseId, node);
      }
    }
    const targeted = options?.timelineCriticalLabels !== undefined || options?.timelineWatchedLabels !== undefined;
    const counts = targeted ? await this.getIssueTimelineCounts(repository, [...unique.values()]) : null;
    const manifest = targeted ? await this.getIssueTimelineManifest(repository, [...unique.values()]) : null;
    const issues: GitHubIssue[] = [];
    for (const node of unique.values()) {
      const [labels, timeline, closingPullRequests] = await Promise.all([
        this.getIssueLabels(repository, node.number, node.labels),
        this.getIssueTimeline(repository, node.number, targeted ? node.timelineItems : undefined),
        this.getIssueClosingPullRequests(repository, node.number, node.closedByPullRequestsReferences),
      ]);
      // Check both fully assembled connections. A nested timeline can claim it is
      // complete while omitting events or comments, even when totalCount agrees.
      const labeled = new Set(timeline.history.flatMap((event) => event.kind === "LABELED" ? [event.label] : []));
      const expectedCount = counts?.get(node.number);
      const expectedIds = manifest?.get(node.number);
      const matchesEvidence = (value: typeof timeline) => timelineMatchesEvidence(value, expectedCount, expectedIds);
      const suspect = targeted && (!matchesEvidence(timeline) || (node.timelineItems !== undefined && labels.some((label) =>
        options?.timelineCriticalLabels?.has(label)
        || (options?.timelineWatchedLabels?.has(label) && !labeled.has(label)),
      )));
      const authoritativeTimeline = suspect ? await this.getIssueTimeline(repository, node.number) : timeline;
      if (targeted && !matchesEvidence(authoritativeTimeline)) {
        // The original evidence may describe a timeline rewritten while the scan
        // read it: such a rewrite reads as incompleteness against witnesses
        // captured earlier. Genuine truncation persists across reads, so re-take
        // both independent witnesses for this one issue and compare them against
        // THIS reread; only a persistent disagreement refuses publication.
        const [freshCounts, freshManifest] = await Promise.all([
          this.getIssueTimelineCounts(repository, [node]),
          this.getPerIssueTimelineManifest(repository, [node]),
        ]);
        if (!timelineMatchesEvidence(authoritativeTimeline, freshCounts.get(node.number), freshManifest.get(node.number))) {
          throw new Error(`GitHub issue ${node.number} timeline completeness could not be verified.`);
        }
      }
      issues.push(toGitHubIssue(node, labels, authoritativeTimeline, closingPullRequests));
    }
    return issues;
  }

  public async getIssue(repository: GitHubRepositoryReference, subject: GitHubSubject): Promise<GitHubIssue | null> {
    const data = await this.graphql.query<{
      repository: { issue: GitHubGraphqlIssueNode | null } | null;
    }>(issueQuery, { owner: repository.owner, name: repository.name, issueNumber: subject.number });
    const node = data.repository?.issue;
    if (node === null) return null;
    if (node === undefined || node.databaseId !== subject.id) {
      throw new Error("GitHub issue identity did not match the dirty subject.");
    }
    const [labels, timeline, closingPullRequests] = await Promise.all([
      this.getIssueLabels(repository, node.number, node.labels),
      this.getIssueTimeline(repository, node.number),
      this.getIssueClosingPullRequests(repository, node.number, node.closedByPullRequestsReferences),
    ]);
    return toGitHubIssue(node, labels, timeline, closingPullRequests);
  }

  public async getPullRequestClosingIssues(
    repository: GitHubRepositoryReference,
    subject: GitHubSubject,
  ): Promise<GitHubIssueReference[]> {
    const nodes = await collectCursorPages(async (cursor) => {
      const data = await this.graphql.query<{
        repository: { pullRequest: { databaseId: number; closingIssuesReferences: GitHubGraphqlPage<{
          databaseId: number; number: number; repository: { databaseId: number };
        }> } | null } | null;
      }>(closingIssuesQuery, { owner: repository.owner, name: repository.name, pullRequestNumber: subject.number, cursor });
      const pullRequest = data.repository?.pullRequest;
      if (pullRequest == null || pullRequest.databaseId !== subject.id) {
        throw new Error("GitHub pull request identity did not match the dirty subject.");
      }
      return pullRequest.closingIssuesReferences;
    });
    return nodes.map((node) => ({ id: node.databaseId, number: node.number, repositoryGitHubId: node.repository.databaseId }));
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
          events: githubWebhookEvents,
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

  public async ensureWebhookEvents(
    repository: GitHubRepositoryReference,
    webhookId: number,
    existingSecret: string,
  ): Promise<void> {
    if (!Number.isSafeInteger(webhookId) || webhookId <= 0) {
      throw new Error("GitHub webhook id must be a positive safe integer.");
    }
    if (existingSecret.length === 0) {
      throw new Error("Existing webhook secret must be configured.");
    }
    const path = `/repos/${segment(repository.owner)}/${segment(repository.name)}/hooks/${webhookId}`;
    try {
      const before = parseWebhook(await this.request(path), webhookId);
      const missing = githubWebhookEvents.filter((event) => !subscribesTo(before.events, event));
      if (missing.length === 0) return;

      // GitHub's PATCH adds events without replacing concurrent subscriptions.
      // Its update contract requires retaining the original secret explicitly;
      // GET only returns a mask. Preserve the other settings read from this hook.
      const after = parseWebhook(await this.request(path, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          add_events: missing,
          active: before.active,
          config: { ...before.config, secret: existingSecret },
        }),
      }), webhookId);
      if (
        ![...githubWebhookEvents, ...before.events].every((event) => subscribesTo(after.events, event))
        || after.active !== before.active
        || Object.entries(before.config).some(([key, value]) => key !== "secret" && after.config[key] !== value)
      ) {
        throw new Error("GitHub webhook subscription verification failed.");
      }
    } catch (error) {
      // The ordinary gateway retains diagnostic bodies for internal callers.
      // Administrative outcomes must never carry those bodies to an operator.
      if (error instanceof GitHubApiError) {
        throw new GitHubApiError(error.status, error.rateLimited, error.retryAfterSeconds);
      }
      throw error;
    }
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
    return response.body;
  }

  // Sequential reads avoid request bursts; callers treat failures as "not checked".
  // The byte cap is checked after delivery, so one transport chunk can exceed it in memory.
  // A local 8 MiB HTTP probe on Node 24.17 / Undici 7.28 yielded chunks <= 64 KiB:
  // Node frames the reads, not the server's writes. This is an observation, not a guaranteed
  // chunk limit; an injected fetch can deliver larger chunks, which are still skipped.
  public async listWorkflowFiles(
    repository: GitHubRepositoryReference,
  ): Promise<ClaimPathEvidence[]> {
    // Like request(), this path keeps one abort signal alive through headers
    // and bodies. Its deadline spans the entire workflow listing and file reads,
    // while request() gives each REST request its own deadline.
    // One ten-second budget covers all reads, honoring a shorter configured timeout.
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new Error("GitHub workflow read timed out.");
        controller.abort(error);
        reject(error);
      }, Math.min(this.timeoutMs, 10_000));
    });
    // Retain the race for injected transports that ignore abort. Body cleanup runs
    // synchronously on abort, before the deadline can settle the caller's promise.
    const beforeDeadline = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, deadline]);
    const requestWorkflow = async (path: string, init: RequestInit = {}): Promise<Response> => {
      let response: Response;
      try {
        response = await beforeDeadline(this.fetchImplementation(`${this.apiUrl}${path}`, {
          ...init,
          headers: githubHeaders(this.accessToken, init.headers),
          signal: controller.signal,
        }).then((received) => {
          // A transport that ignores abort can deliver headers after the deadline.
          if (controller.signal.aborted) {
            void received.body?.cancel().catch(() => undefined);
            controller.signal.throwIfAborted();
          }
          return received;
        }));
      } catch (error) {
        controller.signal.throwIfAborted();
        if (error instanceof GitHubApiError) throw error;
        throw new Error("GitHub request failed.");
      }
      if (!response.ok) {
        const body = await beforeDeadline(boundedResponseText(response, Infinity, controller.signal)).catch(() => null);
        controller.signal.throwIfAborted();
        const { rateLimited, retryAfterSeconds } = classifyGitHubRateLimit(response.status, response.headers, body);
        throw new GitHubApiError(response.status, rateLimited, retryAfterSeconds, body);
      }
      return response;
    };
    try {
      const contentsPath = `/repos/${segment(repository.owner)}/${segment(repository.name)}/contents`;
      let response: Response;
      try {
        response = await requestWorkflow(`${contentsPath}/.github/workflows`);
      } catch (error) {
        if (error instanceof GitHubApiError && error.status === 404) {
          return [];
        }
        throw error;
      }

      let entries: unknown;
      try {
        const text = await beforeDeadline(boundedResponseText(response, Infinity, controller.signal));
        entries = JSON.parse(text ?? "");
      } catch {
        controller.signal.throwIfAborted();
        throw new Error("GitHub API response was invalid.");
      }
      if (!Array.isArray(entries)) {
        return [];
      }
      const files = entries.filter((entry: unknown): entry is GitHubRestWorkflowFile =>
        entry !== null && typeof entry === "object" && !Array.isArray(entry)
        && "type" in entry && entry.type === "file"
        && "name" in entry && typeof entry.name === "string" && entry.name.length > 0
        && "path" in entry && typeof entry.path === "string" && entry.path.length > 0
        && "size" in entry && typeof entry.size === "number" && Number.isSafeInteger(entry.size)
        && entry.size >= 0 && entry.size <= maxWorkflowBytes && /\.ya?ml$/i.test(entry.name))
        .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
        .slice(0, 50);
      const workflows: ClaimPathEvidence[] = [];
      for (const entry of files) {
        const fileResponse = await requestWorkflow(
          `${contentsPath}/${entry.path.split("/").map(segment).join("/")}`,
          { headers: { Accept: "application/vnd.github.raw" } },
        );
        const content = await beforeDeadline(boundedResponseText(fileResponse, maxWorkflowBytes, controller.signal));
        if (content !== null) {
          workflows.push({ path: entry.path, content });
        }
      }
      return workflows;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async getIssuesPage(
    repository: GitHubRepositoryReference,
    cursor: string | null,
    since?: string,
  ): Promise<GitHubGraphqlPage<GitHubGraphqlIssueNode>> {
    const data = await this.graphql.query<{
      repository: { issues: GitHubGraphqlPage<GitHubGraphqlIssueNode> } | null;
      rateLimit?: { cost: number; limit: number; remaining: number; resetAt: string } | null;
    }>(issuesQuery, { owner: repository.owner, name: repository.name, cursor, since });
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

  private async getIssueTimelineManifest(
    repository: GitHubRepositoryReference,
    issues: readonly GitHubGraphqlIssueNode[],
  ): Promise<Map<number, Set<string>>> {
    const manifest = new Map(issues.map((issue) => [issue.number, new Set<string>()]));
    if (issues.length === 0) return manifest;
    const identities = new Map(issues.map((issue) => [issue.number, issue.databaseId]));
    const watchedEvents = new Set(["labeled", "unlabeled", "assigned", "unassigned"]);
    const path = `/repos/${segment(repository.owner)}/${segment(repository.name)}/issues`;
    let requests = 0;
    // These repository-wide REST collections enumerate IDs independently of the
    // degraded GraphQL timeline resolver. Never treat an unfinished manifest as
    // proof: large repositories fail closed at a bounded request budget.
    const readPage = async (collection: "events" | "comments", page: number): Promise<GitHubRestResponse> => {
      if (requests === 50) {
        throw new Error("GitHub timeline completeness could not be verified within 50 repository manifest requests.");
      }
      checkGraphqlRequestBudget();
      requests += 1;
      const response = await this.request(`${path}/${collection}?per_page=100&page=${page}`);
      const payload = await responseJson<unknown>(response);
      if (collection === "events") {
        for (const event of manifestEventRows.parse(payload)) {
          if (!watchedEvents.has(event.event) || !manifest.has(event.issue.number)) continue;
          if (identities.get(event.issue.number) !== event.issue.id) {
            throw new Error("GitHub timeline manifest issue identity was invalid.");
          }
          manifest.get(event.issue.number)!.add(event.node_id);
        }
      } else {
        for (const comment of manifestCommentRows.parse(payload)) {
          const match = /\/repos\/([^/]+)\/([^/]+)\/issues\/([1-9]\d*)$/.exec(new URL(comment.issue_url).pathname);
          if (match === null || match[1]!.toLowerCase() !== segment(repository.owner).toLowerCase()
            || match[2]!.toLowerCase() !== segment(repository.name).toLowerCase()) {
            throw new Error("GitHub timeline manifest issue URL was invalid.");
          }
          const number = Number(match[3]);
          if (!Number.isSafeInteger(number)) throw new Error("GitHub timeline manifest issue number was invalid.");
          manifest.get(number)?.add(comment.node_id);
        }
      }
      return response;
    };
    // Estimate both collections from their first pages BEFORE walking them: a
    // repository that outgrew the 50-request budget would otherwise exhaust it
    // deterministically, failing every retry forever. rel="last" carries the
    // page count; no rel="next" at all means a single page; rel="next" without
    // rel="last" is UNKNOWN size and refuses the repo-wide walk in favor of the
    // per-issue fallback below.
    const estimates = new Map<"events" | "comments", { more: boolean; pages: number | null }>();
    for (const collection of ["events", "comments"] as const) {
      const link = (await readPage(collection, 1)).headers.get("link");
      estimates.set(collection, hasNextLink(link) ? { more: true, pages: lastLinkPage(link) } : { more: false, pages: 1 });
    }
    const eventsPages = estimates.get("events")!.pages;
    const commentsPages = estimates.get("comments")!.pages;
    if (eventsPages !== null && commentsPages !== null && eventsPages + commentsPages <= 50) {
      for (const collection of ["events", "comments"] as const) {
        let more = estimates.get(collection)!.more;
        for (let page = 1; more; ) {
          page += 1;
          more = hasNextLink((await readPage(collection, page)).headers.get("link"));
        }
      }
      return manifest;
    }
    // The estimate refused the repo-wide walk, or pages shifted beyond it
    // mid-walk. The repository has outgrown the budget; that is a cost problem,
    // not a verdict about the timeline, so enumerate each scanned issue's own
    // REST collections instead. Exhaustion below is a cost guard — the queue's
    // retry backoff remains the recovery path, and no cooldown is set for it.
    return this.getPerIssueTimelineManifest(repository, issues);
  }

  /**
   * Rebuilds every manifest entry from per-issue REST collections, mirroring
   * the repo-wide walk's validation: identical zod schemas, and the same
   * identity error when a row names a different issue or a foreign id. The
   * issue number comes from the request path, so no issue_url parsing happens.
   * This enumerator is also the fresh witness on the suspect path, so it must
   * depend on nothing captured before the reread it verifies.
   */
  private async getPerIssueTimelineManifest(
    repository: GitHubRepositoryReference,
    issues: readonly GitHubGraphqlIssueNode[],
  ): Promise<Map<number, Set<string>>> {
    const manifest = new Map(issues.map((issue) => [issue.number, new Set<string>()]));
    if (issues.length === 0) return manifest;
    const identities = new Map(issues.map((issue) => [issue.number, issue.databaseId]));
    const watchedEvents = new Set(["labeled", "unlabeled", "assigned", "unassigned"]);
    const path = `/repos/${segment(repository.owner)}/${segment(repository.name)}/issues`;
    const budget = issues.length * 4 + 4;
    let requests = 0;
    for (const issue of issues) {
      for (const collection of ["events", "comments"] as const) {
        for (let page = 1; ; page += 1) {
          if (requests === budget) {
            throw new Error("GitHub timeline completeness could not be verified within the per-issue manifest request budget.");
          }
          checkGraphqlRequestBudget();
          requests += 1;
          const response = await this.request(`${path}/${issue.number}/${collection}?per_page=100&page=${page}`);
          const payload = await responseJson<unknown>(response);
          if (collection === "events") {
            for (const event of manifestEventRows.parse(payload)) {
              if (event.issue.number !== issue.number || identities.get(issue.number) !== event.issue.id) {
                throw new Error("GitHub timeline manifest issue identity was invalid.");
              }
              if (watchedEvents.has(event.event)) {
                manifest.get(issue.number)!.add(event.node_id);
              }
            }
          } else {
            for (const comment of manifestCommentRows.parse(payload)) {
              manifest.get(issue.number)!.add(comment.node_id);
            }
          }
          if (!hasNextLink(response.headers.get("link"))) break;
        }
      }
    }
    return manifest;
  }

  private async getIssueTimelineCounts(
    repository: GitHubRepositoryReference,
    issues: readonly GitHubGraphqlIssueNode[],
  ): Promise<Map<number, number>> {
    const counts = new Map<number, number>();
    // Count-only queries with 100 distinct issues also degrade. Keep these reads
    // independent of the bulk connection and bounded to 20 issue lookups.
    for (let offset = 0; offset < issues.length; offset += 20) {
      const batch = issues.slice(offset, offset + 20);
      const variables: Record<string, string | number> = { owner: repository.owner, name: repository.name };
      const fields = batch.map((issue) => {
        variables[`number${issue.number}`] = issue.number;
        return `i${issue.number}: issue(number: $number${issue.number}) {
          databaseId
          timelineItems(first: 0, itemTypes: ${issueTimelineItemTypes}) { totalCount }
        }`;
      });
      const data = await this.graphql.query<{
        repository: Record<string, { databaseId: number; timelineItems: { totalCount: number } } | null> | null;
      }>(`query IssueTimelineCounts($owner: String!, $name: String!, ${batch.map((issue) => `$number${issue.number}: Int!`).join(", ")}) {
        rateLimit { cost limit remaining resetAt }
        repository(owner: $owner, name: $name) { ${fields.join("\n")} }
      }`, variables);
      for (const issue of batch) {
        const node = data.repository?.[`i${issue.number}`];
        const count = node?.timelineItems?.totalCount;
        if (node?.databaseId !== issue.databaseId || !Number.isSafeInteger(count) || count === undefined || count < 0) {
          throw new Error(`GitHub issue ${issue.number} timeline completeness count was invalid.`);
        }
        counts.set(issue.number, count);
      }
    }
    return counts;
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

  private async request(path: string, init: RequestInit = {}): Promise<GitHubRestResponse> {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    // One absolute deadline covers headers and body: require progress within
    // timeoutMs, not just liveness from trickling bytes. Never reset per chunk.
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        const error = new Error("GitHub request timed out.");
        controller.abort(error);
        reject(error);
      }, this.timeoutMs);
    });
    // Injected transports can ignore abort, so race both headers and body reads.
    const beforeDeadline = <T>(operation: Promise<T>): Promise<T> => Promise.race([operation, deadline]);

    try {
      const response = await beforeDeadline(this.fetchImplementation(`${this.apiUrl}${path}`, {
        ...init,
        headers: githubHeaders(this.accessToken, init.headers),
        signal: controller.signal,
      }).then((received) => {
        // An abort-ignoring transport can still deliver a body after the deadline.
        if (controller.signal.aborted) {
          void received.body?.cancel().catch(() => undefined);
          controller.signal.throwIfAborted();
        }
        return received;
      }));

      if (!response.ok) {
        // HTTP failure intentionally takes precedence over a body timeout; pinned by
        // "preserves the HTTP failure when reading its body is aborted" in graphql.test.ts.
        const body = await beforeDeadline(boundedResponseText(response, Infinity, controller.signal)).catch(() => null);
        const { rateLimited, retryAfterSeconds } = classifyGitHubRateLimit(response.status, response.headers, body);
        throw new GitHubApiError(response.status, rateLimited, retryAfterSeconds, body);
      }

      // Drain successful bodies even when callers only need the status.
      const body = await beforeDeadline(boundedResponseText(response, Infinity, controller.signal));
      return { status: response.status, headers: response.headers, body: body ?? "" };
    } catch (error) {
      if (error instanceof Error && error.message === "GitHub request timed out.") {
        throw error;
      }

      if (error instanceof GitHubApiError) {
        throw error;
      }

      controller.signal.throwIfAborted();

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
  stateReason: GitHubIssue["stateReason"];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  author: GitHubGraphqlAccount | null;
  labels: GitHubGraphqlLabelConnection;
  assignees: { nodes: GitHubGraphqlAssignee[] };
  timelineItems: GitHubGraphqlIssueTimelineConnection;
  closedByPullRequestsReferences: GitHubGraphqlPage<GitHubGraphqlPullRequestNode>;
};

type GitHubGraphqlAssignee = { login: string; databaseId?: number | null };

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

const issueTimelineItemTypes = "[LABELED_EVENT, UNLABELED_EVENT, ASSIGNED_EVENT, UNASSIGNED_EVENT, ISSUE_COMMENT]";

const issueFields = `
          databaseId
          number
          title
          body
          url
          state
          stateReason
          createdAt
          updatedAt
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
            nodes { login ... on User { databaseId } }
          }
          timelineItems(
            first: 50
            itemTypes: ${issueTimelineItemTypes}
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
`;

const issuesQuery = `
  query RepositoryIssues($owner: String!, $name: String!, $cursor: String, $since: DateTime) {
    rateLimit { cost limit remaining resetAt }
    repository(owner: $owner, name: $name) {
      issues(first: 100, after: $cursor, filterBy: { since: $since }, orderBy: { field: UPDATED_AT, direction: DESC }) {
        nodes { ${issueFields} }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;

const issueQuery = `
  query RepositoryIssue($owner: String!, $name: String!, $issueNumber: Int!) {
    rateLimit { cost limit remaining resetAt }
    repository(owner: $owner, name: $name) {
      issue(number: $issueNumber) { ${issueFields} }
    }
  }
`;

const closingIssuesQuery = `
  query PullRequestClosingIssues($owner: String!, $name: String!, $pullRequestNumber: Int!, $cursor: String) {
    rateLimit { cost limit remaining resetAt }
    repository(owner: $owner, name: $name) {
      pullRequest(number: $pullRequestNumber) {
        databaseId
        closingIssuesReferences(first: 100, after: $cursor) {
          nodes { databaseId number repository { databaseId } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

const closingPullRequestsQuery = `
  query ClosingPullRequests($owner: String!, $name: String!, $issueNumber: Int!, $cursor: String) {
    rateLimit { cost limit remaining resetAt }
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
    rateLimit { cost limit remaining resetAt }
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
    rateLimit { cost limit remaining resetAt }
    repository(owner: $owner, name: $name) {
      issue(number: $issueNumber) {
        timelineItems(
          first: 100
          after: $cursor
          itemTypes: ${issueTimelineItemTypes}
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
    rateLimit { cost limit remaining resetAt }
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
    rateLimit { cost limit remaining resetAt }
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
  if (typeof payload?.private !== "boolean") {
    throw new Error("GitHub API response was invalid.");
  }
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

const webhookSchema = z.object({
  id: z.number().int().positive().safe(),
  active: z.boolean(),
  events: z.array(z.string().min(1)),
  config: z.object({
    url: z.url(),
    content_type: z.enum(["json", "form"]),
    insecure_ssl: z.union([z.literal("0"), z.literal("1"), z.literal(0), z.literal(1)]),
  }).catchall(z.union([z.string(), z.number(), z.boolean()])),
});

function parseWebhook(response: GitHubRestResponse, webhookId: number): z.infer<typeof webhookSchema> {
  let payload: unknown;
  try { payload = JSON.parse(response.body); } catch { /* Invalid responses fail closed below. */ }
  const parsed = webhookSchema.safeParse(payload);
  if (response.status !== 200 || !parsed.success || parsed.data.id !== webhookId) {
    throw new Error("GitHub webhook response was invalid.");
  }
  return parsed.data;
}

function subscribesTo(events: readonly string[], event: string): boolean {
  return events.includes("*") || events.includes(event);
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
    stateReason: node.stateReason,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    closedAt: node.closedAt,
    authorLogin: node.author?.login ?? null,
    authorGitHubUserId: accountGitHubUserId(node.author),
    labels,
    claimAssigneeGitHubLogin: claimAssigneeLogin(node.assignees.nodes),
    claimAssigneeGitHubUserId: claimAssigneeGitHubUserId(node.assignees.nodes),
    history: timeline.history,
    comments: timeline.comments,
    closingPullRequests,
  };
}

/**
 * The claim lock GitHub's assignee page states, under the `assignees(first: 2)`
 * page cap: no assignee is null, exactly one unambiguous assignee is its login,
 * and two nodes reliably mean two or more assignees, which is the reserved
 * ambiguous-claim login — never null, so an ambiguous claim stays
 * distinguishable from an unassigned issue and keeps reserving exposure.
 */
function claimAssigneeLogin(assignees: readonly GitHubGraphqlAssignee[]): string | null {
  if (assignees.length >= 2) {
    return AMBIGUOUS_CLAIM_ASSIGNEE_LOGIN;
  }
  if (assignees.length === 0) {
    return null;
  }
  const login = assignees[0]?.login.trim();
  return login === undefined || login.length === 0 ? null : login;
}

/**
 * The claim assignee's immutable numeric identity, read from the SAME single
 * unambiguous assignee node the login comes from, so the two can never describe
 * different accounts. Null whenever GitHub reported no usable one — no
 * assignee, several, or one that is not a User (Bot, Mannequin, Organization).
 */
function claimAssigneeGitHubUserId(assignees: readonly GitHubGraphqlAssignee[]): number | null {
  if (assignees.length !== 1) {
    return null;
  }
  return accountGitHubUserId(assignees[0] ?? null);
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

/**
 * Orders timeline items chronologically. Intra-instant order is DELIBERATELY
 * unspecified: GitHub node ids are opaque and the timeline carries no
 * sub-second sequence signal, so no data-determined order exists for events
 * sharing an instant, and consumers must not depend on one. (A stable sort
 * keeps arrival order within an instant; the settlement fold reduces
 * same-instant label evidence by instant, not by arrival-ordered replay.)
 */
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

async function boundedResponseText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string | null> {
  if (response.body === null) {
    return "";
  }
  const reader = response.body.getReader();
  const cleanup = () => {
    try {
      // Cancellation may reject or never settle. Initiate it without awaiting it,
      // then release the reader immediately, including when a read is pending.
      void reader.cancel().catch(() => undefined);
    } catch {
      // Cleanup must not replace the read's result or error.
    } finally {
      reader.releaseLock();
    }
  };
  signal.addEventListener("abort", cleanup, { once: true });
  const decoder = new TextDecoder();
  let bytes = 0;
  let content = "";
  try {
    signal.throwIfAborted();
    while (true) {
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      if (done) {
        return content + decoder.decode();
      }
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        return null;
      }
      content += decoder.decode(value, { stream: true });
    }
  } finally {
    signal.removeEventListener("abort", cleanup);
    cleanup();
  }
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

async function responseJson<T>(response: GitHubRestResponse): Promise<T> {
  try {
    return JSON.parse(response.body) as T;
  } catch {
    throw new Error("GitHub API response was invalid.");
  }
}

function hasNextLink(linkHeader: string | null): boolean {
  return linkHeader?.split(",").some((link) => /rel="?next"?/.test(link)) ?? false;
}

/**
 * The rel="last" page number, or null when it is absent or unusable — an
 * UNKNOWN collection size that is never treated as small. Absent rel="next"
 * never reaches this: that case already means a single page.
 */
function lastLinkPage(linkHeader: string | null): number | null {
  const last = linkHeader?.split(",").find((link) => /rel="?last"?/.test(link));
  if (last === undefined) return null;
  const target = /<([^>]+)>/.exec(last)?.[1];
  if (target === undefined) return null;
  const page = Number(new URL(target, "https://api.github.com").searchParams.get("page"));
  return Number.isSafeInteger(page) && page >= 1 ? page : null;
}

/**
 * The one completeness rule for every witness pair: the timeline's ids must be
 * exactly as many as the independent count, unique, and exactly the REST
 * manifest's ids. The scan-time evidence and the fresh pair taken for a
 * suspect reread run this same comparison, so a mid-read rewrite and a truly
 * truncated read are separated by whether disagreement persists across
 * re-taken evidence — never by a different rule.
 */
function timelineMatchesEvidence(
  timeline: { history: Array<{ id: string }>; comments: Array<{ id: string }> },
  expectedCount: number | undefined,
  expectedIds: Set<string> | undefined,
): boolean {
  const ids = [...timeline.history, ...timeline.comments].map(({ id }) => id);
  return ids.length === expectedCount && new Set(ids).size === expectedCount
    && expectedIds?.size === expectedCount && ids.every((id) => expectedIds.has(id));
}

/** Identical row schemas for the repo-wide walk and the per-issue fallback. */
const manifestEventRows = z.array(z.object({
  node_id: z.string().min(1), event: z.string(),
  issue: z.object({ id: z.number().int().positive().safe(), number: z.number().int().positive().safe() }),
}));
const manifestCommentRows = z.array(z.object({ node_id: z.string().min(1), issue_url: z.url() }));
