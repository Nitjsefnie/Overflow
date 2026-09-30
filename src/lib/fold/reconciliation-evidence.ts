import type {
  GitHubIssue,
  GitHubIssueComment,
  GitHubPullRequest,
  GitHubPullRequestReview,
  GitHubSubject,
} from "@/lib/github/types";

// Earlier evidence may contain unchecked bulk timelines; force a complete refresh.
// Format 4 moves the two arrays into row-per-fact storage
// (repository_reconciliation_evidence_facts). The bump is what keeps a
// metadata row that survived the migration honest: its facts table starts
// empty, and a matching format would let a partial pass read that emptiness as
// "nothing cached" instead of forcing the full pass that repopulates it.
export const RECONCILIATION_EVIDENCE_FORMAT = 4;

/**
 * Fixed nonblank string that replaces every nonblank cached comment body when
 * the evidence cache serialises (issue 681). The fold reads a comment body only
 * through `body.trim().length > 0` while selecting a settlement rationale, so a
 * nonblank placeholder preserves every settlement decision exactly, and a blank
 * body maps to "" so it stays non-qualifying.
 */
export const CACHED_COMMENT_BODY_PLACEHOLDER = "[body removed]";

/**
 * A cached pull request as the narrowing leaves it: its own body is gone.
 */
export type NarrowedCachedPullRequest = Omit<GitHubPullRequest, "body">;

/**
 * A cached issue as the narrowing leaves it: comment bodies are kept as
 * placeholder-or-empty strings, and the issue's and its nested pull requests'
 * own bodies are gone.
 */
export type NarrowedCachedIssue = Omit<GitHubIssue, "body" | "closingPullRequests"> & {
  comments: GitHubIssueComment[];
  closingPullRequests: NarrowedCachedPullRequest[];
};

/**
 * Anything shaped like a cached issue, tolerating already-narrowed input: the
 * issue's body may be absent, which is what the narrowing itself produces. The
 * nested pull requests are opaque records here — already-narrowed ones carry no
 * body to match, so demanding `{ body? }` would reject exactly the input the
 * narrowing is idempotent over.
 */
export type BodyBearingCachedIssue = {
  body?: string | undefined;
  comments: Array<{ body?: string | undefined }>;
  closingPullRequests: Array<object>;
};

/** `Issue` with the body fields removed and the comment bodies re-typed as present strings. */
type BodyNarrowed<Issue extends BodyBearingCachedIssue> = Omit<Issue, "body"> & {
  comments: Array<Omit<Issue["comments"][number], "body"> & { body: string }>;
  closingPullRequests: Array<Omit<Issue["closingPullRequests"][number], "body">>;
};

/**
 * Drops body text from cached issues: comment bodies become
 * `CACHED_COMMENT_BODY_PLACEHOLDER` when nonblank and "" when blank, and the
 * issue's and its nested pull requests' own bodies are removed outright.
 * Reviews, rawDiff, ids, logins, timestamps and history events pass through
 * untouched. Accepts already-narrowed issues, so re-running the narrowing (as
 * the unregistration scrub may) is a no-op.
 */
export function narrowCachedIssueBodies<Issue extends BodyBearingCachedIssue>(
  issues: readonly Issue[],
): Array<BodyNarrowed<Issue>> {
  return issues.map((issue) => {
    const issueRest = { ...issue };
    delete (issueRest as { body?: unknown }).body;
    const comments = issue.comments.map((comment) => ({
      ...comment,
      body: comment.body !== undefined && comment.body.trim().length > 0
        ? CACHED_COMMENT_BODY_PLACEHOLDER
        : "",
    }));
    const closingPullRequests = issue.closingPullRequests.map((pullRequest) => {
      const pullRequestRest = { ...pullRequest };
      delete (pullRequestRest as { body?: unknown }).body;
      return pullRequestRest;
    });
    // The spread carries every property of `issue` except the removed body
    // fields. TypeScript cannot relate two Omit compositions across the
    // generic, so the shape is asserted with one cast here.
    return { ...issueRest, comments, closingPullRequests } as BodyNarrowed<Issue>;
  });
}

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
  issues: NarrowedCachedIssue[];
  pullRequests: ReconciliationPullRequestEvidence[];
};

export type ReconciliationSynchronization = {
  expectedVersion: number | null;
  scanStartedAt: Date;
  full: boolean;
  /** Fresh upstream reads still carry their body; retained cached issues do not. */
  issues: Array<GitHubIssue | NarrowedCachedIssue>;
  pullRequests: ReconciliationPullRequestEvidence[];
  dirtySubjects: DirtyReconciliationSubject[];
};
