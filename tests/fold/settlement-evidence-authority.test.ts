import { describe, expect, it } from "vitest";
import { foldRepository, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";

describe("integrated rejected settlement closure reasons", () => {
  it("records a non-sponsor label rejection with the sponsor-authority reason", () => {
    const snapshot = evidenceFixture({ issueAuthor: "contributor", settler: "contributor" });

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "SETTLEMENT_EVIDENCE_REJECTED",
      githubPullRequestId: 201,
      reason: "The settled label `delivered/6` was applied by `contributor` rather than the repository sponsor `sponsor`.",
    }]);
    expect(result.policyViolations).toEqual([{ code: "SETTLED_LABEL_UNAUTHORIZED", githubIssueId: 101 }]);
    expect(result.settlements[0]).toMatchObject({ status: "UNSETTLED", settledPoints: null, credits: 0 });
    expect(result.ledgerEntries).toEqual([]);
  });

  it("records edited-only rationale rejection with the after-close edit reason", () => {
    const snapshot = evidenceFixture({ issueAuthor: "contributor" });
    snapshot.issues[0]!.comments[0]!.lastEditedAt = "2026-09-01T12:20:00.000Z";

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "SETTLEMENT_EVIDENCE_REJECTED",
      githubPullRequestId: 201,
      reason: "Every qualifying rationale comment by `sponsor` naming `delivered/6` was edited after the settlement evidence window closed at 2026-09-01T12:15:00.000Z.",
    }]);
    expect(result.policyViolations).toEqual([{ code: "SETTLED_RATIONALE_EDITED", githubIssueId: 101 }]);
    expect(result.settlements[0]).toMatchObject({ status: "UNSETTLED", settledPoints: null, credits: 0 });
    expect(result.ledgerEntries).toEqual([]);
  });
});

describe("policy audit across participation eligibility", () => {
  const cases = (["SETTLED_LABEL_UNAUTHORIZED", "SETTLED_RATIONALE_EDITED"] as const).flatMap((code) =>
    (["BANNED", "RECALIBRATING"] as const).flatMap((state) =>
      (["sponsor", "contributor"] as const).map((actor) => ({ code, state, actor })),
    ),
  );

  it.each(cases)("audits $code when $actor was $state at merge", ({ code, state, actor }) => {
    const snapshot = evidenceFixture({
      issueAuthor: "contributor",
      settler: code === "SETTLED_LABEL_UNAUTHORIZED" ? "contributor" : "sponsor",
    });
    if (code === "SETTLED_RATIONALE_EDITED") {
      snapshot.issues[0]!.comments[0]!.lastEditedAt = "2026-09-01T12:20:00.000Z";
    }
    const user = snapshot.users.find((candidate) => candidate.id === actor)!;
    user.moderationEvents = [
      { id: "sanction", priorState: "ACTIVE", newState: state, occurredAt: "2026-09-01T11:59:00.000Z" },
      { id: "reinstatement", priorState: state, newState: "ACTIVE", occurredAt: "2026-09-01T13:00:00.000Z" },
    ];
    if (actor === "sponsor") {
      snapshot.repository.sponsor = user;
    }

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([{ code, githubIssueId: 101 }]);
    expect(result.settlements).toEqual([]);
    expect(result.ledgerEntries).toEqual([]);
  });
});

