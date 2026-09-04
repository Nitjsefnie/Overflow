import type { JSONValue } from "postgres";
import type { SqlClient, TransactionClient } from "@/lib/db/types";
import { getSql } from "@/lib/db/client";
import type { EnforcementState } from "@/lib/db/types";
import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";
import type {
  ExistingFoldIssue,
  FoldResult,
  FoldSettlement,
  FoldUser,
} from "@/lib/fold/repository-fold";
import type {
  ReconciliationDeltas,
  ReconciliationRepository,
  ReconciliationStore,
} from "@/lib/fold/reconcile";
import type { GitHubWebhookDelivery } from "@/lib/github/webhook-schema";
import type { WebhookDeliveryStore } from "@/lib/webhooks/processor";
import { decryptToken } from "@/lib/security/token-cipher";

type RepositoryRow = {
  id: string;
  owner_name: string;
  active: boolean;
  difficulty_scheme: DifficultyScheme;
  sponsor_id: string;
  sponsor_github_login: string;
  sponsor_enforcement_state: EnforcementState;
};

type UserRow = {
  id: string;
  github_login: string;
  enforcement_state: EnforcementState;
};

type IssueRow = {
  id: string;
  github_issue_id: number | string;
  opening_label: string;
  opening_comparison_points: number;
  opening_reserve_points: number;
};

type PullRequestRow = {
  id: string;
  github_pull_request_id: number | string;
};

type SettlementRow = {
  id: string;
  issue_id: string;
  pull_request_id: string;
  github_issue_id: number | string;
  github_pull_request_id: number | string;
  creditor_id: string | null;
  creditor_github_login: string | null;
  debtor_id: string;
  opening_comparison_points: number;
  settled_points: number | null;
  review_rounds: number;
  credits: number;
  proof_sha256: string;
  status: FoldSettlement["status"];
};

export class PostgresFoldStore implements ReconciliationStore, WebhookDeliveryStore {
  public constructor(
    private readonly sql: SqlClient = getSql(),
    private readonly tokenEncryptionKey: string | undefined = process.env.TOKEN_ENCRYPTION_KEY,
  ) {}

  public async getRepository(repositoryId: string): Promise<ReconciliationRepository | null> {
    const [row] = await this.sql<RepositoryRow[]>`
      select
        repositories.id,
        repositories.owner_name,
        repositories.active,
        repositories.difficulty_scheme,
        sponsors.id as sponsor_id,
        sponsors.github_login as sponsor_github_login,
        sponsors.enforcement_state as sponsor_enforcement_state
      from registered_repositories as repositories
      join users as sponsors on sponsors.id = repositories.sponsor_id
      where repositories.id = ${repositoryId}
      limit 1
    `;
    return row === undefined ? null : toReconciliationRepository(row);
  }

  public async findRepositoryByOwnerName(ownerName: string): Promise<{ id: string } | null> {
    const [row] = await this.sql<{ id: string }[]>`
      select id
      from registered_repositories
      where owner_name = ${ownerName} and active = true
      limit 1
    `;
    return row ?? null;
  }

  public async listActiveRepositoryIds(): Promise<string[]> {
    const rows = await this.sql<{ id: string }[]>`
      select id from registered_repositories where active = true order by id
    `;
    return rows.map((row) => row.id);
  }

  public async getGitHubAccessToken(userId: string): Promise<string | null> {
    const [row] = await this.sql<{ encrypted_oauth_token: Buffer | null }[]>`
      select encrypted_oauth_token from users where id = ${userId} limit 1
    `;
    if (row === undefined || row.encrypted_oauth_token === null) {
      return null;
    }
    if (this.tokenEncryptionKey === undefined || this.tokenEncryptionKey.length === 0) {
      throw new Error("Token encryption key must be configured.");
    }
    return decryptToken(Buffer.from(row.encrypted_oauth_token).toString("utf8"), this.tokenEncryptionKey);
  }

