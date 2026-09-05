import { createHash } from "node:crypto";
import { isParticipationEligible, type EnforcementState, type IssueState, type PullRequestState } from "@/lib/db/types";
import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";
import { foldLedger, type LedgerEntry } from "@/lib/domain/ledger";
import { calculateSettlement, type SettlementDecision } from "@/lib/domain/settlement";
import type {
  GitHubIssueComment,
  GitHubIssueHistoryEvent,
  GitHubPullRequestReview,
} from "@/lib/github/types";

export type FoldModerationEvent = {
  id: string;
  priorState: EnforcementState;
  newState: EnforcementState;
  occurredAt: string;
};

export type FoldUser = {
  id: string;
  githubLogin: string;
  enforcementState: EnforcementState;
  moderationEvents?: FoldModerationEvent[];
};

export type RepositoryFoldSnapshot = {
  repository: {
    id: string;
    ownerName: string;
    active: boolean;
    sponsor: FoldUser;
    difficultyScheme: DifficultyScheme;
  };
  users: FoldUser[];
  issues: RepositoryFoldIssue[];
};

export type RepositoryFoldIssue = {
  id: number;
  number: number;
  title: string;
  body: string;
  url: string;
  state: IssueState;
  createdAt: string;
  authorLogin: string | null;
  labels: string[];
  claimAssigneeGitHubLogin?: string | null;
  history: GitHubIssueHistoryEvent[];
  comments: GitHubIssueComment[];
  /** Deliberately ignored: only GraphQL closedByPullRequestsReferences is authoritative. */
  restTimeline?: unknown;
  closingPullRequests: RepositoryFoldPullRequest[];
};

export type RepositoryFoldPullRequest = {
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
  reviews: GitHubPullRequestReview[];
  rawDiff: string;
};

export type FoldIssue = {
  githubIssueId: number;
  openingLabel: string;
  openingComparisonPoints: number;
  openingReservePoints: number;
  number: number;
  title: string;
  body: string;
  url: string;
  state: IssueState;
  ownerGitHubLogin: string;
  openingSourceEventId: string;
  openingSourceActorLogin: string;
  openingSourceAt: string;
  claimAssigneeGitHubLogin: string | null;
  settledLabel: string | null;
  settledPoints: number | null;
  settledLabelEventId: string | null;
  settledLabelActorLogin: string | null;
  settledLabelAppliedAt: string | null;
  settledRationaleCommentId: string | null;
  settledRationaleActorLogin: string | null;
  settledRationaleCommentedAt: string | null;
};

export type FoldPullRequest = {
  githubPullRequestId: number;
  number: number;
  title: string;
  body: string;
  url: string;
  state: PullRequestState;
  mergedAt: string | null;
  mergeCommitOid: string;
  finalCommitAt: string;
  authorId: string | null;
  authorGitHubLogin: string | null;
  proofSha256: string;
  githubIssueIds: number[];
  reviewRounds: Array<{ githubReviewId: number; submittedAt: string }>;
};

export type FoldSettlement = {
  githubIssueId: number;
  githubPullRequestId: number;
  creditorId: string | null;
  creditorGitHubLogin: string | null;
  debtorId: string;
  openingComparisonPoints: number;
  settledLabel: string | null;
  settledPoints: number | null;
  settledLabelEventId: string | null;
  settledLabelActorLogin: string | null;
  settledLabelAppliedAt: string | null;
  settledRationaleCommentId: string | null;
  settledRationaleActorLogin: string | null;
  settledRationaleCommentedAt: string | null;
  mergeCommitOid: string;
  mergedAt: string;
  reviewRounds: number;
  credits: number;
  proofSha256: string;
  status: "SETTLED" | "UNSETTLED" | "UNCLAIMED";
};

export type SelfWorkCalibration = {
  githubIssueId: number;
  githubPullRequestId: number;
  userId: string;
  openingComparisonPoints: number;
  actualLabel: string | null;
  actualPoints: number | null;
  actualLabelEventId: string | null;
  actualLabelActorLogin: string | null;
  actualLabelAppliedAt: string | null;
  rationaleCommentId: string | null;
  rationaleActorLogin: string | null;
  rationaleCommentedAt: string | null;
  mergeCommitOid: string;
  mergedAt: string;
};

