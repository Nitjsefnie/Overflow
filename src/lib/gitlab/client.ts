import type { ClaimPathEvidence } from "@/lib/domain/claim-path";
import type { GitHubIssueListOptions } from "@/lib/github/client";
import type {
  GitHubIssue,
  GitHubIssueReference,
  GitHubPullRequest,
  GitHubPullRequestReview,
  GitHubRepository,
  GitHubRepositoryReference,
  GitHubSubject,
  GitHubWebhook,
  GitHubWebhookConfiguration,
} from "@/lib/github/types";

const defaultTimeoutMs = 10_000;

/**
 * GitLab names three commit SHAs on a merged merge request (contract gap 5):
 * the branch head (`sha`), the merge commit (`merge_commit_sha`) and the
 * squash commit (`squash_commit_sha`). The GitHub-shaped MR carries the merge
 * commit as `mergeCommitOid`; the other two travel here so the evidence a
 * merge produced is never reduced to one of its three names.
 */
export type GitLabMergeRequest = GitHubPullRequest & {
  sourceSha: string | null;
  squashCommitSha: string | null;
};

export class GitLabApiError extends Error {
  public readonly body: string | null;

  public constructor(
    public readonly status: number,
    body: string | null = null,
  ) {
    super(`GitLab API request failed with status ${status}.`);
    this.name = "GitLabApiError";
    this.body = body === null ? null : body.slice(0, 500);
  }

  // Keep response diagnostics in service logs, out of serialized API errors.
  public toJSON() {
    return { name: this.name, status: this.status };
  }
}

type GitLabProject = {
  id: number;
  name: string;
  path: string;
  path_with_namespace: string;
  visibility: string;
  web_url: string;
  namespace: { name: string; path: string; kind: string };
  permissions?: {
    project_access?: { access_level?: number } | null;
    group_access?: { access_level?: number } | null;
  };
};

type GitLabMergeRequestObject = {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
  author: { id: number; username: string };
  created_at: string;
  updated_at: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
  sha: string | null;
  squash_commit_sha: string | null;
};

type GitLabIssueObject = {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string | null;
  state: string;
  web_url: string;
  author: { id: number; username: string };
  labels: string[];
  created_at: string;
  updated_at: string;
  closed_at: string | null;
  assignees?: Array<{ id: number; username: string }>;
  assignee?: { id: number; username: string } | null;
};

type GitLabRestResponse = {
  status: number;
  headers: Headers;
  body: string;
};

type GitLabHookObject = {
  id: number;
  url: string;
  push_events: boolean;
  issues_events: boolean;
  merge_requests_events: boolean;
};

/**
 * GitLab timestamp shapes vary — millisecond precision with Z, second
 * precision with Z, and explicit offsets — and one of them round-trips
 * through Date differently than it arrived. Normalization happens exactly
 * once, here at the gateway boundary, so every field a caller reads is ISO
 * UTC.
 */
function normalizeTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`GitLab returned an unparsable timestamp: ${value}`);
  }
  return parsed.toISOString();
}

function segment(value: string): string {
  return encodeURIComponent(value);
}