describe("rating authority", () => {
  it("does not let an outsider who filed, priced and closed an issue earn credit against the sponsor", () => {
    const snapshot = evidenceFixture({
      issueAuthor: "contributor",
      opener: "contributor",
      settler: "contributor",
      commenter: "contributor",
      pullRequestAuthor: "contributor",
    });

    const result = foldRepository(snapshot);

    expect(result.issues).toEqual([]);
    expect(result.settlements).toEqual([]);
    expect(result.ledgerEntries).toEqual([]);
    expect(result.policyViolations).toEqual([{ code: "OPENING_LABEL_MISSING", githubIssueId: 101 }]);
  });

  it("does not let two outsiders price and close an issue between them", () => {
    const snapshot = evidenceFixture({
      issueAuthor: "maintainer",
      opener: "maintainer",
      settler: "maintainer",
      commenter: "maintainer",
      pullRequestAuthor: "contributor",
    });

    const result = foldRepository(snapshot);

    expect(result.issues).toEqual([]);
    expect(result.settlements).toEqual([]);
    expect(result.policyViolations).toEqual([{ code: "OPENING_LABEL_MISSING", githubIssueId: 101 }]);
  });

  it("settles an outsider-filed issue that the sponsor priced at opening and at settlement", () => {
    const snapshot = evidenceFixture({ issueAuthor: "contributor", pullRequestAuthor: "contributor" });

    const result = foldRepository(snapshot);

    expect(result.settlements).toEqual([
      expect.objectContaining({ status: "SETTLED", creditorId: "contributor", debtorId: "sponsor", credits: 6 }),
    ]);
    expect(result.issues[0]).toMatchObject({
      ownerGitHubLogin: "contributor",
      openingSourceActorLogin: "sponsor",
      settledLabelActorLogin: "sponsor",
      settledRationaleActorLogin: "sponsor",
    });
    expect(result.policyViolations).toEqual([]);
  });

  it("rejects a settled label the credited pull request author applied and records why", () => {
    const snapshot = evidenceFixture({ issueAuthor: "contributor", settler: "contributor", commenter: "contributor" });

    const result = foldRepository(snapshot);

    expect(result.settlements).toEqual([
      expect.objectContaining({ status: "UNSETTLED", settledPoints: null, credits: 0, settledLabelEventId: null }),
    ]);
    expect(result.policyViolations).toEqual([{ code: "SETTLED_LABEL_UNAUTHORIZED", githubIssueId: 101 }]);
  });

  it("rejects a settled label applied by a collaborator who is not the sponsor", () => {
    const snapshot = evidenceFixture({ settler: "maintainer" });

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ status: "UNSETTLED", settledPoints: null, credits: 0 });
    expect(result.policyViolations).toEqual([{ code: "SETTLED_LABEL_UNAUTHORIZED", githubIssueId: 101 }]);
  });

  it("rejects a rationale comment from someone other than the sponsor without a label violation", () => {
    const snapshot = evidenceFixture({ commenter: "maintainer" });

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ status: "UNSETTLED", settledPoints: null, credits: 0 });
    expect(result.policyViolations).toEqual([]);
  });

  it("keeps the sponsor's own priced and closed work as calibration evidence", () => {
    const snapshot = evidenceFixture({ pullRequestAuthor: "sponsor" });
    snapshot.issues[0]!.closingPullRequests[0]!.authorGitHubUserId = 1001;

    const result = foldRepository(snapshot);

    expect(result.settlements).toEqual([]);
    expect(result.selfWorkCalibrations).toEqual([
      expect.objectContaining({ githubIssueId: 101, userId: "sponsor", actualPoints: 6, actualLabelActorLogin: "sponsor" }),
    ]);
    expect(result.policyViolations).toEqual([]);
  });

  it("matches the sponsor login case-insensitively and ignores surrounding whitespace", () => {
    const snapshot = evidenceFixture();
    snapshot.repository.sponsor.githubLogin = " Sponsor ";

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ status: "SETTLED", credits: 6 });
  });
});

