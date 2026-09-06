import { describe, expect, it } from "vitest";
import { foldRepository, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";

/**
 * The opening refusal a moderator reads is the only record of why an issue left
 * the fold, so it has to say WHICH refusal it was: no opening-catalog label was
 * ever applied, or one is standing and the account that applied it is not the
 * repository sponsor. The second is an accusation about an account and the
 * first is not, and the settled side already draws that line with
 * `SETTLED_LABEL_UNAUTHORIZED`.
 */

const SPONSOR_GITHUB_USER_ID = 1001;
const SPONSOR_LOGIN = "sponsor";
const OUTSIDER_GITHUB_USER_ID = 2001;
const ISSUE_CREATED_AT = "2026-08-30T09:00:00.000Z";
const OPENING_LABELED_AT = "2026-08-30T10:00:00.000Z";

type FixtureActor = { login: string | null; githubUserId: number | null };

const sponsor: FixtureActor = { login: SPONSOR_LOGIN, githubUserId: SPONSOR_GITHUB_USER_ID };
const outsider: FixtureActor = { login: "contributor", githubUserId: OUTSIDER_GITHUB_USER_ID };
/** A different numeric account holding the login the sponsor's record still stores. */
const impostorHoldingTheSponsorLogin: FixtureActor = {
  login: SPONSOR_LOGIN,
  githubUserId: OUTSIDER_GITHUB_USER_ID,
};

describe("opening label authority", () => {
  it("names the account when an in-window opening label is not the sponsor's", () => {
    const snapshot = openingFixture({ opening: outsider });

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([{
      code: "OPENING_LABEL_UNAUTHORIZED",
      githubIssueId: 101,
      openingLabel: "M",
      openingSourceActorLogin: "contributor",
    }]);
    expect(result.issues).toEqual([]);
    // The label was applied and is still on the issue — nothing is missing here,
    // which is exactly what the old `OPENING_LABEL_MISSING` record contradicted.
    expect(snapshot.issues[0]!.labels).toContain("M");
  });

  it("refuses an idless in-window actor the sponsor's stored login can be compared against", () => {
    const snapshot = openingFixture({ opening: { login: "contributor", githubUserId: null } });

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([{
      code: "OPENING_LABEL_UNAUTHORIZED",
      githubIssueId: 101,
      openingLabel: "M",
      openingSourceActorLogin: "contributor",
    }]);
    expect(result.issues).toEqual([]);
  });

  it("refuses a different account that took the sponsor's stored login", () => {
    const snapshot = openingFixture({ opening: impostorHoldingTheSponsorLogin });

    const result = foldRepository(snapshot);

    // The login is the payload's own text, so here it is the login the impostor
    // holds — which happens to read like the sponsor's. The account was refused
    // on its numeric id; the login names what a moderator will see on the event.
    expect(result.policyViolations).toEqual([{
      code: "OPENING_LABEL_UNAUTHORIZED",
      githubIssueId: 101,
      openingLabel: "M",
      openingSourceActorLogin: SPONSOR_LOGIN,
    }]);
    expect(result.issues).toEqual([]);
  });

  it("names `unknown` rather than the sponsor when the payload carries no usable actor login", () => {
    const snapshot = openingFixture({ opening: { login: "   ", githubUserId: OUTSIDER_GITHUB_USER_ID } });

    const result = foldRepository(snapshot);

    // `sponsorDisplayLogin` would fall back to the sponsor's stored login here,
    // which would name the sponsor as the account that applied an unauthorized
    // label. The refusal names nobody rather than the wrong body.
    expect(result.policyViolations).toEqual([{
      code: "OPENING_LABEL_UNAUTHORIZED",
      githubIssueId: 101,
      openingLabel: "M",
      openingSourceActorLogin: "unknown",
    }]);
  });

  it("names the first candidate applied when several outsiders applied opening labels", () => {
    const snapshot = openingFixture({ opening: outsider });
    applyOpeningLabel(snapshot, {
      id: "opening-2",
      label: "S",
      actor: { login: "maintainer", githubUserId: 3001 },
      createdAt: "2026-08-30T10:30:00.000Z",
    });

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([{
      code: "OPENING_LABEL_UNAUTHORIZED",
      githubIssueId: 101,
      openingLabel: "M",
      openingSourceActorLogin: "contributor",
    }]);
  });

  it("names the first candidate that can be compared, skipping one that cannot", () => {
    // With no sponsor login stored, an idless actor is unattributable on its own
    // — it is the later event carrying an account id that makes the refusal an
    // accusation, so that is the one the row has to name.
    const snapshot = openingFixture({ opening: { login: "contributor", githubUserId: null } });
    snapshot.repository.sponsor.githubLogin = "   ";
    applyOpeningLabel(snapshot, {
      id: "opening-2",
      label: "S",
      actor: { login: "maintainer", githubUserId: 3001 },
      createdAt: "2026-08-30T10:30:00.000Z",
    });

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([{
      code: "OPENING_LABEL_UNAUTHORIZED",
      githubIssueId: 101,
      openingLabel: "S",
      openingSourceActorLogin: "maintainer",
    }]);
  });

  it("reports a missing opening when no opening-catalog label was ever applied", () => {
    const snapshot = openingFixture();
    snapshot.issues[0]!.labels = [];
    snapshot.issues[0]!.history = [];

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([
      { code: "OPENING_LABEL_MISSING", githubIssueId: 101 },
    ]);
    expect(result.issues).toEqual([]);
  });

  it("reports a missing opening when nothing can be compared and no account can be accused", () => {
    const snapshot = openingFixture({ opening: { login: "contributor", githubUserId: null } });
    snapshot.repository.sponsor.githubLogin = "   ";

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([
      { code: "OPENING_LABEL_MISSING", githubIssueId: 101 },
    ]);
    expect(result.issues).toEqual([]);
  });

  // Each of these is `openingFixture({ opening: outsider })` — the fixture the
  // first case in this file proves records `OPENING_LABEL_UNAUTHORIZED` — with
  // one field of the issue itself spoiled. So they pin the two early returns and
  // not some absence of a candidate: the accusation is available and declined.
  it.each([
    { name: "a deleted author account GitHub reports as null", authorLogin: null },
    { name: "an author login that is only whitespace", authorLogin: "   " },
  ])("reports a missing opening for $name", ({ authorLogin }) => {
    const snapshot = openingFixture({ opening: outsider });
    snapshot.issues[0]!.authorLogin = authorLogin;

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([
      { code: "OPENING_LABEL_MISSING", githubIssueId: 101 },
    ]);
    expect(result.issues).toEqual([]);
  });

  it("reports a missing opening when the issue's own creation instant is unreadable", () => {
    const snapshot = openingFixture({ opening: outsider });
    snapshot.issues[0]!.createdAt = "last Tuesday";

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([
      { code: "OPENING_LABEL_MISSING", githubIssueId: 101 },
    ]);
    expect(result.issues).toEqual([]);
  });

  it("reports a missing opening for a non-sponsor label applied after the opening deadline", () => {
    const snapshot = openingFixture({ opening: outsider });
    snapshot.issues[0]!.history.push({
      kind: "ASSIGNED",
      id: "assignment-1",
      actorLogin: SPONSOR_LOGIN,
      actorGitHubUserId: SPONSOR_GITHUB_USER_ID,
      assigneeLogin: "contributor",
      createdAt: "2026-08-30T09:30:00.000Z",
    });

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([
      { code: "OPENING_LABEL_MISSING", githubIssueId: 101 },
    ]);
    expect(result.issues).toEqual([]);
  });

  it("reports a missing opening for a non-sponsor label applied before the issue was created", () => {
    const snapshot = openingFixture({ opening: outsider });
    snapshot.issues[0]!.history[0]!.createdAt = "2026-08-30T08:00:00.000Z";

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([
      { code: "OPENING_LABEL_MISSING", githubIssueId: 101 },
    ]);
    expect(result.issues).toEqual([]);
  });

  it("prices the issue with no violation when the sponsor applied the opening label in window", () => {
    const result = foldRepository(openingFixture());

    expect(result.policyViolations).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({
      githubIssueId: 101,
      openingLabel: "M",
      openingComparisonPoints: 5,
      openingSourceEventId: "opening-1",
      openingSourceActorLogin: SPONSOR_LOGIN,
    })]);
  });
});

