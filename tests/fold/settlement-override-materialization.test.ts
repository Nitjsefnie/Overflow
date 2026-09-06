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
import { verifiedRepositoryAt } from "../support/verified-repository";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;
const tokenEncryptionKey = Buffer.alloc(32, 21).toString("base64url");

const repositoryOwnerName = "example/overrides";
const selfWorkOwnerName = "example/self-work";
const sponsorLogin = "override-sponsor";
const contributorLogin = "override-contributor";
const disputedIssueId = 8_100_001;
const disputedPullRequestId = 8_100_002;
const declinedIssueId = 8_100_003;
const declinedPullRequestId = 8_100_004;
const selfWorkSponsorLogin = "override-self-sponsor";
const correctedCalibrationIssueId = 8_100_005;
const correctedCalibrationPullRequestId = 8_100_006;
const uncorrectedCalibrationIssueId = 8_100_007;
const uncorrectedCalibrationPullRequestId = 8_100_008;

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

describe("a granted settlement override survives reconciliation", () => {
  it("rebuilds the corrected settlement on every reconciliation, with credits recomputed from the rule", async () => {
    const sponsorId = await insertUser(sponsorLogin, 1001);
    const contributorId = await insertUser(contributorLogin, 2001);
    const moderatorId = await insertUser("override-moderator", 3001);
    await giveAccessToken(sponsorId);
    const repositoryId = await insertRepository(sponsorId, {
      githubRepositoryId: 8_300_001,
      ownerName: repositoryOwnerName,
      githubWebhookId: 8_300_002,
    });
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
      target: { kind: "settlement", settlementId: disputed },
      reason: "The delivered label was applied, but the rationale comment came later.",
    });
    const declinedRequest = await overrides.createRequest({
      requesterId: contributorId,
      target: { kind: "settlement", settlementId: declined },
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
      target: { kind: "settlement", settlementId: await settlementIdFor(disputedIssueId) },
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

describe("a granted correction to a self-work calibration survives reconciliation", () => {
  it("rebuilds the corrected calibration on every reconciliation without inventing evidence", async () => {
    const selfWorkSponsorId = await insertUser(selfWorkSponsorLogin, 4001);
    const moderatorId = await insertUser("calibration-moderator", 4002);
    await giveAccessToken(selfWorkSponsorId);
    const repositoryId = await insertRepository(selfWorkSponsorId, {
      githubRepositoryId: 8_300_003,
      ownerName: selfWorkOwnerName,
      githubWebhookId: 8_300_004,
    });
    const store = new PostgresFoldStore(sql, tokenEncryptionKey);
    const github = selfWorkGateway();

    await reconcileOnce(store, github, repositoryId);

    // The sponsor closed their own issues, so the work is calibration rather
    // than a settlement — and with no rationale comment the fold finds no
    // delivered difficulty to calibrate the opening estimate against.
    await expect(calibrationFacts(correctedCalibrationIssueId)).resolves.toEqual({
      user_id: selfWorkSponsorId,
      opening_comparison_points: 5,
      actual_points: null,
      settled_label: null,
      settled_label_event_id: null,
      settled_rationale_comment_id: null,
    });

    const overrides = new PostgresSettlementOverrideStore(sql);
    const request = await overrides.createRequest({
      requesterId: selfWorkSponsorId,
      target: { kind: "calibration", calibrationId: await calibrationIdFor(correctedCalibrationIssueId) },
      reason: "The delivered work was harder than the opening estimate, but the rationale comment never landed.",
    });
    if (request.kind !== "ok") {
      throw new Error("Expected the calibration correction request to open.");
    }
    await overrides.decideRequest({
      actorId: moderatorId,
      requestId: request.value.id,
      decision: "GRANT",
      settledPoints: 8,
      reason: "Eight points matches the delivered diff.",
    });

    // Twice, because one reconciliation proves nothing: the fold rebuilds every
    // calibration from immutable history and materialization rewrites the row.
    const correctingRun = await reconcileOnce(store, github, repositoryId);
    const afterFirstReconciliation = await calibrationFacts(correctedCalibrationIssueId);
    const rebuildingRun = await reconcileOnce(store, github, repositoryId);
    const afterSecondReconciliation = await calibrationFacts(correctedCalibrationIssueId);

    expect(afterFirstReconciliation).toEqual({
      user_id: selfWorkSponsorId,
      opening_comparison_points: 5,
      actual_points: 8,
      // The grant priced the work; it did not claim GitHub recorded a label or
      // the rationale comment that would authorize one.
      settled_label: null,
      settled_label_event_id: null,
      settled_rationale_comment_id: null,
    });
    expect(afterSecondReconciliation).toEqual(afterFirstReconciliation);

    // The recorded reconciliation change and the written row agree: the run
    // that applied the correction records exactly one calibration change, and
    // the run that reads the same history again records none.
    await expect(calibrationChanges(correctingRun)).resolves.toEqual([
      { change_kind: "CHANGE", before_actual_points: null, after_actual_points: "8" },
    ]);
    await expect(calibrationChanges(rebuildingRun)).resolves.toEqual([]);

    // A calibration nobody corrected keeps the fold's answer.
    await expect(calibrationFacts(uncorrectedCalibrationIssueId)).resolves.toMatchObject({
      actual_points: null,
    });
  });
});

async function reconcileOnce(
  store: PostgresFoldStore,
  github: ReconciliationGateway,
  repositoryId: string,
): Promise<string> {
  const summary = await reconcileRepository({ store, github }, repositoryId);
  if (summary.skipped) {
    throw new Error("Reconciliation was skipped, so it materialized nothing.");
  }
  return summary.runId;
}

async function calibrationFacts(githubIssueId: number) {
  const [row] = await sql<
    {
      user_id: string;
      opening_comparison_points: number;
      actual_points: number | null;
      settled_label: string | null;
      settled_label_event_id: string | null;
      settled_rationale_comment_id: string | null;
    }[]
  >`
    select
      self_work_calibrations.user_id, self_work_calibrations.opening_comparison_points,
      self_work_calibrations.actual_points,
      issues.settled_label, issues.settled_label_event_id, issues.settled_rationale_comment_id
    from self_work_calibrations
    join issues on issues.id = self_work_calibrations.issue_id
    where issues.github_issue_id = ${githubIssueId}
  `;
  if (row === undefined) {
    throw new Error(`No self-work calibration was materialized for issue ${githubIssueId}.`);
  }
  return row;
}

async function calibrationIdFor(githubIssueId: number): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    select self_work_calibrations.id
    from self_work_calibrations
    join issues on issues.id = self_work_calibrations.issue_id
    where issues.github_issue_id = ${githubIssueId}
  `;
  return row.id;
}

function calibrationChanges(runId: string) {
  return sql<{ change_kind: string; before_actual_points: string | null; after_actual_points: string | null }[]>`
    select
      reconciliation_changes.change_kind,
      reconciliation_changes.before_state->>'actualPoints' as before_actual_points,
      reconciliation_changes.after_state->>'actualPoints' as after_actual_points
    from reconciliation_changes
    where reconciliation_changes.reconciliation_run_id = ${runId}
      and reconciliation_changes.entity_kind = 'SELF_WORK_CALIBRATION'
  `;
}

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

async function insertUser(githubLogin: string, githubUserId: number): Promise<string> {
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${githubLogin})
    returning id
  `;
  return user.id;
}

async function insertRepository(
  sponsorId: string,
  input: { githubRepositoryId: number; ownerName: string; githubWebhookId: number },
): Promise<string> {
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    )
    values (
      ${input.githubRepositoryId}, ${input.ownerName}, ${sponsorId}, ${"PUBLIC"}, ${input.githubWebhookId},
      ${sql.json(difficultyScheme())}::jsonb
    )
    returning id
  `;
  return repository.id;
}

/**
 * Reconciliation reads the repository through its sponsor's stored token, so a
 * sponsor without one never reaches the fold.
 */
async function giveAccessToken(userId: string): Promise<void> {
  await sql`
    update users
    set encrypted_oauth_token = ${Buffer.from(encryptToken("override-token", tokenEncryptionKey), "utf8")}
    where id = ${userId}
  `;
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

const settlementParticipants = {
  repository: "example/overrides",
  ownerLogin: sponsorLogin,
  assigneeLogin: contributorLogin,
};

const settlementAuthor = {
  repository: "example/overrides",
  authorLogin: contributorLogin,
  authorGitHubUserId: 2001,
};

/**
 * Two closed issues whose pull requests merged, neither carrying the rationale
 * comment the settlement rules require, so both fold to `UNSETTLED`.
 */
function gateway(): ReconciliationGateway {
  const issues: GitHubIssue[] = [
    unsettledIssue({ id: disputedIssueId, number: 1, ...settlementParticipants }),
    unsettledIssue({ id: declinedIssueId, number: 2, ...settlementParticipants }),
  ];
  const pullRequests = new Map<number, GitHubPullRequest[]>([
    [1, [mergedPullRequest({ id: disputedPullRequestId, number: 11, ...settlementAuthor })]],
    [2, [mergedPullRequest({ id: declinedPullRequestId, number: 12, ...settlementAuthor })]],
  ]);
  const reviews: GitHubPullRequestReview[] = [
    { id: 8_400_001, state: "CHANGES_REQUESTED", submittedAt: "2026-09-01T11:00:00.000Z", dismissal: null },
  ];
  return {
    getRepositoryById: verifiedRepositoryAt(repositoryOwnerName),
    listIssues: async () => issues.map((issue) => ({
      ...issue, closingPullRequests: pullRequests.get(issue.number) ?? [],
    })),
    getPullRequestReviews: async (_repository, pullRequestNumber) => (
      reviews.map((review) => ({ ...review, id: review.id + pullRequestNumber }))
    ),
    getPullRequestDiff: async (_repository, pullRequestNumber) => `override diff ${pullRequestNumber}`,
  };
}

function unsettledIssue(input: {
  id: number;
  number: number;
  repository: string;
  ownerLogin: string;
  assigneeLogin: string;
}): GitHubIssue {
  return {
    id: input.id,
    number: input.number,
    title: `An issue settled by the wrong bookkeeping ${input.number}`,
    body: "Issue evidence",
    url: `https://github.com/${input.repository}/issues/${input.number}`,
    state: "CLOSED",
    createdAt: "2026-09-01T08:00:00.000Z",
    authorLogin: input.ownerLogin,
    labels: ["M"],
    claimAssigneeGitHubLogin: input.assigneeLogin,
    history: [
      {
        kind: "LABELED",
        id: `opening-${input.id}`,
        actorLogin: input.ownerLogin,
        label: "M",
        createdAt: "2026-09-01T08:01:00.000Z",
      },
    ],
    comments: [],
    closingPullRequests: [],
  };
}

function mergedPullRequest(input: {
  id: number;
  number: number;
  repository: string;
  authorLogin: string;
  authorGitHubUserId: number;
}): GitHubPullRequest {
  return {
    id: input.id,
    number: input.number,
    title: `A merged pull request ${input.number}`,
    body: "Pull request evidence",
    url: `https://github.com/${input.repository}/pull/${input.number}`,
    state: "MERGED",
    mergedAt: "2026-09-01T12:00:00.000Z",
    mergeCommitOid: input.id.toString(16).padStart(40, "0"),
    finalCommitAt: "2026-09-01T10:00:00.000Z",
    authorLogin: input.authorLogin,
    authorGitHubUserId: input.authorGitHubUserId,
  };
}

/**
 * Two closed issues of the sponsor's own, each merged by the sponsor, so both
 * fold to a self-work calibration rather than to a settlement. Neither carries
 * the rationale comment that would give the fold a delivered difficulty.
 */
function selfWorkGateway(): ReconciliationGateway {
  const participants = {
    repository: "example/self-work",
    ownerLogin: selfWorkSponsorLogin,
    assigneeLogin: selfWorkSponsorLogin,
  };
  const author = {
    repository: "example/self-work",
    authorLogin: selfWorkSponsorLogin,
    authorGitHubUserId: 4001,
  };
  const issues: GitHubIssue[] = [
    unsettledIssue({ id: correctedCalibrationIssueId, number: 3, ...participants }),
    unsettledIssue({ id: uncorrectedCalibrationIssueId, number: 4, ...participants }),
  ];
  const pullRequests = new Map<number, GitHubPullRequest[]>([
    [3, [mergedPullRequest({ id: correctedCalibrationPullRequestId, number: 13, ...author })]],
    [4, [mergedPullRequest({ id: uncorrectedCalibrationPullRequestId, number: 14, ...author })]],
  ]);
  return {
    getRepositoryById: verifiedRepositoryAt(selfWorkOwnerName),
    listIssues: async () => issues.map((issue) => ({
      ...issue, closingPullRequests: pullRequests.get(issue.number) ?? [],
    })),
    getPullRequestReviews: async () => [],
    getPullRequestDiff: async (_repository, pullRequestNumber) => `self-work diff ${pullRequestNumber}`,
  };
}
