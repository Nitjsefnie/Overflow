import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import type { GitHubIssue, GitHubIssueComment, GitHubPullRequest } from "@/lib/github/types";
import { credentialBinding, encryptToken } from "@/lib/security/token-cipher";
import { verifiedRepositoryAt } from "../support/verified-repository";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;
const tokenEncryptionKey = Buffer.alloc(32, 23).toString("base64url");

const ownerName = "example/donations";
const repositoryGitHubId = 8_700_001;
const issueGitHubId = 8_700_011;
const pullRequestGitHubId = 8_700_012;
const sponsorGitHubId = 1101;
const contributorGitHubId = 2101;
const mergedAt = "2026-09-01T12:00:00.000Z";

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "donation_materialization", user: "donation_materialization" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});

beforeEach(async () => {
  await sql`truncate users cascade`;
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.OVERFLOW_DATABASE_URL;
  else process.env.OVERFLOW_DATABASE_URL = originalDatabaseUrl;
});

describe("a /donate mark reconciled into the settlements table", () => {
  let sponsorId: string;
  let contributorId: string;
  let repositoryId: string;
  let store: PostgresFoldStore;

  beforeEach(async () => {
    sponsorId = await insertUser("donation-sponsor", sponsorGitHubId);
    contributorId = await insertUser("donation-contributor", contributorGitHubId);
    await giveAccessToken(sponsorId);
    repositoryId = await insertRepository(sponsorId);
    store = new PostgresFoldStore(sql, tokenEncryptionKey);
  });

  it("settles work marked before the merge as DONATED, keeping its figure and moving no points", async () => {
    const run = await reconcileRepository({ store, github: gateway(() => [settledIssue([donate()])]) }, repositoryId);

    await expect(settlementFacts()).resolves.toEqual({
      status: "DONATED", donation_comment_id: "donate-comment", settled_points: 7, review_rounds: 1, credits: 6,
      creditor_id: contributorId, debtor_id: sponsorId,
    });
    await expect(settlementLegs()).resolves.toEqual([]);
    await expect(balances([sponsorId, contributorId])).resolves.toEqual([]);
    await expect(settlementChanges(run.runId!)).resolves.toEqual([{
      change_kind: "ADD", before: null, after: { status: "DONATED", donationCommentId: "donate-comment", credits: 6 },
    }]);
  });

  it("keeps the mark through a pass served from the evidence cache, and rewrites the row as the mark comes and goes", async () => {
    let listed: GitHubIssue[] = [settledIssue([])];
    const github = gateway(() => listed);

    await reconcileRepository({ store, github }, repositoryId);
    await expect(settlementFacts()).resolves.toMatchObject({ status: "SETTLED", donation_comment_id: null, credits: 6 });
    await expect(settlementLegs()).resolves.toEqual([
      { account_id: sponsorId, amount: -6 }, { account_id: contributorId, amount: 6 },
    ]);

    listed = [settledIssue([donate()])];
    const marked = await reconcileRepository({ store, github }, repositoryId);
    await expect(settlementFacts()).resolves.toMatchObject({ status: "DONATED", donation_comment_id: "donate-comment", credits: 6 });
    await expect(settlementLegs()).resolves.toEqual([]);
    await expect(settlementChanges(marked.runId!)).resolves.toEqual([{
      change_kind: "CHANGE",
      before: { status: "SETTLED", donationCommentId: null, credits: 6 },
      after: { status: "DONATED", donationCommentId: "donate-comment", credits: 6 },
    }]);

    // Nothing changed upstream: the issue is folded from the cache, whose comment bodies are placeholders.
    listed = [];
    const cachedPass = await reconcileRepository({ store, github }, repositoryId);
    await expect(cachedIssueBodies()).resolves.toEqual(["[body removed]", "[body removed]"]);
    await expect(settlementFacts()).resolves.toMatchObject({ status: "DONATED", donation_comment_id: "donate-comment" });
    await expect(settlementChanges(cachedPass.runId!)).resolves.toEqual([]);

    listed = [settledIssue([])];
    const unmarked = await reconcileRepository({ store, github }, repositoryId);
    await expect(settlementFacts()).resolves.toMatchObject({ status: "SETTLED", donation_comment_id: null, credits: 6 });
    await expect(settlementLegs()).resolves.toEqual([
      { account_id: sponsorId, amount: -6 }, { account_id: contributorId, amount: 6 },
    ]);
    await expect(settlementChanges(unmarked.runId!)).resolves.toEqual([{
      change_kind: "CHANGE",
      before: { status: "DONATED", donationCommentId: "donate-comment", credits: 6 },
      after: { status: "SETTLED", donationCommentId: null, credits: 6 },
    }]);
  });
});

async function settlementFacts() {
  const [row] = await sql<Record<string, unknown>[]>`
    select settlements.status::text, settlements.donation_comment_id, settlements.settled_points, settlements.review_rounds,
      settlements.credits, settlements.creditor_id, settlements.debtor_id
    from settlements join issues on issues.id = settlements.issue_id
    where issues.github_issue_id = ${issueGitHubId}
  `;
  return row;
}

async function settlementLegs() {
  return [...await sql<{ account_id: string; amount: number }[]>`
    select ledger_entries.account_id, ledger_entries.amount
    from ledger_entries
    join settlements on settlements.id = ledger_entries.settlement_id
    join issues on issues.id = settlements.issue_id
    where issues.github_issue_id = ${issueGitHubId}
    order by ledger_entries.amount
  `];
}