/** A second opening-catalog application, so a refusal has more than one candidate to choose from. */
function applyOpeningLabel(
  snapshot: RepositoryFoldSnapshot,
  application: { id: string; label: string; actor: FixtureActor; createdAt: string },
): void {
  snapshot.issues[0]!.history.push({
    kind: "LABELED",
    id: application.id,
    actorLogin: application.actor.login,
    actorGitHubUserId: application.actor.githubUserId,
    label: application.label,
    createdAt: application.createdAt,
  });
  snapshot.issues[0]!.labels.push(application.label);
}

/**
 * One open issue the sponsor filed, carrying a standing opening-catalog label
 * applied an hour after it was created and before any assignment. Only the
 * account that applied that label varies, so a single refusal is read against
 * an otherwise acceptable opening.
 */
function openingFixture(actors: { opening?: FixtureActor } = {}): RepositoryFoldSnapshot {
  const opening = actors.opening ?? sponsor;
  return {
    repository: {
      id: "repository",
      githubRepositoryId: 5001,
      ownerName: "octo/example",
      active: true,
      registeredAt: "2026-01-01T00:00:00.000Z",
      sponsor: {
        id: "sponsor",
        githubUserId: SPONSOR_GITHUB_USER_ID,
        githubLogin: SPONSOR_LOGIN,
        enforcementState: "ACTIVE",
        moderationEvents: [],
      },
      difficultyScheme: {
        openingName: "Size",
        actualName: "Delivered",
        openingLabels: [
          { label: "S", comparisonPoints: 2, reservePoints: 2 },
          { label: "M", comparisonPoints: 5, reservePoints: 5 },
        ],
        actualLabels: Array.from({ length: 10 }, (_, index) => ({
          label: `delivered/${index + 1}`,
          points: index + 1,
        })),
      },
    },
    users: [
      {
        id: "sponsor",
        githubUserId: SPONSOR_GITHUB_USER_ID,
        githubLogin: SPONSOR_LOGIN,
        enforcementState: "ACTIVE",
        moderationEvents: [],
      },
      {
        id: "contributor",
        githubUserId: OUTSIDER_GITHUB_USER_ID,
        githubLogin: "contributor",
        enforcementState: "ACTIVE",
        moderationEvents: [],
      },
    ],
    issues: [
      {
        id: 101,
        number: 1,
        title: "Issue",
        body: "Issue body",
        url: "https://github.com/octo/example/issues/1",
        state: "OPEN",
        createdAt: ISSUE_CREATED_AT,
        closedAt: null,
        authorLogin: SPONSOR_LOGIN,
        authorGitHubUserId: SPONSOR_GITHUB_USER_ID,
        labels: ["M"],
        claimAssigneeGitHubLogin: null,
        history: [
          {
            kind: "LABELED",
            id: "opening-1",
            actorLogin: opening.login,
            actorGitHubUserId: opening.githubUserId,
            label: "M",
            createdAt: OPENING_LABELED_AT,
          },
        ],
        comments: [],
        closingPullRequests: [],
      },
    ],
  };
}
