import type { IssueState, PullRequestState, RepositoryVisibility } from "@/lib/db/types";

/**
 * Reserved claim-assignee value standing for "GitHub reports two or more assignees".
 *
 * GitHub logins admit only alphanumerics and hyphens, so underscores are invalid
 * and this string can never collide with a real assignee's login. Every consumer
 * that decides on the column's nullity therefore reads the ambiguity
 * conservatively: the issue stays off the available-work board, and the
 * sponsor's exposure stays reserved as if an outsider held the claim.
 */
export const AMBIGUOUS_CLAIM_ASSIGNEE_LOGIN = "__overflow_ambiguous_claim__";

export type GitHubRepositoryReference = {
  owner: string;
  name: string;
};

export type GitHubRepository = GitHubRepositoryReference & {
  ownerType: "USER" | "ORGANIZATION";
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
  /** GraphQL `Issue.stateReason`; null when GitHub supplies no reason. */
  stateReason: string | null;
  createdAt: string;
  /** Upstream update time, independent of local materialization timestamps. */
  updatedAt: string;
  /** GraphQL `Issue.closedAt`; null while the issue is open. */
  closedAt: string | null;
  authorLogin: string | null;
  /** GraphQL `User.databaseId` of the author; null when the author is absent or not a User (Bot, Mannequin, Organization). */
  authorGitHubUserId: number | null;
  labels: string[];
  claimAssigneeGitHubLogin: string | null;
  history: GitHubIssueHistoryEvent[];
  comments: GitHubIssueComment[];
  closingPullRequests: GitHubPullRequest[];
};

export type GitHubSubject = { id: number; number: number };

export type GitHubIssueReference = GitHubSubject & { repositoryGitHubId: number };

export type GitHubIssueHistoryEvent =
  | {
      kind: "LABELED";
      id: string;
      actorLogin: string | null;
      /** GraphQL `User.databaseId` of the actor; null when the actor is absent or not a User (Bot, Mannequin, Organization). */
      actorGitHubUserId: number | null;
      label: string;
      createdAt: string;
    }
  | {
      kind: "UNLABELED";
      id: string;
      actorLogin: string | null;
      /** GraphQL `User.databaseId` of the actor; null when the actor is absent or not a User (Bot, Mannequin, Organization). */
      actorGitHubUserId: number | null;
      label: string;
      createdAt: string;
    }
  | {
      kind: "ASSIGNED";
      id: string;
      actorLogin: string | null;
      /** GraphQL `User.databaseId` of the actor; null when the actor is absent or not a User (Bot, Mannequin, Organization). */
      actorGitHubUserId: number | null;
      assigneeLogin: string | null;
      createdAt: string;
    }
  | {
      kind: "UNASSIGNED";
      id: string;
      actorLogin: string | null;
      /** GraphQL `User.databaseId` of the actor; null when the actor is absent or not a User (Bot, Mannequin, Organization). */
      actorGitHubUserId: number | null;
      assigneeLogin: string | null;
      createdAt: string;
    };

export type GitHubIssueComment = {
  id: string;
  databaseId: number | null;
  authorLogin: string | null;
  /** GraphQL `User.databaseId` of the author; null when the author is absent or not a User (Bot, Mannequin, Organization). */
  authorGitHubUserId: number | null;
  body: string;
  createdAt: string;
  /** GraphQL `IssueComment.lastEditedAt`; null when the body was never edited. */
  lastEditedAt: string | null;
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
  /** GraphQL `User.databaseId` of the author; null when the author is absent or not a User (Bot, Mannequin, Organization). */
  authorGitHubUserId: number | null;
  /**
   * GraphQL `Repository.databaseId` of the repository this pull request lives
   * in. A closing reference can name a pull request in a different repository,
   * so its evidence must never be read from the registered one — and this id,
   * unlike the name, survives a rename or an owner transfer.
   */
  repositoryGitHubId: number;
  /**
   * GraphQL `Repository.nameWithOwner` (`"owner/name"`) of the same repository.
   * Carried for what a person reads, never for deciding ownership: GitHub keeps
   * serving a renamed repository under its old name while reporting the new one.
   */
  repositoryNameWithOwner: string;
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

export type GitHubPullRequestReviewDismissal = {
  /** `ReviewDismissedEvent.createdAt`. */
  at: string;
  /** `ReviewDismissedEvent.previousReviewState`; null when GitHub omitted it. */
  previousState: GitHubPullRequestReviewState | null;
};

export type GitHubPullRequestReview = {
  id: number;
  state: GitHubPullRequestReviewState;
  submittedAt: string | null;
  dismissal: GitHubPullRequestReviewDismissal | null;
};