  public async listExistingIssues(repositoryId: string): Promise<ExistingFoldIssue[]> {
    const rows = await this.sql<IssueRow[]>`
      select github_issue_id, opening_label, opening_comparison_points, opening_reserve_points
      from issues
      where repository_id = ${repositoryId}
    `;
    return rows.map((row) => ({
      githubIssueId: toSafeInteger(row.github_issue_id),
      openingLabel: row.opening_label,
      openingComparisonPoints: row.opening_comparison_points,
      openingReservePoints: row.opening_reserve_points,
    }));
  }

  public async findUsersByGitHubLogins(logins: readonly string[]): Promise<FoldUser[]> {
    const normalized = [...new Set(logins.map(normalizeLogin).filter((login) => login.length > 0))];
    if (normalized.length === 0) {
      return [];
    }
    const rows = await this.sql<UserRow[]>`
      select id, github_login, enforcement_state
      from users
      where lower(github_login) = any(${this.sql.array(normalized)})
    `;
    return rows.map(toFoldUser);
  }

  public async beginRun(repositoryId: string): Promise<string> {
    const [row] = await this.sql<{ id: string }[]>`
      insert into reconciliation_runs (repository_id, status)
      values (${repositoryId}, ${"PENDING"})
      returning id
    `;
    if (row === undefined) {
      throw new Error("Reconciliation run insert returned no row.");
    }
    return row.id;
  }

  public async failRun(runId: string, errorMessage: string): Promise<void> {
    void errorMessage;
    await this.sql`
      update reconciliation_runs
      set status = ${"FAILED"}, completed_at = now(), error_message = ${"Reconciliation failed."}
      where id = ${runId}
    `;
  }

  public async completeRun(runId: string): Promise<void> {
    await this.sql`
      update reconciliation_runs
      set status = ${"COMPLETED"}, completed_at = now(), error_message = null
      where id = ${runId}
    `;
  }

  public async materialize(input: {
    repositoryId: string;
    runId: string;
    fold: FoldResult;
  }): Promise<ReconciliationDeltas> {
    return this.sql.begin(async (transaction) => {
      const issueIds = await upsertIssues(transaction, input.repositoryId, input.fold);
      const pullRequestIds = await upsertPullRequests(transaction, input.repositoryId, input.fold, issueIds);
      await replacePullRequestIssueLinks(transaction, input.fold, issueIds, pullRequestIds);
      const deltas = await materializeSettlements(transaction, input, issueIds, pullRequestIds);
      await materializeSelfWorkCalibrations(transaction, input.fold, issueIds, pullRequestIds);
      await materializeUnwritableClosures(transaction, input.fold, issueIds);
      await materializeReviewRounds(transaction, input.fold, pullRequestIds);
      await deleteAbsentMaterialization(transaction, input.repositoryId, input.fold, issueIds, pullRequestIds);
      await recordPolicyViolations(transaction, input.runId, input.fold);
      await transaction`
        update reconciliation_runs
        set status = ${"COMPLETED"}, completed_at = now(), error_message = null
        where id = ${input.runId}
      `;
      return deltas;
    }) as Promise<ReconciliationDeltas>;
  }

  public async claimDelivery(delivery: GitHubWebhookDelivery): Promise<"NEW" | "DUPLICATE"> {
    const rows = await this.sql<{ id: string }[]>`
      insert into webhook_deliveries (github_delivery_id, event_name, processing_state)
      values (${delivery.deliveryId}, ${delivery.event}, ${"PENDING"})
      on conflict (github_delivery_id) do update
      set processing_state = ${"PENDING"}, error_message = null, processed_at = null
      where webhook_deliveries.processing_state = ${"FAILED"}
      returning id
    `;
    return rows.length === 0 ? "DUPLICATE" : "NEW";
  }

  public async findRepositoryByGitHubId(githubRepositoryId: number): Promise<{ id: string; active: boolean } | null> {
    const [row] = await this.sql<{ id: string; active: boolean }[]>`
      select id, active from registered_repositories where github_repository_id = ${githubRepositoryId} limit 1
    `;
    return row ?? null;
  }

