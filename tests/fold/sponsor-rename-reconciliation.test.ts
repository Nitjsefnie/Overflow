import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import type { GitHubIssue } from "@/lib/github/types";
import { encryptToken } from "@/lib/security/token-cipher";
import { verifiedRepositoryAt } from "../support/verified-repository";

/**
 * The rename the fold has to survive, driven through the entry point that lost
 * the issue: `users.github_login` refreshes only when that user next signs in,
 * so it is stale for as long as the sponsor does not sign in again, while
 * GitHub reports the renamed account's CURRENT login as the author and as the
 * actor of every event it serves. Deciding who the sponsor is by login
 * therefore resolves no opening after the rename, the issue drops out of the
 * fold, and materialization deletes its row — the loss the run reported as
 * `COMPLETED` with nothing removed.
 *
 * The suites either side of this one each hold one half: `sponsor-account-rename`
 * pins the predicate on a hand-built snapshot, `materialization-removals` pins
 * the removal log on a fold that emptied for an unrelated reason. Only here does
 * a non-null actor id reach `reconcileRepository` and a real database.
 */
const SPONSOR_GITHUB_USER_ID = 9_400_001;
/** What `users.github_login` still holds after the sponsor renamed. */
const STORED_SPONSOR_LOGIN = "owner-old";
/** What GitHub now reports for the same numeric account. */
const RENAMED_SPONSOR_LOGIN = "owner-new";
/** A different GitHub account that has taken the login the sponsor left behind. */
const IMPOSTOR_GITHUB_USER_ID = 9_400_002;

const renamedSponsorRepositoryGitHubId = 9_410_001;
const impostorRepositoryGitHubId = 9_410_003;
const renamedSponsorIssueGitHubId = 9_420_001;
const impostorIssueGitHubId = 9_420_002;

/** Registration predates every fixture timestamp, so no evidence window is out of reach. */
const REGISTERED_AT = "2026-01-01T00:00:00.000Z";
const ISSUE_CREATED_AT = "2026-08-30T09:00:00.000Z";
const OPENING_LABELED_AT = "2026-08-30T10:00:00.000Z";

let container: StartedTestContainer | undefined;
let sql: Sql;
let sponsorId: string;
const originalDatabaseUrl = process.env.DATABASE_URL;
const tokenEncryptionKey = Buffer.alloc(32, 41).toString("base64url");

type FixtureActor = { login: string | null; githubUserId: number | null };

const sponsorBeforeTheRename: FixtureActor = {
  login: STORED_SPONSOR_LOGIN,
  githubUserId: SPONSOR_GITHUB_USER_ID,
};
const sponsorAfterTheRename: FixtureActor = {
  login: RENAMED_SPONSOR_LOGIN,
  githubUserId: SPONSOR_GITHUB_USER_ID,
};
const impostorHoldingTheFreedLogin: FixtureActor = {
  login: STORED_SPONSOR_LOGIN,
  githubUserId: IMPOSTOR_GITHUB_USER_ID,
};

type IssueRow = {
  id: string;
  github_issue_id: number | string;
  owner_github_login: string | null;
  opening_label: string;
  opening_comparison_points: number;
  opening_reserve_points: number;
  opening_source_event_id: string | null;
  opening_source_actor_login: string | null;
};

type ChangeRow = {
  entity_kind: string;
  change_kind: string;
  pull_request_id: string | null;
  before_state: Record<string, unknown> | null;
  after_state: Record<string, unknown> | null;
};

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "overflow_sponsor_rename_fold_test",
    user: "overflow_sponsor_rename_fold_test",
    password: "overflow_sponsor_rename_fold_test",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
  // One account sponsors both repositories: `users.github_login` is unique, so
  // the stored login the rename left behind can only exist once.
  sponsorId = await insertSponsor();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

