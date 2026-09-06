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
  /** GitHub's immutable numeric id of the author; null when GitHub reported none. */
  authorGitHubUserId: number | null;
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

/**
 * What a refusal records, and why the unauthorized one says more than its code.
 *
 * This row is the only record a moderator gets — the fold emits it,
 * `recordPolicyViolations` writes it to `reconciliation_changes`, and nothing
 * else is kept — so an accusation has to answer "which label, and who applied
 * it" without one. An absence has neither to report, so the two are a union on
 * `code` rather than one shape with two nullable columns: a consumer that
 * switches on the code gets the fields typed where they exist and is not made
 * to handle an absence that cannot happen.
 *
 * The label and one actor login are STRUCTURED facts for tooling to group and
 * filter on, and `reason` is the PROSE a moderator reads. The sponsor's stored
 * login appears only in that prose, so it is not redundant. Only the prose can
 * carry the discriminator where an account has taken the login the sponsor's
 * record still stores, since there the structured login is the sponsor's own
 * and says nothing.
 */
type OpeningRefusal =
  | { code: "OPENING_LABEL_MISSING" }
  | {
      code: "OPENING_LABEL_UNAUTHORIZED";
      /** The opening-catalog label the refused application applied. */
      openingLabel: string;
      /** The login GitHub reported for the account that applied it, or `unknown`. */
      openingSourceActorLogin: string;
      /** The same refusal in the words a moderator reads. */
      reason: string;
    };