  public async markProcessed(deliveryId: string): Promise<void> {
    await this.sql`
      update webhook_deliveries
      set processing_state = ${"PROCESSED"}, processed_at = now(), error_message = null
      where github_delivery_id = ${deliveryId}
    `;
  }

  public async markFailed(deliveryId: string, errorMessage: string): Promise<void> {
    void errorMessage;
    await this.sql`
      update webhook_deliveries
      set processing_state = ${"FAILED"}, error_message = ${"Webhook processing failed."}, processed_at = now()
      where github_delivery_id = ${deliveryId}
    `;
  }
}

export async function claimGitHubIdentity(
  sql: SqlClient,
  userId: string,
  githubLogin: string,
): Promise<void> {
  await sql.begin(async (transaction) => {
    const selfWorkSettlements = await transaction<SettlementRow[]>`
      select
        settlements.id,
        settlements.issue_id,
        settlements.pull_request_id,
        issues.github_issue_id,
        pull_requests.github_pull_request_id,
        settlements.creditor_id,
        settlements.creditor_github_login,
        settlements.debtor_id,
        settlements.opening_comparison_points,
        settlements.settled_points,
        settlements.review_rounds,
        settlements.credits,
        settlements.proof_sha256,
        settlements.status
      from settlements
      join issues on issues.id = settlements.issue_id
      join pull_requests on pull_requests.id = settlements.pull_request_id
      where settlements.status = ${"UNCLAIMED"}
        and lower(settlements.creditor_github_login) = ${normalizeLogin(githubLogin)}
        and settlements.debtor_id = ${userId}
    `;
    for (const settlement of selfWorkSettlements) {
      await transaction`
        insert into self_work_calibrations (
          pull_request_id, issue_id, user_id, opening_comparison_points, actual_points
        )
        values (
          ${settlement.pull_request_id}, ${settlement.issue_id}, ${userId},
          ${settlement.opening_comparison_points}, ${settlement.settled_points}
        )
        on conflict (pull_request_id, issue_id) do update
        set user_id = excluded.user_id,
            opening_comparison_points = excluded.opening_comparison_points,
            actual_points = excluded.actual_points
      `;
      await transaction`delete from settlements where id = ${settlement.id}`;
    }

    await transaction`
      update pull_requests
      set author_id = ${userId}
      where lower(author_github_login) = ${normalizeLogin(githubLogin)}
    `;
    await transaction`
      update settlements
      set creditor_id = ${userId}, status = ${"SETTLED"}
      where status = ${"UNCLAIMED"}
        and lower(creditor_github_login) = ${normalizeLogin(githubLogin)}
        and debtor_id <> ${userId}
    `;
  });
}

async function upsertIssues(
  sql: TransactionClient,
  repositoryId: string,
  fold: FoldResult,
): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  for (const issue of fold.issues) {
    const [row] = await sql<IssueRow[]>`
      insert into issues (
        github_issue_id, repository_id, issue_number, title, body, url, state,
        opening_label, opening_comparison_points, opening_reserve_points, claim_assignee_github_login
      )
      values (
        ${issue.githubIssueId}, ${repositoryId}, ${issue.number}, ${issue.title}, ${issue.body}, ${issue.url}, ${issue.state},
        ${issue.openingLabel}, ${issue.openingComparisonPoints}, ${issue.openingReservePoints}, ${issue.claimAssigneeGitHubLogin}
      )
      on conflict (github_issue_id) do update
      set issue_number = excluded.issue_number,
          title = excluded.title,
          body = excluded.body,
          url = excluded.url,
          state = excluded.state,
          claim_assignee_github_login = excluded.claim_assignee_github_login,
          updated_at = now()
      returning id, github_issue_id, opening_label, opening_comparison_points, opening_reserve_points
    `;
    if (row === undefined) {
      throw new Error("Issue materialization returned no row.");
    }
    ids.set(issue.githubIssueId, row.id);
  }
  return ids;
}

