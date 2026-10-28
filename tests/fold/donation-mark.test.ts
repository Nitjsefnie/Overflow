import { describe, expect, it } from "vitest";
import { attachDonationMarks, donatedSettlement } from "@/lib/fold/donation-mark";
import { foldRepository, type FoldResult, type FoldSettlement, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";
import { applyGrantedSettlementOverride } from "@/lib/overrides/apply";
import type { GitHubIssueComment } from "@/lib/github/types";

const SPONSOR_ID = 1001;
const CONTRIBUTOR_ID = 2001;
const MERGED_AT = "2026-09-01T12:00:00.000Z";

describe("attachDonationMarks", () => {
  it("marks a settlement whose pull request author wrote /donate before the merge", () => {
    const snapshot = donationFixture([donate("donate-1", "2026-09-01T11:45:00.000Z")]);

    const settlement = attachedSettlement(snapshot);

    expect(settlement).toMatchObject({ status: "SETTLED", donationCommentId: "donate-1" });
    expect(donatedSettlement(settlement)).toMatchObject({
      status: "DONATED", donationCommentId: "donate-1", settledPoints: 6, reviewRounds: 0, credits: 6, creditorId: "contributor",
    });
  });

  it("leaves a settlement without a /donate comment unmarked and paid", () => {
    const settlement = attachedSettlement(donationFixture([]));

    expect(settlement.donationCommentId).toBeNull();
    expect(donatedSettlement(settlement)).toMatchObject({ status: "SETTLED", donationCommentId: null, credits: 6 });
  });

  it("ignores a /donate written by anyone but the pull request author, decided by the forge user id", () => {
    const sponsor = { ...donate("donate-1", "2026-09-01T11:45:00.000Z"), authorLogin: "sponsor", authorGitHubUserId: SPONSOR_ID };
    const sameLoginOtherAccount = { ...donate("donate-2", "2026-09-01T11:45:00.000Z"), authorGitHubUserId: 3001 };
    const loginWithoutId = { ...donate("donate-3", "2026-09-01T11:45:00.000Z"), authorGitHubUserId: null };

    for (const comment of [sponsor, sameLoginOtherAccount, loginWithoutId]) {
      expect(attachedSettlement(donationFixture([comment])).donationCommentId).toBeNull();
    }
  });

  it("never marks when the pull request author carries no forge user id", () => {
    const snapshot = donationFixture([{ ...donate("donate-1", "2026-09-01T11:45:00.000Z"), authorGitHubUserId: null }]);
    snapshot.issues[0]!.closingPullRequests[0]!.authorGitHubUserId = null;

    expect(attachedSettlement(snapshot).donationCommentId).toBeNull();
  });

  it("counts a mark written at the merge instant and refuses one written after it", () => {
    expect(attachedSettlement(donationFixture([donate("donate-1", MERGED_AT)])).donationCommentId).toBe("donate-1");
    expect(attachedSettlement(donationFixture([donate("donate-1", "2026-09-01T12:00:00.001Z")])).donationCommentId).toBeNull();
  });

  it("never counts an edited /donate, whenever it was edited", () => {
    const editedBeforeMerge = { ...donate("donate-1", "2026-09-01T11:00:00.000Z"), lastEditedAt: "2026-09-01T11:01:00.000Z" };
    const editedAfterMerge = { ...donate("donate-1", "2026-09-01T11:00:00.000Z"), lastEditedAt: "2026-09-02T09:00:00.000Z" };

    for (const comment of [editedBeforeMerge, editedAfterMerge]) {
      expect(attachedSettlement(donationFixture([comment])).donationCommentId).toBeNull();
    }
  });

  it("matches the trimmed body exactly", () => {
    const padded = { ...donate("donate-1", "2026-09-01T11:45:00.000Z"), body: "  /donate\n" };
    expect(attachedSettlement(donationFixture([padded])).donationCommentId).toBe("donate-1");

    for (const body of ["/donate please", "/Donate", "`/donate`", "/donated", "", "   "]) {
      const comment = { ...donate("donate-1", "2026-09-01T11:45:00.000Z"), body };
      expect(attachedSettlement(donationFixture([comment])).donationCommentId).toBeNull();
    }
  });

  it("passes over a comment the forge reported without an id or a readable time", () => {
    const noId = { ...donate("", "2026-09-01T11:00:00.000Z") };
    const noTime = { ...donate("donate-2", "not a time") };

    expect(attachedSettlement(donationFixture([noId, noTime])).donationCommentId).toBeNull();
  });

  it("picks the earliest qualifying mark, then the smaller databaseId, whatever the arrival order", () => {
    const later = { ...donate("donate-late", "2026-09-01T11:50:00.000Z"), databaseId: 1 };
    const tiedHigh = { ...donate("donate-high", "2026-09-01T11:40:00.000Z"), databaseId: 20 };
    const tiedLow = { ...donate("donate-low", "2026-09-01T11:40:00.000Z"), databaseId: 10 };
    const comments = [later, tiedHigh, tiedLow];

    expect(attachedSettlement(donationFixture(comments)).donationCommentId).toBe("donate-low");
    expect(attachedSettlement(donationFixture([...comments].reverse())).donationCommentId).toBe("donate-low");
  });

  it("picks one mark among same-instant marks that carry no databaseId, whatever the arrival order", () => {
    const comments = [
      { ...donate("donate-b", "2026-09-01T11:40:00.000Z"), databaseId: null },
      { ...donate("donate-a", "2026-09-01T11:40:00.000Z"), databaseId: null },
    ];

    expect(attachedSettlement(donationFixture(comments)).donationCommentId).toBe("donate-a");
    expect(attachedSettlement(donationFixture([...comments].reverse())).donationCommentId).toBe("donate-a");
  });

  it("keeps sponsor self-work a self-work calibration, even with a /donate on it", () => {
    const snapshot = donationFixture([{ ...donate("donate-1", "2026-09-01T11:45:00.000Z"), authorLogin: "sponsor", authorGitHubUserId: SPONSOR_ID }]);
    snapshot.issues[0]!.closingPullRequests[0]!.authorLogin = "sponsor";
    snapshot.issues[0]!.closingPullRequests[0]!.authorGitHubUserId = SPONSOR_ID;
    const fold = foldRepository(snapshot);

    const attached = attachDonationMarks(fold, fresh(snapshot));

    expect(attached.settlements).toEqual([]);
    expect(attached.selfWorkCalibrations).toEqual(fold.selfWorkCalibrations);
    expect(attached.selfWorkCalibrations).toHaveLength(1);
  });

  it("leaves an unsettled settlement unsettled and writes no mark on it", () => {
    const snapshot = donationFixture([donate("donate-1", "2026-09-01T11:45:00.000Z")]);
    snapshot.issues[0]!.comments = snapshot.issues[0]!.comments.filter((comment) => comment.id !== "rationale-1");

    const settlement = attachedSettlement(snapshot);

    expect(settlement).toMatchObject({ status: "UNSETTLED", donationCommentId: "donate-1" });
    expect(donatedSettlement(settlement)).toEqual({ ...settlement, donationCommentId: null });
  });

  it("donates the work of an author with no account, keeping the creditor null and the login", () => {
    const snapshot = donationFixture([donate("donate-1", "2026-09-01T11:45:00.000Z")]);
    snapshot.users = snapshot.users.filter((user) => user.id !== "contributor");

    const settlement = attachedSettlement(snapshot);

    expect(settlement).toMatchObject({ status: "UNCLAIMED", donationCommentId: "donate-1" });
    expect(donatedSettlement(settlement)).toMatchObject({
      status: "DONATED", creditorId: null, creditorGitHubLogin: "contributor", creditorGitHubUserId: CONTRIBUTOR_ID,
      donationCommentId: "donate-1", settledPoints: 6, credits: 6,
    });
  });

  it("matches a GitLab merge request author by the forge user id on the same instance", () => {
    const snapshot = donationFixture([donate("donate-1", "2026-09-01T11:45:00.000Z")]);
    snapshot.repository.provider = "gitlab";
    snapshot.repository.instanceUrl = "https://gitlab.example.test";
    snapshot.forgeIdentities = [{ user: snapshot.users.find((user) => user.id === "contributor")!, forgeUserId: CONTRIBUTOR_ID }];
    snapshot.users = [];

    const settlement = attachedSettlement(snapshot);

    expect(settlement).toMatchObject({ provider: "gitlab", status: "SETTLED", creditorId: "contributor", donationCommentId: "donate-1" });
    expect(donatedSettlement(settlement).status).toBe("DONATED");
  });

  it("reads marks only from issues read fresh this pass, and leaves the fold it was given untouched", () => {
    const snapshot = donationFixture([donate("donate-1", "2026-09-01T11:45:00.000Z")]);
    const fold = foldRepository(snapshot);
    const before = structuredClone(fold);
    // The evidence cache keeps no issue body and replaces every nonblank comment body.
    const cached = snapshot.issues.map((issue) => ({
      ...issue, comments: issue.comments.map((comment) => ({ ...comment, body: "[body removed]" })),
    }));

    const fromCache = attachDonationMarks(fold, cached);
    const fromFresh = attachDonationMarks(fold, fresh(snapshot));

    expect("donationCommentId" in fromCache.settlements[0]!).toBe(false);
    expect(fromFresh.settlements[0]!.donationCommentId).toBe("donate-1");
    expect(fold).toEqual(before);
    expect(attachDonationMarks(fold, fresh(snapshot))).toEqual(fromFresh);
  });

  it("reads the author of the pull request the settlement names, not another closing pull request's", () => {
    const snapshot = donationFixture([donate("donate-1", "2026-09-01T11:45:00.000Z")]);
    const settledFold = foldRepository(snapshot);
    const issues = fresh(snapshot);
    issues[0]!.closingPullRequests = [
      { ...issues[0]!.closingPullRequests[0]!, id: 999, authorGitHubUserId: CONTRIBUTOR_ID },
      { ...issues[0]!.closingPullRequests[0]!, authorGitHubUserId: 3001 },
    ];

    expect(attachDonationMarks(settledFold, issues).settlements[0]!.donationCommentId).toBeNull();
  });
});

describe("donatedSettlement", () => {
  const settled = (donationCommentId?: string | null): FoldSettlement => {
    const settlement = attachedSettlement(donationFixture([]));
    const { donationCommentId: _absent, ...rest } = settlement;
    void _absent;
    return donationCommentId === undefined ? rest : { ...rest, donationCommentId };
  };
  const stored = (donationCommentId: string | null, githubPullRequestId: number | string = 201) => ({
    github_pull_request_id: githubPullRequestId, donation_comment_id: donationCommentId,
  });

  it("keeps the stored mark for an issue not read fresh this pass, while it names the same pull request", () => {
    expect(donatedSettlement(settled(), stored("donate-1"))).toMatchObject({ status: "DONATED", donationCommentId: "donate-1" });
    expect(donatedSettlement(settled(), stored("donate-1", "201"))).toMatchObject({ status: "DONATED", donationCommentId: "donate-1" });
    expect(donatedSettlement(settled(), stored("donate-1", 202))).toMatchObject({ status: "SETTLED", donationCommentId: null });
    expect(donatedSettlement(settled(), stored(null))).toMatchObject({ status: "SETTLED", donationCommentId: null });
    expect(donatedSettlement(settled())).toMatchObject({ status: "SETTLED", donationCommentId: null });
  });

  it("lets a fresh read override the stored mark both ways", () => {
    expect(donatedSettlement(settled(null), stored("donate-1"))).toMatchObject({ status: "SETTLED", donationCommentId: null });
    expect(donatedSettlement(settled("donate-2"), stored("donate-1"))).toMatchObject({ status: "DONATED", donationCommentId: "donate-2" });
  });

  it("changes nothing on a donated settlement but its status and mark", () => {
    const settlement = settled("donate-1");

    expect(donatedSettlement(settlement)).toEqual({ ...settlement, status: "DONATED" });
  });

  it("keeps a moderator-corrected settlement donated, at the corrected figure", () => {
    const corrected = donatedSettlement(applyGrantedSettlementOverride({ ...settled("donate-1"), reviewRounds: 1 }, 4));

    expect(corrected).toMatchObject({ status: "DONATED", donationCommentId: "donate-1", settledPoints: 4, credits: 3 });
  });
});

function attachedSettlement(snapshot: RepositoryFoldSnapshot): FoldSettlement {
  const attached: FoldResult = attachDonationMarks(foldRepository(snapshot), fresh(snapshot));
  expect(attached.settlements).toHaveLength(1);
  return attached.settlements[0]!;
}

/** The snapshot's issues as a fresh read leaves them: carrying a body. */
function fresh(snapshot: RepositoryFoldSnapshot) {
  return snapshot.issues.map((issue) => ({ ...issue, body: "" }));
}

function donate(id: string, createdAt: string): GitHubIssueComment {
  return { id, databaseId: 500, authorLogin: "contributor", authorGitHubUserId: CONTRIBUTOR_ID, body: "/donate", createdAt, lastEditedAt: null };
}

/** One closed issue the sponsor settled at delivered/6, closed by the contributor's merged pull request. */
function donationFixture(extraComments: GitHubIssueComment[]): RepositoryFoldSnapshot {
  const sponsor = { id: "sponsor", githubUserId: SPONSOR_ID, githubLogin: "sponsor", enforcementState: "ACTIVE" as const, moderationEvents: [] };
  const contributor = { id: "contributor", githubUserId: CONTRIBUTOR_ID, githubLogin: "contributor", enforcementState: "ACTIVE" as const, moderationEvents: [] };
  return {
    repository: {
      id: "repository",
      githubRepositoryId: 5001,
      ownerName: "octo/example",
      active: true,
      registeredAt: "2026-01-01T00:00:00.000Z",
      sponsor,
      difficultySchemeVersions: [],
      difficultyScheme: {
        openingName: "Size",
        actualName: "Delivered",
        openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
        actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
      },
    },
    users: [sponsor, contributor],
    issues: [
      {
        id: 101,
        number: 1,
        title: "Issue",
        url: "https://github.com/octo/example/issues/1",
        state: "CLOSED",
        stateReason: "COMPLETED",
        createdAt: "2026-08-30T09:00:00.000Z",
        updatedAt: "2026-09-01T12:05:00.000Z",
        closedAt: "2026-09-01T12:05:00.000Z",
        authorLogin: "sponsor",
        authorGitHubUserId: SPONSOR_ID,
        labels: ["M", "delivered/6"],
        history: [
          { kind: "LABELED", id: "opening-1", actorLogin: "sponsor", actorGitHubUserId: SPONSOR_ID, label: "M", createdAt: "2026-08-30T10:00:00.000Z" },
          { kind: "LABELED", id: "actual-1", actorLogin: "sponsor", actorGitHubUserId: SPONSOR_ID, label: "delivered/6", createdAt: "2026-09-01T11:00:00.000Z" },
        ],
        comments: [
          {
            id: "rationale-1", databaseId: 401, authorLogin: "sponsor", authorGitHubUserId: SPONSOR_ID,
            body: "Settled as delivered/6 after reviewing the final diff.", createdAt: "2026-09-01T11:30:00.000Z", lastEditedAt: null,
          },
          ...extraComments,
        ],
        closingPullRequests: [
          {
            id: 201,
            number: 11,
            title: "Pull request",
            url: "https://github.com/octo/example/pull/11",
            state: "MERGED",
            mergedAt: MERGED_AT,
            mergeCommitOid: "c".repeat(40),
            finalCommitAt: "2026-09-01T10:00:00.000Z",
            authorLogin: "contributor",
            authorGitHubUserId: CONTRIBUTOR_ID,
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
