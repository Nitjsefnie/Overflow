import { describe, expect, it } from "vitest";
import { foldRepository, type FoldUser, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";
import { teamAt, teamMembershipsFromJson, type FoldTeamMembership } from "@/lib/fold/team-membership";

const mergedAt = "2026-09-01T12:00:00Z";

function user(id: string, githubUserId: number, teamMemberships: FoldTeamMembership[] = []): FoldUser {
  return { id, githubUserId, githubLogin: id, enforcementState: "ACTIVE", moderationEvents: [], teamMemberships };
}

const member = (teamId: string, joinedAt: string, leftAt: string | null = null) => ({ teamId, joinedAt, leftAt });

/** One closed issue whose pull request by `author`, merged at `mergedAt`, the sponsor priced at 6 with a review round. */
function snapshot(sponsor: FoldUser, author: FoldUser, { label = true } = {}): RepositoryFoldSnapshot {
  const sponsorEvent = { actorLogin: sponsor.githubLogin, actorGitHubUserId: sponsor.githubUserId };
  return {
    repository: {
      id: "repository", githubRepositoryId: 5001, ownerName: "octo/example", active: true, registeredAt: "2026-01-01T00:00:00Z",
      sponsor, difficultySchemeVersions: [],
      difficultyScheme: {
        openingName: "Size", actualName: "Delivered", openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
        actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
      },
    },
    users: [sponsor, author],
    issues: [{
      id: 101, number: 1, title: "Issue", url: "https://github.com/octo/example/issues/1", state: "CLOSED", stateReason: "COMPLETED",
      createdAt: "2026-08-30T09:00:00Z", updatedAt: "2026-09-01T12:05:00Z", closedAt: "2026-09-01T12:05:00Z",
      authorLogin: sponsor.githubLogin, authorGitHubUserId: sponsor.githubUserId, labels: [],
      history: [
        { kind: "LABELED", id: "opening", ...sponsorEvent, label: "M", createdAt: "2026-08-30T10:00:00Z" },
        ...(label ? [{ kind: "LABELED" as const, id: "actual", ...sponsorEvent, label: "delivered/6", createdAt: "2026-09-01T11:00:00Z" }] : []),
      ],
      comments: [{ id: "rationale", databaseId: 401, authorLogin: sponsor.githubLogin, authorGitHubUserId: sponsor.githubUserId,
        body: "Settled after reading the diff.", createdAt: "2026-09-01T11:30:00Z", lastEditedAt: null }],
      closingPullRequests: [{
        id: 201, number: 11, title: "Pull request", url: "https://github.com/octo/example/pull/11", state: "MERGED", mergedAt,
        mergeCommitOid: "0123456789abcdef0123456789abcdef01234567", finalCommitAt: "2026-09-01T10:00:00Z",
        authorLogin: author.githubLogin, authorGitHubUserId: author.githubUserId, repositoryGitHubId: 5001,
        repositoryNameWithOwner: "octo/example", rawDiff: "diff",
        reviews: [{ id: 301, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T10:30:00Z", dismissal: null }],
      }],
    }],
  };
}

describe("teamAt", () => {
  it.each([
    ["joined at the merge instant", [member("T", mergedAt)], "T"],
    ["joined a microsecond after the merge", [member("T", "2026-09-01T12:00:00.000001Z")], null],
    ["left at the merge instant", [member("T", "2026-08-01T00:00:00Z", mergedAt)], null],
    ["left a microsecond after the merge", [member("T", "2026-08-01T00:00:00Z", "2026-09-01T12:00:00.000001Z")], "T"],
    ["left before the merge, joined another team after it",
      [member("T", "2026-08-01T00:00:00Z", "2026-08-15T00:00:00Z"), member("U", "2026-09-02T00:00:00Z")], null],
    ["left one team and joined another before the merge",
      [member("T", "2026-08-01T00:00:00Z", "2026-08-15T00:00:00Z"), member("U", "2026-08-15T00:00:00Z")], "U"],
    ["held two overlapping rows: the later join decides",
      [member("U", "2026-08-20T00:00:00Z"), member("T", "2026-08-01T00:00:00Z", "2026-09-02T00:00:00Z")], "U"],
    ["held two rows joined at one instant: the greater team id decides",
      [member("U", "2026-08-20T00:00:00Z", "2026-09-02T00:00:00Z"), member("T", "2026-08-20T00:00:00Z")], "U"],
    ["held the same tie listed the other way round",
      [member("T", "2026-08-20T00:00:00Z"), member("U", "2026-08-20T00:00:00Z", "2026-09-02T00:00:00Z")], "U"],
  ])("%s", (_case, memberships, expected) => {
    expect(teamAt(user("author", 2001, memberships), mergedAt)).toBe(expected);
  });

  it("names no team for an unknown author or an unreadable merge instant", () => {
    expect(teamAt(undefined, mergedAt)).toBeNull();
    expect(teamAt(user("author", 2001, [member("T", "2026-08-01T00:00:00Z")]), "not a time")).toBeNull();
  });
});

describe("teamMembershipsFromJson", () => {
  it("keeps each row's microseconds and refuses a malformed history", () => {
    expect(teamMembershipsFromJson([
      { teamId: "T", joinedAt: "2026-09-01T12:00:00.000001+00:00", leftAt: null },
      { teamId: "U", joinedAt: "2026-08-01T00:00:00+02:00", leftAt: "2026-08-02T00:00:00.5+00:00" },
    ])).toEqual([
      member("T", "2026-09-01T12:00:00.000001Z"),
      member("U", "2026-07-31T22:00:00.000000Z", "2026-08-02T00:00:00.500000Z"),
    ]);
    for (const malformed of [null, [{ teamId: "T", joinedAt: "yesterday", leftAt: null }], [{ teamId: 1, joinedAt: mergedAt, leftAt: null }],
      [{ teamId: "T", joinedAt: mergedAt }]]) {
      expect(() => teamMembershipsFromJson(malformed)).toThrow("Team membership history was invalid.");
    }
  });
});

describe("a team member's merged closing pull request", () => {
  const sponsor = user("sponsor", 1001);

  it("settles to the author's merge-time team and credits the team in the fold's ledger", () => {
    const result = foldRepository(snapshot(sponsor, user("author", 2001, [member("T", "2026-08-01T00:00:00Z")])));
    expect(result.settlements).toEqual([expect.objectContaining({
      creditorId: "author", teamId: "T", status: "SETTLED", settledPoints: 6, reviewRounds: 1, credits: 5,
    })]);
    expect(result.ledgerEntries.map(({ accountId, amount }) => [accountId, amount])).toEqual([["T", 5], ["sponsor", -5]]);
  });

  it("settles a non-member's work to the author, with no team", () => {
    const result = foldRepository(snapshot(sponsor, user("author", 2001, [member("T", "2026-09-02T00:00:00Z")])));
    expect(result.settlements).toHaveLength(1);
    expect(result.settlements[0]).not.toHaveProperty("teamId");
    expect(result.ledgerEntries.map(({ accountId, amount }) => [accountId, amount])).toEqual([["author", 5], ["sponsor", -5]]);
  });

  it("settles as self-work when a teammate sponsors the repository, the calibration naming the sponsor", () => {
    const teammate = user("teammate", 1002, [member("T", "2026-07-01T00:00:00Z")]);
    const result = foldRepository(snapshot(teammate, user("author", 2001, [member("T", "2026-08-01T00:00:00Z")])));
    expect(result.settlements).toEqual([]);
    expect(result.ledgerEntries).toEqual([]);
    expect(result.selfWorkCalibrations).toEqual([expect.objectContaining({ userId: "teammate", actualPoints: 6 })]);

    const unlabelled = foldRepository(snapshot(teammate, user("author", 2001, [member("T", "2026-08-01T00:00:00Z")]), { label: false }));
    expect(unlabelled.unwritableClosures).toEqual([expect.objectContaining({ kind: "SETTLEMENT_EVIDENCE_REJECTED", unlabelledSelfWork: true })]);
  });

  it.each([
    ["sponsors in a different team", [member("U", "2026-07-01T00:00:00Z")]],
    ["left the author's team before the merge", [member("T", "2026-07-01T00:00:00Z", "2026-08-31T00:00:00Z")]],
    ["joins the author's team after the merge", [member("T", "2026-09-01T12:00:01Z")]],
  ])("settles to the team when the sponsor %s", (_case, sponsorMemberships) => {
    const result = foldRepository(snapshot(user("sponsor", 1001, sponsorMemberships), user("author", 2001, [member("T", "2026-08-01T00:00:00Z")])));
    expect(result.selfWorkCalibrations).toEqual([]);
    expect(result.settlements).toEqual([expect.objectContaining({ creditorId: "author", teamId: "T", credits: 5 })]);
  });

  it("still judges participation on the author at the merge", () => {
    const banned = user("author", 2001, [member("T", "2026-08-01T00:00:00Z")]);
    banned.moderationEvents = [{ id: "ban", priorState: "ACTIVE", newState: "BANNED", occurredAt: "2026-08-15T00:00:00Z" }];
    const result = foldRepository(snapshot(user("teammate", 1002, [member("T", "2026-07-01T00:00:00Z")]), banned));
    expect([result.settlements, result.selfWorkCalibrations, result.ledgerEntries]).toEqual([[], [], []]);
    expect(foldRepository(snapshot(sponsor, banned)).settlements).toEqual([]);
  });
});
