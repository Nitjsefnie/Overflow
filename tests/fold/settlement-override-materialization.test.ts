import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import type { GitHubIssue, GitHubPullRequest, GitHubPullRequestReview } from "@/lib/github/types";
import { PostgresSettlementOverrideStore } from "@/lib/overrides/postgres-store";
import { encryptToken } from "@/lib/security/token-cipher";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;
const tokenEncryptionKey = Buffer.alloc(32, 21).toString("base64url");

const sponsorLogin = "override-sponsor";
const contributorLogin = "override-contributor";
const disputedIssueId = 8_100_001;
const disputedPullRequestId = 8_100_002;
const declinedIssueId = 8_100_003;
const declinedPullRequestId = 8_100_004;

describe("a granted settlement override survives reconciliation", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "overflow_override_fold_test",
      user: "overflow_override_fold_test",
      password: "overflow_override_fold_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
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

  it("rebuilds the corrected settlement on every reconciliation, with credits recomputed from the rule", async () => {
    const sponsorId = await insertUser(sponsorLogin);
    const contributorId = await insertUser(contributorLogin);
    const moderatorId = await insertUser("override-moderator");
    await sql`
      update users
      set encrypted_oauth_token = ${Buffer.from(encryptToken("override-token", tokenEncryptionKey), "utf8")}
      where id = ${sponsorId}
    `;
    const repositoryId = await insertRepository(sponsorId);
    const store = new PostgresFoldStore(sql, tokenEncryptionKey);
    const github = gateway();

    await reconcileRepository({ store, github }, repositoryId);

    // The bookkeeping failed: the rationale comment is missing, so the fold
    // records an unsettled settlement with no credits even though the pull
    // request merged.
    await expect(settlementFacts(disputedIssueId)).resolves.toEqual({
      status: "UNSETTLED",
      settled_points: null,
      review_rounds: 1,
      credits: 0,
      creditor_id: contributorId,
      debtor_id: sponsorId,
    });

    const overrides = new PostgresSettlementOverrideStore(sql);
    const disputed = await settlementIdFor(disputedIssueId);
    const declined = await settlementIdFor(declinedIssueId);
    const disputedRequest = await overrides.createRequest({
      requesterId: contributorId,
      settlementId: disputed,
      reason: "The delivered label was applied, but the rationale comment came later.",
    });
    const declinedRequest = await overrides.createRequest({
      requesterId: contributorId,
      settlementId: declined,
      reason: "This one should not be corrected.",
    });
    if (disputedRequest.kind !== "ok" || declinedRequest.kind !== "ok") {
      throw new Error("Expected both correction requests to open.");
    }
    await overrides.decideRequest({
      actorId: moderatorId,
      requestId: disputedRequest.value.id,
      decision: "GRANT",
      settledPoints: 6,
      reason: "The merged work matches six delivered points.",
    });
    await overrides.decideRequest({
      actorId: moderatorId,
      requestId: declinedRequest.value.id,
      decision: "DECLINE",
      reason: "The issue was closed without the work being delivered.",
    });

    // Twice, because one reconciliation proves nothing: the fold deletes and
    // rewrites settlement rows from immutable history on every run.
    await reconcileRepository({ store, github }, repositoryId);
    const afterFirstReconciliation = await settlementFacts(disputedIssueId);
    await reconcileRepository({ store, github }, repositoryId);
    const afterSecondReconciliation = await settlementFacts(disputedIssueId);

    expect(afterFirstReconciliation).toEqual({
      status: "SETTLED",
      settled_points: 6,
      review_rounds: 1,
      credits: 5,
      creditor_id: contributorId,
      debtor_id: sponsorId,
    });
    expect(afterSecondReconciliation).toEqual(afterFirstReconciliation);

    // A declined request corrects nothing.
    await expect(settlementFacts(declinedIssueId)).resolves.toMatchObject({
      status: "UNSETTLED",
      settled_points: null,
      credits: 0,
    });

    // The correction reaches the ledger through the ordinary credits view.
    await expect(balanceOf(contributorId)).resolves.toBe(5);
    await expect(balanceOf(sponsorId)).resolves.toBe(-5);

    // The immutable evidence is untouched: the issue still carries no settled
    // label, because GitHub history never gained one.
    await expect(sql`
      select settled_label, settled_points, settled_label_event_id
      from issues where github_issue_id = ${disputedIssueId}
    `).resolves.toEqual([{ settled_label: null, settled_points: null, settled_label_event_id: null }]);

    // The correction itself survives reconciliation too.
    await expect(sql`
      select state::text as state, settled_points
      from settlement_override_requests where id = ${disputedRequest.value.id}
    `).resolves.toEqual([{ state: "GRANTED", settled_points: 6 }]);
  });

  it("applies the most recently granted correction when a settlement is corrected twice", async () => {
    const repositoryId = await repositoryIdFor(disputedIssueId);
    const store = new PostgresFoldStore(sql, tokenEncryptionKey);
    const overrides = new PostgresSettlementOverrideStore(sql);
    const [{ id: contributorId }] = await sql<{ id: string }[]>`
      select id from users where github_login = ${contributorLogin}
    `;
    const [{ id: moderatorId }] = await sql<{ id: string }[]>`
      select id from users where github_login = ${"override-moderator"}
    `;

    const reopened = await overrides.createRequest({
      requesterId: contributorId,
      settlementId: await settlementIdFor(disputedIssueId),
      reason: "Six was still too generous.",
    });
    if (reopened.kind !== "ok") {
      throw new Error("Expected a second correction request to open once the first was decided.");
    }
    await overrides.decideRequest({
      actorId: moderatorId,
      requestId: reopened.value.id,
      decision: "GRANT",
      settledPoints: 3,
      reason: "Three points matches the delivered diff.",
    });

    await reconcileRepository({ store, github: gateway() }, repositoryId);

    await expect(settlementFacts(disputedIssueId)).resolves.toMatchObject({
      status: "SETTLED",
      settled_points: 3,
      review_rounds: 1,
      credits: 2,
    });
  });
});