export type UnwritableClosure = {
  githubIssueId: number;
  kind: "NO_CLOSING_PULL_REQUEST" | "SETTLEMENT_EVIDENCE_REJECTED";
  githubPullRequestId: number | null;
  reason: string;
};

export type SettlementEvidenceViolationCode = "SETTLED_LABEL_UNAUTHORIZED" | "SETTLED_RATIONALE_EDITED";

export type FoldPolicyViolation = {
  code:
    | "OPENING_LABEL_MISSING"
    | "OPENING_LABEL_AMBIGUOUS"
    | "OPENING_LABEL_MUTATED"
    | SettlementEvidenceViolationCode;
  githubIssueId: number;
};

export type FoldResult = {
  issues: FoldIssue[];
  pullRequests: FoldPullRequest[];
  settlements: FoldSettlement[];
  selfWorkCalibrations: SelfWorkCalibration[];
  unwritableClosures: UnwritableClosure[];
  policyViolations: FoldPolicyViolation[];
  ledgerEntries: LedgerEntry[];
};

/**
 * Tolerance applied to every evidence-ordering comparison in the fold.
 *
 * Both evidence windows are sequences a person performs by hand, and the order
 * things land in is routinely off by seconds or minutes. Settlement: push the
 * final commit, apply the settled label, comment naming it, merge — the comment
 * gets written before the label, or both are remembered just after the merge.
 * Opening: label the issue, then assign it — but `gh issue create --label
 * --assignee` applies the assignee FIRST, so the opening label lands a second
 * after the assignment it was meant to precede.
 *
 * Enforced to the second, each of those discards a real record, and neither
 * window can be reopened afterwards. The grace absorbs the ordering mistake
 * without widening either window into a different rule: evidence outside it is
 * still rejected, so a settled label applied an hour after merge still proves
 * nothing about what the reviewer saw, and an opening label applied an hour
 * after the assignment still fails to show the work was priced before it was
 * spoken for.
 * The same close applies to edits: a rationale comment whose last edit is after
 * the window closed is rejected, since its current body is not evidence of what
 * the reviewer wrote before merge.
 */
const EVIDENCE_ORDERING_GRACE_MS = 15 * 60 * 1000;

type OpeningResolution = {
  githubIssueId: number;
  openingLabel: string;
  openingComparisonPoints: number;
  openingReservePoints: number;
  ownerGitHubLogin: string;
  openingSourceEventId: string;
  openingSourceActorLogin: string;
  openingSourceAt: string;
  mutated: boolean;
};

type SettledDifficultyEvidence = {
  label: string;
  points: number;
  labelEventId: string;
  labelActorLogin: string;
  labelAppliedAt: string;
  rationaleCommentId: string;
  rationaleActorLogin: string;
  rationaleCommentedAt: string;
};

type SettledDifficultyResolution =
  | { kind: "accepted"; evidence: SettledDifficultyEvidence }
  | { kind: "rejected"; reason: string; violation?: SettlementEvidenceViolationCode };

type AuthoritativeClosingPullRequest = RepositoryFoldPullRequest & {
  mergedAt: string;
  mergeCommitOid: string;
  finalCommitAt: string;
};