async function upsertPullRequests(
  sql: TransactionClient,
  repositoryId: string,
  fold: FoldResult,
  issueIds: Map<number, string>,
): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  for (const pullRequest of fold.pullRequests) {
    const firstIssueId = issueIds.get(pullRequest.githubIssueIds[0] ?? -1);
    if (firstIssueId === undefined) {
      throw new Error("Pull request was missing an authoritative issue.");
    }
    const [row] = await sql<PullRequestRow[]>`
      insert into pull_requests (
        github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
        author_id, author_github_login, actual_label, actual_points, state, merged_at, proof_sha256
      )
      values (
        ${pullRequest.githubPullRequestId}, ${repositoryId}, ${firstIssueId}, ${pullRequest.number},
        ${pullRequest.url}, ${pullRequest.title}, ${pullRequest.body}, ${pullRequest.authorId},
        ${pullRequest.authorGitHubLogin}, ${pullRequest.actualLabel}, ${pullRequest.actualPoints},
        ${pullRequest.state}, ${pullRequest.mergedAt}, ${pullRequest.proofSha256}
      )
      on conflict (github_pull_request_id) do update
      set issue_id = excluded.issue_id,
          pull_request_number = excluded.pull_request_number,
          url = excluded.url,
          title = excluded.title,
          body = excluded.body,
          author_id = excluded.author_id,
          author_github_login = excluded.author_github_login,
          actual_label = excluded.actual_label,
          actual_points = excluded.actual_points,
          state = excluded.state,
          merged_at = excluded.merged_at,
          proof_sha256 = excluded.proof_sha256,
          updated_at = now()
      returning id, github_pull_request_id
    `;
    if (row === undefined) {
      throw new Error("Pull request materialization returned no row.");
    }
    ids.set(pullRequest.githubPullRequestId, row.id);
  }
  return ids;
}

async function materializeSettlements(
  sql: TransactionClient,
  input: { repositoryId: string; runId: string; fold: FoldResult },
  issueIds: Map<number, string>,
  pullRequestIds: Map<number, string>,
): Promise<ReconciliationDeltas> {
  const existingRows = await sql<SettlementRow[]>`
    select
      settlements.id, settlements.issue_id, settlements.pull_request_id,
      issues.github_issue_id, pull_requests.github_pull_request_id,
      settlements.creditor_id, settlements.creditor_github_login, settlements.debtor_id,
      settlements.opening_comparison_points, settlements.settled_points, settlements.review_rounds,
      settlements.credits, settlements.proof_sha256, settlements.status
    from settlements
    join issues on issues.id = settlements.issue_id
    join pull_requests on pull_requests.id = settlements.pull_request_id
    where issues.repository_id = ${input.repositoryId}
  `;
  const existingByIssue = new Map(existingRows.map((row) => [toSafeInteger(row.github_issue_id), row]));
  let adds = 0;
  let changes = 0;
  let removals = 0;

  for (const settlement of input.fold.settlements) {
    const issueId = requiredId(issueIds, settlement.githubIssueId, "Issue");
    const pullRequestId = requiredId(pullRequestIds, settlement.githubPullRequestId, "Pull request");
    const current = existingByIssue.get(settlement.githubIssueId);
    const desired = settlementState(settlement);
    if (current === undefined) {
      await insertSettlement(sql, settlement, issueId, pullRequestId);
      await recordChange(sql, input.runId, pullRequestId, "ADD", null, desired);
      adds += 1;
      continue;
    }
    existingByIssue.delete(settlement.githubIssueId);
    const before = settlementStateFromRow(current);
    if (JSON.stringify(before) !== JSON.stringify(desired)) {
      await updateSettlement(sql, settlement, issueId, pullRequestId);
      await recordChange(sql, input.runId, pullRequestId, "CHANGE", before, desired);
      changes += 1;
    }
  }

  for (const row of existingByIssue.values()) {
    await sql`delete from settlements where id = ${row.id}`;
    await recordChange(sql, input.runId, row.pull_request_id, "REMOVE", settlementStateFromRow(row), null);
    removals += 1;
  }

  return { adds, changes, removals };
}

