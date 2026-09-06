import { describe, expect, it } from "vitest";
import { foldRepository, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";

describe("repository fold history authority", () => {
  it("settles only from an owner-applied issue label and matching owner rationale in the final review window", () => {
    const result = foldRepository(historySnapshot());

    expect(result.settlements).toEqual([
      expect.objectContaining({
        githubIssueId: 101,
        settledPoints: 6,
        credits: 6,
        status: "SETTLED",
      }),
    ]);
    expect(result.issues[0]).toMatchObject({
      openingLabel: "M",
      openingSourceEventId: "opening-1",
      openingSourceActorLogin: "owner",
      openingSourceAt: "2026-08-30T10:00:00.000Z",
      settledLabel: "delivered/6",
      settledPoints: 6,
      settledLabelEventId: "actual-1",
      settledLabelActorLogin: "owner",
      settledLabelAppliedAt: "2026-09-01T11:00:00.000Z",
      settledRationaleCommentId: "comment-1",
      settledRationaleActorLogin: "owner",
      settledRationaleCommentedAt: "2026-09-01T11:30:00.000Z",
    });
  });

  it("does not settle from a PR-only actual label", () => {
    const snapshot = historySnapshot();
    historyIssue(snapshot).history = historyIssue(snapshot).history.filter(
      (event: { id: string }) => event.id !== "actual-1",
    );

    const result = foldRepository(snapshot);

    expect(result.settlements).toEqual([
      expect.objectContaining({ status: "UNSETTLED", settledPoints: null, credits: 0 }),
    ]);
  });

  it("does not let a contributor price work by applying the issue label", () => {
    const snapshot = historySnapshot();
    const actualEvent = historyIssue(snapshot).history.find(
      (event: { id: string }) => event.id === "actual-1",
    ) as { actorLogin: string };
    actualEvent.actorLogin = "contributor";

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ status: "UNSETTLED", settledPoints: null, credits: 0 });
  });

  it.each([
    // The timing cases sit outside the settlement-evidence grace. Offsets inside
    // it are deliberately accepted; that boundary is covered in
    // tests/fold/repository-fold.test.ts.
    ["well before the final PR commit", "2026-09-01T09:44:00.000Z", "Owner rationale for delivered/6"],
    ["without a nonblank rationale", "2026-09-01T11:30:00.000Z", "   "],
    ["without naming the configured label", "2026-09-01T11:30:00.000Z", "Reviewed the landed change."],
    ["well after merge", "2026-09-01T12:16:00.000Z", "Owner rationale for delivered/6"],
  ])("does not settle when owner proof is %s", (_case, commentTime, commentBody) => {
    const snapshot = historySnapshot();
    const issue = historyIssue(snapshot);
    if (_case === "well before the final PR commit") {
      const event = issue.history.find((item: { id: string }) => item.id === "actual-1") as { createdAt: string };
      event.createdAt = commentTime;
    } else {
      issue.comments[0] = { ...issue.comments[0], createdAt: commentTime, body: commentBody };
    }

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ status: "UNSETTLED", settledPoints: null, credits: 0 });
  });

  it("rebuilds the original owner opening from immutable history and flags later opening mutations", () => {
    const snapshot = historySnapshot();
    const issue = historyIssue(snapshot);
    issue.labels = ["L", "delivered/6"];
    issue.history.push(
      {
        kind: "ASSIGNED",
        id: "assignment-1",
        actorLogin: "owner",
        assigneeLogin: "contributor",
        createdAt: "2026-08-31T09:00:00.000Z",
      },
      {
        kind: "LABELED",
        id: "opening-mutation-1",
        actorLogin: "owner",
        label: "L",
        createdAt: "2026-08-31T10:00:00.000Z",
      },
    );

    const result = foldRepository(snapshot);

    expect(result.issues[0]).toMatchObject({
      openingLabel: "M",
      openingComparisonPoints: 5,
      openingSourceEventId: "opening-1",
    });
    expect(result.policyViolations).toContainEqual({
      code: "OPENING_LABEL_MUTATED",
      githubIssueId: 101,
    });
  });

  it("uses immutable moderation history at merge instead of a later sanction", () => {
    const snapshot = historySnapshot();
    const contributor = snapshot.users.find((user) => user.id === "contributor")! as typeof snapshot.users[number] & {
      moderationEvents: unknown[];
    };
    contributor.enforcementState = "BANNED";
    contributor.moderationEvents = [
      {
        id: "moderation-after-merge",
        priorState: "ACTIVE",
        newState: "BANNED",
        occurredAt: "2026-09-02T00:00:00.000Z",
      },
    ];

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ status: "SETTLED", creditorId: "contributor", credits: 6 });
  });

  it.each(["RECALIBRATING", "BANNED"] as const)(
    "keeps work merged while the contributor was %s ineligible",
    (newState) => {
      const snapshot = historySnapshot();
      const contributor = snapshot.users.find((user) => user.id === "contributor")! as typeof snapshot.users[number] & {
        moderationEvents: unknown[];
      };
      contributor.enforcementState = newState;
      contributor.moderationEvents = [
        {
          id: "moderation-before-merge",
          priorState: "ACTIVE",
          newState,
          occurredAt: "2026-09-01T09:00:00.000Z",
        },
      ];

      const result = foldRepository(snapshot);

      expect(result.settlements).toEqual([]);
      expect(result.ledgerEntries).toEqual([]);
    },
  );

  it("rejects a merged closing PR without an exact 40-hex merge commit proof", () => {
    const snapshot = historySnapshot();
    historyPullRequest(snapshot).mergeCommitOid = "not-a-merge-oid";

    const result = foldRepository(snapshot);

    expect(result.settlements).toEqual([]);
    expect(result.selfWorkCalibrations).toEqual([]);
  });
});

