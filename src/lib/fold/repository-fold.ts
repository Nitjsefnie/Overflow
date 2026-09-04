import { createHash } from "node:crypto";
import type { EnforcementState, IssueState, PullRequestState } from "@/lib/db/types";
import {
  parseActualDifficulty,
  parseOpeningDifficulty,
  type DifficultyScheme,
} from "@/lib/domain/difficulty-scheme";
import { foldLedger, type LedgerEntry } from "@/lib/domain/ledger";
import { calculateSettlement, type SettlementDecision } from "@/lib/domain/settlement";
import type { GitHubPullRequestReview } from "@/lib/github/types";

export type FoldUser = {
  id: string;
  githubLogin: string;
  enforcementState: EnforcementState;
};

export type ExistingFoldIssue = {
  githubIssueId: number;
  openingLabel: string;
  openingComparisonPoints: number;
  openingReservePoints: number;
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
  existingIssues: ExistingFoldIssue[];
  issues: RepositoryFoldIssue[];
};

export type RepositoryFoldIssue = {
  id: number;
  number: number;
  title: string;
  body: string;
  url: string;
  state: IssueState;
  labels: string[];
  claimAssigneeGitHubLogin?: string | null;
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
  authorLogin: string | null;
  labels: string[];
  reviews: GitHubPullRequestReview[];
  rawDiff: string;
};

export type FoldIssue = ExistingFoldIssue & {
  number: number;
  title: string;
  body: string;
  url: string;
  state: IssueState;
  claimAssigneeGitHubLogin: string | null;
};

export type FoldPullRequest = {
  githubPullRequestId: number;
  number: number;
  title: string;
  body: string;
  url: string;
  state: PullRequestState;
  mergedAt: string | null;
  authorId: string | null;
  authorGitHubLogin: string | null;
  actualLabel: string | null;
  actualPoints: number | null;
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
  settledPoints: number | null;
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
  actualPoints: number | null;
};

export type UnwritableClosure = {
  githubIssueId: number;
  reason: string;
};