describe("rationale comment edits", () => {
  it("rejects a rationale comment edited after the settlement window closed and records why", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.comments[0]!.lastEditedAt = "2026-09-01T12:20:00.000Z";

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "UNSETTLED",
      settledPoints: null,
      credits: 0,
      settledRationaleCommentId: null,
    });
    expect(result.policyViolations).toEqual([{ code: "SETTLED_RATIONALE_EDITED", githubIssueId: 101 }]);
  });

  it("accepts a rationale comment edited inside the settlement window", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.comments[0]!.lastEditedAt = "2026-09-01T12:10:00.000Z";

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ status: "SETTLED", settledPoints: 6, credits: 6 });
    expect(result.policyViolations).toEqual([]);
  });

  it("falls through to an unedited later rationale when the first one was edited after the window", () => {
    const snapshot = evidenceFixture();
    const issue = snapshot.issues[0]!;
    issue.comments[0]!.lastEditedAt = "2026-09-02T09:00:00.000Z";
    issue.comments.push({
      id: "comment-2",
      databaseId: 402,
      authorLogin: "sponsor",
      body: "Confirming delivered/6.",
      createdAt: "2026-09-01T11:45:00.000Z",
      lastEditedAt: null,
    });

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "SETTLED",
      settledPoints: 6,
      settledRationaleCommentId: "comment-2",
      settledRationaleCommentedAt: "2026-09-01T11:45:00.000Z",
    });
    expect(result.policyViolations).toEqual([]);
  });

  it("does not report an edit violation when the comment never named the label", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.comments[0]!.body = "Looks fine.";
    snapshot.issues[0]!.comments[0]!.lastEditedAt = "2026-09-02T09:00:00.000Z";

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ status: "UNSETTLED", settledPoints: null });
    expect(result.policyViolations).toEqual([]);
  });
});

describe("settled label authority boundaries", () => {
  it.each([
    { name: "exactly at final commit minus grace", createdAt: "2026-09-01T09:45:00.000Z", accepted: true },
    { name: "one millisecond before final commit minus grace", createdAt: "2026-09-01T09:44:59.999Z", accepted: false },
  ])("handles a settled label $name", ({ createdAt, accepted }) => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.history[1]!.createdAt = createdAt;
    snapshot.issues[0]!.comments[0]!.createdAt = "2026-09-01T09:45:00.000Z";

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: accepted ? "SETTLED" : "UNSETTLED",
      settledPoints: accepted ? 6 : null,
      credits: accepted ? 6 : 0,
      settledLabelEventId: accepted ? "actual-1" : null,
    });
    expect(result.policyViolations).toEqual([]);
    if (!accepted) {
      expect(result.ledgerEntries).toEqual([]);
    }
  });

  it("ignores an unauthorized settled label before the window without a policy violation", () => {
    const snapshot = evidenceFixture({ settler: "maintainer" });
    snapshot.issues[0]!.history[1]!.createdAt = "2026-09-01T09:00:00.000Z";

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ status: "UNSETTLED", settledPoints: null, credits: 0 });
    expect(result.policyViolations).toEqual([]);
  });

  it("accepts a settled label from a differently-cased sponsor login", () => {
    const snapshot = evidenceFixture({ settler: " Sponsor " });

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ status: "SETTLED", settledPoints: 6, credits: 6 });
    expect(result.policyViolations).toEqual([]);
  });

  it("rejects a settled label from an actor whose login merely starts with the sponsor login", () => {
    const snapshot = evidenceFixture({ settler: "sponsor2" });

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "UNSETTLED", settledPoints: null, credits: 0, settledLabelEventId: null,
    });
    expect(result.ledgerEntries).toEqual([]);
    expect(result.policyViolations).toEqual([{ code: "SETTLED_LABEL_UNAUTHORIZED", githubIssueId: 101 }]);
  });
});

