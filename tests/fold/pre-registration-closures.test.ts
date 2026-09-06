import { describe, expect, it } from "vitest";
import { foldRepository, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const registeredAt = "2026-09-01T00:00:00.000Z";

describe("closures whose evidence window shut before the repository was registered", () => {
  it("records a rejected settlement whose refused settled label was applied after registration", () => {
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, shift(registeredAt, -12 * HOUR));
    // The production shape: the merge is months stale, but the label the fold
    // refused landed thirty-seven minutes after Overflow began watching, which
    // is exactly the settlement-override case a moderator can still act on.
    applyRefusedSettledLabelAt(snapshot, shift(registeredAt, 37 * MINUTE));

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([
      expect.objectContaining({ githubIssueId: 101, kind: "SETTLEMENT_EVIDENCE_REJECTED", githubPullRequestId: 201 }),
    ]);
  });

  it("drops a rejected settlement whose refused settled label was also applied before registration", () => {
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, shift(registeredAt, -12 * HOUR));
    applyRefusedSettledLabelAt(snapshot, shift(registeredAt, -4 * HOUR));

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([]);
  });

  it("records a rejected settlement whose window was still open five minutes into registration", () => {
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, shift(registeredAt, -5 * MINUTE));

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([
      expect.objectContaining({ githubIssueId: 101, kind: "SETTLEMENT_EVIDENCE_REJECTED" }),
    ]);
  });

  it("drops a rejected settlement whose window shut five minutes before registration", () => {
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, shift(registeredAt, -20 * MINUTE));

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([]);
  });

  it("records a rejected settlement whose window shut exactly at registration", () => {
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, shift(registeredAt, -15 * MINUTE));

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([
      expect.objectContaining({ githubIssueId: 101, kind: "SETTLEMENT_EVIDENCE_REJECTED" }),
    ]);
  });

  it("records a rejected settlement whose closing pull request merged after registration", () => {
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, shift(registeredAt, 2 * HOUR));

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([
      expect.objectContaining({ githubIssueId: 101, kind: "SETTLEMENT_EVIDENCE_REJECTED" }),
    ]);
  });

  it("measures a rejected settlement by its merge, not by a later close of the issue", () => {
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, shift(registeredAt, -12 * HOUR));
    // A pull request in the registered repository closed this issue, so its
    // evidence window shut at that merge. The issue row was closed out by hand
    // hours later, and reading that instead would resurrect a dead closure.
    snapshot.issues[0]!.closedAt = shift(registeredAt, 2 * HOUR);

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([]);
  });

  it("prices no issue at all when the sponsor has no login, so no settlement rejection is reachable", () => {
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, shift(registeredAt, -12 * HOUR));
    snapshot.repository.sponsor.githubLogin = "   ";

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([{ code: "OPENING_LABEL_MISSING", githubIssueId: 101 }]);
    expect(result.unwritableClosures).toEqual([]);
    expect(result.issues).toEqual([]);
  });
});

describe("closures with no closing pull request, against the registration instant", () => {
  it("drops one whose issue closed before registration", () => {
    const snapshot = handClosedFixture(shift(registeredAt, -12 * HOUR));

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([]);
  });

  it("records one whose issue closed after registration", () => {
    const snapshot = handClosedFixture(shift(registeredAt, 2 * HOUR));

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([noClosingPullRequestClosure]);
  });

  it("records one whose issue closed exactly at registration", () => {
    const snapshot = handClosedFixture(registeredAt);

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([noClosingPullRequestClosure]);
  });

  it("records one whose closing instant GitHub never reported", () => {
    const snapshot = handClosedFixture(null);

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([noClosingPullRequestClosure]);
  });

  it("records one whose closing instant cannot be read", () => {
    const snapshot = handClosedFixture("closed last Tuesday");

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([noClosingPullRequestClosure]);
  });

  it("compares closing instants as moments rather than as text", () => {
    // 2026-08-31T20:00Z, twelve hours before registration — but every
    // character up to the offset sorts after the normalized registration
    // instant, so a textual comparison would record this one.
    const snapshot = handClosedFixture("2026-09-01T05:00:00+09:00");

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([]);
  });

  it("records one reopened and closed again after registration, since closedAt reports the latest close", () => {
    // GraphQL reports a single closedAt, and it is the most recent close. The
    // window a moderator would be asked to fill is the one that is still
    // current, so the earlier close this issue also had does not decide it.
    const snapshot = handClosedFixture(shift(registeredAt, 2 * HOUR));
    snapshot.issues[0]!.createdAt = "2026-06-01T09:00:00.000Z";

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([noClosingPullRequestClosure]);
  });
});