async function insertSettlement(
  sql: TransactionClient,
  settlement: FoldSettlement,
  issueId: string,
  pullRequestId: string,
): Promise<void> {
  await sql`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
    )
    values (
      ${pullRequestId}, ${issueId}, ${settlement.creditorId}, ${settlement.creditorGitHubLogin}, ${settlement.debtorId},
      ${settlement.openingComparisonPoints}, ${settlement.settledPoints}, ${settlement.reviewRounds},
      ${settlement.credits}, ${settlement.proofSha256}, ${settlement.status}
    )
  `;
}

async function updateSettlement(
  sql: TransactionClient,
  settlement: FoldSettlement,
  issueId: string,
  pullRequestId: string,
): Promise<void> {
  await sql`
    update settlements
    set pull_request_id = ${pullRequestId}, issue_id = ${issueId}, creditor_id = ${settlement.creditorId},
        creditor_github_login = ${settlement.creditorGitHubLogin}, debtor_id = ${settlement.debtorId},
        opening_comparison_points = ${settlement.openingComparisonPoints}, settled_points = ${settlement.settledPoints},
        review_rounds = ${settlement.reviewRounds}, credits = ${settlement.credits}, proof_sha256 = ${settlement.proofSha256},
        status = ${settlement.status}
    where issue_id = ${issueId}
  `;
}

async function materializeSelfWorkCalibrations(
  sql: TransactionClient,
  fold: FoldResult,
  issueIds: Map<number, string>,
  pullRequestIds: Map<number, string>,
): Promise<void> {
  for (const calibration of fold.selfWorkCalibrations) {
    await sql`
      insert into self_work_calibrations (
        pull_request_id, issue_id, user_id, opening_comparison_points, actual_points
      )
      values (
        ${requiredId(pullRequestIds, calibration.githubPullRequestId, "Pull request")},
        ${requiredId(issueIds, calibration.githubIssueId, "Issue")},
        ${calibration.userId}, ${calibration.openingComparisonPoints}, ${calibration.actualPoints}
      )
      on conflict (pull_request_id, issue_id) do update
      set user_id = excluded.user_id,
          opening_comparison_points = excluded.opening_comparison_points,
          actual_points = excluded.actual_points
    `;
  }
}

async function materializeUnwritableClosures(
  sql: TransactionClient,
  fold: FoldResult,
  issueIds: Map<number, string>,
): Promise<void> {
  for (const closure of fold.unwritableClosures) {
    await sql`
      insert into unwritable_closures (issue_id, reason)
      values (${requiredId(issueIds, closure.githubIssueId, "Issue")}, ${closure.reason})
      on conflict (issue_id) do update set reason = excluded.reason
    `;
  }
}

async function materializeReviewRounds(
  sql: TransactionClient,
  fold: FoldResult,
  pullRequestIds: Map<number, string>,
): Promise<void> {
  for (const pullRequest of fold.pullRequests) {
    const pullRequestId = requiredId(pullRequestIds, pullRequest.githubPullRequestId, "Pull request");
    await sql`delete from review_rounds where pull_request_id = ${pullRequestId}`;
    for (const review of pullRequest.reviewRounds) {
      await sql`
        insert into review_rounds (pull_request_id, github_review_id, submitted_at)
        values (${pullRequestId}, ${review.githubReviewId}, ${review.submittedAt})
      `;
    }
  }
}

