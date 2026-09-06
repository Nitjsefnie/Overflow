import { describe, expect, it } from "vitest";
import {
  foldRepository,
  type FoldResult,
  type FoldUser,
  type RepositoryFoldSnapshot,
} from "@/lib/fold/repository-fold";

/**
 * `users.github_login` is refreshed only when that user next signs in, so it
 * goes stale the moment the sponsor renames on GitHub — while GitHub reports
 * the renamed account's CURRENT login on every issue, event and comment it
 * serves. Deciding who the rater is by login therefore stops recognising the
 * sponsor at the rename, and hands the sponsor's authority to whoever takes the
 * freed login next. The numeric account id is what a rename cannot move.
 */
const SPONSOR_GITHUB_USER_ID = 1001;
/** What `users.github_login` still holds after the sponsor renamed. */
const STORED_SPONSOR_LOGIN = "sponsor-old";
/** What GitHub now reports for the same account. */
const RENAMED_SPONSOR_LOGIN = "sponsor-new";
/** A different GitHub account that has taken the sponsor's freed login. */
const IMPOSTOR_GITHUB_USER_ID = 7777;

type FixtureActor = { login: string | null; githubUserId: number | null };

const renamedSponsor: FixtureActor = {
  login: RENAMED_SPONSOR_LOGIN,
  githubUserId: SPONSOR_GITHUB_USER_ID,
};
const sponsorBeforeTheRename: FixtureActor = {
  login: STORED_SPONSOR_LOGIN,
  githubUserId: SPONSOR_GITHUB_USER_ID,
};
const impostorHoldingTheFreedLogin: FixtureActor = {
  login: STORED_SPONSOR_LOGIN,
  githubUserId: IMPOSTOR_GITHUB_USER_ID,
};