describe("review rounds at merge", () => {
  it("counts distinct reviews sharing a submission timestamp as separate rounds", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.reviews = [
      { id: 401, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T10:30:00.000Z", dismissal: null },
      { id: 402, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T10:30:00.000Z", dismissal: null },
    ];

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ reviewRounds: 2, credits: 4 });
    expect(result.pullRequests[0]?.reviewRounds).toEqual([
      { githubReviewId: 401, submittedAt: "2026-09-01T10:30:00.000Z" },
      { githubReviewId: 402, submittedAt: "2026-09-01T10:30:00.000Z" },
    ]);
  });

  it("sorts review rounds by id regardless of input order", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.reviews = [
      { id: 402, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T10:30:00.000Z", dismissal: null },
      { id: 401, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T10:40:00.000Z", dismissal: null },
    ];

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ reviewRounds: 2, credits: 4 });
    expect(result.pullRequests[0]?.reviewRounds).toEqual([
      { githubReviewId: 401, submittedAt: "2026-09-01T10:40:00.000Z" },
      { githubReviewId: 402, submittedAt: "2026-09-01T10:30:00.000Z" },
    ]);
  });

  it("judges each review by its own dismissal timestamp", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.reviews = [
      {
        id: 401,
        state: "DISMISSED",
        submittedAt: "2026-09-01T10:30:00.000Z",
        dismissal: { at: "2026-09-01T13:00:00.000Z", previousState: "CHANGES_REQUESTED" },
      },
      {
        id: 402,
        state: "DISMISSED",
        submittedAt: "2026-09-01T10:40:00.000Z",
        dismissal: { at: "2026-09-01T11:00:00.000Z", previousState: "CHANGES_REQUESTED" },
      },
    ];

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ reviewRounds: 1, credits: 5 });
    expect(result.pullRequests[0]?.reviewRounds).toEqual([
      { githubReviewId: 401, submittedAt: "2026-09-01T10:30:00.000Z" },
    ]);
  });

  it("does not count a commented review dismissed after merge", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.reviews = [
      {
        id: 401,
        state: "DISMISSED",
        submittedAt: "2026-09-01T10:30:00.000Z",
        dismissal: { at: "2026-09-01T13:00:00.000Z", previousState: "COMMENTED" },
      },
    ];

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ reviewRounds: 0, credits: 6 });
    expect(result.pullRequests[0]?.reviewRounds).toEqual([]);
  });

  it("honors attached dismissals even for current changes requested and excludes missing provenance", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.reviews = [
      {
        id: 401,
        state: "CHANGES_REQUESTED",
        submittedAt: "2026-09-01T10:30:00.000Z",
        dismissal: { at: "2026-09-01T11:00:00.000Z", previousState: "CHANGES_REQUESTED" },
      },
      { id: 402, state: "DISMISSED", submittedAt: "2026-09-01T10:40:00.000Z", dismissal: null },
    ];

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ reviewRounds: 0, credits: 6 });
    expect(result.pullRequests[0]?.reviewRounds).toEqual([]);
  });

  it.each([
    { at: "2026-09-01T11:59:59.999Z", rounds: 0, credits: 6 },
    { at: "2026-09-01T12:00:00.000Z", rounds: 1, credits: 5 },
    { at: "2026-09-01T12:00:00.001Z", rounds: 1, credits: 5 },
    { at: "not-a-timestamp", rounds: 1, credits: 5 },
  ])("counts $rounds rounds when dismissal is at $at", ({ at, rounds, credits }) => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.reviews = [{
      id: 310,
      state: "DISMISSED",
      submittedAt: "2026-09-01T10:30:00.000Z",
      dismissal: { at, previousState: "CHANGES_REQUESTED" },
    }];

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ reviewRounds: rounds, credits });
    expect(result.pullRequests[0]?.reviewRounds).toEqual(rounds === 0 ? [] : [
      { githubReviewId: 310, submittedAt: "2026-09-01T10:30:00.000Z" },
    ]);
  });

  it.each(["CHANGES_REQUESTED", "DISMISSED"] as const)(
    "checks strict submission time and distinct ids for %s reviews",
    (state) => {
      const snapshot = evidenceFixture();
      const reviews = [
        { id: 320, submittedAt: "2026-09-01T11:59:59.999Z" },
        { id: 321, submittedAt: "2026-09-01T12:00:00.000Z" },
        { id: 322, submittedAt: "2026-09-01T12:00:00.001Z" },
        { id: 323, submittedAt: "not-a-timestamp" },
        { id: 324, submittedAt: null },
        { id: 325, submittedAt: "2026-09-01T11:00:00.000Z" },
      ].map((review) => ({
        ...review,
        state,
        dismissal: state === "DISMISSED"
          ? { at: "2026-09-01T13:00:00.000Z", previousState: "CHANGES_REQUESTED" as const }
          : null,
      }));
      snapshot.issues[0]!.closingPullRequests[0]!.reviews = [...reviews, reviews[0]!];

      const result = foldRepository(snapshot);

      expect(result.settlements[0]).toMatchObject({ reviewRounds: 2, credits: 4 });
      expect(result.pullRequests[0]?.reviewRounds).toEqual([
        { githubReviewId: 320, submittedAt: "2026-09-01T11:59:59.999Z" },
        { githubReviewId: 325, submittedAt: "2026-09-01T11:00:00.000Z" },
      ]);
    },
  );

  it("keeps a changes-requested round that was dismissed after the merge", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.reviews = [
      {
        id: 301,
        state: "DISMISSED",
        submittedAt: "2026-09-01T10:30:00.000Z",
        dismissal: { at: "2026-09-01T13:00:00.000Z", previousState: "CHANGES_REQUESTED" },
      },
    ];

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ reviewRounds: 1, credits: 5 });
    expect(result.pullRequests[0]?.reviewRounds).toEqual([{ githubReviewId: 301, submittedAt: "2026-09-01T10:30:00.000Z" }]);
  });

  it("drops a changes-requested round that was dismissed before the merge", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.reviews = [
      {
        id: 301,
        state: "DISMISSED",
        submittedAt: "2026-09-01T10:30:00.000Z",
        dismissal: { at: "2026-09-01T11:00:00.000Z", previousState: "CHANGES_REQUESTED" },
      },
    ];

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ reviewRounds: 0, credits: 6 });
  });

  it("never counts a dismissed approval or a dismissal of unknown provenance", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.reviews = [
      {
        id: 301,
        state: "DISMISSED",
        submittedAt: "2026-09-01T10:30:00.000Z",
        dismissal: { at: "2026-09-01T13:00:00.000Z", previousState: "APPROVED" },
      },
      { id: 302, state: "DISMISSED", submittedAt: "2026-09-01T10:40:00.000Z", dismissal: null },
      {
        id: 303,
        state: "DISMISSED",
        submittedAt: "2026-09-01T10:50:00.000Z",
        dismissal: { at: "2026-09-01T13:00:00.000Z", previousState: null },
      },
    ];

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ reviewRounds: 0, credits: 6 });
  });

  it("still ignores a changes-requested review submitted at or after the merge, dismissed or not", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.reviews = [
      { id: 301, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T12:00:00.000Z", dismissal: null },
      {
        id: 302,
        state: "DISMISSED",
        submittedAt: "2026-09-01T12:30:00.000Z",
        dismissal: { at: "2026-09-01T13:00:00.000Z", previousState: "CHANGES_REQUESTED" },
      },
    ];

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({ reviewRounds: 0, credits: 6 });
  });
});

