import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  foldRepository,
  type RepositoryFoldSnapshot,
} from "@/lib/fold/repository-fold";

describe("foldRepository", () => {
  it("keeps self work as calibration evidence instead of a settlement", () => {
    const result = foldRepository(selfWorkFixture());

    expect(result.settlements).toHaveLength(0);
    expect(result.selfWorkCalibrations).toHaveLength(1);
    expect(result.selfWorkCalibrations[0]).toMatchObject({
      githubIssueId: 101,
      githubPullRequestId: 201,
      userId: "sponsor",
      actualPoints: 6,
    });
  });

  it("never treats a plausible REST timeline cross-reference as an authoritative closing PR", () => {
    const result = foldRepository(restTimelineTrapFixture());

    expect(result.settlements).toHaveLength(0);
    expect(result.unwritableClosures).toHaveLength(1);
    expect(result.unwritableClosures[0]).toMatchObject({
      githubIssueId: 101,
      reason: "No merged GitHub GraphQL closing pull request was found.",
    });
  });

  it("subtracts each unique formal changes-requested review submitted before merge", () => {
    const result = foldRepository(twoReviewRoundsFixture());

    expect(result.settlements[0]?.credits).toBe(4);
    expect(result.settlements[0]?.reviewRounds).toBe(2);
  });

  it("uses the configured S/M/L catalog rather than inferring a label's points", () => {
    const snapshot = outsiderFixture();
    setOpeningLabel(snapshot, "S");
    setActualLabel(snapshot, "delivered/7");

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      openingComparisonPoints: 2,
      settledPoints: 7,
      credits: 7,
    });
  });

  it("preserves the owner-applied opening event after labels change and reports a policy violation", () => {
    const snapshot = outsiderFixture();
    snapshot.issues[0]!.labels = ["L", "delivered/6"];
    snapshot.issues[0]!.history.push(
      {
        kind: "LABELED",
        id: "opening-mutation",
        actorLogin: "sponsor",
        label: "L",
        createdAt: "2026-08-31T10:00:00.000Z",
      },
    );

    const result = foldRepository(snapshot);

    expect(result.issues[0]).toMatchObject({
      openingLabel: "M",
      openingComparisonPoints: 5,
      openingReservePoints: 5,
    });
    expect(result.policyViolations).toEqual([
      expect.objectContaining({ code: "OPENING_LABEL_MUTATED", githubIssueId: 101 }),
    ]);
  });

  it("does not infer opening labels applied by a bot or after the first assignment", () => {
    const missing = outsiderFixture();
    missing.issues[0]!.history[0] = {
      ...missing.issues[0]!.history[0]!,
      actorLogin: "automation-bot",
    };
    const postAssignment = outsiderFixture();
    postAssignment.issues[0]!.history.unshift({
      kind: "ASSIGNED",
      id: "assignment-before-opening",
      actorLogin: "sponsor",
      assigneeLogin: "contributor",
      createdAt: "2026-08-30T09:30:00.000Z",
    });

    for (const snapshot of [missing, postAssignment]) {
      const result = foldRepository(snapshot);
      expect(result.issues).toHaveLength(0);
      expect(result.settlements).toHaveLength(0);
      expect(result.policyViolations).toHaveLength(1);
    }
  });

  it("uses the PR author as contributor while keeping an issue assignee as only a claim lock", () => {
    const snapshot = outsiderFixture();
    snapshot.users.push({ id: "assignee", githubLogin: "claim-holder", enforcementState: "ACTIVE", moderationEvents: [] });
    snapshot.issues[0]!.claimAssigneeGitHubLogin = "claim-holder";

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      creditorId: "contributor",
      debtorId: "sponsor",
    });
  });

  it("retains a zero-credit outsider settlement and proof without emitting a ledger entry", () => {
    const snapshot = outsiderFixture();
    setActualLabel(snapshot, "delivered/1");
    snapshot.issues[0]!.closingPullRequests[0]!.reviews = [
      { id: 301, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T11:00:00.000Z" },
    ];

    const result = foldRepository(snapshot);

    expect(result.settlements).toEqual([
      expect.objectContaining({ status: "SETTLED", credits: 0, proofSha256: sha256("diff") }),
    ]);
    expect(result.ledgerEntries).toEqual([]);
  });

  it("keeps an unjoined PR author unclaimed with GitHub identity, proof, and amount", () => {
    const snapshot = outsiderFixture();
    snapshot.users = snapshot.users.filter((user) => user.id !== "contributor");

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "UNCLAIMED",
      creditorId: null,
      creditorGitHubLogin: "contributor",
      credits: 6,
      proofSha256: sha256("diff"),
    });
  });

  it("materializes one deterministic settlement for every issue closed by one merged PR", () => {
    const snapshot = outsiderFixture();
    const secondIssue = structuredClone(snapshot.issues[0]!);
    secondIssue.id = 102;
    secondIssue.number = 2;
    secondIssue.title = "Second issue";
    secondIssue.url = "https://github.com/octo/example/issues/2";
    snapshot.issues.push(secondIssue);

    const result = foldRepository(snapshot);

    expect(result.pullRequests).toHaveLength(1);
    expect(result.settlements).toHaveLength(2);
    expect(result.settlements.map((settlement) => settlement.githubIssueId).sort()).toEqual([101, 102]);
  });

  it("settles an issue once when several merged GraphQL links are present", () => {
    const snapshot = outsiderFixture();
    snapshot.issues[0]!.closingPullRequests = [
      { ...snapshot.issues[0]!.closingPullRequests[0]!, id: 202, number: 12, mergedAt: "2026-09-02T12:00:00.000Z" },
      { ...snapshot.issues[0]!.closingPullRequests[0]!, id: 201, number: 10, mergedAt: "2026-09-01T12:00:00.000Z" },
    ];

    const result = foldRepository(snapshot);

    expect(result.settlements).toEqual([
      expect.objectContaining({ githubPullRequestId: 201, githubIssueId: 101 }),
    ]);
  });

  it.each([
    ["a warned sponsor", (snapshot: RepositoryFoldSnapshot) => { snapshot.repository.sponsor.enforcementState = "WARNED"; }],
    ["an under-audit sponsor", (snapshot: RepositoryFoldSnapshot) => { snapshot.repository.sponsor.enforcementState = "UNDER_AUDIT"; }],
    ["a warned PR author", (snapshot: RepositoryFoldSnapshot) => {
      snapshot.users.find((user) => user.id === "contributor")!.enforcementState = "WARNED";
    }],
    ["an under-audit PR author", (snapshot: RepositoryFoldSnapshot) => {
      snapshot.users.find((user) => user.id === "contributor")!.enforcementState = "UNDER_AUDIT";
    }],
  ])("creates the outsider settlement for %s", (_name, change) => {
    const snapshot = outsiderFixture();
    change(snapshot);

    const result = foldRepository(snapshot);

    expect(result.settlements).toEqual([
      expect.objectContaining({
        status: "SETTLED",
        creditorId: "contributor",
        debtorId: "sponsor",
        credits: 6,
      }),
    ]);
    expect(result.ledgerEntries).toHaveLength(2);
  });

  it.each([
    ["a banned sponsor", (snapshot: RepositoryFoldSnapshot) => { snapshot.repository.sponsor.enforcementState = "BANNED"; }],
    ["a recalibrating sponsor", (snapshot: RepositoryFoldSnapshot) => { snapshot.repository.sponsor.enforcementState = "RECALIBRATING"; }],
    ["a banned PR author", (snapshot: RepositoryFoldSnapshot) => {
      snapshot.users.find((user) => user.id === "contributor")!.enforcementState = "BANNED";
    }],
    ["a recalibrating PR author", (snapshot: RepositoryFoldSnapshot) => {
      snapshot.users.find((user) => user.id === "contributor")!.enforcementState = "RECALIBRATING";
    }],
  ])("does not create new settlements or ledger entries for %s", (_name, change) => {
    const snapshot = outsiderFixture();
    change(snapshot);

    const result = foldRepository(snapshot);

    expect(result.settlements).toEqual([]);
    expect(result.ledgerEntries).toEqual([]);
  });

  it("rebuilds eligible historical facts even when the repository is inactive later", () => {
    const snapshot = outsiderFixture();
    snapshot.repository.active = false;

    const result = foldRepository(snapshot);

    expect(result.settlements).toEqual([
      expect.objectContaining({ status: "SETTLED", creditorId: "contributor", credits: 6 }),
    ]);
  });
});