export function foldRepository(snapshot: RepositoryFoldSnapshot): FoldResult {
  const usersByLogin = new Map(snapshot.users.map((user) => [normalizeLogin(user.githubLogin), user]));
  // The sponsor pays for the work, so only the sponsor's labels and rationale
  // price it. Work closed by the sponsor remains self-work calibration.
  const raterLogin = normalizedNonblankLogin(snapshot.repository.sponsor.githubLogin);
  const issues: FoldIssue[] = [];
  const pullRequestsByGitHubId = new Map<number, FoldPullRequest>();
  const settlements: FoldSettlement[] = [];
  const selfWorkCalibrations: SelfWorkCalibration[] = [];
  const unwritableClosures: UnwritableClosure[] = [];
  const policyViolations: FoldPolicyViolation[] = [];

  for (const issue of snapshot.issues) {
    const opening = resolveOpening(issue, snapshot.repository.difficultyScheme, raterLogin);
    if (opening === null) {
      policyViolations.push({
        code: "OPENING_LABEL_MISSING",
        githubIssueId: issue.id,
      });
      continue;
    }

    if (opening.mutated) {
      policyViolations.push({ code: "OPENING_LABEL_MUTATED", githubIssueId: issue.id });
    }

    const pullRequest = issue.state === "CLOSED"
      ? selectClosingPullRequest(issue.closingPullRequests)
      : null;
    const settledResolution = pullRequest === null
      ? null
      : resolveSettledDifficulty(issue, pullRequest, snapshot.repository.difficultyScheme, raterLogin);
    const settledDifficulty = settledResolution?.kind === "accepted" ? settledResolution.evidence : null;
    if (settledResolution?.kind === "rejected" && settledResolution.violation !== undefined) {
      policyViolations.push({ code: settledResolution.violation, githubIssueId: issue.id });
    }

    issues.push({
      githubIssueId: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      url: issue.url,
      state: issue.state,
      ownerGitHubLogin: opening.ownerGitHubLogin,
      openingLabel: opening.openingLabel,
      openingComparisonPoints: opening.openingComparisonPoints,
      openingReservePoints: opening.openingReservePoints,
      openingSourceEventId: opening.openingSourceEventId,
      openingSourceActorLogin: opening.openingSourceActorLogin,
      openingSourceAt: opening.openingSourceAt,
      claimAssigneeGitHubLogin: issue.claimAssigneeGitHubLogin ?? null,
      settledLabel: settledDifficulty?.label ?? null,
      settledPoints: settledDifficulty?.points ?? null,
      settledLabelEventId: settledDifficulty?.labelEventId ?? null,
      settledLabelActorLogin: settledDifficulty?.labelActorLogin ?? null,
      settledLabelAppliedAt: settledDifficulty?.labelAppliedAt ?? null,
      settledRationaleCommentId: settledDifficulty?.rationaleCommentId ?? null,
      settledRationaleActorLogin: settledDifficulty?.rationaleActorLogin ?? null,
      settledRationaleCommentedAt: settledDifficulty?.rationaleCommentedAt ?? null,
    });

    if (issue.state !== "CLOSED") {
      continue;
    }

    if (pullRequest === null) {
      unwritableClosures.push({
        githubIssueId: issue.id,
        kind: "NO_CLOSING_PULL_REQUEST",
        githubPullRequestId: null,
        reason: "No merged GitHub GraphQL closing pull request was found.",
      });
      continue;
    }

    const author = pullRequest.authorLogin === null ? undefined : usersByLogin.get(normalizeLogin(pullRequest.authorLogin));
    const reviewRounds = countReviewRounds(pullRequest.reviews, pullRequest.mergedAt);
    const proofSha256 = hashRawDiff(pullRequest.rawDiff);
    const foldedPullRequest = rememberPullRequest(
      pullRequestsByGitHubId,
      pullRequest,
      issue.id,
      author?.id ?? null,
      proofSha256,
      reviewRounds,
    );

    if (settledResolution?.kind === "rejected") {
      unwritableClosures.push({
        githubIssueId: issue.id,
        kind: "SETTLEMENT_EVIDENCE_REJECTED",
        githubPullRequestId: pullRequest.id,
        reason: settledResolution.reason,
      });
    }

    if (!isParticipationEligibleAt(snapshot.repository.sponsor, pullRequest.mergedAt)) {
      continue;
    }

    if (author !== undefined && !isParticipationEligibleAt(author, pullRequest.mergedAt)) {
      continue;
    }

    if (author?.id === snapshot.repository.sponsor.id) {
      selfWorkCalibrations.push({
        githubIssueId: issue.id,
        githubPullRequestId: foldedPullRequest.githubPullRequestId,
        userId: author.id,
        openingComparisonPoints: opening.openingComparisonPoints,
        actualLabel: settledDifficulty?.label ?? null,
        actualPoints: settledDifficulty?.points ?? null,
        actualLabelEventId: settledDifficulty?.labelEventId ?? null,
        actualLabelActorLogin: settledDifficulty?.labelActorLogin ?? null,
        actualLabelAppliedAt: settledDifficulty?.labelAppliedAt ?? null,
        rationaleCommentId: settledDifficulty?.rationaleCommentId ?? null,
        rationaleActorLogin: settledDifficulty?.rationaleActorLogin ?? null,
        rationaleCommentedAt: settledDifficulty?.rationaleCommentedAt ?? null,
        mergeCommitOid: foldedPullRequest.mergeCommitOid,
        mergedAt: foldedPullRequest.mergedAt!,
      });
      continue;
    }

    settlements.push(
      toSettlement({
        issueId: issue.id,
        pullRequest: foldedPullRequest,
        author,
        authorLogin: pullRequest.authorLogin,
        debtorId: snapshot.repository.sponsor.id,
        openingComparisonPoints: opening.openingComparisonPoints,
        settledDifficulty,
      }),
    );
  }

  const ledgerEntries = foldLedger(
    settlements.flatMap((settlement) => toLedgerSettlement(settlement)),
  );

  return {
    issues: issues.sort((left, right) => left.githubIssueId - right.githubIssueId),
    pullRequests: [...pullRequestsByGitHubId.values()].sort(
      (left, right) => left.githubPullRequestId - right.githubPullRequestId,
    ),
    settlements: settlements.sort((left, right) => left.githubIssueId - right.githubIssueId),
    selfWorkCalibrations: selfWorkCalibrations.sort((left, right) => left.githubIssueId - right.githubIssueId),
    unwritableClosures: unwritableClosures.sort((left, right) => left.githubIssueId - right.githubIssueId),
    policyViolations: policyViolations.sort((left, right) => left.githubIssueId - right.githubIssueId),
    ledgerEntries,
  };
}

