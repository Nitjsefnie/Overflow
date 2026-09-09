import { createHash } from "node:crypto";
import { isParticipationEligible, type EnforcementState, type IssueState, type PullRequestState } from "@/lib/db/types";
import { difficultySchemeInForceAt, type DifficultyScheme, type DifficultySchemeVersion } from "@/lib/domain/difficulty-scheme";
import { foldLedger, type LedgerEntry } from "@/lib/domain/ledger";
import { calculateSettlement, type SettlementDecision } from "@/lib/domain/settlement";
import { belongsToRegisteredRepository } from "@/lib/fold/repository-ownership";
import type {
  GitHubIssue,
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
    /** The catalog in force now — what the dashboard reads and openings resolve by. */
    difficultyScheme: DifficultyScheme;
    /**
     * The repository's catalog history, earliest first. Empty means the current
     * catalog governs every instant, which is the one-catalog behavior every
     * repository had before catalogs became versioned (issue 180).
     */
    difficultySchemeVersions: DifficultySchemeVersion[];
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
  stateReason: GitHubIssue["stateReason"];
  /** GitHub's update time for this view, including when reused from evidence. */
  updatedAt: string;
  createdAt: string;
  /** GraphQL `Issue.closedAt`; null while the issue is open. */
  closedAt: string | null;
  authorLogin: string | null;
  /** GitHub's immutable numeric id of the author; null when GitHub reported none. */
  authorGitHubUserId: number | null;
  labels: string[];
  claimAssigneeGitHubLogin?: string | null;
  /** GitHub's immutable numeric id of the claim assignee; null when GitHub reported none. */
  claimAssigneeGitHubUserId?: number | null;
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
  updatedAt: string;
  ownerGitHubLogin: string;
  openingSourceEventId: string;
  openingSourceActorLogin: string;
  openingSourceAt: string;
  claimAssigneeGitHubLogin: string | null;
  claimAssigneeGitHubUserId: number | null;
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
 * else is kept — so each variant has to carry what a moderator needs from it.
 * The unauthorized one is an accusation, so it answers "which label, and who
 * applied it". The unattributable one has no account to accuse: an
 * opening-catalog application WAS made, but no account was ever compared
 * against the sponsor, and what the sentence reports is that the repository's
 * own sponsor record is what needs fixing. An absence has nothing to report.
 * The three are a union on `code` rather than one shape with nullable columns:
 * a consumer that switches on the code gets the fields typed where they exist
 * and is not made to handle a case that cannot happen.
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
      code: "OPENING_LABEL_UNATTRIBUTABLE";
      /** The same refusal in the words a moderator reads. */
      reason: string;
    }
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
 * final commit, apply the settled label, post the rationale comment, merge —
 * the comment gets written before the label, or both are remembered just after
 * the merge.
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
    // An opening is pinned to the catalog governing when the issue was created:
    // the materialized opening rating is immutable, so re-resolving it under a
    // catalog the sponsor later changed would either fail the run or look like
    // a mutation (issue 180). Settled evidence resolves by its own window
    // below. With no version history the current catalog governs every
    // creation instant, which is the one-catalog behavior.
    const openingScheme = difficultySchemeInForceAt(
      snapshot.repository.difficultySchemeVersions ?? [],
      Date.parse(issue.createdAt),
      snapshot.repository.difficultyScheme,
    );
    const resolution = resolveOpening(issue, openingScheme, sponsor);
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
    // A closure is priced by the catalog in force when its evidence window
    // closed — merge + the same grace every rejection sentence quotes — so a
    // sponsor appending a later catalog never re-prices an earlier settled
    // figure (issue 180). The selector never reads the clock: the instant is
    // GitHub's merge time, stable across every re-derivation of the same
    // evidence. The opening above is likewise pinned to its issue's creation.
    const settledResolution = pullRequest === null
      ? null
      : resolveSettledDifficulty(
          issue,
          pullRequest,
          difficultySchemeInForceAt(
            snapshot.repository.difficultySchemeVersions ?? [],
            Date.parse(pullRequest.mergedAt) + EVIDENCE_ORDERING_GRACE_MS,
            snapshot.repository.difficultyScheme,
          ),
          sponsor,
        );
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
      updatedAt: issue.updatedAt,
      ownerGitHubLogin: opening.ownerGitHubLogin,
      openingLabel: opening.openingLabel,
      openingComparisonPoints: opening.openingComparisonPoints,
      openingReservePoints: opening.openingReservePoints,
      openingSourceEventId: opening.openingSourceEventId,
      openingSourceActorLogin: opening.openingSourceActorLogin,
      openingSourceAt: opening.openingSourceAt,
      claimAssigneeGitHubLogin: issue.claimAssigneeGitHubLogin ?? null,
      claimAssigneeGitHubUserId: issue.claimAssigneeGitHubUserId ?? null,
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
      } else if (issue.stateReason !== "NOT_PLANNED" && evidenceWindowReachable(evidenceWindowClosedAt, registeredAtTime)) {
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
 * accused — but the label was still applied, so the refusal is
 * `OPENING_LABEL_UNATTRIBUTABLE` rather than the absence one: its sentence
 * names the repository's own sponsor record as the thing to fix, the way the
 * settled window's missing-login reason does. `resolveSettledDifficulty`
 * declines to emit `SETTLED_LABEL_UNAUTHORIZED` on the same guard — but only on
 * that guard: it first replays the history to the labels still STANDING at the
 * merge, while an opening is decided by the applications themselves, so a label
 * applied here and removed again is still refused by name.
 *
 * Candidates arrive already bounded by the opening window, so a label applied
 * before the issue existed or after the opening deadline never reaches here as
 * a candidate: that is a timing refusal, and it reads as missing rather than
 * being absorbed into an authority or an attribution one.
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
    // Empty candidates is the absence: no opening-catalog application landed
    // inside the window, so there is nothing to attribute — that is what
    // OPENING_LABEL_MISSING is for. Candidates present but none attributable is
    // different: the label WAS applied, every application is by an account
    // GitHub named no id for, and the sponsor's record stores no login, so no
    // account was ever compared and none can be accused. Recording that as the
    // absence would read as nothing ever priced, when the record needing repair
    // is the repository's own sponsor record.
    if (candidates.length === 0) {
      return { code: "OPENING_LABEL_MISSING" };
    }
    return {
      code: "OPENING_LABEL_UNATTRIBUTABLE",
      reason: "The repository sponsor has no login, so no opening label can be attributed to the sponsor.",
    };
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

/**
 * The LABELED and UNLABELED history events of one actual-catalog label.
 */
type ActualCatalogLabelEvent = Extract<GitHubIssueHistoryEvent, { kind: "LABELED" | "UNLABELED" }>;

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
  const eventsByLabel = new Map<string, ActualCatalogLabelEvent[]>();
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
    const events = eventsByLabel.get(event.label);
    if (events === undefined) {
      eventsByLabel.set(event.label, [event]);
    } else {
      events.push(event);
    }
  }
  // A label stands at the window close only where replaying its actual-catalog
  // events at-or-before the close from absent leaves it standing: GitHub's
  // timeline carries no sub-second sequence signal (node ids are opaque), so
  // events sharing one instant have no defensible intra-instant order, and the
  // outcome must stay independent of the arrival order GitHub returned. The
  // replay therefore groups by instant and decides each instant from the state
  // carried into it. Exactly one event at an instant decides: a LABELED
  // applies the label and becomes the standing source, an UNLABELED removes
  // it. A LABELED/UNLABELED pair at one instant is order-ambiguous in
  // isolation but its outcome is not: GitHub never records a `labeled` event
  // for a label already present, so from standing the pair can only be a
  // removal followed by the re-application (net standing, and the pair's
  // LABELED event becomes the source), and from absent an application followed
  // by the removal (net absent) — the outcome equals the prior state. Three or
  // more events at one instant, or a same-kind pair, is genuinely undecidable
  // and leaves the label not standing. The source of a standing label is the
  // LABELED event at the final instant — deterministic, never arrival order.
  const activeLabels = new Map<string, Extract<GitHubIssueHistoryEvent, { kind: "LABELED" }>>();
  for (const [label, events] of eventsByLabel) {
    // compareHistoryItems is createdAt-only with a stable sort, so arrival
    // order survives the ties: group by instant explicitly and let the
    // replay decide each instant from the state carried in.
    const byInstant = new Map<number, ActualCatalogLabelEvent[]>();
    for (const event of events) {
      const instant = Date.parse(event.createdAt);
      const group = byInstant.get(instant);
      if (group === undefined) {
        byInstant.set(instant, [event]);
      } else {
        group.push(event);
      }
    }
    const instants = [...byInstant.keys()].sort((left, right) => left - right);
    let standing: Extract<GitHubIssueHistoryEvent, { kind: "LABELED" }> | undefined;
    for (const instant of instants) {
      const atInstant = byInstant.get(instant) ?? [];
      const applied = atInstant.filter((event) => event.kind === "LABELED");
      if (atInstant.length === 1) {
        const [sole] = atInstant;
        standing = sole?.kind === "LABELED" ? sole : undefined;
      } else if (atInstant.length === 2 && applied.length === 1) {
        // One LABELED and one UNLABELED at one instant: the state carried in
        // decides (see the replay rule above).
        standing = standing !== undefined ? applied[0] : undefined;
      } else {
        standing = undefined;
      }
    }
    if (standing !== undefined) {
      activeLabels.set(label, standing);
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
      reason: `Several actual-catalog labels were standing on the issue by fifteen minutes after the merge at ${new Date(pullRequest.mergedAt).toISOString()}: ${[...activeLabels.keys()].sort().map((label) => `\`${label}\``).join(", ")}. Exactly one is required.`,
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
  // The comment's role is to show the sponsor was deliberate, not to restate
  // the label the sponsor had just applied (issue 297): the label already
  // carries the value, and a body that merely contains the label text proves
  // nothing about agreement — it rejected honest prose ("Settled at 7 points")
  // while accepting contradictory prose. What qualifies is a nonblank comment
  // by the sponsor inside the window, and nothing about its wording.
  const candidates = issue.comments
    .filter(validIssueComment)
    .sort((left, right) => compareHistoryItems(left, right) || compareRationaleSequence(left, right))
    .filter((comment) => {
      const commentTime = Date.parse(comment.createdAt);
      return (
        isRepositorySponsor({ login: comment.authorLogin, githubUserId: comment.authorGitHubUserId }, sponsor) &&
        comment.body.trim().length > 0 &&
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
        ? `Every nonblank rationale comment by ${repositorySponsorPhrase(raterLogin)} inside the window was edited after the settlement evidence window closed at ${new Date(windowCloseTime).toISOString()}.`
        : `No nonblank rationale comment by ${repositorySponsorPhrase(raterLogin)} was posted between fifteen minutes before the label at ${new Date(source.createdAt).toISOString()} and fifteen minutes after the merge at ${new Date(pullRequest.mergedAt).toISOString()}.`,
    };
  }
  // The sequence order the sort applied to same-instant candidates is only as
  // good as the ids behind it: a group sharing the selected instant is
  // decidable only where its sequence evidence covers every member but one at
  // most — at most one id without sequence evidence (not a safe integer:
  // null, an absent key, or junk) and no duplicated safe id. Otherwise no
  // evidence-backed rule can say which comment was written first, and the
  // selection is refused rather than made silently arbitrary. The rejection
  // deliberately reuses windowReach, mirroring the sibling no-rationale
  // rejection, including that pre-registration windows drop it silently.
  const tieGroup = qualifyingRationales.filter(
    (comment) => Date.parse(comment.createdAt) === Date.parse(rationale.createdAt),
  );
  const missingDatabaseIdCount = tieGroup.filter(
    (comment) => rationaleSequenceRank(comment.databaseId) === null,
  ).length;
  const duplicatedDatabaseId = findDuplicatedDatabaseId(tieGroup);
  if (missingDatabaseIdCount > 1 || duplicatedDatabaseId !== undefined) {
    return {
      kind: "rejected",
      reach: windowReach,
      reason: duplicatedDatabaseId === undefined
        ? `Several qualifying rationale comments by ${repositorySponsorPhrase(raterLogin)} share the instant ${new Date(Date.parse(rationale.createdAt)).toISOString()} without GitHub database ids, so no evidence-backed rule can order them.`
        : `Several qualifying rationale comments by ${repositorySponsorPhrase(raterLogin)} share the instant ${new Date(Date.parse(rationale.createdAt)).toISOString()}, and more than one carries the GitHub database id ${duplicatedDatabaseId}, so the ids cannot order them.`,
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

/**
 * Breaks the same-instant ties `compareHistoryItems` leaves among RATIONALE
 * CANDIDATES ONLY, by GitHub's per-comment creation sequence: the numeric
 * `IssueComment.databaseId` is assigned in creation order, so among comments
 * sharing one instant the smallest id is the first-written. For content
 * imported through GitHub's migration APIs, databaseId order is import order
 * — arbitrary there, but stable, and accepted. This is the rule family issue
 * 260 settles on — an explicit deterministic rule whose basis is evidence, or
 * an undecidable refusal rather than a silently arbitrary pick
 * (`resolveSettledDifficulty` checks the selected instant's group after
 * selection and rejects a tie its ids cannot order).
 *
 * Node ids (`IssueComment.id`, `IC_…`) never key a selection: they are opaque
 * strings encoding no creation order, unlike the numeric databaseId, so
 * reordering by them would only launder arrival order again.
 *
 * An id that is not a safe integer — null, undefined from an unvalidated
 * passthrough, or any other junk — is NO sequence evidence and sorts after
 * every safe id; it cannot claim to be the earliest. The order between two
 * such ids is deliberately unspecified (the sort is stable, so it is arrival
 * order): callers must not rely on it, and a selected tie carrying two or
 * more of them is rejected as undecidable.
 *
 * `compareHistoryItems` itself is unchanged and stays the primary key, so
 * distinct-instant selection and every other consumer of it are untouched.
 *
 * Already-persisted rationale ids from a prior arrival-order run are safe to
 * move: `settled_rationale_comment_id` is deliberately overwritten by the
 * fold's ordinary issue upsert on every run (unlike the opening evidence,
 * which is immutable), so a tie row swaps its citation once on the next fold
 * and then stays stable — label, points, actor, instant and credits do not
 * change.
 */
function compareRationaleSequence(
  left: Pick<GitHubIssueComment, "createdAt" | "databaseId">,
  right: Pick<GitHubIssueComment, "createdAt" | "databaseId">,
): number {
  const leftRank = rationaleSequenceRank(left.databaseId);
  const rightRank = rationaleSequenceRank(right.databaseId);
  if (leftRank === null || rightRank === null) {
    return (leftRank === null ? 1 : 0) - (rightRank === null ? 1 : 0);
  }
  return leftRank - rightRank;
}

/**
 * The numeric sequence position of a comment id, or null when it carries
 * none. Safe-integer rather than merely finite: ids at or beyond 2^53 would
 * collapse under subtraction and silently restore arrival order, so they
 * count as no evidence.
 */
function rationaleSequenceRank(databaseId: GitHubIssueComment["databaseId"]): number | null {
  return typeof databaseId === "number" && Number.isSafeInteger(databaseId) ? databaseId : null;
}

/**
 * The smallest databaseId two or more comments share, or undefined when no
 * safe id repeats. Ids that carry no sequence evidence cannot be duplicated
 * evidence; the scanned ids are derived in sorted order so the caller's
 * sentence does not depend on the group's order.
 */
function findDuplicatedDatabaseId(comments: GitHubIssueComment[]): number | undefined {
  const counts = new Map<number, number>();
  for (const comment of comments) {
    const rank = rationaleSequenceRank(comment.databaseId);
    if (rank === null) {
      continue;
    }
    counts.set(rank, (counts.get(rank) ?? 0) + 1);
  }
  const duplicated = [...counts.entries()]
    .filter(([, count]) => count > 1)
    .map(([id]) => id)
    .sort((left, right) => left - right);
  return duplicated[0];
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