describe("closures the registration instant does not gate", () => {
  it.each([
    ["long before registration", -12 * HOUR],
    ["after registration", 2 * HOUR],
  ])("records a cross-repository closure whose foreign pull request merged %s", (_case, offset) => {
    // Registering the other repository, or acting on the identity alert this
    // reason carries, is not bound to any evidence window, so the merge
    // instant has no say over whether a moderator can still act.
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, shift(registeredAt, offset));
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

  it.each([
    ["cannot be read", "registered some time last spring"],
    ["is absent", ""],
  ])("records every closure when the repository's registration instant %s", (_case, unreadable) => {
    // Unreachable through the store, which throws on an unreadable
    // created_at rather than folding one, so it is pinned here directly.
    const snapshot = rejectedEvidenceFixture();
    mergeAt(snapshot, shift(registeredAt, -12 * HOUR));
    snapshot.repository.registeredAt = unreadable;

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([
      expect.objectContaining({ githubIssueId: 101, kind: "SETTLEMENT_EVIDENCE_REJECTED" }),
    ]);
  });
});

describe("what the registration instant may not change", () => {
  it("still calibrates self work whose closure the registration boundary dropped", () => {
    const snapshot = rejectedEvidenceFixture();
    const mergedAt = shift(registeredAt, -12 * HOUR);
    mergeAt(snapshot, mergedAt);
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
      mergedAt,
    }]);
  });

  it.each([
    ["a rejected settlement the boundary drops", () => staleRejection(), 0],
    ["a rejected settlement its later label keeps", () => {
      const snapshot = staleRejection();
      applyRefusedSettledLabelAt(snapshot, shift(registeredAt, 37 * MINUTE));
      return snapshot;
    }, 1],
    ["a closure with no closing pull request", () => handClosedFixture(shift(registeredAt, -12 * HOUR)), 0],
    ["self work", () => {
      const snapshot = staleRejection();
      snapshot.issues[0]!.closingPullRequests[0]!.authorLogin = "sponsor";
      snapshot.issues[0]!.closingPullRequests[0]!.authorGitHubUserId = 1001;
      return snapshot;
    }, 0],
  ])("folds %s identically however the repository was registered", (_case, build, recordedAtRegistration) => {
    const asRegistered = build();
    // The same repository, registered early enough that every window was open.
    const asAlwaysWatched = {
      ...build(),
      repository: { ...build().repository, registeredAt: "2026-01-01T00:00:00.000Z" },
    };

    const { unwritableClosures: gated, ...gatedRest } = foldRepository(asRegistered);
    const { unwritableClosures: ungated, ...ungatedRest } = foldRepository(asAlwaysWatched);

    expect(gatedRest).toEqual(ungatedRest);
    expect(gated).toHaveLength(recordedAtRegistration);
    expect(ungated).toHaveLength(1);
  });
});

const noClosingPullRequestClosure = {
  githubIssueId: 101,
  kind: "NO_CLOSING_PULL_REQUEST",
  githubPullRequestId: null,
  reason: "No merged GitHub GraphQL closing pull request was found.",
};

function shift(instant: string, milliseconds: number): string {
  return new Date(Date.parse(instant) + milliseconds).toISOString();
}

function staleRejection(): RepositoryFoldSnapshot {
  const snapshot = rejectedEvidenceFixture();
  mergeAt(snapshot, shift(registeredAt, -12 * HOUR));
  return snapshot;
}

/**
 * A closed issue with no closing pull request at all, closed at the given
 * instant — the only case whose evidence window is the issue's own close.
 */
function handClosedFixture(closedAt: string | null): RepositoryFoldSnapshot {
  const snapshot = rejectedEvidenceFixture();
  snapshot.issues[0]!.closingPullRequests = [];
  snapshot.issues[0]!.closedAt = closedAt;
  return snapshot;
}

/**
 * Moves the merge that closed the issue. The issue's own close moves with it
 * but never onto it: the two are different instants in GitHub, and a rule that
 * reads the wrong one must not pass by having the fixture agree with itself.
 */
function mergeAt(snapshot: RepositoryFoldSnapshot, mergedAt: string): void {
  const issue = snapshot.issues[0]!;
  const pullRequest = issue.closingPullRequests[0]!;
  pullRequest.mergedAt = mergedAt;
  pullRequest.finalCommitAt = shift(mergedAt, -2 * HOUR);
  issue.closedAt = shift(mergedAt, 3 * MINUTE);
}

/**
 * Applies the settled label the fold will refuse for landing after the
 * evidence window closed — the application `resolveSettledDifficulty` names as
 * the earliest later one.
 */
function applyRefusedSettledLabelAt(snapshot: RepositoryFoldSnapshot, createdAt: string): void {
  snapshot.issues[0]!.history.push({
    kind: "LABELED",
    id: "actual-late",
    actorLogin: "sponsor",
    label: "delivered/6",
    createdAt,
  });
}

/**
 * A closed issue priced at opening but never settled: no actual-catalog label
 * ever stood on it inside the window, so the settlement evidence is rejected
 * and the fold has a closure to consider recording.
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
        closedAt: shift(registeredAt, -12 * HOUR + 3 * MINUTE),
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
            mergedAt: shift(registeredAt, -12 * HOUR),
            mergeCommitOid: "0123456789abcdef0123456789abcdef01234567",
            finalCommitAt: shift(registeredAt, -14 * HOUR),
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
