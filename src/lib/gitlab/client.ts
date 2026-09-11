import type { ClaimPathEvidence } from "@/lib/domain/claim-path";
import type { GitHubIssueListOptions } from "@/lib/github/client";
import type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueHistoryEvent,
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

// Live-verified shape (docs.gitlab.com resource_label_events): the label
// travels as an embedded object and the action as "add" | "remove".
type GitLabLabelEventObject = {
  id: number;
  user?: { id: number; username: string } | null;
  created_at: string;
  label?: { name?: string } | null;
  action?: string;
};

// Live-verified shape (docs.gitlab.com notes): activity records share the
// notes endpoint with a `system: true` flag, and `updated_at` is the only
// edit witness a note carries — GitLab exposes no edited-at attribute.
type GitLabNoteObject = {
  id: number;
  body: string;
  author?: { id: number; username: string } | null;
  created_at: string;
  updated_at: string;
  system?: boolean;
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
    // `updated_after`. The targeting controls (`timelineCriticalLabels` /
    // `timelineWatchedLabels`) select embedded-timeline refreshes on GitHub;
    // GitLab embeds no timeline in its issue listing, so there is nothing
    // embedded to refresh and the controls stay unimplemented rather than
    // silently ignored. Instead every listed issue's evidence is read fresh
    // from the per-issue surfaces below — the N+1 decision (issue 539): two
    // requests per issue plus one per merged closing merge request, the
    // simple correct cost on a reconciliation that runs on a budget hold,
    // not a hard rate ceiling.
    const since = options?.since === undefined ? "" : `&updated_after=${encodeURIComponent(options.since)}`;
    const objects = await this.listAllPages<GitLabIssueObject>(
      `/projects/${segment(`${repository.owner}/${repository.name}`)}/issues${since}`,
    );
    const issues: GitHubIssue[] = [];
    for (const object of objects) {
      try {
        issues.push(await this.issueWithEvidence(repository, object));
      } catch (error) {
        // Only 404 answers "this issue is gone": definitive for that issue
        // alone (issue 563), so the listing omits it and the run completes
        // for the remaining issues. The repository itself is not gone — any
        // other status is an upstream problem and still fails the run. The
        // skip is logged because a silent skip on a list endpoint is easy to
        // misread as "no issues".
        if (error instanceof GitLabApiError && error.status === 404) {
          console.error(
            `GitLab issue ${object.iid} in ${repository.owner}/${repository.name} disappeared between the listing and its evidence reads; omitting it from the listing.`,
          );
          continue;
        }
        throw error;
      }
    }
    return issues;
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
    return this.issueWithEvidence(repository, object);
  }

  /**
   * The issue's label history, mapped onto the fold's LABELED/UNLABELED
   * vocabulary. GitLab carries no REST surface for assignment changes (the
   * resource event APIs cover labels, state, milestone, weight and iteration
   * — no assignee), so no history event is ever emitted for ASSIGNED or
   * UNASSIGNED: the fold reads a GitLab row as never assigned, which leaves
   * the opening window unbounded — the same shape a GitHub issue with no
   * recorded assignment folds from. Recorded here where the absence is made,
   * the way `stateReason: null` is (contract item 16).
   *
   * An event whose label GitLab can no longer name (the label was deleted)
   * carries no evidence any consumer can read, so it is skipped rather than
   * mapped onto a label name that was never supplied.
   */
  public async listIssueLabelEvents(
    repository: GitHubRepositoryReference,
    issueIid: number,
  ): Promise<GitHubIssueHistoryEvent[]> {
    const events = await this.listIssueCollection<GitLabLabelEventObject>(repository, issueIid, "resource_label_events");
    const history: GitHubIssueHistoryEvent[] = [];
    for (const event of events) {
      if (event.action !== "add" && event.action !== "remove") continue;
      if (typeof event.label?.name !== "string" || event.label.name.length === 0) continue;
      history.push({
        kind: event.action === "add" ? "LABELED" : "UNLABELED",
        id: String(event.id),
        actorLogin: event.user?.username ?? null,
        actorGitHubUserId: event.user?.id ?? null,
        label: event.label.name,
        createdAt: normalizeTimestamp(event.created_at),
      });
    }
    return history;
  }

  /**
   * The issue's human comments. GitLab records activity ("closed", "changed
   * the label") as system notes on the same notes endpoint — and some of
   * those as separate resource events instead — so a `system` note is not a
   * comment and is dropped at this boundary.
   *
   * GitLab exposes no edited-at attribute for notes; `updated_at` differing
   * from `created_at` is the only edit witness the REST surface carries. The
   * fold reads `lastEditedAt` to refuse a rationale comment whose body
   * changed after the settlement evidence window closed, so the mapping
   * preserves that refusal (a non-null lastEditedAt when the timestamps
   * differ) rather than the never-edited null — the wrong direction to lose.
   */
  public async listIssueComments(
    repository: GitHubRepositoryReference,
    issueIid: number,
  ): Promise<GitHubIssueComment[]> {
    const notes = await this.listIssueCollection<GitLabNoteObject>(repository, issueIid, "notes");
    return notes.flatMap((note) => {
      if (note.system === true) return [];
      const createdAt = normalizeTimestamp(note.created_at);
      const updatedAt = normalizeTimestamp(note.updated_at);
      return [{
        id: String(note.id),
        databaseId: note.id,
        authorLogin: note.author?.username ?? null,
        authorGitHubUserId: note.author?.id ?? null,
        body: note.body,
        createdAt,
        // String forms can differ for the same instant; compare normalized.
        lastEditedAt: updatedAt !== createdAt ? updatedAt : null,
      }];
    });
  }

  /**
   * One issue's full snapshot slice: the timeline surfaces read fresh, and
   * the closing merge requests through the public `getIssueClosingPullRequests`
   * surface — the same callable the issue-547 webhook + initial-import path
   * uses, so the issue-embedded shape and the standalone shape can never
   * drift apart.
   */
  private async issueWithEvidence(
    repository: GitHubRepositoryReference,
    object: GitLabIssueObject,
  ): Promise<GitHubIssue> {
    const [history, comments, closingPullRequests] = await Promise.all([
      this.listIssueLabelEvents(repository, object.iid),
      this.listIssueComments(repository, object.iid),
      this.getIssueClosingPullRequests(repository, object.iid),
    ]);
    return toGitHubIssue(object, history, comments, closingPullRequests);
  }

  /**
   * The per-issue event and note collections are walked with offset
   * pagination: keyset pagination is endpoint-specific on GitLab (live-verified
   * for the issues and closed_by walks), and a keyset walk on an endpoint that
   * ignores it stops after one page — silently truncating the evidence. The
   * `x-next-page` header works on every list endpoint; rows shifting between
   * pages costs at worst a boundary re-read, never a silent skip.
   */
  private async listIssueCollection<T>(
    repository: GitHubRepositoryReference,
    issueIid: number,
    collection: "resource_label_events" | "notes",
  ): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    for (;;) {
      const response = await this.request(
        `/projects/${segment(`${repository.owner}/${repository.name}`)}/issues/${issueIid}/${collection}?per_page=100&page=${page}`,
      );
      items.push(...await responseJson<T[]>(response));
      const next = response.headers.get("x-next-page");
      if (next === null || next === "") break;
      const nextPage = Number(next);
      if (!Number.isSafeInteger(nextPage) || nextPage <= page) {
        throw new Error(`GitLab returned an invalid x-next-page header: ${JSON.stringify(next)}.`);
      }
      page = nextPage;
    }
    return items;
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

function toGitHubIssue(
  object: GitLabIssueObject,
  history: GitHubIssueHistoryEvent[],
  comments: GitHubIssueComment[],
  closingPullRequests: GitLabMergeRequest[],
): GitHubIssue {
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
    // The reconciliation evidence: label events, human comments and closing
    // merge requests read fresh by the caller (`issueWithEvidence`) through
    // the same public surfaces the issue-547 webhook + initial-import path
    // calls, so the issue-embedded shape and the standalone shape cannot
    // drift apart.
    history,
    comments,
    closingPullRequests,
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
