import { describe, expect, it } from "vitest";
import { foldRepository, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";
import { OUTSIDE_REPOSITORY_MARK_LABEL } from "@/lib/fold/outside-repository-mark";

/**
 * The outside-repository mark is read from the labels standing on the issue
 * when it is folded, never from label history: a body or title edit re-folds
 * with the label still standing and keeps the mark, and only taking the label
 * off clears it. Whoever holds label rights on the forge sets it, so the
 * actor that applied it is not consulted.
 */

const SPONSOR_GITHUB_USER_ID = 1001;
const SPONSOR_LOGIN = "sponsor";

describe("outside-repository mark", () => {
  it("marks an issue whose standing labels carry the reserved label", () => {
    const snapshot = markFixture();
    snapshot.issues[0]!.labels.push(OUTSIDE_REPOSITORY_MARK_LABEL);

    expect(foldedMarks(snapshot)).toEqual([true]);
  });

  it("leaves an issue without the reserved label unmarked", () => {
    expect(foldedMarks(markFixture())).toEqual([false]);
  });

  it("clears the mark once the label was taken off, though history still shows it applied", () => {
    const snapshot = markFixture();
    snapshot.issues[0]!.history.push(
      labelEvent("LABELED", "mark-applied", "2026-08-30T11:00:00.000Z"),
      labelEvent("UNLABELED", "mark-removed", "2026-08-30T12:00:00.000Z"),
    );

    expect(foldedMarks(snapshot)).toEqual([false]);
  });

  it("keeps the mark on a standing label whatever account applied it", () => {
    const snapshot = markFixture();
    snapshot.issues[0]!.labels.push(OUTSIDE_REPOSITORY_MARK_LABEL);
    snapshot.issues[0]!.history.push({
      ...labelEvent("LABELED", "mark-applied", "2026-08-30T11:00:00.000Z"),
      actorLogin: "collaborator",
      actorGitHubUserId: 3001,
    });

    expect(foldedMarks(snapshot)).toEqual([true]);
  });

  it("does not read a label that only resembles the reserved one", () => {
    const snapshot = markFixture();
    snapshot.issues[0]!.labels.push(`${OUTSIDE_REPOSITORY_MARK_LABEL} (maybe)`);

    expect(foldedMarks(snapshot)).toEqual([false]);
  });
});

function foldedMarks(snapshot: RepositoryFoldSnapshot): boolean[] {
  const result = foldRepository(snapshot);
  expect(result.issues.map((issue) => issue.githubIssueId)).toEqual([101]);
  return result.issues.map((issue) => issue.asksOutsideRepository);
}

function labelEvent(
  kind: "LABELED" | "UNLABELED",
  id: string,
  createdAt: string,
): RepositoryFoldSnapshot["issues"][number]["history"][number] {
  return {
    kind,
    id,
    actorLogin: SPONSOR_LOGIN,
    actorGitHubUserId: SPONSOR_GITHUB_USER_ID,
    label: OUTSIDE_REPOSITORY_MARK_LABEL,
    createdAt,
  };
}

/** One open issue the sponsor priced with an in-window opening label; only its other labels vary. */
function markFixture(): RepositoryFoldSnapshot {
  const sponsor = {
    id: "sponsor",
    githubUserId: SPONSOR_GITHUB_USER_ID,
    githubLogin: SPONSOR_LOGIN,
    enforcementState: "ACTIVE" as const,
    moderationEvents: [],
  };
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
        actualLabels: [{ label: "delivered/1", points: 1 }],
      },
    },
    users: [sponsor],
    issues: [
      {
        id: 101,
        number: 1,
        title: "Issue",
        url: "https://github.com/octo/example/issues/1",
        state: "OPEN",
        stateReason: null,
        createdAt: "2026-08-30T09:00:00.000Z",
        updatedAt: "2026-09-01T12:05:00.000Z",
        closedAt: null,
        authorLogin: SPONSOR_LOGIN,
        authorGitHubUserId: SPONSOR_GITHUB_USER_ID,
        labels: ["M"],
        claimAssigneeGitHubLogin: null,
        history: [
          {
            kind: "LABELED",
            id: "opening-1",
            actorLogin: SPONSOR_LOGIN,
            actorGitHubUserId: SPONSOR_GITHUB_USER_ID,
            label: "M",
            createdAt: "2026-08-30T10:00:00.000Z",
          },
        ],
        comments: [],
        closingPullRequests: [],
      },
    ],
  };
}
