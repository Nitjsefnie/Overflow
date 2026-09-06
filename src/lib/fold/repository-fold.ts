import { createHash } from "node:crypto";
import { isParticipationEligible, type EnforcementState, type IssueState, type PullRequestState } from "@/lib/db/types";
import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";
import { foldLedger, type LedgerEntry } from "@/lib/domain/ledger";
import { calculateSettlement, type SettlementDecision } from "@/lib/domain/settlement";
import { belongsToRegisteredRepository } from "@/lib/fold/repository-ownership";
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
  /** users.github_user_id — the immutable GitHub account id this row is bound to. */
  githubUserId: number;
  githubLogin: string;
  enforcementState: EnforcementState;
  moderationEvents?: FoldModerationEvent[];
};

export type RepositoryFoldSnapshot = {
  repository: {
    id: string;
    /** registered_repositories.github_repository_id — the identity a rename cannot move. */
    githubRepositoryId: number;
    ownerName: string;
    active: boolean;
    /** registered_repositories.created_at as ISO-8601 — the moment Overflow began watching. */
    registeredAt: string;
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
  /** GraphQL `Issue.closedAt`; null while the issue is open. */
  closedAt: string | null;
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
  authorGitHubUserId: number | null;
  /** GitHub's stable numeric id of the repository this pull request lives in. */
  repositoryGitHubId: number;
  /** The same repository's current `owner/name`, for what a person reads. */
  repositoryNameWithOwner: string;
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
  authorGitHubUserId: number | null;
  proofSha256: string;
  githubIssueIds: number[];
  reviewRounds: Array<{ githubReviewId: number; submittedAt: string }>;
};

export type FoldSettlement = {
  githubIssueId: number;
  githubPullRequestId: number;
  creditorId: string | null;
  creditorGitHubLogin: string | null;
  creditorGitHubUserId: number | null;
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
  kind:
    | "NO_CLOSING_PULL_REQUEST"
    | "SETTLEMENT_EVIDENCE_REJECTED"
    | "CROSS_REPOSITORY_CLOSING_PULL_REQUEST";
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

type ClosingPullRequestSelection =
  | { kind: "SELECTED"; pullRequest: AuthoritativeClosingPullRequest }
  | { kind: "CROSS_REPOSITORY"; pullRequest: AuthoritativeClosingPullRequest }
  | { kind: "NONE" };

const noClosingPullRequest: ClosingPullRequestSelection = { kind: "NONE" };

export function foldRepository(snapshot: RepositoryFoldSnapshot): FoldResult {
  const usersByGitHubUserId = new Map(snapshot.users.map((user) => [user.githubUserId, user]));
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

    const selection = issue.state === "CLOSED"
      ? selectClosingPullRequest(issue.closingPullRequests, snapshot.repository)
      : noClosingPullRequest;
    const pullRequest = selection.kind === "SELECTED" ? selection.pullRequest : null;
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
      // A foreign closing pull request is never materialized, so the closure
      // that records it can reference no pull request row. Its evidence window
      // shut at the foreign merge; with no merge at all, at the close itself.
      const closure: UnwritableClosure = selection.kind === "CROSS_REPOSITORY"
        ? {
          githubIssueId: issue.id,
          kind: "CROSS_REPOSITORY_CLOSING_PULL_REQUEST",
          githubPullRequestId: null,
          reason: crossRepositoryReason(selection.pullRequest, snapshot.repository),
        }
        : {
          githubIssueId: issue.id,
          kind: "NO_CLOSING_PULL_REQUEST",
          githubPullRequestId: null,
          reason: "No merged GitHub GraphQL closing pull request was found.",
        };
      const windowClosedAt = selection.kind === "CROSS_REPOSITORY"
        ? selection.pullRequest.mergedAt
        : issue.closedAt;
      if (evidenceWindowReachable(windowClosedAt, snapshot.repository.registeredAt)) {
        unwritableClosures.push(closure);
      }
      continue;
    }

    const author = pullRequest.authorGitHubUserId === null
      ? undefined
      : usersByGitHubUserId.get(pullRequest.authorGitHubUserId);
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

    if (
      settledResolution?.kind === "rejected" &&
      evidenceWindowReachable(pullRequest.mergedAt, snapshot.repository.registeredAt)
    ) {
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
        authorGitHubUserId: pullRequest.authorGitHubUserId,
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

/**
 * An unwritable closure is a work item for a moderator, so it is worth
 * recording only while the evidence it asks for could still be produced. Every
 * settlement evidence window shuts at the closure — at the merge, or at the
 * close of an issue no pull request closed — and a window that shut before
 * Overflow was registered on the repository shut before anyone could have been
 * asked to fill it. No label applied and no comment written today reopens it,
 * so the row would sit in the queue forever with no action that could clear it.
 *
 * An instant nobody can read is not evidence the window was unreachable, so an
 * unparseable or absent one records: leaving a real work item visible is the
 * recoverable mistake, silently dropping one is not.
 */
function evidenceWindowReachable(windowClosedAt: string | null, registeredAt: string): boolean {
  if (!validTimestamp(windowClosedAt) || !validTimestamp(registeredAt)) {
    return true;
  }
  return Date.parse(windowClosedAt) >= Date.parse(registeredAt);
}

/**
 * Overflow's authority ends at the registered repository, so a closing
 * reference naming a pull request elsewhere is reported rather than folded:
 * its diff and reviews are not evidence about work this repository sponsored.
 */
function selectClosingPullRequest(
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
function crossRepositoryReason(
  pullRequest: AuthoritativeClosingPullRequest,
  registered: RepositoryFoldSnapshot["repository"],
): string {
  if (pullRequest.repositoryNameWithOwner.toLowerCase() !== registered.ownerName.toLowerCase()) {
    return `Closing pull request ${pullRequest.number} belongs to ${pullRequest.repositoryNameWithOwner}, `
      + `not the registered repository ${registered.ownerName}.`;
  }
  return `Closing pull request ${pullRequest.number} does not belong to the registered repository: `
    + `another repository now carries the name ${registered.ownerName} `
    + `(GitHub repository ${pullRequest.repositoryGitHubId}, not ${registered.githubRepositoryId}).`;
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
      reason: `The settled label \`${label}\` was applied by \`${source.actorLogin?.trim() || "unknown"}\` rather than the repository sponsor \`${raterLogin}\`.`,
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
      reason: candidates.length > 0
        ? `Every qualifying rationale comment by \`${raterLogin}\` naming \`${label}\` was edited after the settlement evidence window closed at ${new Date(windowCloseTime).toISOString()}.`
        : `No rationale comment by \`${raterLogin}\` naming \`${label}\` was posted between fifteen minutes before the label at ${new Date(source.createdAt).toISOString()} and fifteen minutes after the merge at ${new Date(pullRequest.mergedAt).toISOString()}.`,
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
    authorGitHubUserId: pullRequest.authorGitHubUserId,
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
    // Count rounds as they stood at merge; later dismissals cannot rewrite
    // the settled price, while a pre-merge dismissal withdraws the round.
    const submittedState = review.state === "DISMISSED"
      ? review.dismissal?.previousState ?? null
      : review.state;
    if (
      submittedState !== "CHANGES_REQUESTED" ||
      !validTimestamp(review.submittedAt) ||
      Date.parse(review.submittedAt) >= mergeTime ||
      dismissedBefore(review, mergeTime)
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
  authorGitHubUserId: number | null;
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
    creditorGitHubUserId: input.authorGitHubUserId,
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

function dismissedBefore(review: GitHubPullRequestReview, deadline: number): boolean {
  return review.dismissal !== null &&
    validTimestamp(review.dismissal.at) &&
    Date.parse(review.dismissal.at) < deadline;
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