export type FoldPolicyViolation =
  | (OpeningRefusal & { githubIssueId: number })
  | {
      code: "OPENING_LABEL_AMBIGUOUS" | "OPENING_LABEL_MUTATED" | SettlementEvidenceViolationCode;
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

type OpeningResolutionResult =
  | { kind: "resolved"; opening: OpeningResolution }
  | { kind: "refused"; violation: OpeningRefusal };

/** A `LABELED` timeline event, the only history event an opening can be read from. */
type OpeningLabelEvent = Extract<GitHubIssueHistoryEvent, { kind: "LABELED" }>;

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

/**
 * What decides whether a refused settlement is still worth a moderator's time.
 *
 * Most refusals describe an evidence window that has since shut, and outside
 * that window there is nothing left to produce. One does not: a sponsor with no
 * login is a fact about the account as it stands, and no window bounds fixing
 * it. The recording site cannot tell those apart from the reason sentence
 * without reading English, so the resolver states which it produced.
 *
 * `refusedEvidenceAt` is the settled label the resolver refused for landing
 * after the window closed, when there was one. It is the whole reason a stale
 * window can still be actionable: the label exists, it is just late, which is
 * the case the settlement-override path was built for.
 */
type RejectionReach =
  | { kind: "UNBOUNDED" }
  | { kind: "WINDOW"; refusedEvidenceAt: string | null };

type SettledDifficultyResolution =
  | { kind: "accepted"; evidence: SettledDifficultyEvidence }
  | { kind: "rejected"; reason: string; reach: RejectionReach; violation?: SettlementEvidenceViolationCode };

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
  const sponsor = snapshot.repository.sponsor;
  const issues: FoldIssue[] = [];
  const pullRequestsByGitHubId = new Map<number, FoldPullRequest>();
  const settlements: FoldSettlement[] = [];
  const selfWorkCalibrations: SelfWorkCalibration[] = [];
  const unwritableClosures: UnwritableClosure[] = [];
  const policyViolations: FoldPolicyViolation[] = [];
  // A property of the repository, not of any one issue. NaN when the stored
  // instant is unreadable, which every reachability test below treats as
  // unknown and therefore still reachable.
  const registeredAtTime = Date.parse(snapshot.repository.registeredAt);

  for (const issue of snapshot.issues) {
    const resolution = resolveOpening(issue, snapshot.repository.difficultyScheme, sponsor);
    if (resolution.kind === "refused") {
      policyViolations.push({ ...resolution.violation, githubIssueId: issue.id });
      continue;
    }
    const opening = resolution.opening;

    if (opening.mutated) {
      policyViolations.push({ code: "OPENING_LABEL_MUTATED", githubIssueId: issue.id });
    }

    const selection = issue.state === "CLOSED"
      ? selectClosingPullRequest(issue.closingPullRequests, snapshot.repository)
      : noClosingPullRequest;
    const pullRequest = selection.kind === "SELECTED" ? selection.pullRequest : null;
    const settledResolution = pullRequest === null
      ? null
      : resolveSettledDifficulty(issue, pullRequest, snapshot.repository.difficultyScheme, sponsor);
    // Said once for both gated recording sites. A closure's evidence window
    // shuts fifteen minutes after the merge that closed the issue — the same
    // fifteen minutes every rejection reason quotes back to a moderator — or,
    // where nothing merged, at the close of the issue itself. A closure naming
    // a foreign pull request reads neither: it is not gated at all.
    const evidenceWindowClosedAt = pullRequest === null
      ? parsedInstant(issue.closedAt)
      : Date.parse(pullRequest.mergedAt) + EVIDENCE_ORDERING_GRACE_MS;
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
      // Either way a foreign closing pull request is never materialized, so
      // the closure that records one can reference no pull request row.
      if (selection.kind === "CROSS_REPOSITORY") {
        // Deliberately ungated. What this asks of a moderator — register the
        // other repository, or act on the identity alert the reason carries —
        // is bound to no evidence window, so however long ago the foreign pull
        // request merged, the work is still there to do.
        unwritableClosures.push({
          githubIssueId: issue.id,
          kind: "CROSS_REPOSITORY_CLOSING_PULL_REQUEST",
          githubPullRequestId: null,
          reason: crossRepositoryReason(selection.pullRequest, snapshot.repository),
        });
      } else if (evidenceWindowReachable(evidenceWindowClosedAt, registeredAtTime)) {
        unwritableClosures.push({
          githubIssueId: issue.id,
          kind: "NO_CLOSING_PULL_REQUEST",
          githubPullRequestId: null,
          reason: "No merged GitHub GraphQL closing pull request was found.",
        });
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
      rejectionReachable(settledResolution.reach, evidenceWindowClosedAt, registeredAtTime)
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
  sponsor: FoldUser,
): OpeningResolutionResult {
  const ownerLogin = normalizedNonblankLogin(issue.authorLogin);
  // Deliberately no guard on the sponsor's own login. `isRepositorySponsor`
  // decides who the rater is, and where GitHub named a numeric account id that
  // decision is already made — a stored login that reads as blank must not
  // overturn it, because refusing the opening here is exactly the loss this
  // fold exists to stop. Where no id is reported on either side the predicate
  // refuses on the blank login by itself.
  // Neither of these is a fact about a label's authority — there is no label to
  // read an actor from yet — so both stay the absence refusal.
  if (ownerLogin === null || !validTimestamp(issue.createdAt)) {
    return { kind: "refused", violation: { code: "OPENING_LABEL_MISSING" } };
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
  // An opening-catalog label APPLIED inside the opening window, whoever applied
  // it and whether or not it is still on the issue. The accepting predicate
  // below is this AND `isRepositorySponsor`, so the only conjunct separating a
  // candidate from an accepted opening is the one whose failure is an authority
  // problem rather than an absence — which is what lets a refusal say which of
  // the two it is. Reading the history rather than `issue.labels` is the
  // accepting predicate's own rule: a later removal is recorded as `mutated`,
  // not as an opening that never happened.
  const openingCandidate = (event: GitHubIssueHistoryEvent): event is OpeningLabelEvent =>
    event.kind === "LABELED" &&
    openingByLabel.has(event.label) &&
    Date.parse(event.createdAt) >= issueCreatedTime &&
    Date.parse(event.createdAt) <= openingDeadline;
  const sourceIndex = orderedHistory.findIndex(
    (event) =>
      openingCandidate(event) &&
      isRepositorySponsor({ login: event.actorLogin, githubUserId: event.actorGitHubUserId }, sponsor),
  );
  if (sourceIndex < 0) {
    return { kind: "refused", violation: openingRefusal(orderedHistory.filter(openingCandidate), sponsor) };
  }
  const source = orderedHistory[sourceIndex] as OpeningLabelEvent;
  const configured = openingByLabel.get(source.label)!;
  const mutated = orderedHistory.slice(sourceIndex + 1).some(
    (event) =>
      (event.kind === "LABELED" || event.kind === "UNLABELED") &&
      openingByLabel.has(event.label),
  );

  return {
    kind: "resolved",
    opening: {
      githubIssueId: issue.id,
      ownerGitHubLogin: issue.authorLogin!.trim(),
      openingLabel: configured.label,
      openingComparisonPoints: configured.comparisonPoints,
      openingReservePoints: configured.reservePoints,
      openingSourceEventId: source.id,
      openingSourceActorLogin: sponsorDisplayLogin(source.actorLogin, sponsor),
      openingSourceAt: new Date(source.createdAt).toISOString(),
      mutated,
    },
  };
}

/**
 * Which refusal to record when no opening-catalog application inside the
 * opening window could be verified as the sponsor's.
 *
 * `OPENING_LABEL_UNAUTHORIZED` records an opening-catalog application whose
 * actor could not be verified as the sponsor, and is reported only where an
 * account could actually be compared: GitHub named a numeric actor id, or the
 * sponsor's stored login is there to read. Where GitHub named no id and the
 * sponsor record's login is blank, nothing was compared and nobody can be
 * accused, so the refusal stays the absence one. `resolveSettledDifficulty`
 * declines to emit `SETTLED_LABEL_UNAUTHORIZED` on the same guard — but only on
 * that guard: it first reduces the history to the labels still STANDING at the
 * merge, while an opening is decided by the applications themselves, so a label
 * applied here and removed again is still refused by name.
 *
 * Candidates arrive already bounded by the opening window, so a label applied
 * before the issue existed or after the opening deadline never reaches here as
 * a candidate: that is a timing refusal, and it reads as missing rather than
 * being absorbed into an authority one.
 */
function openingRefusal(candidates: OpeningLabelEvent[], sponsor: FoldUser): OpeningRefusal {
  const sponsorLogin = normalizedNonblankLogin(sponsor.githubLogin);
  // Only name candidates whose accounts could be compared. Among candidates
  // at the earliest instant, order ids to choose a deterministic diagnostic
  // representative: opaque GitHub ids do not establish which happened first.
  // Keep this key out of the accepting path: its selected id is persisted as
  // immutable evidence and re-derived on every reconciliation. Selecting a
  // different accepted id would fail the run's immutable-evidence check.
  const attributable = candidates
    .filter((candidate) => candidate.actorGitHubUserId !== null || sponsorLogin !== null)
    .sort((left, right) => compareHistoryItems(left, right) || left.id.localeCompare(right.id))[0];
  if (attributable === undefined) {
    // TODO (issue 189): With a blank sponsor login and only idless candidates,
    // stay mute: OPENING_LABEL_UNAUTHORIZED would accuse an account never
    // compared against the sponsor. The settled window's explicit missing-login
    // reason cannot cover this gap because it is downstream of this refusal.
    return { code: "OPENING_LABEL_MISSING" };
  }
  return {
    code: "OPENING_LABEL_UNAUTHORIZED",
    openingLabel: attributable.label,
    // Deliberately not `sponsorDisplayLogin`: that helper falls back to the
    // SPONSOR's stored login when the payload names no actor, which here would
    // record the sponsor as the account that applied an unauthorized label.
    openingSourceActorLogin: attributable.actorLogin?.trim() || "unknown",
    // Shared with the settled side, so an account that took the sponsor's freed
    // login is refused in the same words at both windows.
    reason: labelActorRejection("opening", attributable.label, attributable.actorLogin, sponsorLogin),
  };
}

/**
 * An unwritable closure is a work item for a moderator, so it is worth
 * recording only while the evidence it asks for could still be produced. A
 * settlement evidence window shuts fifteen minutes after the merge, and an
 * issue no pull request closed has only its own close; a window that shut
 * before Overflow was registered on the repository shut before anyone here
 * could have been asked to fill it, and no label applied today reopens it.
 *
 * Reachability is decided against the registration instant only. When that
 * instant is unreadable, or the closing instant is absent or unreadable,
 * nothing has been shown about the window, so the closure is recorded: leaving
 * a real work item visible is the recoverable mistake, and silently dropping
 * one is not.
 */
function evidenceWindowReachable(windowClosedAt: number | null, registeredAtTime: number): boolean {
  if (windowClosedAt === null || !Number.isFinite(registeredAtTime)) {
    return true;
  }
  return windowClosedAt >= registeredAtTime;
}

/**
 * A refused settlement outlives its own window when the evidence it refused
 * arrived after the repository was registered: the settled label is there, it
 * merely landed late, and pricing it is exactly what the settlement-override
 * path does. Recording it is the only way a moderator ever sees it, so the
 * late evidence is checked even once the window itself is out of reach.
 */
function rejectionReachable(
  reach: RejectionReach,
  windowClosedAt: number | null,
  registeredAtTime: number,
): boolean {
  if (reach.kind === "UNBOUNDED") {
    return true;
  }
  if (evidenceWindowReachable(windowClosedAt, registeredAtTime)) {
    return true;
  }
  const refusedEvidenceAt = parsedInstant(reach.refusedEvidenceAt);
  return refusedEvidenceAt !== null && refusedEvidenceAt >= registeredAtTime;
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
  sponsor: FoldUser,
): SettledDifficultyResolution {
  // Read for the rejection sentences below, not as a guard: a blank stored
  // login is only fatal where the login is the only route left, which is
  // decided at the identification itself.
  const raterLogin = normalizedNonblankLogin(sponsor.githubLogin);
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
  // Built once for every refusal below. All five describe the same shut window,
  // and the label that landed after it is what can still make any of them
  // actionable — so which refusal fired must not decide whether it is carried.
  const windowReach: RejectionReach = {
    kind: "WINDOW",
    refusedEvidenceAt: earliestLaterApplication?.createdAt ?? null,
  };
  if (activeLabels.size === 0) {
    const laterApplication = earliestLaterApplication === undefined
      ? ""
      : ` The earliest later application, \`${earliestLaterApplication.label}\` at ${new Date(earliestLaterApplication.createdAt).toISOString()}, came after that window.`;
    return {
      kind: "rejected",
      reach: windowReach,
      reason: `No configured actual-catalog label was standing on the issue by fifteen minutes after the merge at ${new Date(pullRequest.mergedAt).toISOString()}.${laterApplication}`,
    };
  }
  if (activeLabels.size > 1) {
    return {
      kind: "rejected",
      reach: windowReach,
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
      reach: windowReach,
      reason: `The settled label \`${label}\` was applied at ${new Date(source.createdAt).toISOString()}, outside the window from fifteen minutes before the final commit at ${new Date(pullRequest.finalCommitAt).toISOString()} to fifteen minutes after the merge at ${new Date(pullRequest.mergedAt).toISOString()}.`,
    };
  }
  if (!isRepositorySponsor({ login: source.actorLogin, githubUserId: source.actorGitHubUserId }, sponsor)) {
    if (raterLogin === null && source.actorGitHubUserId === null) {
      // GitHub named no account id, so the login was the only route left, and
      // the sponsor's record carries no login to compare against. UNBOUNDED
      // rather than bounded by the evidence window: a sponsor's missing login
      // is a fact about the account today, and no window bounds fixing it.
      return {
        kind: "rejected",
        reach: { kind: "UNBOUNDED" },
        reason: "The repository sponsor has no login, so no settled label can be attributed to the sponsor.",
      };
    }
    return {
      kind: "rejected",
      reach: windowReach,
      violation: "SETTLED_LABEL_UNAUTHORIZED",
      reason: labelActorRejection("settled", label, source.actorLogin, raterLogin),
    };
  }
  const windowCloseTime = mergeTime + EVIDENCE_ORDERING_GRACE_MS;
  const candidates = issue.comments
    .filter(validIssueComment)
    .sort(compareHistoryItems)
    .filter((comment) => {
      const commentTime = Date.parse(comment.createdAt);
      return (
        isRepositorySponsor({ login: comment.authorLogin, githubUserId: comment.authorGitHubUserId }, sponsor) &&
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
      reach: windowReach,
      violation: candidates.length > 0 ? "SETTLED_RATIONALE_EDITED" : undefined,
      reason: candidates.length > 0
        ? `Every qualifying rationale comment by ${repositorySponsorPhrase(raterLogin)} naming \`${label}\` was edited after the settlement evidence window closed at ${new Date(windowCloseTime).toISOString()}.`
        : `No rationale comment by ${repositorySponsorPhrase(raterLogin)} naming \`${label}\` was posted between fifteen minutes before the label at ${new Date(source.createdAt).toISOString()} and fifteen minutes after the merge at ${new Date(pullRequest.mergedAt).toISOString()}.`,
    };
  }
  const configured = actualByLabel.get(label)!;
  return {
    kind: "accepted",
    evidence: {
      label: configured.label,
      points: configured.points,
      labelEventId: source.id,
      labelActorLogin: sponsorDisplayLogin(source.actorLogin, sponsor),
      labelAppliedAt: new Date(source.createdAt).toISOString(),
      rationaleCommentId: rationale.id,
      rationaleActorLogin: sponsorDisplayLogin(rationale.authorLogin, sponsor),
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

/** Whoever GitHub named on a timeline event or a comment, as the payload reports them. */
type FoldActorIdentity = {
  login: string | null;
  githubUserId: number | null;
};

/**
 * The one answer to "did the repository sponsor do this?", for every place the
 * rater's identity decides whether evidence counts.
 *
 * `users.github_login` refreshes only when that user next signs in, so it goes
 * stale the moment the sponsor renames on GitHub — while GitHub reports the
 * renamed account's CURRENT login as the actor of every event it serves. The
 * numeric account id is what a rename cannot move, so wherever GitHub reports
 * one it decides alone: a differing id is a definitive "not the sponsor" and
 * never a reason to consult the login, because the login the sponsor left
 * behind is free for anyone else to take, and taking it would otherwise buy
 * the authority to price this repository's work.
 *
 * The login is consulted only where GitHub reported no usable id at all — a
 * Bot, a Mannequin, an Organization, a deleted account — which is the
 * comparison that has always been made, unchanged.
 */
function isRepositorySponsor(actor: FoldActorIdentity, sponsor: FoldUser): boolean {
  if (actor.githubUserId !== null) {
    return actor.githubUserId === sponsor.githubUserId;
  }
  const sponsorLogin = normalizedNonblankLogin(sponsor.githubLogin);
  return sponsorLogin !== null && normalizedNonblankLogin(actor.login) === sponsorLogin;
}

/**
 * The login a display column shows for an actor `isRepositorySponsor` has
 * already accepted as the repository sponsor.
 *
 * The identification is made by the numeric account id wherever GitHub reports
 * one, and that route never reads the login — so nothing at these call sites
 * proves the payload named a usable one. The type allows `githubUserId` beside
 * a null or whitespace-only `actorLogin`, and both spellings are destructive
 * further down: a null throws where the login is trimmed and fails the whole
 * reconciliation run, and a whitespace-only login trims to the empty string,
 * which the `length(trim(...)) > 0` checks on these columns (migrations 007 and
 * 010) refuse — failing the whole materialization transaction. Falling back
 * here keeps the proof local to the value being written, rather than resting it
 * on what the one producer in `src/lib/github/client.ts` happens to derive.
 *
 * The payload's own text is preferred and kept verbatim, because a login is
 * display text whose case GitHub preserves and this is where the rename becomes
 * visible. The sponsor's stored login is the fallback, non-blank by
 * `users.github_login`'s own check (migration 001). That check spells `trim()`
 * with one argument and so strips spaces only, while `.trim()` here strips all
 * whitespace, leaving a stored tab that the database accepts and this reads as
 * blank (issue 141) — hence the placeholder last, the same one a refusal
 * sentence already uses for an actor it cannot name.
 */
function sponsorDisplayLogin(actorLogin: string | null, sponsor: FoldUser): string {
  return actorLogin?.trim() || sponsor.githubLogin.trim() || "unknown";
}

/**
 * How a refusal names the sponsor. The sponsor is an ACCOUNT; the stored login
 * is only what our record of that account currently says, and it is precisely
 * what anyone can take over once the sponsor renames — so a sentence that names
 * the login alone tells a moderator nothing about what was refused.
 *
 * These strings are payload-derived display text a moderator reads, so no
 * numeric account id belongs in one.
 */
function repositorySponsorPhrase(raterLogin: string | null): string {
  return raterLogin === null
    ? "the repository sponsor's account"
    : `the repository sponsor's account (login \`${raterLogin}\`)`;
}

/**
 * Why a label's actor could not be verified as the sponsor. Where the rejected
 * actor carries the login the sponsor's record still stores — an account that
 * took the freed login after a rename — naming both sides puts the same login
 * either side of "rather than", which reads as a contradiction and names no
 * discriminator. The discriminator is the account.
 *
 * Both label windows refuse an actor for the same reason and must say so the
 * same way, so the noun is a parameter rather than the sentence being written
 * out twice: a second copy is where the impostor branch goes missing.
 */
function labelActorRejection(
  labelKind: "opening" | "settled",
  label: string,
  actorLogin: string | null,
  raterLogin: string | null,
): string {
  const actor = normalizedNonblankLogin(actorLogin);
  if (actor !== null && actor === raterLogin) {
    return `The ${labelKind} label \`${label}\` was applied by a different GitHub account using the login `
      + `\`${actorLogin!.trim()}\`, not by the repository sponsor.`;
  }
  const sponsor = raterLogin === null ? "the repository sponsor" : `the repository sponsor \`${raterLogin}\``;
  return `The application of the ${labelKind} label \`${label}\` by \`${actorLogin?.trim() || "unknown"}\` could not be attributed to ${sponsor}.`;
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

/** The instant as a moment, or null when GitHub reported none we can read. */
function parsedInstant(value: string | null): number | null {
  return validTimestamp(value) ? Date.parse(value) : null;
}