function resolveOpening(
  issue: RepositoryFoldIssue,
  scheme: DifficultyScheme,
  raterLogin: string | null,
): OpeningResolution | null {
  const ownerLogin = normalizedNonblankLogin(issue.authorLogin);
  if (ownerLogin === null || raterLogin === null || !validTimestamp(issue.createdAt)) {
    return null;
  }
  const openingByLabel = new Map(scheme.openingLabels.map((entry) => [entry.label, entry]));
  const orderedHistory = issue.history.filter(validIssueHistoryEvent).sort(compareHistoryItems);
  // Bounded by TIME rather than by position in the history. Ordering here is
  // decided by whichever event GitHub happened to record first, and creating an
  // issue with labels and an assignee in one call records the assignment first
  // — which used to drop the issue from the fold entirely.
  const firstAssignment = orderedHistory.find((event) => event.kind === "ASSIGNED");
  const openingDeadline = firstAssignment === undefined
    ? Number.POSITIVE_INFINITY
    : Date.parse(firstAssignment.createdAt) + EVIDENCE_ORDERING_GRACE_MS;
  const issueCreatedTime = Date.parse(issue.createdAt);
  const sourceIndex = orderedHistory.findIndex(
    (event) =>
      event.kind === "LABELED" &&
      openingByLabel.has(event.label) &&
      normalizedNonblankLogin(event.actorLogin) === raterLogin &&
      Date.parse(event.createdAt) >= issueCreatedTime &&
      Date.parse(event.createdAt) <= openingDeadline,
  );
  if (sourceIndex < 0) {
    return null;
  }
  const source = orderedHistory[sourceIndex] as Extract<GitHubIssueHistoryEvent, { kind: "LABELED" }>;
  const configured = openingByLabel.get(source.label)!;
  const mutated = orderedHistory.slice(sourceIndex + 1).some(
    (event) =>
      (event.kind === "LABELED" || event.kind === "UNLABELED") &&
      openingByLabel.has(event.label),
  );

  return {
    githubIssueId: issue.id,
    ownerGitHubLogin: issue.authorLogin!.trim(),
    openingLabel: configured.label,
    openingComparisonPoints: configured.comparisonPoints,
    openingReservePoints: configured.reservePoints,
    openingSourceEventId: source.id,
    openingSourceActorLogin: source.actorLogin!.trim(),
    openingSourceAt: new Date(source.createdAt).toISOString(),
    mutated,
  };
}