async function replacePullRequestIssueLinks(
  sql: TransactionClient,
  fold: FoldResult,
  issueIds: Map<number, string>,
  pullRequestIds: Map<number, string>,
): Promise<void> {
  for (const pullRequest of fold.pullRequests) {
    const pullRequestId = requiredId(pullRequestIds, pullRequest.githubPullRequestId, "Pull request");
    for (const githubIssueId of pullRequest.githubIssueIds) {
      await sql`
        insert into pull_request_issues (pull_request_id, issue_id)
        values (${pullRequestId}, ${requiredId(issueIds, githubIssueId, "Issue")})
        on conflict do nothing
      `;
    }
  }
}

async function deleteAbsentMaterialization(
  sql: TransactionClient,
  repositoryId: string,
  fold: FoldResult,
  issueIds: Map<number, string>,
  pullRequestIds: Map<number, string>,
): Promise<void> {
  const desiredIssueIds = new Set(issueIds.values());
  const desiredPullRequestIds = new Set(pullRequestIds.values());
  const currentPullRequests = await sql<PullRequestRow[]>`
    select id, github_pull_request_id from pull_requests where repository_id = ${repositoryId}
  `;
  const currentIssues = await sql<IssueRow[]>`
    select id, github_issue_id, opening_label, opening_comparison_points, opening_reserve_points
    from issues where repository_id = ${repositoryId}
  `;

  await deleteAbsentSelfWorkCalibrations(sql, repositoryId, fold);
  await deleteAbsentUnwritableClosures(sql, repositoryId, fold);
  await deleteAbsentPullRequestIssueLinks(sql, repositoryId, fold);
  for (const pullRequest of currentPullRequests) {
    if (!desiredPullRequestIds.has(pullRequest.id)) {
      await sql`delete from review_rounds where pull_request_id = ${pullRequest.id}`;
      await sql`delete from pull_request_issues where pull_request_id = ${pullRequest.id}`;
      await sql`delete from pull_requests where id = ${pullRequest.id}`;
    }
  }
  for (const issue of currentIssues) {
    if (!desiredIssueIds.has(issue.id)) {
      await sql`delete from issues where id = ${issue.id}`;
    }
  }
}

async function deleteAbsentSelfWorkCalibrations(
  sql: TransactionClient,
  repositoryId: string,
  fold: FoldResult,
): Promise<void> {
  const desired = new Set(
    fold.selfWorkCalibrations.map(
      (calibration) => `${calibration.githubPullRequestId}:${calibration.githubIssueId}`,
    ),
  );
  const existing = await sql<{ id: string; github_pull_request_id: number | string; github_issue_id: number | string }[]>`
    select self_work_calibrations.id, pull_requests.github_pull_request_id, issues.github_issue_id
    from self_work_calibrations
    join pull_requests on pull_requests.id = self_work_calibrations.pull_request_id
    join issues on issues.id = self_work_calibrations.issue_id
    where issues.repository_id = ${repositoryId}
  `;
  for (const row of existing) {
    const key = `${toSafeInteger(row.github_pull_request_id)}:${toSafeInteger(row.github_issue_id)}`;
    if (!desired.has(key)) {
      await sql`delete from self_work_calibrations where id = ${row.id}`;
    }
  }
}

async function deleteAbsentUnwritableClosures(
  sql: TransactionClient,
  repositoryId: string,
  fold: FoldResult,
): Promise<void> {
  const desired = new Set(fold.unwritableClosures.map((closure) => closure.githubIssueId));
  const existing = await sql<{ id: string; github_issue_id: number | string }[]>`
    select unwritable_closures.id, issues.github_issue_id
    from unwritable_closures
    join issues on issues.id = unwritable_closures.issue_id
    where issues.repository_id = ${repositoryId}
  `;
  for (const row of existing) {
    if (!desired.has(toSafeInteger(row.github_issue_id))) {
      await sql`delete from unwritable_closures where id = ${row.id}`;
    }
  }
}

