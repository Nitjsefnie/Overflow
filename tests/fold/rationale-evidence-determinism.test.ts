import { describe, expect, it } from "vitest";
import { foldRepository, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";

describe("same-instant rationale evidence determinism", () => {
  const TIE_INSTANT = "2026-09-01T11:30:00.000Z";

  type TieCommentId = "comment-a" | "comment-b";

  /** Body text of each tie member; both name the settled label and differ so a body cannot stand in for an id. */
  const TIE_BODIES: Record<TieCommentId, string> = {
    "comment-a": "Settled as delivered/6 once the retry path held.",
    "comment-b": "Confirmed delivered/6 after the flake was reproduced and fixed.",
  };

  /**
   * The base evidence snapshot with its single rationale comment replaced by two
   * qualifying sponsor comments sharing one instant, in the given arrival order
   * (the order GitHub returned them, which the fold must not depend on).
   */
  function tieSnapshot(
    arrival: readonly TieCommentId[],
    databaseIds: Record<TieCommentId, number | null>,
  ): RepositoryFoldSnapshot {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.comments = arrival.map((id) => ({
      id,
      databaseId: databaseIds[id],
      authorLogin: "sponsor",
      authorGitHubUserId: null,
      body: TIE_BODIES[id],
      createdAt: TIE_INSTANT,
      lastEditedAt: null,
    }));
    return snapshot;
  }

  const BOTH_ARRIVALS = [
    { name: "lower database id arriving first", arrival: ["comment-a", "comment-b"] as const },
    { name: "higher database id arriving first", arrival: ["comment-b", "comment-a"] as const },
  ];

  it.each(BOTH_ARRIVALS)(
    "records identical settlement evidence for two same-instant rationales either way ($name)",
    ({ arrival }) => {
      const databaseIds = { "comment-a": 401, "comment-b": 402 } as const;
      const fromArrival = foldRepository(tieSnapshot(arrival, databaseIds));
      const fromReversed = foldRepository(tieSnapshot([...arrival].reverse(), databaseIds));

      expect(fromArrival.settlements[0]).toMatchObject({
        status: "SETTLED",
        settledPoints: 6,
        credits: 6,
        settledLabelEventId: "actual-1",
        settledRationaleCommentId: "comment-a",
        settledRationaleActorLogin: "sponsor",
        settledRationaleCommentedAt: TIE_INSTANT,
      });
      expect(JSON.stringify(fromReversed.settlements[0])).toBe(JSON.stringify(fromArrival.settlements[0]));
    },
  );

  it.each(BOTH_ARRIVALS)(
    "records the lower database id when the arrival-first comment carries the higher one ($name)",
    ({ arrival }) => {
      // The database ids are assigned by arrival position, so the data argues
      // the opposite way from the arrival order in both runs.
      const databaseIds = arrival[0] === "comment-a" ? { "comment-a": 900, "comment-b": 401 } : { "comment-a": 401, "comment-b": 900 };
      const result = foldRepository(tieSnapshot(arrival, databaseIds));

      expect(result.settlements[0]).toMatchObject({
        status: "SETTLED",
        credits: 6,
        settledRationaleCommentId: arrival[1],
      });
      expect(result.policyViolations).toEqual([]);
    },
  );

  it.each(BOTH_ARRIVALS)(
    "records the only identified comment when a same-instant tie carries one null database id ($name)",
    ({ arrival }) => {
      const result = foldRepository(tieSnapshot(arrival, { "comment-a": null, "comment-b": 402 }));

      expect(result.settlements[0]).toMatchObject({
        status: "SETTLED",
        credits: 6,
        settledRationaleCommentId: "comment-b",
        settledRationaleCommentedAt: TIE_INSTANT,
      });
      expect(result.unwritableClosures).toEqual([]);
      expect(result.policyViolations).toEqual([]);
    },
  );

  it.each(BOTH_ARRIVALS)(
    "records the only identified comment when a same-instant tie carries one comment with the databaseId key absent ($name)",
    ({ arrival }) => {
      // An unvalidated passthrough can drop the key entirely rather than
      // null it; the comment must rank as carrying no sequence evidence.
      const snapshot = tieSnapshot(arrival, { "comment-a": null, "comment-b": 402 });
      Reflect.deleteProperty(snapshot.issues[0]!.comments.find((comment) => comment.id === "comment-a")!, "databaseId");

      const result = foldRepository(snapshot);

      expect(result.settlements[0]).toMatchObject({
        status: "SETTLED",
        credits: 6,
        settledRationaleCommentId: "comment-b",
        settledRationaleCommentedAt: TIE_INSTANT,
      });
      expect(result.unwritableClosures).toEqual([]);
      expect(result.policyViolations).toEqual([]);
    },
  );

  it.each(BOTH_ARRIVALS)(
    "rejects same-instant rationales carrying no database ids rather than picking one ($name)",
    ({ arrival }) => {
      const result = foldRepository(tieSnapshot(arrival, { "comment-a": null, "comment-b": null }));
      const fromReversed = foldRepository(tieSnapshot([...arrival].reverse(), { "comment-a": null, "comment-b": null }));

      expect(result.settlements[0]).toMatchObject({
        status: "UNSETTLED",
        settledPoints: null,
        credits: 0,
        settledLabelEventId: null,
        settledRationaleCommentId: null,
      });
      expect(result.unwritableClosures).toEqual([{
        githubIssueId: 101,
        kind: "SETTLEMENT_EVIDENCE_REJECTED",
        githubPullRequestId: 201,
        reason: "Several qualifying rationale comments by the repository sponsor's account (login `sponsor`) share the instant 2026-09-01T11:30:00.000Z without GitHub database ids, so no evidence-backed rule can order them.",
      }]);
      // Re-folds compare reason bytes, so the sentence must not vary with the
      // arrival order either.
      expect(JSON.stringify(fromReversed.unwritableClosures)).toBe(JSON.stringify(result.unwritableClosures));
      expect(result.policyViolations).toEqual([]);
      expect(result.ledgerEntries).toEqual([]);
    },
  );

  it.each(BOTH_ARRIVALS)(
    "rejects same-instant rationales whose databaseId keys are all absent like null ones ($name)",
    ({ arrival }) => {
      const snapshot = tieSnapshot(arrival, { "comment-a": null, "comment-b": null });
      for (const comment of snapshot.issues[0]!.comments) {
        Reflect.deleteProperty(comment, "databaseId");
      }

      const result = foldRepository(snapshot);

      expect(result.unwritableClosures).toEqual([{
        githubIssueId: 101,
        kind: "SETTLEMENT_EVIDENCE_REJECTED",
        githubPullRequestId: 201,
        reason: "Several qualifying rationale comments by the repository sponsor's account (login `sponsor`) share the instant 2026-09-01T11:30:00.000Z without GitHub database ids, so no evidence-backed rule can order them.",
      }]);
      expect(result.settlements[0]).toMatchObject({ status: "UNSETTLED", settledPoints: null, settledRationaleCommentId: null });
      expect(result.policyViolations).toEqual([]);
    },
  );

  it.each(BOTH_ARRIVALS)(
    "rejects a tie whose instants are equal but spelled differently ($name)",
    ({ arrival }) => {
      const snapshot = tieSnapshot(arrival, { "comment-a": null, "comment-b": null });
      // The two spellings denote one instant. The tie-group predicate must
      // compare instants, not raw strings, or this tie silently settles on
      // the arrival-first comment instead of being refused.
      snapshot.issues[0]!.comments[0]!.createdAt = "2026-09-01T11:30:00Z";

      const result = foldRepository(snapshot);

      expect(result.unwritableClosures).toEqual([{
        githubIssueId: 101,
        kind: "SETTLEMENT_EVIDENCE_REJECTED",
        githubPullRequestId: 201,
        reason: "Several qualifying rationale comments by the repository sponsor's account (login `sponsor`) share the instant 2026-09-01T11:30:00.000Z without GitHub database ids, so no evidence-backed rule can order them.",
      }]);
      expect(result.settlements[0]).toMatchObject({ status: "UNSETTLED", settledPoints: null, settledRationaleCommentId: null });
      expect(result.policyViolations).toEqual([]);
    },
  );

  it.each(BOTH_ARRIVALS)(
    "rejects same-instant rationales carrying one duplicated database id in either arrival order ($name)",
    ({ arrival }) => {
      const result = foldRepository(tieSnapshot(arrival, { "comment-a": 402, "comment-b": 402 }));
      const fromReversed = foldRepository(tieSnapshot([...arrival].reverse(), { "comment-a": 402, "comment-b": 402 }));

      expect(result.settlements[0]).toMatchObject({
        status: "UNSETTLED",
        settledPoints: null,
        credits: 0,
        settledRationaleCommentId: null,
      });
      expect(result.unwritableClosures).toEqual([{
        githubIssueId: 101,
        kind: "SETTLEMENT_EVIDENCE_REJECTED",
        githubPullRequestId: 201,
        reason: "Several qualifying rationale comments by the repository sponsor's account (login `sponsor`) share the instant 2026-09-01T11:30:00.000Z, and more than one carries the GitHub database id 402, so the ids cannot order them.",
      }]);
      // The sentence's id is data-determined at the call site: the tie group
      // inherits the comparator's ascending order, so the first duplicated id
      // is the smallest for every fold input. The in-function sort is
      // defense-in-depth for future callers only.
      expect(JSON.stringify(fromReversed.unwritableClosures)).toBe(JSON.stringify(result.unwritableClosures));
      expect(result.policyViolations).toEqual([]);
    },
  );

  it("names the smallest duplicated id when a tie duplicates several", () => {
    const snapshot = tieSnapshot(["comment-a", "comment-b"], { "comment-a": 403, "comment-b": 402 });
    snapshot.issues[0]!.comments.push(
      { id: "comment-c", databaseId: 403, authorLogin: "sponsor", authorGitHubUserId: null, body: "Also delivered/6, independently.", createdAt: TIE_INSTANT, lastEditedAt: null },
      { id: "comment-d", databaseId: 402, authorLogin: "sponsor", authorGitHubUserId: null, body: "delivered/6 again, from the second reviewer.", createdAt: TIE_INSTANT, lastEditedAt: null },
    );
    snapshot.issues[0]!.comments.reverse();

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "SETTLEMENT_EVIDENCE_REJECTED",
      githubPullRequestId: 201,
      reason: "Several qualifying rationale comments by the repository sponsor's account (login `sponsor`) share the instant 2026-09-01T11:30:00.000Z, and more than one carries the GitHub database id 402, so the ids cannot order them.",
    }]);
    expect(result.policyViolations).toEqual([]);
  });

  it("folds a snapshot containing the tie byte-identically under scrambled comment arrival order", () => {
    const comments = [
      {
        id: "comment-1045", databaseId: 389, authorLogin: "sponsor", authorGitHubUserId: null,
        body: "Noting scope for delivered/6 before the label landed.",
        createdAt: "2026-09-01T10:50:00.000Z", lastEditedAt: null,
      },
      {
        id: "comment-b", databaseId: 403, authorLogin: "sponsor", authorGitHubUserId: null,
        body: TIE_BODIES["comment-b"], createdAt: TIE_INSTANT, lastEditedAt: null,
      },
      {
        id: "comment-1145", databaseId: 404, authorLogin: "sponsor", authorGitHubUserId: null,
        body: "Re-confirming delivered/6 for the record.",
        createdAt: "2026-09-01T11:45:00.000Z", lastEditedAt: null,
      },
      {
        id: "comment-a", databaseId: 402, authorLogin: "sponsor", authorGitHubUserId: null,
        body: TIE_BODIES["comment-a"], createdAt: TIE_INSTANT, lastEditedAt: null,
      },
    ];
    const forward = evidenceFixture();
    forward.issues[0]!.comments = comments;
    const scrambled = evidenceFixture();
    scrambled.issues[0]!.comments = [...comments].reverse();

    const fromForward = foldRepository(forward);
    const fromScrambled = foldRepository(scrambled);

    expect(JSON.stringify(fromScrambled)).toBe(JSON.stringify(fromForward));
    // Self-check: the tie instant is the winning selection instant, so the
    // recorded evidence must be the lower database id of that instant.
    expect(fromForward.settlements[0]).toMatchObject({
      status: "SETTLED",
      credits: 6,
      settledRationaleCommentId: "comment-a",
      settledRationaleCommentedAt: TIE_INSTANT,
    });
  });
});