function selectClosingPullRequest(
  pullRequests: readonly RepositoryFoldPullRequest[],
): AuthoritativeClosingPullRequest | null {
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
  }));
  if (merged.length === 0) {
    return null;
  }

  return merged.sort((left, right) => {
    const timestampDifference = Date.parse(left.mergedAt!) - Date.parse(right.mergedAt!);
    return timestampDifference || left.number - right.number || left.id - right.id;
  })[0] ?? null;
}

function resolveSettledDifficulty(
  issue: RepositoryFoldIssue,
  pullRequest: AuthoritativeClosingPullRequest,
  scheme: DifficultyScheme,
  raterLogin: string | null,
): SettledDifficultyResolution {
  if (raterLogin === null) {
    return {
      kind: "rejected",
      reason: "The repository sponsor has no login, so no settled label can be attributed to the sponsor.",
    };
  }
  const actualByLabel = new Map(scheme.actualLabels.map((entry) => [entry.label, entry]));
  const mergeTime = Date.parse(pullRequest.mergedAt);
  const finalCommitTime = Date.parse(pullRequest.finalCommitAt);
  const activeLabels = new Map<string, Extract<GitHubIssueHistoryEvent, { kind: "LABELED" }>>();
  let earliestLaterApplication: Extract<GitHubIssueHistoryEvent, { kind: "LABELED" }> | undefined;
  for (const event of issue.history.filter(validIssueHistoryEvent).sort(compareHistoryItems)) {
    if (
      (event.kind !== "LABELED" && event.kind !== "UNLABELED") ||
      !actualByLabel.has(event.label)
    ) {
      continue;
    }
    if (Date.parse(event.createdAt) > mergeTime + EVIDENCE_ORDERING_GRACE_MS) {
      if (event.kind === "LABELED" && earliestLaterApplication === undefined) {
        earliestLaterApplication = event;
      }
      continue;
    }
    if (event.kind === "LABELED") {
      activeLabels.set(event.label, event);
    } else {
      activeLabels.delete(event.label);
    }
  }
  if (activeLabels.size === 0) {
    const laterApplication = earliestLaterApplication === undefined
      ? ""
      : ` The earliest later application, \`${earliestLaterApplication.label}\` at ${new Date(earliestLaterApplication.createdAt).toISOString()}, came after that window.`;
    return {
      kind: "rejected",
      reason: `No configured actual-catalog label was standing on the issue by fifteen minutes after the merge at ${new Date(pullRequest.mergedAt).toISOString()}.${laterApplication}`,
    };
  }
  if (activeLabels.size > 1) {
    return {
      kind: "rejected",
      reason: `Several actual-catalog labels were standing on the issue by fifteen minutes after the merge at ${new Date(pullRequest.mergedAt).toISOString()}: ${[...activeLabels.keys()].map((label) => `\`${label}\``).join(", ")}. Exactly one is required.`,
    };
  }
  const [[label, source]] = [...activeLabels.entries()];
  const sourceTime = Date.parse(source.createdAt);
  if (
    sourceTime < finalCommitTime - EVIDENCE_ORDERING_GRACE_MS ||
    sourceTime > mergeTime + EVIDENCE_ORDERING_GRACE_MS
  ) {
    return {
      kind: "rejected",
      reason: `The settled label \`${label}\` was applied at ${new Date(source.createdAt).toISOString()}, outside the window from fifteen minutes before the final commit at ${new Date(pullRequest.finalCommitAt).toISOString()} to fifteen minutes after the merge at ${new Date(pullRequest.mergedAt).toISOString()}.`,
    };
  }
  if (normalizedNonblankLogin(source.actorLogin) !== raterLogin) {
    return {
      kind: "rejected",
      violation: "SETTLED_LABEL_UNAUTHORIZED",
      reason: `The settled label \`${label}\` was applied by \`${source.actorLogin?.trim() || "unknown"}\` rather than the issue owner \`${raterLogin}\`.`,
    };
  }
  const windowCloseTime = mergeTime + EVIDENCE_ORDERING_GRACE_MS;
  const candidates = issue.comments
    .filter(validIssueComment)
    .sort(compareHistoryItems)
    .filter((comment) => {
      const commentTime = Date.parse(comment.createdAt);
      return (
        normalizedNonblankLogin(comment.authorLogin) === raterLogin &&
        comment.body.trim().length > 0 &&
        comment.body.toLocaleLowerCase().includes(label.toLocaleLowerCase()) &&
        commentTime >= sourceTime - EVIDENCE_ORDERING_GRACE_MS &&
        commentTime <= windowCloseTime
      );
    });
  // A body edited after the window closed is the body of today, not the body
  // the reviewer settled on; without edit history it proves nothing.
  const qualifyingRationales = candidates.filter((comment) => !editedAfter(comment, windowCloseTime));
  // Prefer the earliest qualifying rationale at or after the standing label,
  // avoiding an older application's rationale when such a comment exists.
  // An earlier comment inside the grace window is the fallback only when no
  // qualifying rationale exists at or after the standing label.
  const rationale =
    qualifyingRationales.find((comment) => Date.parse(comment.createdAt) >= sourceTime) ??
    qualifyingRationales[0];
  if (rationale === undefined) {
    return {
      kind: "rejected",
      violation: candidates.length > 0 ? "SETTLED_RATIONALE_EDITED" : undefined,
      reason: `No rationale comment by \`${raterLogin}\` naming \`${label}\` was posted between fifteen minutes before the label at ${new Date(source.createdAt).toISOString()} and fifteen minutes after the merge at ${new Date(pullRequest.mergedAt).toISOString()}.`,
    };
  }
  const configured = actualByLabel.get(label)!;
  return {
    kind: "accepted",
    evidence: {
      label: configured.label,
      points: configured.points,
      labelEventId: source.id,
      labelActorLogin: source.actorLogin!.trim(),
      labelAppliedAt: new Date(source.createdAt).toISOString(),
      rationaleCommentId: rationale.id,
      rationaleActorLogin: rationale.authorLogin!.trim(),
      rationaleCommentedAt: new Date(rationale.createdAt).toISOString(),
    },
  };
}