describe("foldRepository across a sponsor's GitHub account rename", () => {
  it("resolves the same opening after the sponsor renamed, with the stored login untouched", () => {
    const beforeTheRename = foldRepository(fixture({
      author: sponsorBeforeTheRename,
      opening: sponsorBeforeTheRename,
      settledLabel: sponsorBeforeTheRename,
      rationale: sponsorBeforeTheRename,
    }));
    const afterTheRename = foldRepository(fixture());

    expect(openingIdentity(beforeTheRename)).toEqual([{
      githubIssueId: 101,
      openingLabel: "M",
      openingComparisonPoints: 5,
      openingReservePoints: 5,
      openingSourceEventId: "opening-1",
      openingSourceAt: "2026-08-30T10:00:00.000Z",
    }]);
    expect(openingIdentity(afterTheRename)).toEqual(openingIdentity(beforeTheRename));
    expect(afterTheRename.policyViolations).toEqual([]);
    // Display text is read from the payload, so it follows the rename.
    expect(afterTheRename.issues[0]).toMatchObject({
      ownerGitHubLogin: RENAMED_SPONSOR_LOGIN,
      openingSourceActorLogin: RENAMED_SPONSOR_LOGIN,
    });
  });

  it("refuses the opening label of a different account that took the sponsor's freed login", () => {
    const result = foldRepository(fixture({ opening: impostorHoldingTheFreedLogin }));

    expect(result.issues).toEqual([]);
    expect(result.policyViolations).toEqual([
      { code: "OPENING_LABEL_MISSING", githubIssueId: 101 },
    ]);
    expect(result.settlements).toEqual([]);
  });

  it("accepts the settled label the sponsor applied under the new login", () => {
    const result = foldRepository(fixture());

    expect(result.unwritableClosures).toEqual([]);
    expect(result.policyViolations).toEqual([]);
    expect(result.settlements).toEqual([expect.objectContaining({
      githubIssueId: 101,
      githubPullRequestId: 201,
      status: "SETTLED",
      settledLabel: "delivered/6",
      settledPoints: 6,
      settledLabelEventId: "actual-1",
      settledLabelActorLogin: RENAMED_SPONSOR_LOGIN,
      credits: 6,
    })]);
  });

  it("refuses the settled label of a different account that took the sponsor's freed login", () => {
    const result = foldRepository(fixture({ settledLabel: impostorHoldingTheFreedLogin }));

    expect(result.policyViolations).toEqual([
      { code: "SETTLED_LABEL_UNAUTHORIZED", githubIssueId: 101 },
    ]);
    expect(result.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "SETTLEMENT_EVIDENCE_REJECTED",
      githubPullRequestId: 201,
      // The impostor holds the login `users.github_login` still stores, so a
      // message naming that login on both sides of the refusal names no
      // discriminator at all. What was refused is the ACCOUNT.
      reason: "The settled label `delivered/6` was applied by a different GitHub account using the login "
        + "`sponsor-old`, not by the repository sponsor.",
    }]);
    expect(result.settlements).toEqual([
      expect.objectContaining({ settledLabel: null, settledPoints: null, status: "UNSETTLED" }),
    ]);
  });

  it("accepts the rationale comment the sponsor wrote under the new login", () => {
    const result = foldRepository(fixture());

    expect(result.settlements).toEqual([expect.objectContaining({
      settledRationaleCommentId: "comment-1",
      settledRationaleActorLogin: RENAMED_SPONSOR_LOGIN,
      settledRationaleCommentedAt: "2026-09-01T11:30:00.000Z",
    })]);
  });

  it("refuses the rationale comment of a different account that took the sponsor's freed login", () => {
    const result = foldRepository(fixture({ rationale: impostorHoldingTheFreedLogin }));

    expect(result.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "SETTLEMENT_EVIDENCE_REJECTED",
      githubPullRequestId: 201,
      // Same discriminator: a comment carrying the stored login is not a
      // comment by the sponsor, and the sentence has to say which it means.
      reason: "No rationale comment by the repository sponsor's account (login `sponsor-old`) naming "
        + "`delivered/6` was posted between fifteen minutes before the label at 2026-09-01T11:00:00.000Z "
        + "and fifteen minutes after the merge at 2026-09-01T12:00:00.000Z.",
    }]);
    expect(result.settlements).toEqual([
      expect.objectContaining({ settledLabel: null, settledPoints: null, status: "UNSETTLED" }),
    ]);
  });

  it("still identifies the sponsor by login when GitHub reports no account id", () => {
    // A Bot, a Mannequin, an Organization or a deleted account carries no
    // numeric id, and the stored login is then all there is to go on.
    const withoutIds: FixtureActor = { login: STORED_SPONSOR_LOGIN, githubUserId: null };
    const result = foldRepository(fixture({
      author: withoutIds,
      opening: withoutIds,
      settledLabel: withoutIds,
      rationale: withoutIds,
    }));

    expect(result.unwritableClosures).toEqual([]);
    expect(result.policyViolations).toEqual([]);
    expect(result.settlements).toEqual([expect.objectContaining({
      githubIssueId: 101,
      status: "SETTLED",
      settledLabel: "delivered/6",
      settledPoints: 6,
      credits: 6,
    })]);
  });

  it("identifies the sponsor by account id when the stored login is blank", () => {
    // `db/migrations/001_initial.sql` rejects a blank `github_login`, but its
    // one-argument `trim()` strips spaces only while the fold's `.trim()`
    // strips all whitespace, so a stored tab is a login the database accepts
    // and the fold reads as blank (issue 141). The account id is untouched by
    // that, and a blank stored login must not veto an identification the id
    // already made — vetoing it produces the issue-129 loss itself.
    const result = foldRepository(fixture({ storedSponsorLogin: "\t" }));

    expect(result.policyViolations).toEqual([]);
    expect(result.unwritableClosures).toEqual([]);
    expect(openingIdentity(result)).toEqual([{
      githubIssueId: 101,
      openingLabel: "M",
      openingComparisonPoints: 5,
      openingReservePoints: 5,
      openingSourceEventId: "opening-1",
      openingSourceAt: "2026-08-30T10:00:00.000Z",
    }]);
    expect(result.settlements).toEqual([expect.objectContaining({
      githubIssueId: 101,
      status: "SETTLED",
      settledLabel: "delivered/6",
      settledPoints: 6,
      settledLabelActorLogin: RENAMED_SPONSOR_LOGIN,
      credits: 6,
    })]);
  });

  it("refuses an idless actor when the stored sponsor login is blank, and says why", () => {
    // Nothing but the login is left to compare with, and there is no login to
    // compare against: the refusal is about the sponsor's own record, so it
    // keeps naming that record rather than the actor.
    const result = foldRepository(fixture({
      storedSponsorLogin: "\t",
      settledLabel: { login: STORED_SPONSOR_LOGIN, githubUserId: null },
    }));

    expect(result.policyViolations).toEqual([]);
    expect(result.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "SETTLEMENT_EVIDENCE_REJECTED",
      githubPullRequestId: 201,
      reason: "The repository sponsor has no login, so no settled label can be attributed to the sponsor.",
    }]);
    expect(result.settlements).toEqual([
      expect.objectContaining({ settledLabel: null, settledPoints: null, status: "UNSETTLED" }),
    ]);
  });

  it("refuses an idless actor whose login is not the sponsor's stored login", () => {
    // Without an id there is nothing but the login, so the renamed sponsor's
    // CURRENT login is not evidence: the stored login is the only claim.
    const result = foldRepository(fixture({
      opening: { login: RENAMED_SPONSOR_LOGIN, githubUserId: null },
    }));

    expect(result.issues).toEqual([]);
    expect(result.policyViolations).toEqual([
      { code: "OPENING_LABEL_MISSING", githubIssueId: 101 },
    ]);
  });
});

