import { describe, expect, it } from "vitest";
import { foldRepository, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";

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
      ownerName: "octo/example",
      active: true,
      sponsor: { id: "sponsor", githubLogin: logins.sponsor, enforcementState: "ACTIVE", moderationEvents: [] },
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
      { id: "sponsor", githubLogin: logins.sponsor, enforcementState: "ACTIVE", moderationEvents: [] },
      { id: "contributor", githubLogin: "contributor", enforcementState: "ACTIVE", moderationEvents: [] },
      { id: "maintainer", githubLogin: "maintainer", enforcementState: "ACTIVE", moderationEvents: [] },
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
            reviews: [],
            rawDiff: "diff",
          },
        ],
      },
    ],
  };
}