async function balances(accountIds: string[]) {
  return [...await sql`
    select account_id, balance from balances where account_id = any(${accountIds}::uuid[]) and balance <> 0
  `];
}

async function settlementChanges(runId: string) {
  const rows = await sql<{ change_kind: string; before_state: Record<string, unknown> | null; after_state: Record<string, unknown> | null }[]>`
    select change_kind::text, before_state, after_state from reconciliation_changes
    where reconciliation_run_id = ${runId} and entity_kind = 'SETTLEMENT'
  `;
  const pick = (state: Record<string, unknown> | null) => state === null ? null
    : { status: state.status, donationCommentId: state.donationCommentId, credits: state.credits };
  return rows.map((row) => ({ change_kind: row.change_kind, before: pick(row.before_state), after: pick(row.after_state) }));
}

async function cachedIssueBodies() {
  const rows = await sql<{ body: string }[]>`
    select comment ->> 'body' as body
    from repository_reconciliation_evidence_facts as facts, jsonb_array_elements(facts.payload -> 'comments') as comment
    where facts.repository_id = ${await onlyRepositoryId()} and facts.kind = 'issue'
    order by comment ->> 'id'
  `;
  return rows.map((row) => row.body);
}

async function onlyRepositoryId(): Promise<string> {
  const [row] = await sql<{ id: string }[]>`select id from registered_repositories`;
  return row.id;
}

async function insertUser(githubLogin: string, githubUserId: number): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (${githubUserId}, ${githubLogin}) returning id
  `;
  return user.id;
}

async function insertRepository(sponsorId: string): Promise<string> {
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
    values (${repositoryGitHubId}, ${ownerName}, ${sponsorId}, 'PUBLIC', 8_700_002, ${sql.json(difficultyScheme())}::jsonb)
    returning id
  `;
  return repository.id;
}

/** Reconciliation reads the repository through its sponsor's stored token. */
async function giveAccessToken(userId: string): Promise<void> {
  await sql`
    update users
    set encrypted_oauth_token = ${Buffer.from(
      encryptToken("donation-token", tokenEncryptionKey, credentialBinding.userOAuthToken(String(sponsorGitHubId))), "utf8",
    )}
    where id = ${userId}
  `;
}

function difficultyScheme() {
  return {
    openingName: "Scope",
    actualName: "Delivered difficulty",
    openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
  };
}

/** Every pass lists exactly what `issues()` returns at the time: an empty list means nothing changed upstream. */
function gateway(issues: () => GitHubIssue[]): ReconciliationGateway {
  return {
    getRepositoryById: verifiedRepositoryAt(ownerName),
    getIssue: async () => null,
    getPullRequestClosingIssues: async () => [],
    listIssues: async () => issues(),
    getPullRequestReviews: async () => [
      { id: 8_700_021, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T11:00:00.000Z", dismissal: null },
    ],
    getPullRequestDiff: async () => "donated diff",
  };
}

function donate(): GitHubIssueComment {
  return {
    id: "donate-comment", databaseId: 8_700_032, authorLogin: "donation-contributor", authorGitHubUserId: contributorGitHubId,
    body: "/donate", createdAt: "2026-09-01T11:40:00.000Z", lastEditedAt: null,
  };
}

/** A closed issue the sponsor settled at delivered/7, closed by the contributor's merged pull request. */
function settledIssue(extraComments: GitHubIssueComment[]): GitHubIssue {
  const sponsor = { actorLogin: "donation-sponsor", actorGitHubUserId: sponsorGitHubId };
  return {
    id: issueGitHubId,
    number: 1,
    title: "Donated work",
    updatedAt: "2026-09-01T12:05:00.000Z",
    body: "Issue evidence",
    url: `https://github.com/${ownerName}/issues/1`,
    state: "CLOSED",
    stateReason: "COMPLETED",
    createdAt: "2026-09-01T08:00:00.000Z",
    closedAt: "2026-09-01T12:05:00.000Z",
    authorLogin: "donation-sponsor",
    authorGitHubUserId: sponsorGitHubId,
    labels: ["M", "delivered/7"],
    claimAssigneeGitHubLogin: "donation-contributor",
    claimAssigneeGitHubUserId: contributorGitHubId,
    history: [
      { kind: "LABELED", id: "opening-label", ...sponsor, label: "M", createdAt: "2026-09-01T08:01:00.000Z" },
      { kind: "LABELED", id: "settled-label", ...sponsor, label: "delivered/7", createdAt: "2026-09-01T11:30:00.000Z" },
    ],
    comments: [
      {
        id: "rationale-comment", databaseId: 8_700_031, authorLogin: "donation-sponsor", authorGitHubUserId: sponsorGitHubId,
        body: "Settled at delivered/7.", createdAt: "2026-09-01T11:35:00.000Z", lastEditedAt: null,
      },
      ...extraComments,
    ],
    closingPullRequests: [mergedPullRequest()],
  };
}

function mergedPullRequest(): GitHubPullRequest {
  return {
    id: pullRequestGitHubId,
    number: 11,
    title: "Donated pull request",
    body: "Pull request evidence",
    url: `https://github.com/${ownerName}/pull/11`,
    state: "MERGED",
    mergedAt,
    mergeCommitOid: "d".repeat(40),
    finalCommitAt: "2026-09-01T10:00:00.000Z",
    authorLogin: "donation-contributor",
    authorGitHubUserId: contributorGitHubId,
    repositoryGitHubId,
    repositoryNameWithOwner: ownerName,
  };
}
