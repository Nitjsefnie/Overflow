import type { GitHubPullRequestReview } from "@/lib/github/types";

export function countReviewRoundsAsOf(
  reviews: readonly GitHubPullRequestReview[],
  cutoffTime: number,
): Array<{ githubReviewId: number; submittedAt: string }> {
  const uniqueReviews = new Map<number, string>();
  for (const review of reviews) {
    // A dismissal before the cutoff withdraws the round; later ones preserve it.
    const submittedState = review.state === "DISMISSED"
      ? review.dismissal?.previousState ?? null
      : review.state;
    if (
      submittedState !== "CHANGES_REQUESTED" ||
      !validTimestamp(review.submittedAt) ||
      Date.parse(review.submittedAt) >= cutoffTime ||
      dismissedBefore(review, cutoffTime)
    ) {
      continue;
    }
    uniqueReviews.set(review.id, review.submittedAt);
  }

  return [...uniqueReviews.entries()]
    .map(([githubReviewId, submittedAt]) => ({ githubReviewId, submittedAt }))
    .sort((left, right) => left.githubReviewId - right.githubReviewId);
}

function dismissedBefore(review: GitHubPullRequestReview, deadline: number): boolean {
  return review.dismissal !== null &&
    validTimestamp(review.dismissal.at) &&
    Date.parse(review.dismissal.at) < deadline;
}

function validTimestamp(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}
