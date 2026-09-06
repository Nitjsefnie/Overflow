import { describe, expect, it } from "vitest";
import { foldRepository, type FoldResult, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";

/**
 * The opening refusal a moderator reads is the only record of why an issue left
 * the fold, so it has to say WHICH refusal it was: no opening-catalog label was
 * applied in the window, or an application could not be attributed to the
 * repository sponsor. The second records an authority refusal and the first
 * does not, and the settled side already draws that line with
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
      reason: "The application of the opening label `M` by `contributor` could not be attributed to the repository sponsor `sponsor`.",
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
      reason: "The application of the opening label `M` by `contributor` could not be attributed to the repository sponsor `sponsor`.",
    }]);
    expect(result.issues).toEqual([]);
  });

  it("refuses a different account that took the sponsor's stored login", () => {
    const snapshot = openingFixture({ opening: impostorHoldingTheSponsorLogin });

    const result = foldRepository(snapshot);

    // `openingSourceActorLogin` is the payload's own text, so here it is the
    // login the impostor holds — which reads exactly like the sponsor's. The
    // sentence is what carries the discriminator: the ACCOUNT was refused, and
    // the login it holds is not evidence of who it is.
    // The point of that branch: a moderator must not be able to read the row as
    // the sponsor having applied the label. The ordinary sentence would print
    // the sponsor's own login on both sides of "rather than". Asserted before
    // the exact shape, so this property is what a regression reports.
    expect(unauthorizedReason(result)).not.toContain(`applied by \`${SPONSOR_LOGIN}\``);
    expect(result.policyViolations).toEqual([{
      code: "OPENING_LABEL_UNAUTHORIZED",
      githubIssueId: 101,
      openingLabel: "M",
      openingSourceActorLogin: SPONSOR_LOGIN,
      reason: "The opening label `M` was applied by a different GitHub account using the login "
        + "`sponsor`, not by the repository sponsor.",
    }]);
    expect(result.issues).toEqual([]);
  });

  it.each([
    { name: "case", login: "SPONSOR", displayedLogin: "SPONSOR" },
    { name: "surrounding whitespace", login: "  sponsor  ", displayedLogin: "sponsor" },
  ])("recognizes an impostor login differing only by $name", ({ login, displayedLogin }) => {
    const snapshot = openingFixture({ opening: { login, githubUserId: OUTSIDER_GITHUB_USER_ID } });

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([{
      code: "OPENING_LABEL_UNAUTHORIZED",
      githubIssueId: 101,
      openingLabel: "M",
      openingSourceActorLogin: displayedLogin,
      reason: "The opening label `M` was applied by a different GitHub account using the login "
        + `\`${displayedLogin}\`, not by the repository sponsor.`,
    }]);
    expect(result.issues).toEqual([]);
  });

  it("refuses an in-window application that was later removed again", () => {
    // The refusal is about an APPLICATION, not about what is on the issue now:
    // the accepting predicate reads `LABELED` events too, so an outsider whose
    // label was taken off again must not read as an opening nobody ever priced.
    const snapshot = openingFixture({ opening: outsider });
    snapshot.issues[0]!.labels = [];
    snapshot.issues[0]!.history.push({
      kind: "UNLABELED",
      id: "opening-1-removed",
      actorLogin: SPONSOR_LOGIN,
      actorGitHubUserId: SPONSOR_GITHUB_USER_ID,
      label: "M",
      createdAt: "2026-08-30T11:00:00.000Z",
    });

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([{
      code: "OPENING_LABEL_UNAUTHORIZED",
      githubIssueId: 101,
      openingLabel: "M",
      openingSourceActorLogin: "contributor",
      reason: "The application of the opening label `M` by `contributor` could not be attributed to the repository sponsor `sponsor`.",
    }]);
  });

  it("names `unknown` rather than the sponsor when the payload carries no usable actor login", () => {
    const snapshot = openingFixture({ opening: { login: "   ", githubUserId: OUTSIDER_GITHUB_USER_ID } });

    const result = foldRepository(snapshot);

    // `sponsorDisplayLogin` would fall back to the sponsor's stored login here,
    // which would name the sponsor as the account that applied an unauthorized
    // label. Both the field and the sentence name nobody rather than the wrong
    // body — the sponsor appears only as the account it cannot be attributed to.
    expect(result.policyViolations).toEqual([{
      code: "OPENING_LABEL_UNAUTHORIZED",
      githubIssueId: 101,
      openingLabel: "M",
      openingSourceActorLogin: "unknown",
      reason: "The application of the opening label `M` by `unknown` could not be attributed to the repository sponsor `sponsor`.",
    }]);
    expect(unauthorizedReason(result)).not.toContain(`applied by \`${SPONSOR_LOGIN}\``);
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
      reason: "The application of the opening label `M` by `contributor` could not be attributed to the repository sponsor `sponsor`.",
    }]);
  });

  it.each([false, true])("uses event ids to break opening refusal ties (reversed: %s)", (reverse) => {
    const snapshot = openingFixture({ opening: outsider });
    applyOpeningLabel(snapshot, {
      id: "opening-2",
      label: "S",
      actor: { login: "maintainer", githubUserId: 3001 },
      createdAt: OPENING_LABELED_AT,
    });
    if (reverse) snapshot.issues[0]!.history.reverse();

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([{
      code: "OPENING_LABEL_UNAUTHORIZED",
      githubIssueId: 101,
      openingLabel: "M",
      openingSourceActorLogin: "contributor",
      reason: "The application of the opening label `M` by `contributor` could not be attributed to the repository sponsor `sponsor`.",
    }]);
    expect(result.issues).toEqual([]);
  });

  it.each([false, true])("uses event ids to break accepted opening ties (reversed: %s)", (reverse) => {
    const snapshot = openingFixture();
    applyOpeningLabel(snapshot, {
      id: "opening-2", label: "S", actor: sponsor, createdAt: OPENING_LABELED_AT,
    });
    if (reverse) snapshot.issues[0]!.history.reverse();

    const result = foldRepository(snapshot);

    expect(result.issues).toEqual([expect.objectContaining({
      openingLabel: "M", openingComparisonPoints: 5, openingSourceEventId: "opening-1",
    })]);
    expect(result.policyViolations).toEqual([{ code: "OPENING_LABEL_MUTATED", githubIssueId: 101 }]);
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
      reason: "The application of the opening label `S` by `maintainer` could not be attributed to the repository sponsor.",
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

  it.each([sponsor, outsider])("reports a missing opening for $login one grace width after the deadline", (opening) => {
    const snapshot = openingFixture({ opening });
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

  it.each([sponsor, outsider])("reports a missing opening for $login one grace width before creation", (opening) => {
    const snapshot = openingFixture({ opening });
    snapshot.issues[0]!.history[0]!.createdAt = "2026-08-30T08:45:00.000Z";

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([
      { code: "OPENING_LABEL_MISSING", githubIssueId: 101 },
    ]);
    expect(result.issues).toEqual([]);
  });

  it.each([
    { name: "creation instant", createdAt: "2026-08-30T09:00:00.000Z" },
    { name: "opening deadline", createdAt: "2026-08-30T09:45:00.000Z" },
  ])("accepts a sponsor application exactly at the $name", ({ createdAt }) => {
    const snapshot = openingFixture();
    snapshot.issues[0]!.history[0]!.createdAt = createdAt;
    snapshot.issues[0]!.history.push({
      kind: "ASSIGNED", id: "assignment-1", actorLogin: SPONSOR_LOGIN,
      actorGitHubUserId: SPONSOR_GITHUB_USER_ID, assigneeLogin: "contributor",
      createdAt: "2026-08-30T09:30:00.000Z",
    });

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([]);
    expect(result.issues).toEqual([expect.objectContaining({
      githubIssueId: 101, openingLabel: "M", openingComparisonPoints: 5,
      openingSourceEventId: "opening-1", openingSourceAt: createdAt,
    })]);
  });

  it.each([
    { name: "creation instant", createdAt: "2026-08-30T09:00:00.000Z" },
    { name: "opening deadline", createdAt: "2026-08-30T09:45:00.000Z" },
  ])("records an unauthorized application exactly at the $name", ({ createdAt }) => {
    const snapshot = openingFixture({ opening: outsider });
    snapshot.issues[0]!.history[0]!.createdAt = createdAt;
    snapshot.issues[0]!.history.push({
      kind: "ASSIGNED", id: "assignment-1", actorLogin: SPONSOR_LOGIN,
      actorGitHubUserId: SPONSOR_GITHUB_USER_ID, assigneeLogin: "contributor",
      createdAt: "2026-08-30T09:30:00.000Z",
    });

    const result = foldRepository(snapshot);

    expect(result.policyViolations).toEqual([{
      code: "OPENING_LABEL_UNAUTHORIZED", githubIssueId: 101, openingLabel: "M",
      openingSourceActorLogin: "contributor",
      reason: "The application of the opening label `M` by `contributor` could not be attributed to the repository sponsor `sponsor`.",
    }]);
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

/** The recorded sentence, narrowed off the violation union so a test can read it alone. */
function unauthorizedReason(result: FoldResult): string {
  const violation = result.policyViolations.find(
    (candidate) => candidate.code === "OPENING_LABEL_UNAUTHORIZED",
  );
  if (violation?.code !== "OPENING_LABEL_UNAUTHORIZED") {
    throw new Error("no OPENING_LABEL_UNAUTHORIZED violation was recorded");
  }
  return violation.reason;
}

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