describe("reconcileRepository across a sponsor's GitHub account rename", () => {
  it("keeps the materialized issue when GitHub starts reporting the sponsor's new login", async () => {
    const { repositoryId, store, ownerName } = await registerRepository({
      githubRepositoryId: renamedSponsorRepositoryGitHubId,
      ownerName: "example/renamed-sponsor",
      githubWebhookId: 9_410_002,
    });
    let issues = [openIssue({
      id: renamedSponsorIssueGitHubId,
      number: 1,
      ownerName,
      author: sponsorBeforeTheRename,
      opening: sponsorBeforeTheRename,
    })];
    const github = gateway(ownerName, () => issues);

    // `adds` counts settlements and calibrations rather than issues, so the
    // materialized row is what says the first run priced this issue at all.
    await reconcile(store, github, repositoryId);
    const materializedBefore = await materializedIssues(repositoryId);
    expect(materializedBefore).toEqual([expect.objectContaining({
      github_issue_id: String(renamedSponsorIssueGitHubId),
      // Both display columns are pinned here, because the claim below is that
      // they FOLLOWED the rename: an inferred starting value would let a row
      // that always read `owner-new` pass as one that changed.
      owner_github_login: STORED_SPONSOR_LOGIN,
      opening_source_actor_login: STORED_SPONSOR_LOGIN,
      opening_label: "M",
      opening_comparison_points: 5,
      opening_reserve_points: 5,
      opening_source_event_id: `opening-${renamedSponsorIssueGitHubId}`,
    })]);

    // The sponsor renamed on GitHub. Every payload now carries the new login
    // against the same numeric account, and nothing signs the sponsor in, so
    // the stored login stays as it was.
    issues = [openIssue({
      id: renamedSponsorIssueGitHubId,
      number: 1,
      ownerName,
      author: sponsorAfterTheRename,
      opening: sponsorAfterTheRename,
    })];
    const second = await reconcile(store, github, repositoryId);

    await expect(storedSponsorLogin()).resolves.toBe(STORED_SPONSOR_LOGIN);
    await expect(runStatus(second.runId)).resolves.toBe("COMPLETED");
    // Asserted BEFORE the counters: this block carries what the case means —
    // the same row, its opening evidence frozen, its display columns moved —
    // and a counter assertion ahead of it would abort the test first, leaving
    // it unwatched under any mutation that reinstates the login comparison.
    const materializedAfter = await materializedIssues(repositoryId);
    expect(materializedAfter).toEqual([{
      // The same row, not a deleted one replaced by an equal-looking insert.
      id: materializedBefore[0].id,
      github_issue_id: materializedBefore[0].github_issue_id,
      opening_label: "M",
      opening_comparison_points: 5,
      opening_reserve_points: 5,
      opening_source_event_id: `opening-${renamedSponsorIssueGitHubId}`,
      // Display text is read from the payload, so it follows the rename while
      // the opening evidence beside it stays frozen.
      owner_github_login: RENAMED_SPONSOR_LOGIN,
      opening_source_actor_login: RENAMED_SPONSOR_LOGIN,
    }]);
    // `removed` is this summary's alias for `removals`, so asserting one
    // against the other proves nothing: both are pinned to the literal the
    // removal log below pins.
    expect({ removals: second.removals, removed: second.removed }).toEqual({ removals: 0, removed: 0 });
    await expect(removalChanges(second.runId)).resolves.toEqual([]);
  });

  it("reports and records the removal when a different account takes the sponsor's freed login", async () => {
    const { repositoryId, store, ownerName } = await registerRepository({
      githubRepositoryId: impostorRepositoryGitHubId,
      ownerName: "example/impostor-opening",
      githubWebhookId: 9_410_004,
    });
    let issues = [openIssue({
      id: impostorIssueGitHubId,
      number: 1,
      ownerName,
      author: sponsorBeforeTheRename,
      opening: sponsorBeforeTheRename,
    })];
    const github = gateway(ownerName, () => issues);

    await reconcile(store, github, repositoryId);
    await expect(materializedIssueIds(repositoryId)).resolves.toEqual([impostorIssueGitHubId]);

    // A different numeric account has taken the login the sponsor left behind
    // and applied the opening label. The issue genuinely has no opening the
    // sponsor gave it, so losing it is correct — what must not happen is losing
    // it silently.
    issues = [openIssue({
      id: impostorIssueGitHubId,
      number: 1,
      ownerName,
      author: sponsorAfterTheRename,
      opening: impostorHoldingTheFreedLogin,
    })];
    const second = await reconcile(store, github, repositoryId);

    await expect(runStatus(second.runId)).resolves.toBe("COMPLETED");
    await expect(materializedIssueIds(repositoryId)).resolves.toEqual([]);
    const removals = await removalChanges(second.runId);
    expect(removals).toEqual([{
      entity_kind: "ISSUE",
      change_kind: "REMOVE",
      pull_request_id: null,
      before_state: {
        githubIssueId: impostorIssueGitHubId,
        openingLabel: "M",
        openingComparisonPoints: 5,
        openingReservePoints: 5,
      },
      after_state: null,
    }]);
    // Pinned to the literal, not to `removals.length`: a defect that recorded
    // one spurious removal AND counted it moves both sides of that comparison
    // together and passes it.
    expect({ removals: second.removals, removed: second.removed }).toEqual({ removals: 1, removed: 1 });
  });
});

