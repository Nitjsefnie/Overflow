import { calculateSettlement, type SettlementDecision } from "@/lib/domain/settlement";
import type {
  FoldPullRequest, FoldSettlement, FoldUser, RepositoryFoldPullRequest, RepositoryFoldSnapshot,
} from "@/lib/fold/repository-fold";
import { belongsToRegisteredRepository } from "@/lib/fold/repository-ownership";
import { countReviewRoundsAsOf } from "@/lib/fold/review-rounds";
import { settlementTeam } from "@/lib/fold/team-membership";
import { validTimestamp } from "@/lib/fold/valid-timestamp";
import type { GitHubPullRequestReview } from "@/lib/github/types";

export type AuthoritativeClosingPullRequest = RepositoryFoldPullRequest & {
  mergedAt: string;
  mergeCommitOid: string;
  finalCommitAt: string;
};

type ClosingPullRequestSelection =
  | { kind: "SELECTED"; pullRequest: AuthoritativeClosingPullRequest }
  | { kind: "CROSS_REPOSITORY"; pullRequest: AuthoritativeClosingPullRequest }
  | { kind: "NONE" };

export const noClosingPullRequest: ClosingPullRequestSelection = { kind: "NONE" };

/**
 * Overflow's authority ends at the registered repository, so a closing
 * reference naming a pull request elsewhere is reported rather than folded:
 * its diff and reviews are not evidence about work this repository sponsored.
 */
export function selectClosingPullRequest(
  pullRequests: readonly RepositoryFoldPullRequest[],
  registered: RepositoryFoldSnapshot["repository"],
): ClosingPullRequestSelection {
  const merged = pullRequests.filter(
    (pullRequest): pullRequest is AuthoritativeClosingPullRequest =>
      pullRequest.state === "MERGED" &&
      validTimestamp(pullRequest.mergedAt) &&
      validTimestamp(pullRequest.finalCommitAt) &&
      Date.parse(pullRequest.finalCommitAt) <= Date.parse(pullRequest.mergedAt) &&
      typeof pullRequest.mergeCommitOid === "string" &&
      /^[0-9a-f]{40}$/i.test(pullRequest.mergeCommitOid),
  ).map((pullRequest) => ({
    ...pullRequest,
    mergeCommitOid: pullRequest.mergeCommitOid.toLowerCase(),
  })).sort((left, right) => {
    const timestampDifference = Date.parse(left.mergedAt!) - Date.parse(right.mergedAt!);
    return timestampDifference || left.number - right.number || left.id - right.id;
  });

  const owned = merged.find((pullRequest) => belongsToRegisteredRepository(registered, pullRequest));
  if (owned !== undefined) {
    return { kind: "SELECTED", pullRequest: owned };
  }
  const foreign = merged[0];
  return foreign === undefined ? noClosingPullRequest : { kind: "CROSS_REPOSITORY", pullRequest: foreign };
}

/**
 * Ownership is settled by id before this is called; the only question here is
 * which sentence a moderator can act on. Naming the two repositories by name
 * reads as a contradiction when the reported name is the registered one, which
 * is exactly what a reused name looks like.
 */
export function crossRepositoryReason(
  pullRequest: AuthoritativeClosingPullRequest,
  registered: RepositoryFoldSnapshot["repository"],
): string {
  if (pullRequest.repositoryNameWithOwner.toLowerCase() !== registered.ownerName.toLowerCase()) {
    // First run after a rename: the snapshot's ownerName was read from the
    // store before this run's identity verify refreshed the row, so the
    // in-memory value still carries the pre-rename path. When the fresh verify
    // saw a different path, the reason names both — a reason naming only the
    // stale path sends the sponsor to a path GitHub no longer answers for.
    if (registered.observedOwnerName !== undefined
      && registered.observedOwnerName.toLowerCase() !== registered.ownerName.toLowerCase()) {
      return `Closing pull request ${pullRequest.number} belongs to ${pullRequest.repositoryNameWithOwner}, `
        + `not the registered repository ${registered.ownerName} `
        + `(the same repository was observed as ${registered.observedOwnerName} on this run).`;
    }
    return `Closing pull request ${pullRequest.number} belongs to ${pullRequest.repositoryNameWithOwner}, `
      + `not the registered repository ${registered.ownerName}.`;
  }
  return `Closing pull request ${pullRequest.number} does not belong to the registered repository: `
    + `another repository now carries the name ${registered.ownerName} `
    + `(GitHub repository ${pullRequest.repositoryGitHubId}, not ${registered.githubRepositoryId}).`;
}