describe("rationale selection boundaries", () => {
  it.each([
    { name: "exactly at close", lastEditedAt: "2026-09-01T12:15:00.000Z", accepted: true },
    { name: "one millisecond after close", lastEditedAt: "2026-09-01T12:15:00.001Z", accepted: false },
    { name: "unparseable", lastEditedAt: "not-a-timestamp", accepted: true },
  ])("handles an edit timestamp $name", ({ lastEditedAt, accepted }) => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.comments[0]!.lastEditedAt = lastEditedAt;

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: accepted ? "SETTLED" : "UNSETTLED",
      settledPoints: accepted ? 6 : null,
      credits: accepted ? 6 : 0,
      settledRationaleCommentId: accepted ? "comment-1" : null,
    });
    expect(result.policyViolations).toEqual(
      accepted ? [] : [{ code: "SETTLED_RATIONALE_EDITED", githubIssueId: 101 }],
    );
    if (!accepted) {
      expect(result.ledgerEntries).toEqual([]);
    }
  });

  it.each([
    { name: "exactly at window close", createdAt: "2026-09-01T12:15:00.000Z", accepted: true },
    { name: "one millisecond after window close", createdAt: "2026-09-01T12:15:00.001Z", accepted: false },
  ])("handles a rationale created $name", ({ createdAt, accepted }) => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.comments[0]!.createdAt = createdAt;

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: accepted ? "SETTLED" : "UNSETTLED",
      settledPoints: accepted ? 6 : null,
      credits: accepted ? 6 : 0,
      settledRationaleCommentId: accepted ? "comment-1" : null,
    });
    expect(result.policyViolations).toEqual([]);
    if (!accepted) {
      expect(result.ledgerEntries).toEqual([]);
    }
  });

  it("accepts a rationale created exactly at label time minus grace", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.comments[0]!.createdAt = "2026-09-01T10:45:00.000Z";

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "SETTLED",
      settledPoints: 6,
      credits: 6,
      settledRationaleCommentId: "comment-1",
    });
    expect(result.policyViolations).toEqual([]);
  });

  it("accepts a rationale with a missing edit timestamp", () => {
    const snapshot = evidenceFixture();
    Reflect.deleteProperty(snapshot.issues[0]!.comments[0]!, "lastEditedAt");

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "SETTLED",
      settledPoints: 6,
      credits: 6,
      settledRationaleCommentId: "comment-1",
    });
    expect(result.policyViolations).toEqual([]);
  });

  it("selects the earliest valid rationale instead of the last", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.comments.push({
      ...snapshot.issues[0]!.comments[0]!,
      id: "comment-2",
      databaseId: 402,
      createdAt: "2026-09-01T11:45:00.000Z",
    });

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "SETTLED",
      settledPoints: 6,
      credits: 6,
      settledRationaleCommentId: "comment-1",
    });
    expect(result.policyViolations).toEqual([]);
  });

  it("selects the earliest of multiple qualifying grace fallbacks", () => {
    const snapshot = evidenceFixture();
    const issue = snapshot.issues[0]!;
    issue.history.push(
      { kind: "UNLABELED", id: "removed", actorLogin: "sponsor", label: "delivered/6", createdAt: "2026-09-01T11:35:00.000Z" },
      { kind: "LABELED", id: "actual-2", actorLogin: "sponsor", label: "delivered/6", createdAt: "2026-09-01T11:40:00.000Z" },
    );
    issue.comments.push({
      ...issue.comments[0]!,
      id: "comment-2",
      databaseId: 402,
      createdAt: "2026-09-01T11:34:00.000Z",
    });

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "SETTLED",
      settledPoints: 6,
      credits: 6,
      settledLabelEventId: "actual-2",
      settledRationaleCommentId: "comment-1",
      settledRationaleCommentedAt: "2026-09-01T11:30:00.000Z",
    });
    expect(result.policyViolations).toEqual([]);
  });

  it("normalizes case and surrounding whitespace in the rationale author login", () => {
    const snapshot = evidenceFixture({ commenter: " Sponsor " });

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "SETTLED",
      settledPoints: 6,
      credits: 6,
      settledRationaleCommentId: "comment-1",
      settledRationaleActorLogin: "Sponsor",
    });
    expect(result.policyViolations).toEqual([]);
  });

  it("sorts rationale candidates chronologically before selecting one", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.comments.unshift({
      ...snapshot.issues[0]!.comments[0]!,
      id: "comment-2",
      databaseId: 402,
      createdAt: "2026-09-01T11:45:00.000Z",
    });

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "SETTLED",
      settledPoints: 6,
      credits: 6,
      settledRationaleCommentId: "comment-1",
    });
    expect(result.policyViolations).toEqual([]);
  });

  it("records the comment author independently of the label actor", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.history[1]!.actorLogin = " Sponsor ";

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "SETTLED",
      settledLabelActorLogin: "Sponsor",
      settledRationaleActorLogin: "sponsor",
    });
    expect(result.policyViolations).toEqual([]);
  });

  it("rejects a rationale author whose login only starts with the sponsor login", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.comments[0]!.authorLogin = "sponsor2";

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "UNSETTLED",
      settledPoints: null,
      credits: 0,
      settledRationaleCommentId: null,
    });
    expect(result.ledgerEntries).toEqual([]);
    expect(result.policyViolations).toEqual([]);
  });

  it("filters an otherwise valid rationale with an empty comment id", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.comments[0]!.id = "";

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "UNSETTLED",
      settledPoints: null,
      credits: 0,
      settledRationaleCommentId: null,
    });
    expect(result.ledgerEntries).toEqual([]);
    expect(result.policyViolations).toEqual([]);
  });

  it("rejects every candidate when all rationales were edited after close", () => {
    const snapshot = evidenceFixture();
    snapshot.issues[0]!.comments[0]!.lastEditedAt = "2026-09-02T09:00:00.000Z";
    snapshot.issues[0]!.comments.push({
      ...snapshot.issues[0]!.comments[0]!,
      id: "comment-2",
      databaseId: 402,
      createdAt: "2026-09-01T11:45:00.000Z",
    });

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "UNSETTLED",
      settledPoints: null,
      credits: 0,
      settledRationaleCommentId: null,
    });
    expect(result.ledgerEntries).toEqual([]);
    expect(result.policyViolations).toEqual([{ code: "SETTLED_RATIONALE_EDITED", githubIssueId: 101 }]);
  });
});