describe("distinct-instant rationale selection", () => {
  it("prefers the earliest qualifying rationale at or after the settled label", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.comments = [
      {
        id: "comment-1045", databaseId: 389, authorLogin: "sponsor", authorGitHubUserId: null,
        body: "Noting scope for delivered/6 before the label landed.",
        createdAt: "2026-09-01T10:45:00.000Z", lastEditedAt: null,
      },
      {
        id: "comment-1130", databaseId: 402, authorLogin: "sponsor", authorGitHubUserId: null,
        body: "Settled as delivered/6 after reviewing the final diff.",
        createdAt: "2026-09-01T11:30:00.000Z", lastEditedAt: null,
      },
      {
        id: "comment-1145", databaseId: 403, authorLogin: "sponsor", authorGitHubUserId: null,
        body: "Re-confirming delivered/6 for the record.",
        createdAt: "2026-09-01T11:45:00.000Z", lastEditedAt: null,
      },
    ].reverse();

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "SETTLED",
      credits: 6,
      settledRationaleCommentId: "comment-1130",
      settledRationaleCommentedAt: "2026-09-01T11:30:00.000Z",
    });
    expect(result.policyViolations).toEqual([]);
  });

  it("falls back to the earliest qualifying rationale overall when every candidate precedes the settled label", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.comments = [
      {
        id: "comment-1045", databaseId: 402, authorLogin: "sponsor", authorGitHubUserId: null,
        body: "Noting scope for delivered/6 before the label landed.",
        createdAt: "2026-09-01T10:45:00.000Z", lastEditedAt: null,
      },
      {
        id: "comment-1050", databaseId: 403, authorLogin: "sponsor", authorGitHubUserId: null,
        body: "Expecting delivered/6 once the final diff lands.",
        createdAt: "2026-09-01T10:50:00.000Z", lastEditedAt: null,
      },
    ].reverse();

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "SETTLED",
      credits: 6,
      settledRationaleCommentId: "comment-1045",
      settledRationaleCommentedAt: "2026-09-01T10:45:00.000Z",
    });
    expect(result.policyViolations).toEqual([]);
  });
});

