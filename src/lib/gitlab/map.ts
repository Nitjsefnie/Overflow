import type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubIssueHistoryEvent,
  GitHubPullRequest,
} from "@/lib/github/types";
import type { GitLabMergeRequest } from "@/lib/gitlab/client";
import { logField } from "@/lib/webhooks/log-field";

export type GitLabMergeRequestObject = {
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

export type GitLabIssueObject = {
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

/** Normalized once at the boundary, so every field a caller reads is ISO UTC. */
export function normalizeTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    // The value is the instance's own text: encoded, it can neither forge a
    // second journal line where the message is logged raw nor drive the
    // operator's terminal.
    throw new Error(`GitLab returned an unparsable timestamp: ${logField(value)}`);
  }
  return parsed.toISOString();
}

export function toGitHubIssue(
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
    // GitLab's two states map onto the ledger's two; item 16: no state_reason,
    // so an absent reason is exempt from neither NOT_PLANNED nor DUPLICATE.
    state: object.state === "opened" ? "OPEN" : "CLOSED",
    stateReason: null,
    createdAt: normalizeTimestamp(object.created_at),
    updatedAt: normalizeTimestamp(object.updated_at),
    closedAt: object.closed_at === null ? null : normalizeTimestamp(object.closed_at),
    authorLogin: object.author?.username ?? null,
    authorGitHubUserId: object.author?.id ?? null,
    labels: object.labels ?? [],
    claimAssigneeGitHubLogin: assignee?.username ?? null,
    claimAssigneeGitHubUserId: assignee?.id ?? null,
    // Evidence read fresh by the caller (`issueWithEvidence`), so the
    // issue-embedded shape and the standalone shape cannot drift apart.
    history,
    comments,
    closingPullRequests,
  };
}

export function toGitLabMergeRequest(object: GitLabMergeRequestObject): GitLabMergeRequest {
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