function rememberPullRequest(
  pullRequestsByGitHubId: Map<number, FoldPullRequest>,
  pullRequest: AuthoritativeClosingPullRequest,
  issueId: number,
  authorId: string | null,
  proofSha256: string,
  reviewRounds: Array<{ githubReviewId: number; submittedAt: string }>,
): FoldPullRequest {
  const existing = pullRequestsByGitHubId.get(pullRequest.id);
  if (existing !== undefined) {
    if (!existing.githubIssueIds.includes(issueId)) {
      existing.githubIssueIds.push(issueId);
      existing.githubIssueIds.sort((left, right) => left - right);
    }
    return existing;
  }

  const folded: FoldPullRequest = {
    githubPullRequestId: pullRequest.id,
    number: pullRequest.number,
    title: pullRequest.title,
    body: pullRequest.body,
    url: pullRequest.url,
    state: pullRequest.state,
    mergedAt: pullRequest.mergedAt,
    mergeCommitOid: pullRequest.mergeCommitOid,
    finalCommitAt: pullRequest.finalCommitAt,
    authorId,
    authorGitHubLogin: pullRequest.authorLogin,
    proofSha256,
    githubIssueIds: [issueId],
    reviewRounds,
  };
  pullRequestsByGitHubId.set(pullRequest.id, folded);
  return folded;
}

function countReviewRounds(
  reviews: readonly GitHubPullRequestReview[],
  mergedAt: string | null,
): Array<{ githubReviewId: number; submittedAt: string }> {
  if (!validTimestamp(mergedAt)) {
    return [];
  }

  const mergeTime = Date.parse(mergedAt);
  const uniqueReviews = new Map<number, string>();
  for (const review of reviews) {
    if (
      review.state !== "CHANGES_REQUESTED" ||
      review.submittedAt === null ||
      !validTimestamp(review.submittedAt) ||
      Date.parse(review.submittedAt) >= mergeTime
    ) {
      continue;
    }
    uniqueReviews.set(review.id, review.submittedAt);
  }

  return [...uniqueReviews.entries()]
    .map(([githubReviewId, submittedAt]) => ({ githubReviewId, submittedAt }))
    .sort((left, right) => left.githubReviewId - right.githubReviewId);
}