export function rememberPullRequest(
  pullRequestsByGitHubId: Map<number, FoldPullRequest>,
  pullRequest: AuthoritativeClosingPullRequest,
  issueId: number,
  authorId: string | null,
  proofSha256: string,
  reviewRounds: Array<{ githubReviewId: number; submittedAt: string }>,
): FoldPullRequest & { mergeCommitOid: string; finalCommitAt: string } {
  const existing = pullRequestsByGitHubId.get(pullRequest.id);
  if (existing !== undefined) {
    if (!existing.githubIssueIds.includes(issueId)) {
      existing.githubIssueIds.push(issueId);
      existing.githubIssueIds.sort((left, right) => left - right);
    }
    return existing as FoldPullRequest & { mergeCommitOid: string; finalCommitAt: string };
  }

  const folded = {
    githubPullRequestId: pullRequest.id,
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.url,
    state: pullRequest.state,
    mergedAt: pullRequest.mergedAt,
    mergeCommitOid: pullRequest.mergeCommitOid,
    finalCommitAt: pullRequest.finalCommitAt,
    authorId,
    authorGitHubLogin: pullRequest.authorLogin,
    authorGitHubUserId: pullRequest.authorGitHubUserId,
    proofSha256,
    githubIssueIds: [issueId],
    reviewRounds,
  };
  pullRequestsByGitHubId.set(pullRequest.id, folded);
  return folded;
}

export function countReviewRounds(
  reviews: readonly GitHubPullRequestReview[],
  mergedAt: string | null,
): Array<{ githubReviewId: number; submittedAt: string }> {
  if (!validTimestamp(mergedAt)) {
    return [];
  }

  return countReviewRoundsAsOf(reviews, Date.parse(mergedAt));
}

export type SettledDifficultyEvidence = {
  label: string;
  points: number;
  labelEventId: string;
  labelActorLogin: string;
  labelAppliedAt: string;
  rationaleCommentId: string;
  rationaleActorLogin: string;
  rationaleCommentedAt: string;
};

/** The settled columns an issue row and a settlement row share; every one is null without accepted evidence. */
export function settledEvidenceColumns(evidence: SettledDifficultyEvidence | null) {
  return {
    settledLabel: evidence?.label ?? null,
    settledPoints: evidence?.points ?? null,
    settledLabelEventId: evidence?.labelEventId ?? null,
    settledLabelActorLogin: evidence?.labelActorLogin ?? null,
    settledLabelAppliedAt: evidence?.labelAppliedAt ?? null,
    settledRationaleCommentId: evidence?.rationaleCommentId ?? null,
    settledRationaleActorLogin: evidence?.rationaleActorLogin ?? null,
    settledRationaleCommentedAt: evidence?.rationaleCommentedAt ?? null,
  };
}

export function toSettlement(input: {
  issueId: number;
  pullRequest: FoldPullRequest & { mergeCommitOid: string };
  author: FoldUser | undefined;
  authorLogin: string | null;
  authorGitHubUserId: number | null;
  provider: string;
  instanceUrl: string | null;
  debtorId: string;
  openingComparisonPoints: number;
  settledDifficulty: SettledDifficultyEvidence | null;
}): FoldSettlement {
  const settledPoints = input.settledDifficulty?.points ?? null;
  const reviewRounds = input.pullRequest.reviewRounds.length;
  const base = {
    githubIssueId: input.issueId,
    githubPullRequestId: input.pullRequest.githubPullRequestId,
    provider: input.provider,
    instanceUrl: input.instanceUrl,
    creditorId: input.author?.id ?? null,
    creditorGitHubLogin: input.authorLogin,
    creditorGitHubUserId: input.authorGitHubUserId,
    ...settlementTeam(input.author, input.pullRequest.mergedAt!),
    debtorId: input.debtorId,
    openingComparisonPoints: input.openingComparisonPoints,
    ...settledEvidenceColumns(input.settledDifficulty),
    mergeCommitOid: input.pullRequest.mergeCommitOid,
    mergedAt: input.pullRequest.mergedAt!,
    reviewRounds,
    proofSha256: input.pullRequest.proofSha256,
  };

  if (settledPoints === null) {
    return { ...base, credits: 0, status: "UNSETTLED" };
  }

  if (input.author === undefined) {
    if (input.authorLogin === null) {
      return { ...base, settledPoints: null, credits: 0, status: "UNSETTLED" };
    }
    return {
      ...base,
      credits: Math.max(0, settledPoints - reviewRounds),
      status: "UNCLAIMED",
    };
  }

  const decision = calculateSettlement({
    creditorId: input.author.id,
    debtorId: input.debtorId,
    opening: input.openingComparisonPoints,
    settled: settledPoints,
    reviewIds: input.pullRequest.reviewRounds.map((review) => String(review.githubReviewId)),
  });
  if (decision.status !== "SETTLED") {
    return { ...base, credits: 0, status: "UNSETTLED" };
  }

  return { ...base, credits: decision.credits, status: "SETTLED" };
}

export function toLedgerSettlement(settlement: FoldSettlement): SettlementDecision[] {
  if (
    settlement.status !== "SETTLED" ||
    settlement.creditorId === null ||
    settlement.settledPoints === null
  ) {
    return [];
  }

  return [
    {
      status: "SETTLED",
      creditorId: settlement.teamId ?? settlement.creditorId,
      debtorId: settlement.debtorId,
      opening: settlement.openingComparisonPoints,
      settled: settlement.settledPoints,
      reviewRounds: settlement.reviewRounds,
      credits: settlement.credits,
    },
  ];
}