function openingIdentity(fold: FoldResult) {
  return fold.issues.map((issue) => ({
    githubIssueId: issue.githubIssueId,
    openingLabel: issue.openingLabel,
    openingComparisonPoints: issue.openingComparisonPoints,
    openingReservePoints: issue.openingReservePoints,
    openingSourceEventId: issue.openingSourceEventId,
    openingSourceAt: issue.openingSourceAt,
  }));
}

/**
 * One closed issue the sponsor opened, priced and settled, closed by a merged
 * pull request from a contributor. Each actor GitHub reports is separately
 * substitutable, so a single site can be moved to an impostor while everything
 * else stays the sponsor.
 */
function fixture(actors: {
  author?: FixtureActor;
  opening?: FixtureActor;
  settledLabel?: FixtureActor;
  rationale?: FixtureActor;
  /** What `users.github_login` holds for the sponsor, when it is not the stored login. */
  storedSponsorLogin?: string;
} = {}): RepositoryFoldSnapshot {
  const author = actors.author ?? renamedSponsor;
  const opening = actors.opening ?? renamedSponsor;
  const settledLabel = actors.settledLabel ?? renamedSponsor;
  const rationale = actors.rationale ?? renamedSponsor;
  // One record, referenced by both `repository.sponsor` and `users`: editing a
  // second copy and not this one would silently decouple the sponsor the fold
  // rates evidence against from the user the ledger pays.
  const sponsor: FoldUser = {
    id: "sponsor",
    githubUserId: SPONSOR_GITHUB_USER_ID,
    githubLogin: actors.storedSponsorLogin ?? STORED_SPONSOR_LOGIN,
    enforcementState: "ACTIVE",
    moderationEvents: [],
  };

  return {
    repository: {
      id: "repository",
      githubRepositoryId: 5001,
      ownerName: "octo/example",
      active: true,
      registeredAt: "2026-01-01T00:00:00.000Z",
      sponsor,
      difficultyScheme: difficultyScheme(),
    },
    users: [
      sponsor,
      {
        id: "contributor",
        githubUserId: 2001,
        githubLogin: "contributor",
        enforcementState: "ACTIVE",
        moderationEvents: [],
      },
    ],
    issues: [
      {
        id: 101,
        number: 1,
        title: "Issue",
        body: "Issue body",
        url: "https://github.com/octo/example/issues/1",
        state: "CLOSED",
        createdAt: "2026-08-30T09:00:00.000Z",
        closedAt: "2026-09-01T12:05:00.000Z",
        authorLogin: author.login,
        authorGitHubUserId: author.githubUserId,
        labels: ["M", "delivered/6"],
        history: [
          {
            kind: "LABELED",
            id: "opening-1",
            actorLogin: opening.login,
            actorGitHubUserId: opening.githubUserId,
            label: "M",
            createdAt: "2026-08-30T10:00:00.000Z",
          },
          {
            kind: "LABELED",
            id: "actual-1",
            actorLogin: settledLabel.login,
            actorGitHubUserId: settledLabel.githubUserId,
            label: "delivered/6",
            createdAt: "2026-09-01T11:00:00.000Z",
          },
        ],
        comments: [
          {
            id: "comment-1",
            databaseId: 401,
            authorLogin: rationale.login,
            authorGitHubUserId: rationale.githubUserId,
            body: "Settled as delivered/6 after reviewing the final diff.",
            createdAt: "2026-09-01T11:30:00.000Z",
            lastEditedAt: null,
          },
        ],
        closingPullRequests: [
          {
            id: 201,
            number: 11,
            title: "Pull request",
            body: "Pull request body",
            url: "https://github.com/octo/example/pull/11",
            state: "MERGED",
            mergedAt: "2026-09-01T12:00:00.000Z",
            mergeCommitOid: "0123456789abcdef0123456789abcdef01234567",
            finalCommitAt: "2026-09-01T10:00:00.000Z",
            authorLogin: "contributor",
            authorGitHubUserId: 2001,
            repositoryGitHubId: 5001,
            repositoryNameWithOwner: "octo/example",
            reviews: [],
            rawDiff: "diff",
          },
        ],
      },
    ],
  };
}

function difficultyScheme() {
  return {
    openingName: "Size",
    actualName: "Delivered",
    openingLabels: [
      { label: "S", comparisonPoints: 2, reservePoints: 2 },
      { label: "M", comparisonPoints: 5, reservePoints: 5 },
      { label: "L", comparisonPoints: 8, reservePoints: 8 },
    ],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}