async function deleteAbsentPullRequestIssueLinks(
  sql: TransactionClient,
  repositoryId: string,
  fold: FoldResult,
): Promise<void> {
  const desired = new Set(
    fold.pullRequests.flatMap((pullRequest) =>
      pullRequest.githubIssueIds.map((githubIssueId) => `${pullRequest.githubPullRequestId}:${githubIssueId}`),
    ),
  );
  const existing = await sql<{
    pull_request_id: string;
    issue_id: string;
    github_pull_request_id: number | string;
    github_issue_id: number | string;
  }[]>`
    select links.pull_request_id, links.issue_id, pull_requests.github_pull_request_id, issues.github_issue_id
    from pull_request_issues as links
    join pull_requests on pull_requests.id = links.pull_request_id
    join issues on issues.id = links.issue_id
    where pull_requests.repository_id = ${repositoryId}
  `;
  for (const row of existing) {
    const key = `${toSafeInteger(row.github_pull_request_id)}:${toSafeInteger(row.github_issue_id)}`;
    if (!desired.has(key)) {
      await sql`
        delete from pull_request_issues
        where pull_request_id = ${row.pull_request_id} and issue_id = ${row.issue_id}
      `;
    }
  }
}

async function recordPolicyViolations(
  sql: TransactionClient,
  runId: string,
  fold: FoldResult,
): Promise<void> {
  for (const violation of fold.policyViolations) {
    await recordChange(sql, runId, null, "POLICY_VIOLATION", null, violation);
  }
}

async function recordChange(
  sql: TransactionClient,
  runId: string,
  pullRequestId: string | null,
  kind: string,
  before: JSONValue | null,
  after: JSONValue | null,
): Promise<void> {
  await sql`
    insert into reconciliation_changes (reconciliation_run_id, pull_request_id, change_kind, before_state, after_state)
    values (${runId}, ${pullRequestId}, ${kind}, ${before === null ? null : sql.json(before)}, ${after === null ? null : sql.json(after)})
  `;
}

function settlementState(settlement: FoldSettlement): JSONValue {
  return {
    githubIssueId: settlement.githubIssueId,
    githubPullRequestId: settlement.githubPullRequestId,
    creditorId: settlement.creditorId,
    creditorGitHubLogin: settlement.creditorGitHubLogin,
    debtorId: settlement.debtorId,
    openingComparisonPoints: settlement.openingComparisonPoints,
    settledPoints: settlement.settledPoints,
    reviewRounds: settlement.reviewRounds,
    credits: settlement.credits,
    proofSha256: settlement.proofSha256,
    status: settlement.status,
  };
}

function settlementStateFromRow(row: SettlementRow): JSONValue {
  return {
    githubIssueId: toSafeInteger(row.github_issue_id),
    githubPullRequestId: toSafeInteger(row.github_pull_request_id),
    creditorId: row.creditor_id,
    creditorGitHubLogin: row.creditor_github_login,
    debtorId: row.debtor_id,
    openingComparisonPoints: row.opening_comparison_points,
    settledPoints: row.settled_points,
    reviewRounds: row.review_rounds,
    credits: row.credits,
    proofSha256: row.proof_sha256,
    status: row.status,
  };
}

function toReconciliationRepository(row: RepositoryRow): ReconciliationRepository {
  return {
    id: row.id,
    ownerName: row.owner_name,
    active: row.active,
    difficultyScheme: row.difficulty_scheme,
    sponsor: {
      id: row.sponsor_id,
      githubLogin: row.sponsor_github_login,
      enforcementState: row.sponsor_enforcement_state,
    },
  };
}

function toFoldUser(row: UserRow): FoldUser {
  return {
    id: row.id,
    githubLogin: row.github_login,
    enforcementState: row.enforcement_state,
  };
}

function requiredId(ids: Map<number, string>, githubId: number, label: string): string {
  const id = ids.get(githubId);
  if (id === undefined) {
    throw new Error(`${label} materialization was missing.`);
  }
  return id;
}

function toSafeInteger(value: number | string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new Error("Database record was invalid.");
  }
  return parsed;
}

function normalizeLogin(value: string): string {
  return value.trim().toLowerCase();
}
