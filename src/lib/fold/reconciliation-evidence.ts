import type { GitHubIssue, GitHubPullRequestReview, GitHubSubject } from "@/lib/github/types";

// Earlier evidence may contain unchecked bulk timelines; force a complete refresh.
export const RECONCILIATION_EVIDENCE_FORMAT = 3;

export type ReconciliationPullRequestEvidence = {
  id: number;
  reviews: GitHubPullRequestReview[];
  rawDiff: string;
};

export type DirtyReconciliationSubject = GitHubSubject & {
  kind: "ISSUE" | "PULL_REQUEST";
  generation: number;
};

/** Only upstream evidence is retained. Repository configuration and users are read afresh. */
export type ReconciliationEvidence = {
  version: number;
  formatVersion: number;
  checkpoint: Date;
  lastFullPassAt: Date;
  issues: GitHubIssue[];
  pullRequests: ReconciliationPullRequestEvidence[];
};

export type ReconciliationSynchronization = {
  expectedVersion: number | null;
  scanStartedAt: Date;
  full: boolean;
  issues: GitHubIssue[];
  pullRequests: ReconciliationPullRequestEvidence[];
  dirtySubjects: DirtyReconciliationSubject[];
};