function toSettlement(input: {
  issueId: number;
  pullRequest: FoldPullRequest;
  author: FoldUser | undefined;
  authorLogin: string | null;
  debtorId: string;
  openingComparisonPoints: number;
  settledDifficulty: SettledDifficultyEvidence | null;
}): FoldSettlement {
  const settledPoints = input.settledDifficulty?.points ?? null;
  const reviewRounds = input.pullRequest.reviewRounds.length;
  const base = {
    githubIssueId: input.issueId,
    githubPullRequestId: input.pullRequest.githubPullRequestId,
    creditorId: input.author?.id ?? null,
    creditorGitHubLogin: input.authorLogin,
    debtorId: input.debtorId,
    openingComparisonPoints: input.openingComparisonPoints,
    settledLabel: input.settledDifficulty?.label ?? null,
    settledPoints,
    settledLabelEventId: input.settledDifficulty?.labelEventId ?? null,
    settledLabelActorLogin: input.settledDifficulty?.labelActorLogin ?? null,
    settledLabelAppliedAt: input.settledDifficulty?.labelAppliedAt ?? null,
    settledRationaleCommentId: input.settledDifficulty?.rationaleCommentId ?? null,
    settledRationaleActorLogin: input.settledDifficulty?.rationaleActorLogin ?? null,
    settledRationaleCommentedAt: input.settledDifficulty?.rationaleCommentedAt ?? null,
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

function toLedgerSettlement(settlement: FoldSettlement): SettlementDecision[] {
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
      creditorId: settlement.creditorId,
      debtorId: settlement.debtorId,
      opening: settlement.openingComparisonPoints,
      settled: settlement.settledPoints,
      reviewRounds: settlement.reviewRounds,
      credits: settlement.credits,
    },
  ];
}

function hashRawDiff(rawDiff: string): string {
  return createHash("sha256").update(rawDiff).digest("hex");
}

function normalizeLogin(login: string): string {
  return login.trim().toLowerCase();
}

function normalizedNonblankLogin(login: string | null): string | null {
  if (login === null || login.trim().length === 0) {
    return null;
  }
  return normalizeLogin(login);
}

function validIssueHistoryEvent(event: GitHubIssueHistoryEvent): boolean {
  return typeof event.id === "string" && event.id.length > 0 && validTimestamp(event.createdAt);
}

function validIssueComment(comment: GitHubIssueComment): boolean {
  return typeof comment.id === "string" && comment.id.length > 0 && validTimestamp(comment.createdAt);
}

function editedAfter(comment: GitHubIssueComment, deadline: number): boolean {
  return validTimestamp(comment.lastEditedAt) && Date.parse(comment.lastEditedAt) > deadline;
}

function compareHistoryItems(
  left: Pick<GitHubIssueHistoryEvent | GitHubIssueComment, "createdAt" | "id">,
  right: Pick<GitHubIssueHistoryEvent | GitHubIssueComment, "createdAt" | "id">,
): number {
  return Date.parse(left.createdAt) - Date.parse(right.createdAt);
}

function isParticipationEligibleAt(user: FoldUser, timestamp: string): boolean {
  if (!validTimestamp(timestamp)) {
    return false;
  }
  const targetTime = Date.parse(timestamp);
  const events = [...(user.moderationEvents ?? [])]
    .filter((event) => typeof event.id === "string" && event.id.length > 0 && validTimestamp(event.occurredAt))
    .sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || left.id.localeCompare(right.id));
  const latestAtEvent = events.filter((event) => Date.parse(event.occurredAt) <= targetTime).at(-1);
  if (latestAtEvent !== undefined) {
    return isParticipationEligible(latestAtEvent.newState);
  }
  const firstLaterEvent = events.find((event) => Date.parse(event.occurredAt) > targetTime);
  return isParticipationEligible(firstLaterEvent?.priorState ?? user.enforcementState);
}

function validTimestamp(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}