function selfWorkFixture(): RepositoryFoldSnapshot {
  const snapshot = outsiderFixture();
  snapshot.issues[0]!.closingPullRequests[0]!.authorLogin = "sponsor";
  return snapshot;
}

function restTimelineTrapFixture(): RepositoryFoldSnapshot {
  const snapshot = outsiderFixture();
  snapshot.issues[0]!.closingPullRequests = [];
  snapshot.issues[0]!.restTimeline = [
    { source: "REST", pullRequestNumber: 201, authorLogin: "contributor" },
  ];
  return snapshot;
}

function twoReviewRoundsFixture(): RepositoryFoldSnapshot {
  const snapshot = outsiderFixture();
  snapshot.issues[0]!.closingPullRequests[0]!.reviews = [
    { id: 301, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T10:00:00.000Z" },
    { id: 301, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T10:01:00.000Z" },
    { id: 302, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T11:00:00.000Z" },
    { id: 303, state: "COMMENTED", submittedAt: "2026-09-01T11:30:00.000Z" },
    { id: 304, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T13:00:00.000Z" },
  ];
  return snapshot;
}

function outsiderFixture(): RepositoryFoldSnapshot {
  return {
    repository: {
      id: "repository",
      ownerName: "octo/example",
      active: true,
      sponsor: { id: "sponsor", githubLogin: "sponsor", enforcementState: "ACTIVE", moderationEvents: [] },
      difficultyScheme: difficultyScheme(),
    },
    users: [
      { id: "sponsor", githubLogin: "sponsor", enforcementState: "ACTIVE", moderationEvents: [] },
      { id: "contributor", githubLogin: "contributor", enforcementState: "ACTIVE", moderationEvents: [] },
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
        authorLogin: "sponsor",
        labels: ["M", "delivered/6"],
        history: [
          {
            kind: "LABELED",
            id: "opening-1",
            actorLogin: "sponsor",
            label: "M",
            createdAt: "2026-08-30T10:00:00.000Z",
          },
          {
            kind: "LABELED",
            id: "actual-1",
            actorLogin: "sponsor",
            label: "delivered/6",
            createdAt: "2026-09-01T11:00:00.000Z",
          },
        ],
        comments: [
          {
            id: "comment-1",
            databaseId: 401,
            authorLogin: "sponsor",
            body: "Settled as delivered/6 after reviewing the final diff.",
            createdAt: "2026-09-01T11:30:00.000Z",
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
            reviews: [],
            rawDiff: "diff",
          },
        ],
      },
    ],
  };
}

function setOpeningLabel(snapshot: RepositoryFoldSnapshot, label: string): void {
  const issue = snapshot.issues[0]!;
  const event = issue.history.find((candidate) => candidate.kind === "LABELED" && candidate.id === "opening-1");
  if (event === undefined || event.kind !== "LABELED") {
    throw new Error("Opening fixture event was missing.");
  }
  event.label = label;
  issue.labels = issue.labels.filter((candidate) => !["S", "M", "L"].includes(candidate));
  issue.labels.push(label);
}

function setActualLabel(snapshot: RepositoryFoldSnapshot, label: string): void {
  const issue = snapshot.issues[0]!;
  const event = issue.history.find((candidate) => candidate.kind === "LABELED" && candidate.id === "actual-1");
  if (event === undefined || event.kind !== "LABELED") {
    throw new Error("Actual fixture event was missing.");
  }
  event.label = label;
  issue.comments[0] = {
    ...issue.comments[0]!,
    body: `Settled as ${label} after reviewing the final diff.`,
  };
  issue.labels = issue.labels.filter((candidate) => !candidate.startsWith("delivered/"));
  issue.labels.push(label);
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("settlement evidence timing grace", () => {
  it("accepts a settled label applied shortly before the final commit", () => {
    const snapshot = outsiderFixture();
    setActualLabelAppliedAt(snapshot, "2026-09-01T09:50:00.000Z");
    setRationaleCommentAt(snapshot, "2026-09-01T09:55:00.000Z");

    expect(foldRepository(snapshot).settlements[0]).toMatchObject({ settledPoints: 6 });
  });

  it("rejects a settled label applied well before the final commit", () => {
    const snapshot = outsiderFixture();
    setActualLabelAppliedAt(snapshot, "2026-09-01T09:40:00.000Z");
    setRationaleCommentAt(snapshot, "2026-09-01T09:45:00.000Z");

    expect(foldRepository(snapshot).settlements[0]).toMatchObject({ settledPoints: null });
  });

  it("accepts a settled label applied shortly after the merge", () => {
    const snapshot = outsiderFixture();
    setActualLabelAppliedAt(snapshot, "2026-09-01T12:10:00.000Z");
    setRationaleCommentAt(snapshot, "2026-09-01T12:12:00.000Z");

    expect(foldRepository(snapshot).settlements[0]).toMatchObject({ settledPoints: 6 });
  });

  it("rejects a settled label applied well after the merge", () => {
    const snapshot = outsiderFixture();
    setActualLabelAppliedAt(snapshot, "2026-09-01T12:20:00.000Z");
    setRationaleCommentAt(snapshot, "2026-09-01T12:22:00.000Z");

    expect(foldRepository(snapshot).settlements[0]).toMatchObject({ settledPoints: null });
  });

  it("accepts a rationale comment posted shortly after the merge", () => {
    const snapshot = outsiderFixture();
    setRationaleCommentAt(snapshot, "2026-09-01T12:10:00.000Z");

    expect(foldRepository(snapshot).settlements[0]).toMatchObject({ settledPoints: 6 });
  });

  it("rejects a rationale comment posted well after the merge", () => {
    const snapshot = outsiderFixture();
    setRationaleCommentAt(snapshot, "2026-09-01T12:20:00.000Z");

    expect(foldRepository(snapshot).settlements[0]).toMatchObject({ settledPoints: null });
  });

  it("accepts a rationale comment posted shortly before its label", () => {
    const snapshot = outsiderFixture();
    setActualLabelAppliedAt(snapshot, "2026-09-01T11:00:00.000Z");
    setRationaleCommentAt(snapshot, "2026-09-01T10:50:00.000Z");

    expect(foldRepository(snapshot).settlements[0]).toMatchObject({ settledPoints: 6 });
  });

  it("rejects a rationale comment posted well before its label", () => {
    const snapshot = outsiderFixture();
    setActualLabelAppliedAt(snapshot, "2026-09-01T11:00:00.000Z");
    setRationaleCommentAt(snapshot, "2026-09-01T10:40:00.000Z");

    expect(foldRepository(snapshot).settlements[0]).toMatchObject({ settledPoints: null });
  });
});

function setActualLabelAppliedAt(snapshot: RepositoryFoldSnapshot, createdAt: string): void {
  const event = snapshot.issues[0]!.history.find(
    (candidate) => candidate.kind === "LABELED" && candidate.id === "actual-1",
  );
  if (event === undefined || event.kind !== "LABELED") {
    throw new Error("Actual fixture event was missing.");
  }
  event.createdAt = createdAt;
}

function setRationaleCommentAt(snapshot: RepositoryFoldSnapshot, createdAt: string): void {
  snapshot.issues[0]!.comments[0] = { ...snapshot.issues[0]!.comments[0]!, createdAt };
}
