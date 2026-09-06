import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  foldRepository,
  type RepositoryFoldSnapshot,
  type FoldUser,
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
      kind: "NO_CLOSING_PULL_REQUEST",
      githubPullRequestId: null,
      reason: "No merged GitHub GraphQL closing pull request was found.",
    });
  });

  it.each([
    "other/fork",
    // Same owner, and a name a reader could mistake for the registered one:
    // neither half of the name has any say, and the reason must still be legible.
    "octo/other-example",
  ])("refuses to settle a closing pull request that belongs to %s", (repositoryNameWithOwner) => {
    const snapshot = outsiderFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.repositoryGitHubId = 5002;
    snapshot.issues[0]!.closingPullRequests[0]!.repositoryNameWithOwner = repositoryNameWithOwner;

    const result = foldRepository(snapshot);

    expect(result.settlements).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    expect(result.selfWorkCalibrations).toEqual([]);
    expect(result.ledgerEntries).toEqual([]);
    expect(result.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "CROSS_REPOSITORY_CLOSING_PULL_REQUEST",
      githubPullRequestId: null,
      reason: expect.stringContaining(repositoryNameWithOwner),
    }]);
    expect(result.unwritableClosures[0]!.reason).toContain("11");
  });

  it("reports a foreign closing pull request without merge proof as no closing pull request", () => {
    const snapshot = outsiderFixture();
    const pullRequest = snapshot.issues[0]!.closingPullRequests[0]!;
    pullRequest.repositoryGitHubId = 5002;
    pullRequest.repositoryNameWithOwner = "other/fork";
    pullRequest.mergeCommitOid = "not-a-merge-commit-oid";

    const result = foldRepository(snapshot);

    // Nothing merged that clears the merge-proof checks, which is what the
    // older kind has always meant; the repository never comes into it.
    expect(result.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "NO_CLOSING_PULL_REQUEST",
      githubPullRequestId: null,
      reason: "No merged GitHub GraphQL closing pull request was found.",
    }]);
  });

  it("settles a closing pull request whose repository was renamed after registration", () => {
    const snapshot = outsiderFixture();
    // GitHub keeps answering for the stored owner/name and reports the new one,
    // so the registered name goes stale silently. The id is what did not move.
    snapshot.issues[0]!.closingPullRequests[0]!.repositoryNameWithOwner = "octo/renamed-example";

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([]);
    expect(result.settlements).toEqual([
      expect.objectContaining({ githubIssueId: 101, githubPullRequestId: 201, status: "SETTLED", credits: 6 }),
    ]);
  });

  it("refuses a closing pull request that merely reuses the registered repository's name", () => {
    const snapshot = outsiderFixture();
    // A freed owner/name can be taken by anyone once the original is renamed,
    // so a name that matches proves nothing about which repository this is.
    snapshot.issues[0]!.closingPullRequests[0]!.repositoryGitHubId = 5002;

    const result = foldRepository(snapshot);

    expect(result.settlements).toEqual([]);
    expect(result.pullRequests).toEqual([]);
    // Naming both repositories here would read "belongs to octo/example, not
    // the registered repository octo/example", which tells a moderator nothing.
    expect(result.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "CROSS_REPOSITORY_CLOSING_PULL_REQUEST",
      githubPullRequestId: null,
      reason: "Closing pull request 11 does not belong to the registered repository: "
        + "another repository now carries the name octo/example (GitHub repository 5002, not 5001).",
    }]);
  });

  it("settles the registered repository's closing pull request over one merged earlier elsewhere", () => {
    const snapshot = outsiderFixture();
    const registered = snapshot.issues[0]!.closingPullRequests[0]!;
    // Selection takes the earliest merge, so a foreign pull request merged
    // first displaces the real one unless the repository is checked.
    snapshot.issues[0]!.closingPullRequests.unshift({
      ...registered,
      id: 202,
      number: 12,
      url: "https://github.com/other/fork/pull/12",
      repositoryGitHubId: 5002,
      repositoryNameWithOwner: "other/fork",
      mergedAt: "2026-09-01T11:45:00.000Z",
      mergeCommitOid: "89abcdef0123456789abcdef0123456789abcdef",
      rawDiff: "foreign diff",
    });

    const result = foldRepository(snapshot);

    expect(result.settlements).toEqual([
      expect.objectContaining({ githubIssueId: 101, githubPullRequestId: 201, status: "SETTLED", credits: 6 }),
    ]);
    expect(result.pullRequests.map(({ githubPullRequestId }) => githubPullRequestId)).toEqual([201]);
    expect(result.unwritableClosures).toEqual([]);
  });

  it("subtracts each unique formal changes-requested review submitted before merge", () => {
    const result = foldRepository(twoReviewRoundsFixture());

    expect(result.settlements[0]?.credits).toBe(4);
    expect(result.settlements[0]?.reviewRounds).toBe(2);
  });

  it("excludes review rounds exactly at merge and one millisecond after merge", () => {
    const snapshot = outsiderFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.mergedAt = "2026-09-01T12:00:00.000Z";
    snapshot.issues[0]!.closingPullRequests[0]!.reviews = [
      { id: 301, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T11:59:59.999Z", dismissal: null },
      { id: 302, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T12:00:00.000Z", dismissal: null },
      { id: 303, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T12:00:00.001Z", dismissal: null },
    ];

    const result = foldRepository(snapshot);

    expect.soft(result.pullRequests[0]?.reviewRounds).toEqual([
      { githubReviewId: 301, submittedAt: "2026-09-01T11:59:59.999Z" },
    ]);
    expect(result.settlements).toEqual([
      expect.objectContaining({ settledPoints: 6, reviewRounds: 1, credits: 5 }),
    ]);
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
    snapshot.users.push({ id: "assignee", githubUserId: 3001, githubLogin: "claim-holder", enforcementState: "ACTIVE", moderationEvents: [] });
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
      { id: 301, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T11:00:00.000Z", dismissal: null },
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
      creditorGitHubUserId: 2001,
      credits: 6,
      proofSha256: sha256("diff"),
    });
  });

  it("credits the pull request author by immutable GitHub id, never by login", () => {
    const snapshot = outsiderFixture();
    // Same login as the joined contributor, different GitHub account.
    snapshot.issues[0]!.closingPullRequests[0]!.authorGitHubUserId = 9999;

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "UNCLAIMED",
      creditorId: null,
      creditorGitHubUserId: 9999,
      creditorGitHubLogin: "contributor",
      credits: 6,
    });
    expect(result.pullRequests[0]).toMatchObject({ authorId: null, authorGitHubUserId: 9999 });
    expect(result.ledgerEntries).toEqual([]);
  });

  it("still credits a contributor who renamed their GitHub account", () => {
    const snapshot = outsiderFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.authorLogin = "contributor-renamed";

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "SETTLED",
      creditorId: "contributor",
      creditorGitHubUserId: 2001,
      creditorGitHubLogin: "contributor-renamed",
      credits: 6,
    });
    expect(result.pullRequests[0]).toMatchObject({ authorId: "contributor", authorGitHubUserId: 2001 });
  });

  it("keeps a renamed sponsor's own work as calibration evidence", () => {
    const snapshot = selfWorkFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.authorLogin = "sponsor-renamed";

    const result = foldRepository(snapshot);

    expect(result.settlements).toEqual([]);
    expect(result.selfWorkCalibrations).toEqual([expect.objectContaining({ userId: "sponsor" })]);
    expect(result.pullRequests[0]).toMatchObject({ authorId: "sponsor", authorGitHubUserId: 1001 });
  });

  it.each(["release-bot[bot]", "contributor"])(
    "leaves a closing pull request by %s without an author id unclaimed and unclaimable",
    (authorLogin) => {
      const snapshot = outsiderFixture();
      snapshot.issues[0]!.closingPullRequests[0]!.authorLogin = authorLogin;
      snapshot.issues[0]!.closingPullRequests[0]!.authorGitHubUserId = null;

      const result = foldRepository(snapshot);

      expect(result.settlements[0]).toMatchObject({
        status: "UNCLAIMED",
        creditorId: null,
        creditorGitHubUserId: null,
        creditorGitHubLogin: authorLogin,
      });
      expect(result.pullRequests[0]).toMatchObject({ authorId: null, authorGitHubUserId: null });
      expect(result.ledgerEntries).toEqual([]);
    },
  );

  it.each([0, null])("never resolves a null author id to a sentinel user id %s", (githubUserId) => {
    const snapshot = outsiderFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.authorLogin = "release-bot[bot]";
    snapshot.issues[0]!.closingPullRequests[0]!.authorGitHubUserId = null;
    // Exercise malformed runtime input too; null is deliberately outside FoldUser's type.
    snapshot.users.push({
      id: "sentinel", githubUserId, githubLogin: "sentinel", enforcementState: "ACTIVE",
    } as unknown as FoldUser);

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "UNCLAIMED", creditorId: null, creditorGitHubUserId: null,
    });
    expect(result.pullRequests[0]).toMatchObject({ authorId: null, authorGitHubUserId: null });
    expect(result.ledgerEntries).toEqual([]);
  });

  it("distinguishes an outsider from a sponsor sharing the same display login", () => {
    const snapshot = outsiderFixture();
    snapshot.users.find((user) => user.id === "contributor")!.githubLogin = "sponsor";
    snapshot.issues[0]!.closingPullRequests[0]!.authorLogin = "sponsor";

    const result = foldRepository(snapshot);

    expect(result.selfWorkCalibrations).toEqual([]);
    expect(result.settlements[0]).toMatchObject({
      status: "SETTLED", creditorId: "contributor", creditorGitHubUserId: 2001, credits: 6,
    });
    expect(result.pullRequests[0]).toMatchObject({ authorId: "contributor", authorGitHubUserId: 2001 });
    expect(result.ledgerEntries).toEqual([
      { accountId: "contributor", counterpartyId: "sponsor", amount: 6 },
      { accountId: "sponsor", counterpartyId: "contributor", amount: -6 },
    ]);
  });

  it("keeps self-work when repository and member reads have different sponsor logins", () => {
    const snapshot = selfWorkFixture();
    snapshot.users.find((user) => user.id === "sponsor")!.githubLogin = "sponsor-renamed";

    const result = foldRepository(snapshot);

    expect(result.settlements).toEqual([]);
    expect(result.selfWorkCalibrations).toEqual([expect.objectContaining({ userId: "sponsor" })]);
    expect(result.pullRequests[0]).toMatchObject({ authorId: "sponsor", authorGitHubUserId: 1001 });
    expect(result.ledgerEntries).toEqual([]);
  });

  it("resolves a known author id even when the display login is null", () => {
    const snapshot = outsiderFixture();
    snapshot.issues[0]!.closingPullRequests[0]!.authorLogin = null;

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "SETTLED", creditorId: "contributor", creditorGitHubUserId: 2001,
      creditorGitHubLogin: null, credits: 6,
    });
    expect(result.pullRequests[0]).toMatchObject({ authorId: "contributor", authorGitHubUserId: 2001 });
    expect(result.ledgerEntries).toEqual([
      { accountId: "contributor", counterpartyId: "sponsor", amount: 6 },
      { accountId: "sponsor", counterpartyId: "contributor", amount: -6 },
    ]);
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

  it.each(["BANNED", "RECALIBRATING"] as const)(
    "keeps historical settlements ineligible after an audit preserves %s",
    (state) => {
      const snapshot = outsiderFixture();
      const contributor = snapshot.users.find((user) => user.id === "contributor")!;
      contributor.enforcementState = "ACTIVE";
      contributor.moderationEvents = [
        { id: "restriction", priorState: "WARNED", newState: state, occurredAt: "2026-09-01T08:00:00.000Z" },
        { id: "audit-opened", priorState: state, newState: state, occurredAt: "2026-09-01T09:00:00.000Z" },
        { id: "later-reactivation", priorState: state, newState: "ACTIVE", occurredAt: "2026-09-02T09:00:00.000Z" },
      ];

      const result = foldRepository(snapshot);

      expect(result.settlements).toEqual([]);
      expect(result.ledgerEntries).toEqual([]);
    },
  );

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
  snapshot.issues[0]!.closingPullRequests[0]!.authorGitHubUserId = 1001;
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
    { id: 301, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T10:00:00.000Z", dismissal: null },
    { id: 301, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T10:01:00.000Z", dismissal: null },
    { id: 302, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T11:00:00.000Z", dismissal: null },
    { id: 303, state: "COMMENTED", submittedAt: "2026-09-01T11:30:00.000Z", dismissal: null },
    { id: 304, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T13:00:00.000Z", dismissal: null },
  ];
  return snapshot;
}

function outsiderFixture(): RepositoryFoldSnapshot {
  return {
    repository: {
      id: "repository",
      githubRepositoryId: 5001,
      ownerName: "octo/example",
      active: true,
      registeredAt: "2026-01-01T00:00:00.000Z",
      sponsor: { id: "sponsor", githubUserId: 1001, githubLogin: "sponsor", enforcementState: "ACTIVE", moderationEvents: [] },
      difficultyScheme: difficultyScheme(),
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
        createdAt: "2026-08-30T09:00:00.000Z",
        closedAt: "2026-09-01T12:00:00.000Z",
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

describe("rejected settlement closure records", () => {
  it("records that no configured actual label stood inside the window", () => {
    const snapshot = outsiderFixture();
    snapshot.issues[0]!.history = snapshot.issues[0]!.history.filter((event) => event.id !== "actual-1");

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "SETTLEMENT_EVIDENCE_REJECTED",
      githubPullRequestId: 201,
      reason: "No configured actual-catalog label was standing on the issue by fifteen minutes after the merge at 2026-09-01T12:00:00.000Z.",
    }]);
    expect(result.issues[0]).toMatchObject({ settledLabel: null, settledPoints: null });
    expect(result.settlements[0]).toMatchObject({ status: "UNSETTLED", settledPoints: null, credits: 0 });
    expect(result.ledgerEntries).toEqual([]);
  });

  it("records the earliest later actual label application from unordered history", () => {
    const snapshot = outsiderFixture();
    setActualLabelAppliedAt(snapshot, "2026-09-01T12:40:00.000Z");
    reapplyActualLabel(snapshot, {
      unlabeledAt: "2026-09-01T12:18:00.000Z",
      relabeledAt: "2026-09-01T12:20:00.000Z",
    });
    snapshot.issues[0]!.history.push({
      kind: "LABELED", id: "unconfigured", actorLogin: "sponsor",
      label: "unconfigured", createdAt: "2026-09-01T12:16:00.000Z",
    });

    expect(foldRepository(snapshot).unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "SETTLEMENT_EVIDENCE_REJECTED",
      githubPullRequestId: 201,
      reason: "No configured actual-catalog label was standing on the issue by fifteen minutes after the merge at 2026-09-01T12:00:00.000Z. The earliest later application, `delivered/6` at 2026-09-01T12:20:00.000Z, came after that window.",
    }]);
  });

  it("records several standing labels in active-map order", () => {
    const snapshot = outsiderFixture();
    snapshot.issues[0]!.history.unshift({
      kind: "LABELED", id: "another-actual", actorLogin: "sponsor",
      label: "delivered/3", createdAt: "2026-09-01T11:10:00.000Z",
    });

    expect(foldRepository(snapshot).unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "SETTLEMENT_EVIDENCE_REJECTED",
      githubPullRequestId: 201,
      reason: "Several actual-catalog labels were standing on the issue by fifteen minutes after the merge at 2026-09-01T12:00:00.000Z: `delivered/6`, `delivered/3`. Exactly one is required.",
    }]);
  });

  it.each([
    ["contributor", "The settled label `delivered/6` was applied by `contributor` rather than the repository sponsor `sponsor`."],
    ["  ", "The settled label `delivered/6` was applied by `unknown` rather than the repository sponsor `sponsor`."],
    [null, "The settled label `delivered/6` was applied by `unknown` rather than the repository sponsor `sponsor`."],
  ])("records a settled label actor of %s who is not the sponsor", (actorLogin, reason) => {
    const snapshot = outsiderFixture();
    snapshot.issues[0]!.history[1]!.actorLogin = actorLogin;

    expect(foldRepository(snapshot).unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "SETTLEMENT_EVIDENCE_REJECTED",
      githubPullRequestId: 201,
      reason,
    }]);
  });

  it("records a standing label applied outside the final-commit window", () => {
    const snapshot = outsiderFixture();
    setActualLabelAppliedAt(snapshot, "2026-09-01T09:40:00.000Z");
    setRationaleCommentAt(snapshot, "2026-09-01T09:45:00.000Z");

    expect(foldRepository(snapshot).unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "SETTLEMENT_EVIDENCE_REJECTED",
      githubPullRequestId: 201,
      reason: "The settled label `delivered/6` was applied at 2026-09-01T09:40:00.000Z, outside the window from fifteen minutes before the final commit at 2026-09-01T10:00:00.000Z to fifteen minutes after the merge at 2026-09-01T12:00:00.000Z.",
    }]);
  });

  it("records the lack of a qualifying sponsor rationale for the standing label", () => {
    const snapshot = outsiderFixture();
    setRationaleCommentAt(snapshot, "2026-09-01T12:20:00.000Z");

    expect(foldRepository(snapshot).unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "SETTLEMENT_EVIDENCE_REJECTED",
      githubPullRequestId: 201,
      reason: "No rationale comment by `sponsor` naming `delivered/6` was posted between fifteen minutes before the label at 2026-09-01T11:00:00.000Z and fifteen minutes after the merge at 2026-09-01T12:00:00.000Z.",
    }]);
  });

  it("emits no unwritable closure when settlement evidence is accepted", () => {
    const result = foldRepository(outsiderFixture());

    expect(result.unwritableClosures).toEqual([]);
    expect(result.settlements[0]).toMatchObject({ status: "SETTLED", settledPoints: 6 });
  });

  it("records rejected self-work evidence and retains its calibration with null actual points", () => {
    const snapshot = selfWorkFixture();
    setRationaleCommentAt(snapshot, "2026-09-01T12:20:00.000Z");

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "SETTLEMENT_EVIDENCE_REJECTED",
      githubPullRequestId: 201,
      reason: "No rationale comment by `sponsor` naming `delivered/6` was posted between fifteen minutes before the label at 2026-09-01T11:00:00.000Z and fifteen minutes after the merge at 2026-09-01T12:00:00.000Z.",
    }]);
    expect(result.selfWorkCalibrations).toEqual([expect.objectContaining({
      githubIssueId: 101, githubPullRequestId: 201, userId: "sponsor", actualPoints: null,
    })]);
    // Both halves of the impossibility the correction queue relies on, in one
    // arrangement: the queue branches a calibration's figure on the points
    // alone because absent points imply an absent label, and pinning the two in
    // different fixtures would let either half move without a control failing.
    expect(result.issues[0]).toMatchObject({ settledLabel: null, settledPoints: null });
    expect(result.settlements).toEqual([]);
    expect(result.ledgerEntries).toEqual([]);
  });

  it.each(["author", "sponsor"])("records rejected evidence even for an ineligible %s", (participant) => {
    const snapshot = outsiderFixture();
    const user = participant === "sponsor"
      ? snapshot.repository.sponsor
      : snapshot.users.find((user) => user.id === "contributor")!;
    user.enforcementState = "BANNED";
    setRationaleCommentAt(snapshot, "2026-09-01T12:20:00.000Z");

    const result = foldRepository(snapshot);

    expect(result.unwritableClosures).toEqual([{
      githubIssueId: 101,
      kind: "SETTLEMENT_EVIDENCE_REJECTED",
      githubPullRequestId: 201,
      reason: "No rationale comment by `sponsor` naming `delivered/6` was posted between fifteen minutes before the label at 2026-09-01T11:00:00.000Z and fifteen minutes after the merge at 2026-09-01T12:00:00.000Z.",
    }]);
    expect(result.pullRequests).toHaveLength(1);
    expect(result.settlements).toEqual([]);
    expect(result.selfWorkCalibrations).toEqual([]);
    expect(result.ledgerEntries).toEqual([]);
  });

  it("sorts unwritable closures by issue id across both rejection kinds", () => {
    const snapshot = outsiderFixture();
    setRationaleCommentAt(snapshot, "2026-09-01T12:20:00.000Z");
    const noClosingPullRequest = structuredClone(snapshot.issues[0]!);
    noClosingPullRequest.id = 100;
    noClosingPullRequest.closingPullRequests = [];
    snapshot.issues.push(noClosingPullRequest);

    expect(foldRepository(snapshot).unwritableClosures).toEqual([
      {
        githubIssueId: 100,
        kind: "NO_CLOSING_PULL_REQUEST",
        githubPullRequestId: null,
        reason: "No merged GitHub GraphQL closing pull request was found.",
      },
      {
        githubIssueId: 101,
        kind: "SETTLEMENT_EVIDENCE_REJECTED",
        githubPullRequestId: 201,
        reason: "No rationale comment by `sponsor` naming `delivered/6` was posted between fifteen minutes before the label at 2026-09-01T11:00:00.000Z and fifteen minutes after the merge at 2026-09-01T12:00:00.000Z.",
      },
    ]);
  });
});

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

  it("accepts a settled label applied exactly fifteen minutes after the merge", () => {
    const snapshot = outsiderFixture();
    setActualLabelAppliedAt(snapshot, "2026-09-01T12:15:00.000Z");
    setRationaleCommentAt(snapshot, "2026-09-01T12:05:00.000Z");

    expect(foldRepository(snapshot).settlements[0]).toMatchObject({ settledPoints: 6 });
  });

  it("rejects a settled label applied fifteen minutes and one millisecond after the merge", () => {
    const snapshot = outsiderFixture();
    setActualLabelAppliedAt(snapshot, "2026-09-01T12:15:00.001Z");
    setRationaleCommentAt(snapshot, "2026-09-01T12:05:00.000Z");

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

  it("accepts a rationale comment posted exactly fifteen minutes before its label", () => {
    const snapshot = outsiderFixture();
    setActualLabelAppliedAt(snapshot, "2026-09-01T11:00:00.000Z");
    setRationaleCommentAt(snapshot, "2026-09-01T10:45:00.000Z");

    expect(foldRepository(snapshot).settlements[0]).toMatchObject({ settledPoints: 6 });
  });

  it("rejects a rationale comment posted fifteen minutes and one millisecond before its label", () => {
    const snapshot = outsiderFixture();
    setActualLabelAppliedAt(snapshot, "2026-09-01T11:00:00.000Z");
    setRationaleCommentAt(snapshot, "2026-09-01T10:44:59.999Z");

    expect(foldRepository(snapshot).settlements[0]).toMatchObject({ settledPoints: null });
  });
});