async function reconcile(
  store: PostgresFoldStore,
  github: ReconciliationGateway,
  repositoryId: string,
): Promise<{ runId: string; removals: number; removed: number }> {
  const summary = await reconcileRepository({ store, github }, repositoryId);
  if (summary.skipped) {
    throw new Error("Expected the reconciliation to run.");
  }
  return { runId: summary.runId, removals: summary.removals, removed: summary.removed };
}

async function runStatus(runId: string): Promise<string> {
  const [row] = await sql<{ status: string }[]>`
    select status from reconciliation_runs where id = ${runId}
  `;
  return row.status;
}

/**
 * `reconciliation_changes` has no intra-run ordering key — one transaction gives
 * every row the same `created_at` and ties break on a random uuid — so the read
 * back is ordered by `entity_kind`, which each fixture here removes at most one
 * of. That makes the order a property of the fixture rather than of the write.
 */
async function removalChanges(runId: string): Promise<ChangeRow[]> {
  return sql<ChangeRow[]>`
    select entity_kind, change_kind, pull_request_id, before_state, after_state
    from reconciliation_changes
    where reconciliation_run_id = ${runId} and change_kind = ${"REMOVE"}
    order by entity_kind::text asc
  `;
}

async function materializedIssues(repositoryId: string): Promise<IssueRow[]> {
  return sql<IssueRow[]>`
    select id, github_issue_id, owner_github_login, opening_label, opening_comparison_points,
           opening_reserve_points, opening_source_event_id, opening_source_actor_login
    from issues where repository_id = ${repositoryId} order by github_issue_id asc
  `;
}

async function materializedIssueIds(repositoryId: string): Promise<number[]> {
  const rows = await materializedIssues(repositoryId);
  return rows.map((row) => Number(row.github_issue_id));
}

async function storedSponsorLogin(): Promise<string> {
  const [row] = await sql<{ github_login: string }[]>`
    select github_login from users where id = ${sponsorId}
  `;
  return row.github_login;
}

async function insertSponsor(): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, encrypted_oauth_token)
    values (
      ${SPONSOR_GITHUB_USER_ID}, ${STORED_SPONSOR_LOGIN},
      ${Buffer.from(encryptToken("sponsor-rename-token", tokenEncryptionKey), "utf8")}
    )
    returning id
  `;
  return user.id;
}

async function registerRepository(input: {
  githubRepositoryId: number;
  ownerName: string;
  githubWebhookId: number;
}): Promise<{ repositoryId: string; store: PostgresFoldStore; ownerName: string }> {
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme, created_at
    )
    values (
      ${input.githubRepositoryId}, ${input.ownerName}, ${sponsorId}, ${"PUBLIC"}, ${input.githubWebhookId},
      ${sql.json(difficultyScheme())}::jsonb, ${REGISTERED_AT}
    )
    returning id
  `;
  return {
    repositoryId: repository.id,
    store: new PostgresFoldStore(sql, tokenEncryptionKey),
    ownerName: input.ownerName,
  };
}

function difficultyScheme() {
  return {
    openingName: "Scope",
    actualName: "Delivered difficulty",
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

function gateway(ownerName: string, issuesNow: () => readonly GitHubIssue[]): ReconciliationGateway {
  return {
    getRepositoryById: verifiedRepositoryAt(ownerName),
    listIssues: async () => issuesNow().map((issue) => ({ ...issue })),
    getPullRequestReviews: async () => [],
    getPullRequestDiff: async (_repository, pullRequestNumber) => `sponsor rename diff ${pullRequestNumber}`,
  };
}

/** One open issue the sponsor authored and priced, with every actor substitutable. */
function openIssue(input: {
  id: number;
  number: number;
  ownerName: string;
  author: FixtureActor;
  opening: FixtureActor;
}): GitHubIssue {
  return {
    id: input.id,
    number: input.number,
    title: `An issue the sponsor opened and priced ${input.number}`,
    body: "Issue evidence",
    url: `https://github.com/${input.ownerName}/issues/${input.number}`,
    state: "OPEN",
    createdAt: ISSUE_CREATED_AT,
    closedAt: null,
    authorLogin: input.author.login,
    authorGitHubUserId: input.author.githubUserId,
    labels: ["M"],
    claimAssigneeGitHubLogin: null,
    history: [
      {
        kind: "LABELED",
        id: `opening-${input.id}`,
        actorLogin: input.opening.login,
        actorGitHubUserId: input.opening.githubUserId,
        label: "M",
        createdAt: OPENING_LABELED_AT,
      },
    ],
    comments: [],
    closingPullRequests: [],
  };
}