export type EvidenceLogins = {
  sponsor: string;
  issueAuthor: string;
  opener: string;
  settler: string;
  commenter: string;
  pullRequestAuthor: string;
};

/**
 * One sponsor-opened, contributor-closed issue with every timestamp inside the
 * evidence windows: opening label 2026-08-30T10:00, final commit 09-01T10:00,
 * settled label 11:00, rationale 11:30, merge 12:00 (window closes 12:15).
 * Every login defaults to "sponsor" except the pull request author.
 */
export function evidenceFixture(overrides: Partial<EvidenceLogins> = {}): RepositoryFoldSnapshot {
  const logins: EvidenceLogins = {
    sponsor: "sponsor",
    issueAuthor: "sponsor",
    opener: "sponsor",
    settler: "sponsor",
    commenter: "sponsor",
    pullRequestAuthor: "contributor",
    ...overrides,
  };
  return {
    repository: {
      id: "repository",
      githubRepositoryId: 5001,
      ownerName: "octo/example",
      active: true,
      registeredAt: "2026-01-01T00:00:00.000Z",
      sponsor: { id: "sponsor", githubUserId: 1001, githubLogin: logins.sponsor, enforcementState: "ACTIVE", moderationEvents: [] },
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
      { id: "sponsor", githubUserId: 1001, githubLogin: logins.sponsor, enforcementState: "ACTIVE", moderationEvents: [] },
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
        createdAt: "2026-08-30T09:00:00.000Z",
        closedAt: "2026-09-01T12:05:00.000Z",
        authorLogin: logins.issueAuthor,
        labels: ["M", "delivered/6"],
        claimAssigneeGitHubLogin: null,
        history: [
          { kind: "LABELED", id: "opening-1", actorLogin: logins.opener, label: "M", createdAt: "2026-08-30T10:00:00.000Z" },
          { kind: "LABELED", id: "actual-1", actorLogin: logins.settler, label: "delivered/6", createdAt: "2026-09-01T11:00:00.000Z" },
        ],
        comments: [
          {
            id: "comment-1",
            databaseId: 401,
            authorLogin: logins.commenter,
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
            authorLogin: logins.pullRequestAuthor,
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