describe("settlement rationale pairing", () => {
  it("records a reapplied label against the rationale written for it", () => {
    const snapshot = outsiderFixture();
    reapplyActualLabel(snapshot, {
      unlabeledAt: "2026-09-01T11:35:00.000Z",
      relabeledAt: "2026-09-01T11:40:00.000Z",
    });
    snapshot.issues[0]!.comments.push({
      id: "comment-2",
      databaseId: 402,
      authorLogin: "sponsor",
      body: "Re-settled as delivered/6 after reapplying the label.",
      createdAt: "2026-09-01T11:41:00.000Z",
      lastEditedAt: null,
    });

    expect(foldRepository(snapshot).issues[0]).toMatchObject({
      settledLabelEventId: "actual-2",
      settledLabelAppliedAt: "2026-09-01T11:40:00.000Z",
      settledRationaleCommentId: "comment-2",
      settledRationaleCommentedAt: "2026-09-01T11:41:00.000Z",
    });
  });

  it("prefers a rationale at or after the label over one inside the grace window before it", () => {
    const snapshot = outsiderFixture();
    setRationaleCommentAt(snapshot, "2026-09-01T10:50:00.000Z");
    snapshot.issues[0]!.comments.push({
      id: "comment-2",
      databaseId: 402,
      authorLogin: "sponsor",
      body: "Settled as delivered/6 after reviewing the final diff.",
      createdAt: "2026-09-01T11:05:00.000Z",
      lastEditedAt: null,
    });

    expect(foldRepository(snapshot).issues[0]).toMatchObject({
      settledLabelEventId: "actual-1",
      settledRationaleCommentId: "comment-2",
    });
  });

  it("prefers a rationale exactly at the label over earlier and later rationales", () => {
    const snapshot = outsiderFixture();
    setRationaleCommentAt(snapshot, "2026-09-01T10:50:00.000Z");
    snapshot.issues[0]!.comments.push(
      {
        id: "comment-2",
        databaseId: 402,
        authorLogin: "sponsor",
        body: "Settled as delivered/6 while applying the label.",
        createdAt: "2026-09-01T11:00:00.000Z",
        lastEditedAt: null,
      },
      {
        id: "comment-3",
        databaseId: 403,
        authorLogin: "sponsor",
        body: "Still delivered/6 after reviewing the final diff.",
        createdAt: "2026-09-01T11:05:00.000Z",
        lastEditedAt: null,
      },
    );

    expect(foldRepository(snapshot).issues[0]).toMatchObject({
      settledRationaleCommentId: "comment-2",
    });
  });

  it("keeps the earliest rationale when several follow the label", () => {
    const snapshot = outsiderFixture();
    snapshot.issues[0]!.comments.push({
      id: "comment-2",
      databaseId: 402,
      authorLogin: "sponsor",
      body: "Still delivered/6 on a second look.",
      createdAt: "2026-09-01T11:45:00.000Z",
      lastEditedAt: null,
    });

    expect(foldRepository(snapshot).issues[0]).toMatchObject({
      settledRationaleCommentId: "comment-1",
    });
  });

  it("falls back to a rationale inside the grace window before a reapplied label when nothing later qualifies", () => {
    const snapshot = outsiderFixture();
    reapplyActualLabel(snapshot, {
      unlabeledAt: "2026-09-01T11:35:00.000Z",
      relabeledAt: "2026-09-01T11:40:00.000Z",
    });

    expect(foldRepository(snapshot).issues[0]).toMatchObject({
      settledLabelEventId: "actual-2",
      settledLabelAppliedAt: "2026-09-01T11:40:00.000Z",
      settledRationaleCommentId: "comment-1",
      settledRationaleCommentedAt: "2026-09-01T11:30:00.000Z",
    });
  });

  it("skips an edited rationale at the reapplied label and prefers the first valid later one over the grace fallback", () => {
    const snapshot = outsiderFixture();
    reapplyActualLabel(snapshot, {
      unlabeledAt: "2026-09-01T11:35:00.000Z",
      relabeledAt: "2026-09-01T11:40:00.000Z",
    });
    const issue = snapshot.issues[0]!;
    issue.comments.push(
      {
        ...issue.comments[0]!,
        id: "comment-2",
        databaseId: 402,
        createdAt: "2026-09-01T11:40:00.000Z",
        lastEditedAt: "2026-09-01T12:15:00.001Z",
      },
      {
        ...issue.comments[0]!,
        id: "comment-4",
        databaseId: 404,
        createdAt: "2026-09-01T11:45:00.000Z",
      },
      {
        ...issue.comments[0]!,
        id: "comment-3",
        databaseId: 403,
        createdAt: "2026-09-01T11:41:00.000Z",
      },
    );

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: "SETTLED",
      settledPoints: 6,
      settledLabelEventId: "actual-2",
      settledRationaleCommentId: "comment-3",
    });
    expect(result.policyViolations).toEqual([]);
  });

  it.each([
    { fallback: "valid", lastEditedAt: null, accepted: true },
    { fallback: "edited after close", lastEditedAt: "2026-09-01T12:15:00.001Z", accepted: false },
  ])("handles a $fallback grace fallback when the reapplied label's own rationale was edited after close", ({ lastEditedAt, accepted }) => {
    const snapshot = outsiderFixture();
    reapplyActualLabel(snapshot, {
      unlabeledAt: "2026-09-01T11:35:00.000Z",
      relabeledAt: "2026-09-01T11:40:00.000Z",
    });
    const issue = snapshot.issues[0]!;
    issue.comments[0]!.lastEditedAt = lastEditedAt;
    issue.comments.push({
      ...issue.comments[0]!,
      id: "comment-2",
      databaseId: 402,
      createdAt: "2026-09-01T11:40:00.000Z",
      lastEditedAt: "2026-09-01T12:15:00.001Z",
    });

    const result = foldRepository(snapshot);

    expect(result.settlements[0]).toMatchObject({
      status: accepted ? "SETTLED" : "UNSETTLED",
      settledPoints: accepted ? 6 : null,
      settledLabelEventId: accepted ? "actual-2" : null,
      settledRationaleCommentId: accepted ? "comment-1" : null,
    });
    expect(result.policyViolations).toEqual(
      accepted ? [] : [{ code: "SETTLED_RATIONALE_EDITED", githubIssueId: 101 }],
    );
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

function reapplyActualLabel(
  snapshot: RepositoryFoldSnapshot,
  times: { unlabeledAt: string; relabeledAt: string },
): void {
  snapshot.issues[0]!.history.push(
    {
      kind: "UNLABELED",
      id: "actual-1-removed",
      actorLogin: "sponsor",
      label: "delivered/6",
      createdAt: times.unlabeledAt,
    },
    {
      kind: "LABELED",
      id: "actual-2",
      actorLogin: "sponsor",
      label: "delivered/6",
      createdAt: times.relabeledAt,
    },
  );
}

describe("opening evidence timing grace", () => {
  it("resolves an opening label applied moments after the first assignment", () => {
    const snapshot = outsiderFixture();
    assignAt(snapshot, "2026-08-30T09:59:58.000Z");

    expect(foldRepository(snapshot).issues[0]).toMatchObject({
      openingLabel: "M",
      openingComparisonPoints: 5,
      openingSourceEventId: "opening-1",
    });
  });

  it("keeps the issue out of the fold when the opening label is applied well after the first assignment", () => {
    const snapshot = outsiderFixture();
    assignAt(snapshot, "2026-08-30T09:44:00.000Z");

    expect(foldRepository(snapshot).issues).toHaveLength(0);
    expect(foldRepository(snapshot).policyViolations).toContainEqual({
      code: "OPENING_LABEL_MISSING",
      githubIssueId: 101,
    });
  });

  it("still resolves an opening label applied before any assignment", () => {
    const snapshot = outsiderFixture();
    assignAt(snapshot, "2026-08-30T11:00:00.000Z");

    expect(foldRepository(snapshot).issues[0]).toMatchObject({ openingLabel: "M" });
  });
});

function assignAt(snapshot: RepositoryFoldSnapshot, createdAt: string): void {
  snapshot.issues[0]!.history.push({
    kind: "ASSIGNED",
    id: "assignment-1",
    actorLogin: "sponsor",
    assigneeLogin: "contributor",
    createdAt,
  });
}
