import { GitHubGraphqlInvalidResponseError } from "@/lib/github/errors";
import type { GitHubIssueComment, GitHubIssueHistoryEvent, GitHubPullRequest } from "@/lib/github/types";

/** Drain started reads before their caller snapshots cost, retaining the first rejection. */
export async function drainIssueReads<T extends readonly unknown[] | []>(
  reads: T,
): Promise<{ -readonly [K in keyof T]: Awaited<T[K]> }> {
  try {
    return await Promise.all(reads);
  } catch (error) {
    await Promise.allSettled(reads);
    throw error;
  }
}

/** The three issue-own connections a walk reads per issue. */
export const CLOSING_PULL_REQUESTS_FIELD_PATH = "closedByPullRequestsReferences.nodes";
export const OPENING_LABELS_FIELD_PATH = "labels.nodes";
export const OPENING_TIMELINE_FIELD_PATH = "timelineItems.nodes";

/** Whether the typed rejection's field names a connection owned by this one issue. */
export function isIssueOwnFieldPath(fieldPath: string): boolean {
  return fieldPath === CLOSING_PULL_REQUESTS_FIELD_PATH
    || fieldPath === OPENING_LABELS_FIELD_PATH
    || fieldPath === OPENING_TIMELINE_FIELD_PATH;
}

/**
 * One issue's closing-PR read: a null entry in that connection marks this ONE
 * issue unreadable (an empty list) instead of failing the whole walk; every
 * other rejection keeps whole-walk semantics.
 */
export type IssueClosingPullRequestsRead = {
  closingPullRequests: GitHubPullRequest[];
  closingPullRequestsUnreadable?: true;
};

export function readIssueClosingPullRequests(read: Promise<GitHubPullRequest[]>): Promise<IssueClosingPullRequestsRead> {
  return read.then((closingPullRequests) => ({ closingPullRequests }), (error: unknown) => {
    if (error instanceof GitHubGraphqlInvalidResponseError && error.fieldPath === CLOSING_PULL_REQUESTS_FIELD_PATH) {
      return { closingPullRequests: [], closingPullRequestsUnreadable: true };
    }
    throw error;
  });
}

/** The opening-evidence legs an issue walk reads beside its closing connection. */
export type IssueOpeningEvidenceRead = {
  labels: string[];
  timeline: { history: GitHubIssueHistoryEvent[]; comments: GitHubIssueComment[] };
  openingEvidenceUnreadable?: true;
};

function unreadableOpeningField(error: unknown): boolean {
  return error instanceof GitHubGraphqlInvalidResponseError
    && (error.fieldPath === OPENING_LABELS_FIELD_PATH || error.fieldPath === OPENING_TIMELINE_FIELD_PATH);
}

/**
 * One issue's opening-evidence read: a labels or timeline typed rejection
 * marks this ONE issue (empty labels, empty history and comments) instead of
 * failing the whole walk; every other rejection keeps whole-walk semantics,
 * rethrown in leg order.
 */
export function readIssueOpeningEvidence(
  labelsRead: Promise<string[]>,
  timelineRead: Promise<{ history: GitHubIssueHistoryEvent[]; comments: GitHubIssueComment[] }>,
): Promise<IssueOpeningEvidenceRead> {
  return Promise.allSettled([labelsRead, timelineRead]).then(([labels, timeline]) => {
    if (labels.status === "rejected") {
      if (!unreadableOpeningField(labels.reason)) throw labels.reason;
      // The marked shape is uniformly empty — the issue is never folded, so
      // no partial read can pass for evidence, wherever the failure landed.
      return { labels: [], timeline: { history: [], comments: [] }, openingEvidenceUnreadable: true };
    }
    if (timeline.status === "rejected") {
      if (!unreadableOpeningField(timeline.reason)) throw timeline.reason;
      return { labels: [], timeline: { history: [], comments: [] }, openingEvidenceUnreadable: true };
    }
    return { labels: labels.value, timeline: timeline.value };
  });
}
