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
  labels: string[];
  claimAssigneeGitHubLogin: string | null;
};

export type GitHubPullRequest = {
  id: number;
  number: number;
  title: string;
  body: string;
  url: string;
  state: PullRequestState;
  mergedAt: string | null;
  authorLogin: string | null;
  labels: string[];
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
