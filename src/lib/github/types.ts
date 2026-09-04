import type { IssueState, PullRequestState, RepositoryVisibility } from "@/lib/db/types";

export type GitHubRepositoryReference = {
  owner: string;
  name: string;
};

export type GitHubRepository = GitHubRepositoryReference & {
  id: number;
  fullName: string;
  visibility: RepositoryVisibility;
  url: string;
  canAdminister: boolean;
};

export type GitHubIssue = {
  id: number;
  number: number;
  title: string;
  body: string;
  url: string;
  state: IssueState;
  createdAt: string;
  authorLogin: string | null;
  labels: string[];
  claimAssigneeGitHubLogin: string | null;
  history: GitHubIssueHistoryEvent[];
  comments: GitHubIssueComment[];
};

export type GitHubIssueHistoryEvent =
  | {
      kind: "LABELED";
      id: string;
      actorLogin: string | null;
      label: string;
      createdAt: string;
    }
  | {
      kind: "UNLABELED";
      id: string;
      actorLogin: string | null;
      label: string;
      createdAt: string;
    }
  | {
      kind: "ASSIGNED";
      id: string;
      actorLogin: string | null;
      assigneeLogin: string | null;
      createdAt: string;
    }
  | {
      kind: "UNASSIGNED";
      id: string;
      actorLogin: string | null;
      assigneeLogin: string | null;
      createdAt: string;
    };

export type GitHubIssueComment = {
  id: string;
  databaseId: number | null;
  authorLogin: string | null;
  body: string;
  createdAt: string;
};

export type GitHubPullRequest = {
  id: number;
  number: number;
  title: string;
  body: string;
  url: string;
  state: PullRequestState;
  mergedAt: string | null;
  mergeCommitOid: string | null;
  finalCommitAt: string | null;
  authorLogin: string | null;
};

export type GitHubWebhook = {
  id: number;
};

export type GitHubWebhookConfiguration = {
  callbackUrl: string;
  secret: string;
};

export type GitHubPullRequestReviewState =
  | "APPROVED"
  | "CHANGES_REQUESTED"
  | "COMMENTED"
  | "DISMISSED"
  | "PENDING";

export type GitHubPullRequestReview = {
  id: number;
  state: GitHubPullRequestReviewState;
  submittedAt: string | null;
};
