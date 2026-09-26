import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  CACHED_COMMENT_BODY_PLACEHOLDER,
  narrowCachedIssueBodies,
} from "@/lib/fold/reconciliation-evidence";
import {
  foldRepository,
  type RepositoryFoldIssue,
  type RepositoryFoldPullRequest,
  type RepositoryFoldSnapshot,
} from "@/lib/fold/repository-fold";

const RAW_DIFF = "diff --git a/proof b/proof\n+the bytes the settlement proof hashes\n";
const RATIONALE = "Settled as delivered/6 after reviewing the final diff.";

describe("cache body narrowing", () => {
  it("keeps a fixed nonblank placeholder that satisfies the fold's only body predicate", () => {
    expect(CACHED_COMMENT_BODY_PLACEHOLDER).toBe("[body removed]");
    expect(CACHED_COMMENT_BODY_PLACEHOLDER.trim().length).toBeGreaterThan(0);
  });

  it("maps every nonblank comment body to the placeholder and every blank one to the empty string", () => {
    const [narrowed] = narrowCachedIssueBodies([cachedIssue()]);

    // Fixture order: the blank sponsor comment, the rationale, the non-sponsor
    // remark — blank maps to "", every nonblank body to the placeholder.
    expect(narrowed!.comments.map(({ body }) => body)).toEqual([
      "", CACHED_COMMENT_BODY_PLACEHOLDER, CACHED_COMMENT_BODY_PLACEHOLDER,
    ]);
  });

  it("drops the issue body and nested pull request bodies while keeping every other field", () => {
    const issue = cachedIssue();
    const [narrowed] = narrowCachedIssueBodies([issue]);

    expect("body" in narrowed!).toBe(false);
    expect("body" in narrowed!.closingPullRequests[0]!).toBe(false);
    // The metadata the fold still reads survives byte for byte: comment ids,
    // authors and instants, and the nested pull request's identity and diff.
    const [blank, rationale, other] = issue.comments;
    expect(narrowed).toEqual({ ...issue, body: undefined,
      comments: [
        { ...blank!, body: "" },
        { ...rationale!, body: CACHED_COMMENT_BODY_PLACEHOLDER },
        { ...other!, body: CACHED_COMMENT_BODY_PLACEHOLDER },
      ],
      closingPullRequests: [{ ...issue.closingPullRequests[0]!, body: undefined }] });
  });

  it("is idempotent over already-narrowed issues", () => {
    const once = narrowCachedIssueBodies([cachedIssue()]);
    const twice = narrowCachedIssueBodies(once);

    expect(twice).toEqual(once);
    expect("body" in twice[0]!).toBe(false);
  });
});

describe("fold parity between wide and narrowed evidence", () => {
  it("settles identically with placeholder comment bodies and no issue bodies, byte for byte", () => {
    const wide = foldRepository(settlementFixture(RATIONALE));
    const narrowed = foldRepository(narrowedFixture(RATIONALE));

    // Self-checks: the wide fold settles through the rationale comment, and the
    // proof is the hash of the raw diff the narrowing never touches.
    expect(wide.settlements[0]).toMatchObject({
      status: "SETTLED", settledPoints: 6, credits: 6, settledRationaleCommentId: "comment-1",
    });
    expect(wide.pullRequests[0]!.proofSha256).toBe(createHash("sha256").update(RAW_DIFF).digest("hex"));

    expect(JSON.stringify(narrowed)).toBe(JSON.stringify(wide));
    expect(narrowed.settlements[0]!.proofSha256).toBe(wide.settlements[0]!.proofSha256);
    expect(narrowed.pullRequests[0]!.proofSha256).toBe(wide.pullRequests[0]!.proofSha256);
  });

  it("keeps a blank rationale comment non-qualifying through the placeholder rule", () => {
    const wide = foldRepository(settlementFixture("   \n\t "));
    const narrowed = foldRepository(narrowedFixture("   \n\t "));

    expect(wide.settlements[0]).toMatchObject({
      status: "UNSETTLED", settledPoints: null, settledRationaleCommentId: null,
    });
    expect(JSON.stringify(narrowed)).toBe(JSON.stringify(wide));
    expect(narrowed.settlements[0]!.proofSha256).toBe(wide.settlements[0]!.proofSha256);
  });
});

/**
 * A snapshot whose cached issues still carry every body — the shape a
 * pre-narrowing cache serialised. The fold's own input type claims no body
 * (issue 681), so the wide shape is a local augmentation of it.
 */
type WideSnapshot = Omit<RepositoryFoldSnapshot, "issues"> & {
  issues: Array<Omit<RepositoryFoldIssue, "closingPullRequests"> & {
    body: string;
    closingPullRequests: Array<RepositoryFoldPullRequest & { body: string }>;
  }>;
};

/**
 * The snapshot with every cached body replaced exactly the way the store
 * serialises them, while the events (ids, actors, instants, diff) stay
 * identical. No cast is needed: narrowing a wide issue yields exactly the
 * fold's bodyless issue shape, which is the property the parity comparison
 * pins.
 */
function narrowedFixture(rationaleBody: string): RepositoryFoldSnapshot {
  const snapshot = settlementFixture(rationaleBody);
  return {
    ...snapshot,
    issues: narrowCachedIssueBodies(snapshot.issues),
  };
}

function cachedIssue(): Parameters<typeof narrowCachedIssueBodies>[0][number] {
  return settlementFixture(RATIONALE).issues[0]!;
}

/**
 * One sponsor-opened, contributor-closed issue whose settlement turns on the
 * rationale comment's body: opening label 2026-08-30T10:00, settled label
 * 11:00, rationale 11:30, merge 12:00 (window closes 12:15). The blank and
 * non-sponsor comments sit inside the window too, so only the body predicate
 * and the sponsor identity can separate them from the rationale.
 */
function settlementFixture(rationaleBody: string): WideSnapshot {
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
        body: "Issue body text the cache must not keep",
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
            id: "comment-blank", databaseId: 391, authorLogin: "sponsor", authorGitHubUserId: null,
            body: "   \n\t ", createdAt: "2026-09-01T11:20:00.000Z", lastEditedAt: null,
          },
          {
            id: "comment-1", databaseId: 401, authorLogin: "sponsor", authorGitHubUserId: null,
            body: rationaleBody, createdAt: "2026-09-01T11:30:00.000Z", lastEditedAt: null,
          },
          {
            id: "comment-other", databaseId: 402, authorLogin: "maintainer", authorGitHubUserId: null,
            body: "A non-sponsor remark the cache must not keep either.", createdAt: "2026-09-01T11:40:00.000Z",
            lastEditedAt: null,
          },
        ],
        closingPullRequests: [
          {
            id: 201,
            number: 11,
            title: "Pull request",
            body: "Pull request body text the cache must not keep",
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
            rawDiff: RAW_DIFF,
          },
        ],
      },
    ],
  };
}