/**
 * One sponsor-opened, contributor-closed issue with every timestamp inside the
 * evidence windows: opening label 2026-08-30T10:00, final commit 09-01T10:00,
 * settled label 11:00, rationale 11:30, merge 12:00 (window closes 12:15).
 */
function evidenceFixture(): RepositoryFoldSnapshot {
  return {
    repository: {
      id: "repository",
      githubRepositoryId: 5001,
      ownerName: "octo/example",
      active: true,
      registeredAt: "2026-01-01T00:00:00.000Z",
      sponsor: { id: "sponsor", githubUserId: 1001, githubLogin: "sponsor", enforcementState: "ACTIVE", moderationEvents: [] },
      difficultySchemeVersions: [],
      difficultyScheme: {
        openingName: "Size",
        actualName: "Delivered",
        openingLabels: [
          { label: "S", comparisonPoints: 2, reservePoints: 2 },
          { label: "M", comparisonPoints: 5, reservePoints: 5 },
          { label: "L", comparisonPoints: 8, reservePoints: 8 },
        ],
        actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
      },
    },
    users: [
      { id: "sponsor", githubUserId: 1001, githubLogin: "sponsor", enforcementState: "ACTIVE", moderationEvents: [] },
      { id: "contributor", githubUserId: 2001, githubLogin: "contributor", enforcementState: "ACTIVE", moderationEvents: [] },
      { id: "maintainer", githubUserId: 3001, githubLogin: "maintainer", enforcementState: "ACTIVE", moderationEvents: [] },
    ],
    issues: [
      {
        id: 101,
        number: 1,
        title: "Issue",
        body: "Issue body",
        url: "https://github.com/octo/example/issues/1",
        state: "CLOSED",
        stateReason: "COMPLETED",
        createdAt: "2026-08-30T09:00:00.000Z",
        closedAt: "2026-09-01T12:05:00.000Z",
        updatedAt: "2026-09-01T12:05:00.000Z",
        authorLogin: "sponsor",
        authorGitHubUserId: null,
        labels: ["M", "delivered/6"],
        claimAssigneeGitHubLogin: null,
        history: [
          {
            kind: "LABELED", id: "opening-1", actorLogin: "sponsor", actorGitHubUserId: null,
            label: "M", createdAt: "2026-08-30T10:00:00.000Z",
          },
          {
            kind: "LABELED", id: "actual-1", actorLogin: "sponsor", actorGitHubUserId: null,
            label: "delivered/6", createdAt: "2026-09-01T11:00:00.000Z",
          },
        ],
        comments: [
          {
            id: "comment-1",
            databaseId: 401,
            authorLogin: "sponsor",
            authorGitHubUserId: null,
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