export type GitLabGatewayOptions = {
  instanceUrl: string;
  token: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

export class GitLabGateway {
  private readonly instanceUrl: string;
  private readonly token: string;
  private readonly fetchImplementation: typeof fetch;
  private readonly timeoutMs: number;

  public constructor(options: GitLabGatewayOptions) {
    this.instanceUrl = options.instanceUrl.replace(/\/$/, "");
    this.token = options.token;
    this.fetchImplementation = options.fetch ?? fetch;
    this.timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  }

  public async getRepository(repository: GitHubRepositoryReference): Promise<GitHubRepository> {
    const response = await this.request(`/projects/${segment(`${repository.owner}/${repository.name}`)}`);
    return toGitHubRepository(await responseJson<GitLabProject>(response));
  }

  public async getRepositoryById(gitlabProjectId: number): Promise<GitHubRepository | null> {
    if (!Number.isSafeInteger(gitlabProjectId) || gitlabProjectId <= 0) {
      throw new Error("GitLab project id must be a positive safe integer.");
    }
    let response: GitLabRestResponse;
    try {
      response = await this.request(`/projects/${gitlabProjectId}`);
    } catch (error) {
      // Only 404 answers "this id is unreachable". Every other failure is an
      // upstream problem, and reading one as a deleted project would retire a
      // live one.
      if (error instanceof GitLabApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
    return toGitHubRepository(await responseJson<GitLabProject>(response));
  }

  public async listIssues(
    repository: GitHubRepositoryReference,
    options?: GitHubIssueListOptions,
  ): Promise<GitHubIssue[]> {
    // `since` — the reconciliation's incremental cursor — maps to GitLab's
    // `updated_after`; the timeline controls have no GitLab equivalent and
    // stay unimplemented rather than silently ignored (their parity is the
    // reconciliation's concern, not the transport's).
    const since = options?.since === undefined ? "" : `&updated_after=${encodeURIComponent(options.since)}`;
    const objects = await this.listAllPages<GitLabIssueObject>(
      `/projects/${segment(`${repository.owner}/${repository.name}`)}/issues${since}`,
    );
    return objects.map(toGitHubIssue);
  }

  public async getIssue(repository: GitHubRepositoryReference, subject: GitHubSubject): Promise<GitHubIssue | null> {
    let response: GitLabRestResponse;
    try {
      response = await this.request(
        `/projects/${segment(`${repository.owner}/${repository.name}`)}/issues/${subject.number}`,
      );
    } catch (error) {
      if (error instanceof GitLabApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
    const object = await responseJson<GitLabIssueObject>(response);
    if (object.id !== subject.id) {
      throw new Error("GitLab issue identity did not match the dirty subject.");
    }
    return toGitHubIssue(object);
  }

  public async getPullRequest(repository: GitHubRepositoryReference, mergeRequestIid: number): Promise<GitLabMergeRequest> {
    const response = await this.request(
      `/projects/${segment(`${repository.owner}/${repository.name}`)}/merge_requests/${mergeRequestIid}`,
    );
    const mergeRequest = await responseJson<GitLabMergeRequestObject>(response);
    return this.withFinalCommitAt(repository, mergeRequestIid, mergeRequest);
  }

  /**
   * The fold's evidence window reads `finalCommitAt` (the last push before the
   * merge), and the MR object does not carry it — it lives on the MR's commits.
   * One bounded commit read supplies it; a failed read leaves it null, where
   * the fold's own validity check refuses the MR rather than guessing.
   */
  private async withFinalCommitAt(
    repository: GitHubRepositoryReference,
    mergeRequestIid: number,
    mergeRequest: GitLabMergeRequestObject,
  ): Promise<GitLabMergeRequest> {
    const mapped = toGitLabMergeRequest(mergeRequest);
    if (mergeRequest.merged_at === null) {
      return mapped;
    }
    try {
      const commits = await this.listAllPages<{ committed_at: string | null; committed_date: string }>(
        `/projects/${segment(`${repository.owner}/${repository.name}`)}/merge_requests/${mergeRequestIid}/commits?per_page=100`,
      );
      const timestamps = commits
        .map((commit) => commit.committed_at ?? commit.committed_date)
        .filter((value): value is string => typeof value === "string");
      mapped.finalCommitAt = timestamps.length === 0
        ? null
        : normalizeTimestamp(timestamps.slice().sort().at(-1)!);
    } catch {
      mapped.finalCommitAt = null;
    }
    return mapped;
  }

  public async getPullRequestClosingIssues(
    repository: GitHubRepositoryReference,
    subject: GitHubSubject,
  ): Promise<GitHubIssueReference[]> {
    const objects = await this.listAllPages<{ id: number; iid: number; project_id: number }>(
      `/projects/${segment(`${repository.owner}/${repository.name}`)}/merge_requests/${subject.number}/closes_issues`,
    );
    return objects.map((object) => ({ id: object.id, number: object.iid, repositoryGitHubId: object.project_id }));
  }

  public async getIssueClosingPullRequests(
    repository: GitHubRepositoryReference,
    issueIid: number,
    // The GitHub signature carries a GraphQL continuation page; GitLab has no
    // such page, so the parameter exists for seam parity and is never used.
    _initialPage?: unknown,
  ): Promise<GitLabMergeRequest[]> {
    void _initialPage;
    const objects = await this.listAllPages<GitLabMergeRequestObject>(
      `/projects/${segment(`${repository.owner}/${repository.name}`)}/issues/${issueIid}/closed_by`,
    );
    const mapped: GitLabMergeRequest[] = [];
    for (const object of objects) {
      mapped.push(await this.withFinalCommitAt(repository, object.iid, object));
    }
    return mapped;
  }

  /**
   * GitLab approvals are not review rounds: contract decision 2 prices every
   * GitLab review round at zero, so the reviews list is permanently empty.
   * The seam stays honest by returning the empty verdict rather than mapping
   * approvals into a shape that would price them. Revisit only if the
   * contract's extension criterion — a GitLab-native round equivalent —
   * ever lands.
   */
  public async getPullRequestReviews(
    _repository: GitHubRepositoryReference,
    _pullRequestNumber: number,
  ): Promise<GitHubPullRequestReview[]> {
    void _repository;
    void _pullRequestNumber;
    return [];
  }

  /**
   * Contract item 30, graded NOT SUPPLIED by the 2026-09-11 probe: GitLab CI
   * has no issue-comment pipeline source, so no in-repo workflow artifact can
   * evidence claim automation. A GitLab gateway's claim-path verdict is
   * permanently NOT_CHECKED.
   */
  public async listWorkflowFiles(_repository: GitHubRepositoryReference): Promise<ClaimPathEvidence[]> {
    void _repository;
    return [];
  }

  /**
   * Contract gap 8: the labels endpoint is auth-gated on at least one public
   * project, so a refusal here falls back to the union of labels embedded in
   * the issues the gateway can read.
   */
  public async listRepositoryLabels(repository: GitHubRepositoryReference): Promise<Set<string>> {
    let labels: Set<string>;
    try {
      const response = await this.request(
        `/projects/${segment(`${repository.owner}/${repository.name}`)}/labels?per_page=100`,
      );
      const payload = await responseJson<Array<{ name: string }>>(response);
      labels = new Set(payload.filter((label) => typeof label.name === "string").map((label) => label.name));
    } catch (error) {
      if (!(error instanceof GitLabApiError) || (error.status !== 401 && error.status !== 403)) {
        throw error;
      }
      labels = new Set();
      const issues = await this.listIssues(repository);
      for (const gitlabIssue of issues) {
        for (const label of gitlabIssue.labels) labels.add(label);
      }
    }
    return labels;
  }

  public async getPullRequestDiff(repository: GitHubRepositoryReference, mergeRequestIid: number): Promise<string> {
    const response = await this.request(
      `/projects/${segment(`${repository.owner}/${repository.name}`)}/merge_requests/${mergeRequestIid}/diff`,
    );
    return response.body;
  }

  public async createWebhook(
    repository: GitHubRepositoryReference,
    configuration: GitHubWebhookConfiguration,
  ): Promise<GitHubWebhook> {
    const response = await this.request(
      `/projects/${segment(`${repository.owner}/${repository.name}`)}/hooks`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          url: configuration.callbackUrl,
          token: configuration.secret,
          // The events the GitHub side ensures, in GitLab's flag vocabulary.
          issue_events: true,
          merge_requests_events: true,
          // Deliveries are event-scoped; a push would be noise.
          push_events: false,
        }),
      },
    );
    const payload = await responseJson<{ id: number }>(response);
    return { id: payload.id };
  }

  public async deleteWebhook(repository: GitHubRepositoryReference, webhookId: number): Promise<void> {
    await this.request(
      `/projects/${segment(`${repository.owner}/${repository.name}`)}/hooks/${webhookId}`,
      { method: "DELETE" },
    );
  }

  public async ensureWebhookEvents(
    repository: GitHubRepositoryReference,
    webhookId: number,
    existingSecret: string,
  ): Promise<void> {
    if (!Number.isSafeInteger(webhookId) || webhookId <= 0) {
      throw new Error("GitLab webhook id must be a positive safe integer.");
    }
    if (existingSecret.length === 0) {
      throw new Error("Existing webhook secret must be configured.");
    }
    const path = `/projects/${segment(`${repository.owner}/${repository.name}`)}/hooks/${webhookId}`;
    const hook = await responseJson<GitLabHookObject>(await this.request(path));
    if (hook.issues_events === true && hook.merge_requests_events === true) return;
    await this.request(path, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      // GitLab's request parameter is `issue_events`; the response field is
      // `issues_events` — the vocabulary difference is GitLab's, not ours.
      body: JSON.stringify({ issue_events: true, merge_requests_events: true }),
    });
  }

  private async request(path: string, init: RequestInit = {}): Promise<GitLabRestResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let status: number;
    let headers: Headers;
    let body: string;
    try {
      const response = await this.fetchImplementation(`${this.instanceUrl}/api/v4${path}`, {
        ...init,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(init.headers as Record<string, string> | undefined),
        },
        signal: controller.signal,
      });
      status = response.status;
      headers = response.headers;
      body = await response.text();
    } catch (error) {
      // Transport failure — timeout abort or connection error. A status of 0
      // names it without impersonating any HTTP status.
      throw new GitLabApiError(0, error instanceof Error ? error.message : "transport failure");
    } finally {
      clearTimeout(timeout);
    }
    if (status < 200 || status >= 300) {
      throw new GitLabApiError(status, body);
    }
    return { status, headers, body };
  }

  private async listAllPages<T>(path: string): Promise<T[]> {
    // Keyset pagination (contract gap 7, live-verified): offset pagination
    // drifts when rows shift between pages, and reconciliation reads exactly
    // the surfaces where that would silently skip evidence. Ordered by id
    // ascending, following the x-next-page-cursor the server hands back.
    const items: T[] = [];
    let cursor: string | null = null;
    for (;;) {
      const separator = path.includes("?") ? "&" : "?";
      const base = `${path}${separator}per_page=100&pagination=keyset&order_by=id&sort=asc`;
      const target = cursor === null ? base : `${base}&cursor=${encodeURIComponent(cursor)}`;
      const response = await this.request(target);
      const payload = await responseJson<T[]>(response);
      items.push(...payload);
      cursor = response.headers.get("x-next-page-cursor");
      if (cursor === null || cursor === "") break;
    }
    return items;
  }
}

