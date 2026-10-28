// An edited mark never counts: a collaborator can edit it, and the fold reads no editor.
import type { SettlementRow } from "@/lib/fold/postgres-row-mapping";
import {
  compareHistoryItems, compareRationaleSequence, validIssueComment, type FoldResult, type FoldSettlement,
} from "@/lib/fold/repository-fold";
import type { GitHubIssueComment } from "@/lib/github/types";

export const DONATION_COMMAND = "/donate";

type MarkSource = {
  id: number;
  body?: string;
  comments: readonly GitHubIssueComment[];
  closingPullRequests: ReadonlyArray<{ id: number; authorGitHubUserId: number | null }>;
};

function donationCommentId(source: MarkSource, settlement: FoldSettlement): string | null {
  const author = source.closingPullRequests.find((pr) => pr.id === settlement.githubPullRequestId)?.authorGitHubUserId ?? null;
  const mergedAt = Date.parse(settlement.mergedAt);
  const marks = source.comments.filter((comment) =>
    author !== null && validIssueComment(comment) && comment.authorGitHubUserId === author &&
    comment.lastEditedAt === null && comment.body.trim() === DONATION_COMMAND &&
    Date.parse(comment.createdAt) <= mergedAt)
    // The node id only makes the stored citation independent of arrival order.
    .sort((left, right) => compareHistoryItems(left, right) || compareRationaleSequence(left, right) ||
      (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return marks[0]?.id ?? null;
}

/** Sets donationCommentId on fresh issues only; absent means not read fresh (stored mark stands), null means no mark. */
export function attachDonationMarks(fold: FoldResult, issues: readonly MarkSource[]): FoldResult {
  const fresh = new Map(issues.filter((issue) => typeof issue.body === "string").map((issue) => [issue.id, issue]));
  return {
    ...fold,
    settlements: fold.settlements.map((settlement) => {
      const source = fresh.get(settlement.githubIssueId);
      return source === undefined ? settlement : { ...settlement, donationCommentId: donationCommentId(source, settlement) };
    }),
  };
}

/** An absent mark falls back to the stored row's while it names the same pull request. */
export function donatedSettlement(
  settlement: FoldSettlement,
  stored?: Pick<SettlementRow, "github_pull_request_id" | "donation_comment_id">,
): FoldSettlement {
  const mark = settlement.donationCommentId !== undefined ? settlement.donationCommentId
    : stored !== undefined && Number(stored.github_pull_request_id) === settlement.githubPullRequestId
      ? stored.donation_comment_id : null;
  return mark !== null && (settlement.status === "SETTLED" || settlement.status === "UNCLAIMED")
    ? { ...settlement, status: "DONATED", donationCommentId: mark }
    : { ...settlement, donationCommentId: null };
}