async function settlementFacts(githubIssueId: number) {
  const [row] = await sql<
    {
      status: string;
      settled_points: number | null;
      review_rounds: number;
      credits: number;
      creditor_id: string | null;
      debtor_id: string;
    }[]
  >`
    select
      settlements.status::text as status, settlements.settled_points, settlements.review_rounds,
      settlements.credits, settlements.creditor_id, settlements.debtor_id
    from settlements
    join issues on issues.id = settlements.issue_id
    where issues.github_issue_id = ${githubIssueId}
  `;
  if (row === undefined) {
    throw new Error(`No settlement was materialized for issue ${githubIssueId}.`);
  }
  return row;
}

async function settlementIdFor(githubIssueId: number): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select settlements.id
    from settlements
    join issues on issues.id = settlements.issue_id
    where issues.github_issue_id = ${githubIssueId}
  `;
  return row.id;
}

async function repositoryIdFor(githubIssueId: number): Promise<string> {
  const [row] = await sql<{ repository_id: string }[]>`
    select repository_id from issues where github_issue_id = ${githubIssueId}
  `;
  return row.repository_id;
}

async function balanceOf(accountId: string): Promise<number> {
  const [row] = await sql<{ balance: number }[]>`
    select balance from balances where account_id = ${accountId}
  `;
  return row?.balance ?? 0;
}

async function insertUser(githubLogin: string): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${8_200_000 + githubLogin.length * 17 + githubLogin.charCodeAt(0)}, ${githubLogin})
    returning id
  `;
  return user.id;
}

async function insertRepository(sponsorId: string): Promise<string> {
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    )
    values (
      ${8_300_001}, ${"example/overrides"}, ${sponsorId}, ${"PUBLIC"}, ${8_300_002},
      ${sql.json(difficultyScheme())}::jsonb
    )
    returning id
  `;
  return repository.id;
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

/**
 * Two closed issues whose pull requests merged, neither carrying the rationale
 * comment the settlement rules require, so both fold to `UNSETTLED`.
 */
function gateway(): ReconciliationGateway {
  const issues: GitHubIssue[] = [
    unsettledIssue({ id: disputedIssueId, number: 1 }),
    unsettledIssue({ id: declinedIssueId, number: 2 }),
  ];
  const pullRequests = new Map<number, GitHubPullRequest[]>([
    [1, [mergedPullRequest({ id: disputedPullRequestId, number: 11 })]],
    [2, [mergedPullRequest({ id: declinedPullRequestId, number: 12 })]],
  ]);
  const reviews: GitHubPullRequestReview[] = [
    { id: 8_400_001, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T11:00:00.000Z", dismissal: null },
  ];
  return {
    listIssues: async () => issues,
    getIssueClosingPullRequests: async (_repository, issueNumber) => pullRequests.get(issueNumber) ?? [],
    getPullRequestReviews: async (_repository, pullRequestNumber) => (
      reviews.map((review) => ({ ...review, id: review.id + pullRequestNumber }))
    ),
    getPullRequestDiff: async (_repository, pullRequestNumber) => `override diff ${pullRequestNumber}`,
  };
}

function unsettledIssue(input: { id: number; number: number }): GitHubIssue {
  return {
    id: input.id,
    number: input.number,
    title: `An issue settled by the wrong bookkeeping ${input.number}`,
    body: "Issue evidence",
    url: `https://github.com/example/overrides/issues/${input.number}`,
    state: "CLOSED",
    createdAt: "2026-09-01T08:00:00.000Z",
    authorLogin: sponsorLogin,
    labels: ["M"],
    claimAssigneeGitHubLogin: contributorLogin,
    history: [
      {
        kind: "LABELED",
        id: `opening-${input.id}`,
        actorLogin: sponsorLogin,
        label: "M",
        createdAt: "2026-09-01T08:01:00.000Z",
      },
    ],
    comments: [],
  };
}

function mergedPullRequest(input: { id: number; number: number }): GitHubPullRequest {
  return {
    id: input.id,
    number: input.number,
    title: `A merged pull request ${input.number}`,
    body: "Pull request evidence",
    url: `https://github.com/example/overrides/pull/${input.number}`,
    state: "MERGED",
    mergedAt: "2026-09-01T12:00:00.000Z",
    mergeCommitOid: input.id.toString(16).padStart(40, "0"),
    finalCommitAt: "2026-09-01T10:00:00.000Z",
    authorLogin: contributorLogin,
  };
}
