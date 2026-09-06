import { describe, expect, it } from "vitest";
import { foldRepository, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";

const registeredAt = "2026-09-01T00:00:00.000Z";
const beforeRegistration = "2026-08-25T12:00:00.000Z";
const afterRegistration = "2026-09-03T12:00:00.000Z";

describe("closures whose evidence window shut before the repository was registered", () => {
  it("drops a rejected settlement whose closing pull request merged before registration", () => {
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, beforeRegistration);

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([]);
  });

  it("records a rejected settlement whose closing pull request merged at the registration instant", () => {
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, registeredAt);

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([
      expect.objectContaining({
        githubIssueId: 101,
        kind: "SETTLEMENT_EVIDENCE_REJECTED",
        githubPullRequestId: 201,
      }),
    ]);
  });

  it("records a rejected settlement whose closing pull request merged after registration", () => {
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, afterRegistration);

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([
      expect.objectContaining({
        githubIssueId: 101,
        kind: "SETTLEMENT_EVIDENCE_REJECTED",
        githubPullRequestId: 201,
      }),
    ]);
  });

  it("drops a closure with no closing pull request whose issue closed before registration", () => {
    const snapshot = rejectedEvidenceFixture();
    snapshot.issues[0]!.closingPullRequests = [];
    snapshot.issues[0]!.closedAt = beforeRegistration;

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([]);
  });

  it("records a closure with no closing pull request whose issue closed after registration", () => {
    const snapshot = rejectedEvidenceFixture();
    snapshot.issues[0]!.closingPullRequests = [];
    snapshot.issues[0]!.closedAt = afterRegistration;

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "NO_CLOSING_PULL_REQUEST",
      githubPullRequestId: null,
      reason: "No merged GitHub GraphQL closing pull request was found.",
    }]);
  });

  it("records a closure with no closing pull request whose closing instant GitHub never reported", () => {
    const snapshot = rejectedEvidenceFixture();
    snapshot.issues[0]!.closingPullRequests = [];
    snapshot.issues[0]!.closedAt = null;

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "NO_CLOSING_PULL_REQUEST",
      githubPullRequestId: null,
      reason: "No merged GitHub GraphQL closing pull request was found.",
    }]);
  });

  it("drops a cross-repository closure whose foreign pull request merged before registration", () => {
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, beforeRegistration);
    snapshot.issues[0]!.closingPullRequests[0]!.repositoryGitHubId = 5002;
    snapshot.issues[0]!.closingPullRequests[0]!.repositoryNameWithOwner = "other/fork";

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([]);
  });

  it("records a cross-repository closure whose foreign pull request merged after registration", () => {
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, afterRegistration);
    snapshot.issues[0]!.closingPullRequests[0]!.repositoryGitHubId = 5002;
    snapshot.issues[0]!.closingPullRequests[0]!.repositoryNameWithOwner = "other/fork";

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([
      expect.objectContaining({
        githubIssueId: 101,
        kind: "CROSS_REPOSITORY_CLOSING_PULL_REQUEST",
        githubPullRequestId: null,
      }),
    ]);
  });

  it("still calibrates self work whose closure the registration boundary dropped", () => {
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, beforeRegistration);
    snapshot.issues[0]!.closingPullRequests[0]!.authorLogin = "sponsor";
    snapshot.issues[0]!.closingPullRequests[0]!.authorGitHubUserId = 1001;

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([]);
    expect(result.settlements).toEqual([]);
    expect(result.selfWorkCalibrations).toEqual([{
      githubIssueId: 101,
      githubPullRequestId: 201,
      userId: "sponsor",
      openingComparisonPoints: 5,
      actualLabel: null,
      actualPoints: null,
      actualLabelEventId: null,
      actualLabelActorLogin: null,
      actualLabelAppliedAt: null,
      rationaleCommentId: null,
      rationaleActorLogin: null,
      rationaleCommentedAt: null,
      mergeCommitOid: "0123456789abcdef0123456789abcdef01234567",
      mergedAt: beforeRegistration,
    }]);
  });

  it.each([
    ["self work", "sponsor", 1001],
    ["a contributor's work", "contributor", 2001],
  ])("folds %s identically whether or not the closure was dropped", (_case, authorLogin, authorGitHubUserId) => {
    const dropped = rejectedEvidenceFixture();
    mergeAt(dropped, beforeRegistration);
    dropped.issues[0]!.closingPullRequests[0]!.authorLogin = authorLogin;
    dropped.issues[0]!.closingPullRequests[0]!.authorGitHubUserId = authorGitHubUserId;
    // The same repository, registered early enough that the window was still
    // open: everything but the closure must fold to the very same rows.
    const recorded = { ...dropped, repository: { ...dropped.repository, registeredAt: "2026-01-01T00:00:00.000Z" } };

    const { unwritableClosures: droppedClosures, ...droppedRest } = foldRepository(dropped);
    const { unwritableClosures: recordedClosures, ...recordedRest } = foldRepository(recorded);

    expect(droppedRest).toEqual(recordedRest);
    expect(droppedClosures).toEqual([]);
    expect(recordedClosures).toHaveLength(1);
  });
});

function mergeAt(snapshot: RepositoryFoldSnapshot, mergedAt: string): void {
  const issue = snapshot.issues[0]!;
  const pullRequest = issue.closingPullRequests[0]!;
  pullRequest.mergedAt = mergedAt;
  pullRequest.finalCommitAt = new Date(Date.parse(mergedAt) - 2 * 60 * 60 * 1000).toISOString();
  issue.closedAt = mergedAt;
}

/**
 * A closed issue priced at opening but never settled: no actual-catalog label
 * ever stood on it, so the settlement evidence is rejected and the fold has a
 * closure to consider recording.
 */
function rejectedEvidenceFixture(): RepositoryFoldSnapshot {
  return {
    repository: {
      id: "repository",
      githubRepositoryId: 5001,
      ownerName: "octo/example",
      active: true,
      registeredAt,
      sponsor: { id: "sponsor", githubUserId: 1001, githubLogin: "sponsor", enforcementState: "ACTIVE", moderationEvents: [] },
      difficultyScheme: {
        openingName: "Size",
        actualName: "Delivered",
        openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
        actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
      },
    },
    users: [
      { id: "sponsor", githubUserId: 1001, githubLogin: "sponsor", enforcementState: "ACTIVE", moderationEvents: [] },
      { id: "contributor", githubUserId: 2001, githubLogin: "contributor", enforcementState: "ACTIVE", moderationEvents: [] },
    ],
    issues: [
      {
        id: 101,
        number: 1,
        title: "Issue",
        body: "Issue body",
        url: "https://github.com/octo/example/issues/1",
        state: "CLOSED",
        createdAt: "2026-08-20T09:00:00.000Z",
        closedAt: beforeRegistration,
        authorLogin: "sponsor",
        labels: ["M"],
        history: [
          {
            kind: "LABELED",
            id: "opening-1",
            actorLogin: "sponsor",
            label: "M",
            createdAt: "2026-08-20T10:00:00.000Z",
          },
        ],
        comments: [],
        closingPullRequests: [
          {
            id: 201,
            number: 11,
            title: "Pull request",
            body: "Pull request body",
            url: "https://github.com/octo/example/pull/11",
            state: "MERGED",
            mergedAt: beforeRegistration,
            mergeCommitOid: "0123456789abcdef0123456789abcdef01234567",
            finalCommitAt: "2026-08-25T10:00:00.000Z",
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
