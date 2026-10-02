import { describe, expect, it } from "vitest";
import { belongsToRegisteredRepository } from "@/lib/fold/repository-ownership";

/**
 * The one place reconciliation and the fold both ask whether a closing pull
 * request lives in the repository Overflow was registered for, so the answer has
 * to be keyed on GitHub's numeric repository id and on nothing else.
 *
 * The objects the real call sites pass carry a name beside the id — the
 * registered row has `ownerName` and `observedOwnerName`, a closing reference has
 * `repositoryNameWithOwner` — and every one of those names is unreadable for this
 * decision. A renamed or transferred repository keeps its id while GitHub goes on
 * answering for the old name and reports the new one, so a name comparison turns
 * every pull request in the repository's own tracker foreign the moment it is
 * renamed; and a freed name can be taken by anyone, so a name that matches proves
 * nothing. The fixtures below are shaped like the call sites precisely so that a
 * name-keyed implementation has the names to be wrong with.
 */

/** Derived from the function, so a change to its declared inputs cannot drift. */
type RegisteredRepository = Parameters<typeof belongsToRegisteredRepository>[0] & {
  ownerName: string;
  observedOwnerName?: string;
};
type ClosingSubject = Parameters<typeof belongsToRegisteredRepository>[1] & {
  repositoryNameWithOwner: string;
};

/** `registered_repositories.github_repository_id` for the repository under test. */
const REGISTERED_ID = 526_309_017;
const RENAMED_TO_NAME = "new-owner/new-name";
const REGISTERED_NAME = "old-owner/old-name";

function registered(overrides: Partial<RegisteredRepository> = {}): RegisteredRepository {
  return { githubRepositoryId: REGISTERED_ID, ownerName: REGISTERED_NAME, ...overrides };
}

function pullRequest(overrides: Partial<ClosingSubject> = {}): ClosingSubject {
  return {
    repositoryGitHubId: REGISTERED_ID,
    repositoryNameWithOwner: RENAMED_TO_NAME,
    ...overrides,
  };
}

describe("belongsToRegisteredRepository", () => {
  it("counts a pull request in the registered repository as its own after a rename or transfer", () => {
    // The registration was filed under the old name; this run observed the new
    // one, and the closing reference reports the new one too. The id never moved.
    const observation = registered({ observedOwnerName: RENAMED_TO_NAME });

    expect(belongsToRegisteredRepository(observation, pullRequest())).toBe(true);
    // Nothing but the id is consulted: `RENAMED_TO_NAME` and `REGISTERED_NAME`
    // above differ, so a decision that read `ownerName` would answer false here
    // and unsettle work already credited in this repository's own tracker.
  });

  it("counts a pull request whose name matches the registered one as foreign once the id differs", () => {
    // The freed name, taken by someone else. The name is identical on both sides
    // and the ids are not, so a name-keyed implementation would credit a stranger's
    // pull request as evidence about this repository.
    const impostor = pullRequest({
      repositoryGitHubId: REGISTERED_ID + 1,
      repositoryNameWithOwner: REGISTERED_NAME,
    });

    expect(belongsToRegisteredRepository(registered(), impostor)).toBe(false);
  });

  it("decides on the id alone, with no name on either side", () => {
    // The two declared inputs and nothing else: no name is needed to answer, and
    // none is present to answer from.
    expect(
      belongsToRegisteredRepository({ githubRepositoryId: REGISTERED_ID }, { repositoryGitHubId: REGISTERED_ID }),
    ).toBe(true);
    expect(
      belongsToRegisteredRepository({ githubRepositoryId: 1 }, { repositoryGitHubId: 2 }),
    ).toBe(false);
  });

  // Recorded so it is not re-derived: a `String(a) === String(b)` comparison and an
  // `Object.is(a, b)` comparison are equivalent-in-practice here and cannot be
  // killed by any case. Both differ from `===` only on `NaN` and on `-0`, and
  // neither reaches this function: the registered id is `toSafeInteger(row.
  // github_repository_id)` at `src/lib/fold/postgres-store.ts:2604`, which throws
  // on `NaN`, and a closing pull request's id is `repositoryGitHubId(node)` at
  // `src/lib/github/client.ts:1308`, which throws unless it is a safe integer
  // greater than zero. The predicate itself is pure and takes plain numbers, so
  // the cases below are synthetic by construction; the argument above is only that
  // no real id narrows which mutants are reachable.

  // A numeric id is a whole number, so one id can be a prefix of another's
  // digits. Comparing them as text — or accepting one that merely starts with the
  // other — confuses a repository with an id that only looks like it.
  it.each([
    { registered: 420, foreign: 42 },
    { registered: 42, foreign: 420 },
    { registered: 123_456_789, foreign: 1_234_567_890 },
    { registered: 70, foreign: 7 },
  ])("refuses id $registered against a different id $foreign that shares its digits", ({ registered: id, foreign }) => {
    expect(
      belongsToRegisteredRepository(registered({ githubRepositoryId: id }), pullRequest({ repositoryGitHubId: foreign })),
    ).toBe(false);
  });

  // Neither operand is a presence flag, so a falsy id is an id like any other and
  // not an absent repository. A truthiness guard around the comparison — the shape
  // `Boolean(a && b && a === b)` takes — answers false for the one pair that is
  // genuinely equal, which unsettles this repository's own closing pull requests.
  it("counts id 0 as its own match rather than as an absent repository", () => {
    expect(
      belongsToRegisteredRepository(registered({ githubRepositoryId: 0 }), pullRequest({ repositoryGitHubId: 0 })),
    ).toBe(true);
  });

  it("refuses neighbouring ids, which no transfer or rename produces", () => {
    // Off-by-one acceptance is the shape a "close enough" comparison takes, and a
    // real repository id never lands one away from another repository's.
    expect(
      belongsToRegisteredRepository(registered({ githubRepositoryId: 1_000 }), pullRequest({ repositoryGitHubId: 1_001 })),
    ).toBe(false);
    expect(
      belongsToRegisteredRepository(registered({ githubRepositoryId: 1_001 }), pullRequest({ repositoryGitHubId: 1_000 })),
    ).toBe(false);
  });
});