function toGitHubRepository(project: GitLabProject): GitHubRepository {
  const pathParts = project.path_with_namespace.split("/");
  const owner = pathParts.slice(0, -1).join("/");
  // GitLab reports the effective access level as the higher of the direct
  // project access and the access inherited through the namespace group:
  // a group Maintainer carries project_access === null and group_access at
  // Maintainer, so reading project_access alone would refuse someone who
  // genuinely holds the permission. Maintainer (40) or Owner (50) either way.
  const effectiveAccessLevel = Math.max(
    project.permissions?.project_access?.access_level ?? 0,
    project.permissions?.group_access?.access_level ?? 0,
  );
  return {
    id: project.id,
    owner,
    // GitLab's `name` is the display name and may differ from the path slug,
    // while every project endpoint is addressed owner/name. `name` is
    // therefore the last path segment, so owner/name joined always equals
    // path_with_namespace (issue 543).
    name: pathParts[pathParts.length - 1],
    ownerType: project.namespace?.kind === "group" ? "ORGANIZATION" : "USER",
    fullName: project.path_with_namespace,
    visibility: project.visibility === "public" ? "PUBLIC" : "PRIVATE",
    url: project.web_url,
    canAdminister: effectiveAccessLevel >= 40,
  };
}

function toGitHubIssue(object: GitLabIssueObject): GitHubIssue {
  const assignee = object.assignees?.[0] ?? object.assignee ?? null;
  return {
    id: object.id,
    number: object.iid,
    title: object.title,
    body: object.description ?? "",
    url: object.web_url,
    // GitLab's two states map exactly onto the ledger's two.
    state: object.state === "opened" ? "OPEN" : "CLOSED",
    // Contract item 16: GitLab carries no state_reason. The NOT_PLANNED gate
    // is skipped for GitLab rows — recorded here where the absence is made.
    stateReason: null,
    createdAt: normalizeTimestamp(object.created_at),
    updatedAt: normalizeTimestamp(object.updated_at),
    closedAt: object.closed_at === null ? null : normalizeTimestamp(object.closed_at),
    authorLogin: object.author?.username ?? null,
    authorGitHubUserId: object.author?.id ?? null,
    labels: object.labels ?? [],
    claimAssigneeGitHubLogin: assignee?.username ?? null,
    claimAssigneeGitHubUserId: assignee?.id ?? null,
    // Timeline parity (label events, comments, closing references embedded in
    // the issue) is the reconciliation surface — issue 296 step 2 C2 — not the
    // registration surface this gateway is first consumed by.
    history: [],
    comments: [],
    closingPullRequests: [],
  };
}

function toGitLabMergeRequest(object: GitLabMergeRequestObject): GitLabMergeRequest {
  return {
    id: object.id,
    number: object.iid,
    title: object.title,
    body: object.description ?? "",
    url: object.web_url,
    state: object.state === "merged" ? "MERGED" : object.state === "closed" ? "CLOSED" : "OPEN",
    mergedAt: object.merged_at === null ? null : normalizeTimestamp(object.merged_at),
    mergeCommitOid: object.merge_commit_sha,
    finalCommitAt: null,
    authorLogin: object.author?.username ?? null,
    authorGitHubUserId: object.author?.id ?? null,
    repositoryGitHubId: object.project_id,
    repositoryNameWithOwner: object.web_url
      .replace(/^https?:\/\//, "")
      .split("/-")[0]!
      .split("/api/")[0]!
      .split("/")
      .slice(1)
      .join("/"),
    sourceSha: object.sha,
    squashCommitSha: object.squash_commit_sha,
  };
}

async function responseJson<T>(response: GitLabRestResponse): Promise<T> {
  return JSON.parse(response.body) as T;
}