function historySnapshot(): RepositoryFoldSnapshot {
  return {
    repository: {
      id: "repository",
      githubRepositoryId: 5001,
      ownerName: "octo/example",
      active: true,
      sponsor: {
        id: "sponsor",
        githubUserId: 1001,
        githubLogin: "owner",
        enforcementState: "ACTIVE",
        moderationEvents: [],
      },
      difficultyScheme: {
        openingName: "Offer band",
        actualName: "Delivered band",
        openingLabels: [
          { label: "S", comparisonPoints: 2, reservePoints: 2 },
          { label: "M", comparisonPoints: 5, reservePoints: 5 },
          { label: "L", comparisonPoints: 8, reservePoints: 8 },
        ],
        actualLabels: Array.from({ length: 10 }, (_, index) => ({
          label: `delivered/${index + 1}`,
          points: index + 1,
        })),
      },
    },
    users: [
      { id: "sponsor", githubUserId: 1001, githubLogin: "owner", enforcementState: "ACTIVE", moderationEvents: [] },
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
        createdAt: "2026-08-30T09:00:00.000Z",
        authorLogin: "owner",
        labels: ["M", "delivered/6"],
        claimAssigneeGitHubLogin: "contributor",
        history: [
          {
            kind: "LABELED",
            id: "opening-1",
            actorLogin: "owner",
            label: "M",
            createdAt: "2026-08-30T10:00:00.000Z",
          },
          {
            kind: "LABELED",
            id: "actual-1",
            actorLogin: "owner",
            label: "delivered/6",
            createdAt: "2026-09-01T11:00:00.000Z",
          },
        ],
        comments: [
          {
            id: "comment-1",
            databaseId: 501,
            authorLogin: "owner",
            body: "Owner rationale for delivered/6 after reviewing the landed diff.",
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
            labels: ["delivered/6"],
            reviews: [],
            rawDiff: "diff",
          },
        ],
      },
    ],
  } as unknown as RepositoryFoldSnapshot;
}

function historyIssue(snapshot: RepositoryFoldSnapshot) {
  return snapshot.issues[0]! as typeof snapshot.issues[number] & {
    history: Array<Record<string, unknown>>;
    comments: Array<{ id: string; authorLogin: string | null; body: string; createdAt: string }>;
  };
}

function historyPullRequest(snapshot: RepositoryFoldSnapshot) {
  return snapshot.issues[0]!.closingPullRequests[0]! as typeof snapshot.issues[number]["closingPullRequests"][number] & {
    mergeCommitOid: string | null;
    finalCommitAt: string | null;
  };
}