export type FoldPolicyViolation = {
  code: "OPENING_LABEL_MISSING" | "OPENING_LABEL_AMBIGUOUS" | "OPENING_LABEL_MUTATED";
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

export function foldRepository(snapshot: RepositoryFoldSnapshot): FoldResult {
  const usersByLogin = new Map(snapshot.users.map((user) => [normalizeLogin(user.githubLogin), user]));
  const existingIssuesByGitHubId = new Map(
    snapshot.existingIssues.map((issue) => [issue.githubIssueId, issue]),
  );
  const issues: FoldIssue[] = [];
  const pullRequestsByGitHubId = new Map<number, FoldPullRequest>();
  const settlements: FoldSettlement[] = [];
  const selfWorkCalibrations: SelfWorkCalibration[] = [];
  const unwritableClosures: UnwritableClosure[] = [];
  const policyViolations: FoldPolicyViolation[] = [];
  const canCreateSettlements = snapshot.repository.active && snapshot.repository.sponsor.enforcementState !== "BANNED";

  for (const issue of snapshot.issues) {
    const opening = resolveOpening(issue, existingIssuesByGitHubId.get(issue.id), snapshot.repository.difficultyScheme);
    if (opening === null) {
      policyViolations.push({
        code: openingViolationCode(issue, snapshot.repository.difficultyScheme),
        githubIssueId: issue.id,
      });
      continue;
    }

    const existing = existingIssuesByGitHubId.get(issue.id);
    if (existing !== undefined && openingHasChanged(issue, existing, snapshot.repository.difficultyScheme)) {
      policyViolations.push({ code: "OPENING_LABEL_MUTATED", githubIssueId: issue.id });
    }

    issues.push({
      githubIssueId: issue.id,
      number: issue.number,
      title: issue.title,
      body: issue.body,
      url: issue.url,
      state: issue.state,
      openingLabel: opening.openingLabel,
      openingComparisonPoints: opening.openingComparisonPoints,
      openingReservePoints: opening.openingReservePoints,
      claimAssigneeGitHubLogin: issue.claimAssigneeGitHubLogin ?? null,
    });

    if (issue.state !== "CLOSED") {
      continue;
    }

    const pullRequest = selectClosingPullRequest(issue.closingPullRequests);
    if (pullRequest === null) {
      unwritableClosures.push({
        githubIssueId: issue.id,
        reason: "No merged GitHub GraphQL closing pull request was found.",
      });
      continue;
    }

    const author = pullRequest.authorLogin === null ? undefined : usersByLogin.get(normalizeLogin(pullRequest.authorLogin));
    const actual = parseActualDifficulty(pullRequest.labels, snapshot.repository.difficultyScheme);
    const reviewRounds = countReviewRounds(pullRequest.reviews, pullRequest.mergedAt);
    const proofSha256 = hashRawDiff(pullRequest.rawDiff);
    const foldedPullRequest = rememberPullRequest(
      pullRequestsByGitHubId,
      pullRequest,
      issue.id,
      author?.id ?? null,
      actual.kind === "ok" ? actual.label : null,
      actual.kind === "ok" ? actual.points : null,
      proofSha256,
      reviewRounds,
    );

    if (!canCreateSettlements) {
      continue;
    }

    if (author?.id === snapshot.repository.sponsor.id) {
      selfWorkCalibrations.push({
        githubIssueId: issue.id,
        githubPullRequestId: foldedPullRequest.githubPullRequestId,
        userId: author.id,
        openingComparisonPoints: opening.openingComparisonPoints,
        actualPoints: actual.kind === "ok" ? actual.points : null,
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
  existing: ExistingFoldIssue | undefined,
  scheme: DifficultyScheme,
): ExistingFoldIssue | null {
  if (existing !== undefined) {
    return existing;
  }

  const parsed = parseOpeningDifficulty(issue.labels, scheme);
  if (parsed.kind !== "ok") {
    return null;
  }

  return {
    githubIssueId: issue.id,
    openingLabel: parsed.label,
    openingComparisonPoints: parsed.comparisonPoints,
    openingReservePoints: parsed.reservePoints,
  };
}

function openingViolationCode(
  issue: RepositoryFoldIssue,
  scheme: DifficultyScheme,
): FoldPolicyViolation["code"] {
  return parseOpeningDifficulty(issue.labels, scheme).kind === "ambiguous"
    ? "OPENING_LABEL_AMBIGUOUS"
    : "OPENING_LABEL_MISSING";
}

function openingHasChanged(
  issue: RepositoryFoldIssue,
  existing: ExistingFoldIssue,
  scheme: DifficultyScheme,
): boolean {
  const current = parseOpeningDifficulty(issue.labels, scheme);
  return (
    current.kind !== "ok" ||
    current.label !== existing.openingLabel ||
    current.comparisonPoints !== existing.openingComparisonPoints ||
    current.reservePoints !== existing.openingReservePoints
  );
}

function selectClosingPullRequest(
  pullRequests: readonly RepositoryFoldPullRequest[],
): RepositoryFoldPullRequest | null {
  const merged = pullRequests.filter(
    (pullRequest) => pullRequest.state === "MERGED" && validTimestamp(pullRequest.mergedAt),
  );
  if (merged.length === 0) {
    return null;
  }

  return merged.sort((left, right) => {
    const timestampDifference = Date.parse(left.mergedAt!) - Date.parse(right.mergedAt!);
    return timestampDifference || left.number - right.number || left.id - right.id;
  })[0] ?? null;
}

function rememberPullRequest(
  pullRequestsByGitHubId: Map<number, FoldPullRequest>,
  pullRequest: RepositoryFoldPullRequest,
  issueId: number,
  authorId: string | null,
  actualLabel: string | null,
  actualPoints: number | null,
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
    authorId,
    authorGitHubLogin: pullRequest.authorLogin,
    actualLabel,
    actualPoints,
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
}): FoldSettlement {
  const settledPoints = input.pullRequest.actualPoints;
  const reviewRounds = input.pullRequest.reviewRounds.length;
  const base = {
    githubIssueId: input.issueId,
    githubPullRequestId: input.pullRequest.githubPullRequestId,
    creditorId: input.author?.id ?? null,
    creditorGitHubLogin: input.authorLogin,
    debtorId: input.debtorId,
    openingComparisonPoints: input.openingComparisonPoints,
    settledPoints,
    reviewRounds,
    proofSha256: input.pullRequest.proofSha256,
  };

  if (settledPoints === null) {
    return { ...base, credits: 0, status: "UNSETTLED" };
  }

  if (input.author === undefined) {
    if (input.authorLogin === null) {
      return { ...base, credits: 0, status: "UNSETTLED" };
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

function validTimestamp(value: string | null): value is string {
  return value !== null && Number.isFinite(Date.parse(value));
}
