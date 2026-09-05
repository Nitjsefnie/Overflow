import { randomUUID } from "node:crypto";
import type { JSONValue } from "postgres";
import { getSql } from "@/lib/db/client";
import {
  type EnforcementState,
  type SqlClient,
  type TransactionClient,
} from "@/lib/db/types";
import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";
import type {
  FoldModerationEvent,
  FoldResult,
  FoldSettlement,
  FoldUser,
  SelfWorkCalibration,
  UnwritableClosure,
} from "@/lib/fold/repository-fold";
import type {
  ReconciliationDeltas,
  ReconciliationRepository,
  ReconciliationStore,
} from "@/lib/fold/reconcile";
import type { GitHubWebhookDelivery } from "@/lib/github/webhook-schema";
import { applyGrantedSettlementOverride } from "@/lib/overrides/apply";
import type { WebhookDeliveryClaim, WebhookDeliveryStore } from "@/lib/webhooks/processor";
import { decryptToken } from "@/lib/security/token-cipher";

type RepositoryRow = {
  id: string;
  owner_name: string;
  active: boolean;
  difficulty_scheme: DifficultyScheme;
  sponsor_id: string;
  sponsor_github_user_id: number | string;
  sponsor_github_login: string;
  sponsor_enforcement_state: EnforcementState;
  sponsor_moderation_events: unknown;
};

type UserRow = {
  id: string;
  github_user_id: number | string;
  github_login: string;
  enforcement_state: EnforcementState;
  moderation_events: unknown;
};

type IssueRow = {
  id: string;
  github_issue_id: number | string;
  opening_label: string;
  opening_comparison_points: number;
  opening_reserve_points: number;
  owner_github_login: string | null;
  opening_source_event_id: string | null;
  opening_source_actor_login: string | null;
  opening_source_at: string | Date | null;
  settled_label: string | null;
  settled_points: number | null;
  settled_label_event_id: string | null;
  settled_label_actor_login: string | null;
  settled_label_applied_at: string | Date | null;
  settled_rationale_comment_id: string | null;
  settled_rationale_actor_login: string | null;
  settled_rationale_commented_at: string | Date | null;
};

type PullRequestRow = {
  id: string;
  github_pull_request_id: number | string;
  merge_commit_oid?: string | null;
  merged_at?: string | Date | null;
};

type SettlementRow = {
  id: string;
  issue_id: string;
  pull_request_id: string;
  github_issue_id: number | string;
  github_pull_request_id: number | string;
  creditor_id: string | null;
  creditor_github_login: string | null;
  creditor_github_user_id: number | string | null;
  debtor_id: string;
  opening_comparison_points: number;
  settled_points: number | null;
  review_rounds: number;
  credits: number;
  proof_sha256: string;
  status: FoldSettlement["status"];
  settled_label: string | null;
  settled_label_event_id: string | null;
  settled_label_actor_login: string | null;
  settled_label_applied_at: string | Date | null;
  settled_rationale_comment_id: string | null;
  settled_rationale_actor_login: string | null;
  settled_rationale_commented_at: string | Date | null;
  merge_commit_oid: string | null;
  merged_at: string | Date | null;
};

type IdentityClaimSettlementRow = Pick<
  SettlementRow,
  | "id"
  | "issue_id"
  | "pull_request_id"
  | "creditor_id"
  | "creditor_github_login"
  | "debtor_id"
  | "opening_comparison_points"
  | "settled_points"
>;

type WebhookDeliveryLeaseRow = {
  processing_lease_token: string;
};

type SelfWorkCalibrationRow = {
  id: string;
  pull_request_id: string;
  issue_id: string;
  github_pull_request_id: number | string;
  github_issue_id: number | string;
  user_id: string;
  opening_comparison_points: number;
  actual_points: number | null;
  actual_label: string | null;
  settled_label_event_id: string | null;
  settled_label_actor_login: string | null;
  settled_label_applied_at: string | Date | null;
  settled_rationale_comment_id: string | null;
  settled_rationale_actor_login: string | null;
  settled_rationale_commented_at: string | Date | null;
  merge_commit_oid: string | null;
  merged_at: string | Date | null;
};

type UnwritableClosureRow = {
  id: string;
  issue_id: string;
  github_issue_id: number | string;
  kind: UnwritableClosure["kind"];
  github_pull_request_id: number | string | null;
  reason: string;
};

type ReconciledEntityKind =
  | "SETTLEMENT"
  | "SELF_WORK_CALIBRATION"
  | "UNWRITABLE_CLOSURE"
  | "POLICY_VIOLATION";

type ReconciliationChangeKind = "ADD" | "CHANGE" | "REMOVE" | "POLICY_VIOLATION";

const repositoryLockWaitDeadlineMs = 60_000;
const repositoryLockInitialRetryMs = 10;
const repositoryLockMaximumRetryMs = 250;
const repositoryLockNamespace = 684029183;
const repositoryCoordinationFailure = "Unable to coordinate repository reconciliation.";

function waitForRepositoryLockRetry(attempt: number, remainingMs: number): Promise<void> {
  const retryCeilingMs = Math.min(
    repositoryLockMaximumRetryMs,
    repositoryLockInitialRetryMs * (2 ** Math.min(attempt, 10)),
  );
  const retryFloorMs = Math.ceil(retryCeilingMs / 2);
  const jitteredRetryMs = retryFloorMs
    + Math.floor(Math.random() * (retryCeilingMs - retryFloorMs + 1));
  const retryMs = Math.max(1, Math.min(remainingMs, jitteredRetryMs));
  return new Promise((resolve) => setTimeout(resolve, retryMs));
}

export class PostgresFoldStore implements ReconciliationStore, WebhookDeliveryStore {
  public constructor(
    private readonly sql: SqlClient = getSql(),
    private readonly tokenEncryptionKey: string | undefined = process.env.TOKEN_ENCRYPTION_KEY,
  ) {}

  public async withRepositoryReconciliation<T>(
    repositoryId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    const deadline = Date.now() + repositoryLockWaitDeadlineMs;
    let attempt = 0;

    while (true) {
      if (attempt > 0 && Date.now() >= deadline) {
        throw new Error(repositoryCoordinationFailure);
      }
      let connection: Awaited<ReturnType<SqlClient["reserve"]>>;
      try {
        connection = await this.sql.reserve();
      } catch {
        throw new Error(repositoryCoordinationFailure);
      }

      let locked = false;
      try {
        const [lock] = await connection<{ acquired: boolean }[]>`
          select pg_try_advisory_lock(
            hashtextextended(${repositoryId}, ${repositoryLockNamespace})
          ) as acquired
        `;
        locked = lock?.acquired === true;
        if (locked) {
          try {
            return await work();
          } finally {
            try {
              const [unlock] = await connection<{ released: boolean }[]>`
                select pg_advisory_unlock(
                  hashtextextended(${repositoryId}, ${repositoryLockNamespace})
                ) as released
              `;
              if (unlock?.released !== true) {
                throw new Error(repositoryCoordinationFailure);
              }
            } catch {
              throw new Error(repositoryCoordinationFailure);
            }
          }
        }
      } catch (error) {
        if (locked) {
          throw error;
        }
        throw new Error(repositoryCoordinationFailure);
      } finally {
        connection.release();
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(repositoryCoordinationFailure);
      }
      await waitForRepositoryLockRetry(attempt, remainingMs);
      attempt += 1;
    }
  }

  public async getRepository(repositoryId: string): Promise<ReconciliationRepository | null> {
    const [row] = await this.sql<RepositoryRow[]>`
      select
        repositories.id,
        repositories.owner_name,
        repositories.active,
        repositories.difficulty_scheme,
        sponsors.id as sponsor_id,
        sponsors.github_user_id as sponsor_github_user_id,
        sponsors.github_login as sponsor_github_login,
        sponsors.enforcement_state as sponsor_enforcement_state,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', events.id,
            'priorState', events.prior_state,
            'newState', events.new_state,
            'occurredAt', events.created_at
          ) order by events.created_at, events.id)
          from moderation_events as events
          where events.target_user_id = sponsors.id
        ), '[]'::jsonb) as sponsor_moderation_events
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

  public async findUsersByGitHubUserIds(githubUserIds: readonly number[]): Promise<FoldUser[]> {
    const normalized = [...new Set(githubUserIds.filter((id) => Number.isSafeInteger(id) && id > 0))];
    if (normalized.length === 0) {
      return [];
    }
    const rows = await this.sql<UserRow[]>`
      select
        users.id,
        users.github_user_id,
        users.github_login,
        users.enforcement_state,
        coalesce((
          select jsonb_agg(jsonb_build_object(
            'id', events.id,
            'priorState', events.prior_state,
            'newState', events.new_state,
            'occurredAt', events.created_at
          ) order by events.created_at, events.id)
          from moderation_events as events
          where events.target_user_id = users.id
        ), '[]'::jsonb) as moderation_events
      from users
      where users.github_user_id = any(${this.sql.array(normalized.map(String))}::bigint[])
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
      const [existingSettlements, existingSelfWorkCalibrations] = await Promise.all([
        loadExistingSettlements(transaction, input.repositoryId),
        loadExistingSelfWorkCalibrations(transaction, input.repositoryId),
      ]);
      const issueIds = await upsertIssues(transaction, input.repositoryId, input.fold);
      const pullRequestIds = await upsertPullRequests(transaction, input.repositoryId, input.fold, issueIds);
      await replacePullRequestIssueLinks(transaction, input.repositoryId, input.fold, issueIds, pullRequestIds);
      const settlementDeltas = await materializeSettlements(
        transaction,
        input,
        issueIds,
        pullRequestIds,
        existingSettlements,
      );
      const selfWorkDeltas = await materializeSelfWorkCalibrations(
        transaction,
        input,
        issueIds,
        pullRequestIds,
        existingSelfWorkCalibrations,
      );
      const unwritableClosureDeltas = await materializeUnwritableClosures(transaction, input, issueIds, pullRequestIds);
      await materializeReviewRounds(transaction, input.fold, pullRequestIds);
      await deleteAbsentMaterialization(transaction, input.repositoryId, input.fold, issueIds, pullRequestIds);
      await recordPolicyViolations(transaction, input.runId, input.fold);
      await transaction`
        update reconciliation_runs
        set status = ${"COMPLETED"}, completed_at = now(), error_message = null
        where id = ${input.runId}
      `;
      return combineDeltas(settlementDeltas, selfWorkDeltas, unwritableClosureDeltas);
    }) as Promise<ReconciliationDeltas>;
  }

  public async claimDelivery(delivery: GitHubWebhookDelivery): Promise<WebhookDeliveryClaim> {
    const leaseToken = randomUUID();
    const rows = await this.sql<WebhookDeliveryLeaseRow[]>`
      insert into webhook_deliveries (
        github_delivery_id, event_name, processing_state, processing_lease_token, lease_expires_at, attempt_count
      )
      values (${delivery.deliveryId}, ${delivery.event}, ${"PENDING"}, ${leaseToken}, now() + interval '5 minutes', 1)
      on conflict (github_delivery_id) do update
      set event_name = excluded.event_name,
          processing_state = ${"PENDING"},
          processing_lease_token = excluded.processing_lease_token,
          lease_expires_at = excluded.lease_expires_at,
          attempt_count = webhook_deliveries.attempt_count + 1,
          error_message = null,
          processed_at = null
      where webhook_deliveries.processing_state = ${"FAILED"}
        or (
          webhook_deliveries.processing_state = ${"PENDING"}
          and coalesce(webhook_deliveries.lease_expires_at, webhook_deliveries.received_at) <= now()
        )
      returning processing_lease_token::text
    `;
    const [row] = rows;
    return row === undefined
      ? { status: "DUPLICATE" }
      : { status: "CLAIMED", leaseToken: row.processing_lease_token };
  }

  public async findRepositoryByGitHubId(githubRepositoryId: number): Promise<{ id: string; active: boolean } | null> {
    const [row] = await this.sql<{ id: string; active: boolean }[]>`
      select id, active from registered_repositories where github_repository_id = ${githubRepositoryId} limit 1
    `;
    return row ?? null;
  }

  public async markProcessed(deliveryId: string, leaseToken: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      update webhook_deliveries
      set processing_state = ${"PROCESSED"},
          processed_at = now(),
          error_message = null,
          processing_lease_token = null,
          lease_expires_at = null
      where github_delivery_id = ${deliveryId}
        and processing_state = ${"PENDING"}
        and processing_lease_token = ${leaseToken}
      returning id
    `;
    return rows.length === 1;
  }

  public async renewDeliveryLease(deliveryId: string, leaseToken: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      update webhook_deliveries
      set lease_expires_at = now() + interval '5 minutes'
      where github_delivery_id = ${deliveryId}
        and processing_state = ${"PENDING"}
        and processing_lease_token = ${leaseToken}
      returning id
    `;
    return rows.length === 1;
  }

  public async markFailed(deliveryId: string, leaseToken: string, errorMessage: string): Promise<boolean> {
    void errorMessage;
    const rows = await this.sql<{ id: string }[]>`
      update webhook_deliveries
      set processing_state = ${"FAILED"},
          error_message = ${"Webhook processing failed."},
          processed_at = now(),
          processing_lease_token = null,
          lease_expires_at = null
      where github_delivery_id = ${deliveryId}
        and processing_state = ${"PENDING"}
        and processing_lease_token = ${leaseToken}
      returning id
    `;
    return rows.length === 1;
  }
}

export async function claimGitHubIdentity(
  sql: SqlClient,
  userId: string,
  githubUserId: number,
): Promise<void> {
  if (!Number.isSafeInteger(githubUserId) || githubUserId <= 0) {
    throw new Error("GitHub user id must be a positive integer.");
  }
  await sql.begin(async (transaction) => {
    const selfWorkSettlements = await transaction<IdentityClaimSettlementRow[]>`
      select
        settlements.id,
        settlements.issue_id,
        settlements.pull_request_id,
        settlements.creditor_id,
        settlements.creditor_github_login,
        settlements.debtor_id,
        settlements.opening_comparison_points,
        settlements.settled_points
      from settlements
      join pull_requests on pull_requests.id = settlements.pull_request_id
      where settlements.status = ${"UNCLAIMED"}
        and settlements.creditor_github_user_id = ${githubUserId}
        and settlements.debtor_id = ${userId}
        and pull_requests.merged_at is not null
        and participation_eligible_at(${userId}, pull_requests.merged_at)
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
      where author_github_user_id = ${githubUserId}
    `;
    await transaction`
      update settlements
      set creditor_id = ${userId}, status = ${"SETTLED"}
      from users as creditor, users as debtor, pull_requests
      where settlements.status = ${"UNCLAIMED"}
        and settlements.creditor_github_user_id = ${githubUserId}
        and settlements.debtor_id <> ${userId}
        and creditor.id = ${userId}
        and debtor.id = settlements.debtor_id
        and pull_requests.id = settlements.pull_request_id
        and pull_requests.merged_at is not null
        and participation_eligible_at(creditor.id, pull_requests.merged_at)
        and participation_eligible_at(debtor.id, pull_requests.merged_at)
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
        owner_github_login, opening_label, opening_comparison_points, opening_reserve_points,
        opening_source_event_id, opening_source_actor_login, opening_source_at,
        settled_label, settled_points, settled_label_event_id, settled_label_actor_login,
        settled_label_applied_at, settled_rationale_comment_id, settled_rationale_actor_login,
        settled_rationale_commented_at, claim_assignee_github_login
      )
      values (
        ${issue.githubIssueId}, ${repositoryId}, ${issue.number}, ${issue.title}, ${issue.body}, ${issue.url}, ${issue.state},
        ${issue.ownerGitHubLogin}, ${issue.openingLabel}, ${issue.openingComparisonPoints}, ${issue.openingReservePoints},
        ${issue.openingSourceEventId}, ${issue.openingSourceActorLogin}, ${issue.openingSourceAt},
        ${issue.settledLabel}, ${issue.settledPoints}, ${issue.settledLabelEventId}, ${issue.settledLabelActorLogin},
        ${issue.settledLabelAppliedAt}, ${issue.settledRationaleCommentId}, ${issue.settledRationaleActorLogin},
        ${issue.settledRationaleCommentedAt}, ${issue.claimAssigneeGitHubLogin}
      )
      on conflict (github_issue_id) do update
      set issue_number = excluded.issue_number,
          title = excluded.title,
          body = excluded.body,
          url = excluded.url,
          state = excluded.state,
          opening_label = case
            when issues.opening_source_event_id is null then excluded.opening_label
            else issues.opening_label
          end,
          opening_comparison_points = case
            when issues.opening_source_event_id is null then excluded.opening_comparison_points
            else issues.opening_comparison_points
          end,
          opening_reserve_points = case
            when issues.opening_source_event_id is null then excluded.opening_reserve_points
            else issues.opening_reserve_points
          end,
          owner_github_login = coalesce(issues.owner_github_login, excluded.owner_github_login),
          opening_source_event_id = coalesce(issues.opening_source_event_id, excluded.opening_source_event_id),
          opening_source_actor_login = coalesce(issues.opening_source_actor_login, excluded.opening_source_actor_login),
          opening_source_at = coalesce(issues.opening_source_at, excluded.opening_source_at),
          settled_label = excluded.settled_label,
          settled_points = excluded.settled_points,
          settled_label_event_id = excluded.settled_label_event_id,
          settled_label_actor_login = excluded.settled_label_actor_login,
          settled_label_applied_at = excluded.settled_label_applied_at,
          settled_rationale_comment_id = excluded.settled_rationale_comment_id,
          settled_rationale_actor_login = excluded.settled_rationale_actor_login,
          settled_rationale_commented_at = excluded.settled_rationale_commented_at,
          claim_assignee_github_login = excluded.claim_assignee_github_login,
          updated_at = now()
      returning
        id, github_issue_id, opening_label, opening_comparison_points, opening_reserve_points,
        owner_github_login, opening_source_event_id, opening_source_actor_login, opening_source_at,
        settled_label, settled_points, settled_label_event_id, settled_label_actor_login,
        settled_label_applied_at, settled_rationale_comment_id, settled_rationale_actor_login,
        settled_rationale_commented_at
    `;
    if (row === undefined) {
      throw new Error("Issue materialization returned no row.");
    }
    if (
      row.opening_label !== issue.openingLabel ||
      row.opening_comparison_points !== issue.openingComparisonPoints ||
      row.opening_reserve_points !== issue.openingReservePoints ||
      row.owner_github_login !== issue.ownerGitHubLogin ||
      row.opening_source_event_id !== issue.openingSourceEventId ||
      row.opening_source_actor_login !== issue.openingSourceActorLogin ||
      timestampToIso(row.opening_source_at) !== issue.openingSourceAt
    ) {
      throw new Error("Issue opening evidence did not match immutable GitHub history.");
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
        author_id, author_github_login, author_github_user_id, state, merged_at, merge_commit_oid, final_commit_at, proof_sha256
      )
      values (
        ${pullRequest.githubPullRequestId}, ${repositoryId}, ${firstIssueId}, ${pullRequest.number},
        ${pullRequest.url}, ${pullRequest.title}, ${pullRequest.body}, ${pullRequest.authorId},
        ${pullRequest.authorGitHubLogin}, ${pullRequest.authorGitHubUserId}, ${pullRequest.state}, ${pullRequest.mergedAt},
        ${pullRequest.mergeCommitOid}, ${pullRequest.finalCommitAt}, ${pullRequest.proofSha256}
      )
      on conflict (github_pull_request_id) do update
      set issue_id = excluded.issue_id,
          pull_request_number = excluded.pull_request_number,
          url = excluded.url,
          title = excluded.title,
          body = excluded.body,
          author_id = excluded.author_id,
          author_github_login = excluded.author_github_login,
          author_github_user_id = excluded.author_github_user_id,
          state = excluded.state,
          merged_at = excluded.merged_at,
          merge_commit_oid = excluded.merge_commit_oid,
          final_commit_at = excluded.final_commit_at,
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
  existingRows: readonly SettlementRow[],
): Promise<ReconciliationDeltas> {
  const existingByIssue = new Map(existingRows.map((row) => [toSafeInteger(row.github_issue_id), row]));
  const grantedOverrides = await loadGrantedSettlementOverrides(sql, input.repositoryId);
  let adds = 0;
  let changes = 0;
  let removals = 0;

  for (const folded of input.fold.settlements) {
    const settlement = applyGrantedOverride(folded, grantedOverrides);
    const issueId = requiredId(issueIds, settlement.githubIssueId, "Issue");
    const pullRequestId = requiredId(pullRequestIds, settlement.githubPullRequestId, "Pull request");
    const current = existingByIssue.get(settlement.githubIssueId);
    const desired = settlementState(settlement);
    if (current === undefined) {
      await insertSettlement(sql, settlement, issueId, pullRequestId);
      await recordChange(sql, input.runId, pullRequestId, "SETTLEMENT", "ADD", null, desired);
      adds += 1;
      continue;
    }
    existingByIssue.delete(settlement.githubIssueId);
    const before = settlementStateFromRow(current);
    if (JSON.stringify(before) !== JSON.stringify(desired)) {
      await updateSettlement(sql, settlement, issueId, pullRequestId);
      await recordChange(sql, input.runId, pullRequestId, "SETTLEMENT", "CHANGE", before, desired);
      changes += 1;
    }
  }

  for (const row of existingByIssue.values()) {
    await sql`delete from settlements where id = ${row.id}`;
    await recordChange(
      sql,
      input.runId,
      row.pull_request_id,
      "SETTLEMENT",
      "REMOVE",
      settlementStateFromRow(row),
      null,
    );
    removals += 1;
  }

  return { adds, changes, removals };
}

/**
 * The settled points a moderator granted for each of this repository's issues.
 *
 * A correction cannot live in `settlements`, which materialization deletes and
 * rewrites from immutable GitHub history on every run, so it is read back here
 * and applied to the fold's result before the row is written. Where an issue has
 * been corrected more than once the most recent grant wins, so the map is filled
 * in decision order and later grants overwrite earlier ones.
 */
async function loadGrantedSettlementOverrides(
  sql: TransactionClient,
  repositoryId: string,
): Promise<Map<number, number>> {
  const rows = await sql<{ github_issue_id: number | string; settled_points: number | string }[]>`
    select issues.github_issue_id, overrides.settled_points
    from settlement_override_requests as overrides
    join issues on issues.id = overrides.issue_id
    where issues.repository_id = ${repositoryId}
      and overrides.state = 'GRANTED'
      and overrides.settled_points is not null
    order by overrides.decided_at asc, overrides.id asc
  `;
  const grantedPoints = new Map<number, number>();
  for (const row of rows) {
    grantedPoints.set(toSafeInteger(row.github_issue_id), toSafeInteger(row.settled_points));
  }
  return grantedPoints;
}

function applyGrantedOverride(
  settlement: FoldSettlement,
  grantedOverrides: ReadonlyMap<number, number>,
): FoldSettlement {
  const settledPoints = grantedOverrides.get(settlement.githubIssueId);
  return settledPoints === undefined
    ? settlement
    : applyGrantedSettlementOverride(settlement, settledPoints);
}

async function loadExistingSettlements(
  sql: TransactionClient,
  repositoryId: string,
): Promise<SettlementRow[]> {
  return sql<SettlementRow[]>`
    select
      settlements.id, settlements.issue_id, settlements.pull_request_id,
      issues.github_issue_id, pull_requests.github_pull_request_id,
      settlements.creditor_id, settlements.creditor_github_login, settlements.creditor_github_user_id, settlements.debtor_id,
      settlements.opening_comparison_points, settlements.settled_points, settlements.review_rounds,
      settlements.credits, settlements.proof_sha256, settlements.status,
      issues.settled_label, issues.settled_label_event_id, issues.settled_label_actor_login,
      issues.settled_label_applied_at, issues.settled_rationale_comment_id,
      issues.settled_rationale_actor_login, issues.settled_rationale_commented_at,
      pull_requests.merge_commit_oid, pull_requests.merged_at
    from settlements
    join issues on issues.id = settlements.issue_id
    join pull_requests on pull_requests.id = settlements.pull_request_id
    where issues.repository_id = ${repositoryId}
  `;
}

async function insertSettlement(
  sql: TransactionClient,
  settlement: FoldSettlement,
  issueId: string,
  pullRequestId: string,
): Promise<void> {
  await sql`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, creditor_github_login, creditor_github_user_id, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
    )
    values (
      ${pullRequestId}, ${issueId}, ${settlement.creditorId}, ${settlement.creditorGitHubLogin}, ${settlement.creditorGitHubUserId}, ${settlement.debtorId},
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
        creditor_github_login = ${settlement.creditorGitHubLogin},
        creditor_github_user_id = ${settlement.creditorGitHubUserId}, debtor_id = ${settlement.debtorId},
        opening_comparison_points = ${settlement.openingComparisonPoints}, settled_points = ${settlement.settledPoints},
        review_rounds = ${settlement.reviewRounds}, credits = ${settlement.credits}, proof_sha256 = ${settlement.proofSha256},
        status = ${settlement.status}
    where issue_id = ${issueId}
  `;
}

async function materializeSelfWorkCalibrations(
  sql: TransactionClient,
  input: { repositoryId: string; runId: string; fold: FoldResult },
  issueIds: Map<number, string>,
  pullRequestIds: Map<number, string>,
  existingRows: readonly SelfWorkCalibrationRow[],
): Promise<ReconciliationDeltas> {
  const existingByKey = new Map(
    existingRows.map((row) => [selfWorkCalibrationKeyFromRow(row), row]),
  );
  let adds = 0;
  let changes = 0;
  let removals = 0;

  for (const calibration of input.fold.selfWorkCalibrations) {
    const pullRequestId = requiredId(pullRequestIds, calibration.githubPullRequestId, "Pull request");
    const issueId = requiredId(issueIds, calibration.githubIssueId, "Issue");
    const key = selfWorkCalibrationKey(calibration.githubPullRequestId, calibration.githubIssueId);
    const current = existingByKey.get(key);
    const desired = selfWorkCalibrationState(calibration);
    if (current === undefined) {
      await sql`
        insert into self_work_calibrations (
          pull_request_id, issue_id, user_id, opening_comparison_points, actual_points
        )
        values (
          ${pullRequestId}, ${issueId}, ${calibration.userId},
          ${calibration.openingComparisonPoints}, ${calibration.actualPoints}
        )
      `;
      await recordChange(
        sql,
        input.runId,
        pullRequestId,
        "SELF_WORK_CALIBRATION",
        "ADD",
        null,
        desired,
      );
      adds += 1;
      continue;
    }

    existingByKey.delete(key);
    const before = selfWorkCalibrationStateFromRow(current);
    if (JSON.stringify(before) !== JSON.stringify(desired)) {
      await sql`
        update self_work_calibrations
        set user_id = ${calibration.userId},
            opening_comparison_points = ${calibration.openingComparisonPoints},
            actual_points = ${calibration.actualPoints}
        where id = ${current.id}
      `;
      await recordChange(
        sql,
        input.runId,
        pullRequestId,
        "SELF_WORK_CALIBRATION",
        "CHANGE",
        before,
        desired,
      );
      changes += 1;
    }
  }

  for (const row of existingByKey.values()) {
    await sql`delete from self_work_calibrations where id = ${row.id}`;
    await recordChange(
      sql,
      input.runId,
      row.pull_request_id,
      "SELF_WORK_CALIBRATION",
      "REMOVE",
      selfWorkCalibrationStateFromRow(row),
      null,
    );
    removals += 1;
  }

  return { adds, changes, removals };
}

async function loadExistingSelfWorkCalibrations(
  sql: TransactionClient,
  repositoryId: string,
): Promise<SelfWorkCalibrationRow[]> {
  return sql<SelfWorkCalibrationRow[]>`
    select
      self_work_calibrations.id,
      self_work_calibrations.pull_request_id,
      self_work_calibrations.issue_id,
      pull_requests.github_pull_request_id,
      issues.github_issue_id,
      self_work_calibrations.user_id,
      self_work_calibrations.opening_comparison_points,
      self_work_calibrations.actual_points,
      issues.settled_label as actual_label,
      issues.settled_label_event_id,
      issues.settled_label_actor_login,
      issues.settled_label_applied_at,
      issues.settled_rationale_comment_id,
      issues.settled_rationale_actor_login,
      issues.settled_rationale_commented_at,
      pull_requests.merge_commit_oid,
      pull_requests.merged_at
    from self_work_calibrations
    join pull_requests on pull_requests.id = self_work_calibrations.pull_request_id
    join issues on issues.id = self_work_calibrations.issue_id
    where issues.repository_id = ${repositoryId}
    order by issues.github_issue_id, pull_requests.github_pull_request_id
  `;
}

async function materializeUnwritableClosures(
  sql: TransactionClient,
  input: { repositoryId: string; runId: string; fold: FoldResult },
  issueIds: Map<number, string>,
  pullRequestIds: Map<number, string>,
): Promise<ReconciliationDeltas> {
  const existingRows = await sql<UnwritableClosureRow[]>`
    select unwritable_closures.id, unwritable_closures.issue_id, issues.github_issue_id,
      unwritable_closures.kind::text, pull_requests.github_pull_request_id, unwritable_closures.reason
    from unwritable_closures
    join issues on issues.id = unwritable_closures.issue_id
    left join pull_requests on pull_requests.id = unwritable_closures.pull_request_id
    where issues.repository_id = ${input.repositoryId}
    order by issues.github_issue_id
  `;
  const existingByIssue = new Map(
    existingRows.map((row) => [toSafeInteger(row.github_issue_id), row]),
  );
  let adds = 0;
  let changes = 0;
  let removals = 0;

  for (const closure of input.fold.unwritableClosures) {
    const issueId = requiredId(issueIds, closure.githubIssueId, "Issue");
    const pullRequestId = closure.githubPullRequestId === null
      ? null
      : requiredId(pullRequestIds, closure.githubPullRequestId, "Pull request");
    const current = existingByIssue.get(closure.githubIssueId);
    const desired = unwritableClosureState(closure);
    if (current === undefined) {
      await sql`
        insert into unwritable_closures (issue_id, pull_request_id, kind, reason)
        values (${issueId}, ${pullRequestId}, ${closure.kind}, ${closure.reason})
      `;
      await recordChange(sql, input.runId, null, "UNWRITABLE_CLOSURE", "ADD", null, desired);
      adds += 1;
      continue;
    }

    existingByIssue.delete(closure.githubIssueId);
    const before = unwritableClosureStateFromRow(current);
    if (JSON.stringify(before) !== JSON.stringify(desired)) {
      await sql`
        update unwritable_closures
        set pull_request_id = ${pullRequestId}, kind = ${closure.kind}, reason = ${closure.reason}
        where id = ${current.id}
      `;
      await recordChange(sql, input.runId, null, "UNWRITABLE_CLOSURE", "CHANGE", before, desired);
      changes += 1;
    }
  }

  for (const row of existingByIssue.values()) {
    await sql`delete from unwritable_closures where id = ${row.id}`;
    await recordChange(
      sql,
      input.runId,
      null,
      "UNWRITABLE_CLOSURE",
      "REMOVE",
      unwritableClosureStateFromRow(row),
      null,
    );
    removals += 1;
  }

  return { adds, changes, removals };
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
  repositoryId: string,
  fold: FoldResult,
  issueIds: Map<number, string>,
  pullRequestIds: Map<number, string>,
): Promise<void> {
  for (const pullRequest of fold.pullRequests) {
    const pullRequestId = requiredId(pullRequestIds, pullRequest.githubPullRequestId, "Pull request");
    for (const githubIssueId of pullRequest.githubIssueIds) {
      await sql`
        insert into pull_request_issues (pull_request_id, issue_id, repository_id)
        values (${pullRequestId}, ${requiredId(issueIds, githubIssueId, "Issue")}, ${repositoryId})
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
    await recordChange(sql, runId, null, "POLICY_VIOLATION", "POLICY_VIOLATION", null, violation);
  }
}

async function recordChange(
  sql: TransactionClient,
  runId: string,
  pullRequestId: string | null,
  entityKind: ReconciledEntityKind,
  changeKind: ReconciliationChangeKind,
  before: JSONValue | null,
  after: JSONValue | null,
): Promise<void> {
  await sql`
    insert into reconciliation_changes (
      reconciliation_run_id, pull_request_id, entity_kind, change_kind, before_state, after_state
    )
    values (
      ${runId}, ${pullRequestId}, ${entityKind}, ${changeKind},
      ${before === null ? null : sql.json(before)}, ${after === null ? null : sql.json(after)}
    )
  `;
}

function settlementState(settlement: FoldSettlement): JSONValue {
  return {
    githubIssueId: settlement.githubIssueId,
    githubPullRequestId: settlement.githubPullRequestId,
    creditorId: settlement.creditorId,
    creditorGitHubLogin: settlement.creditorGitHubLogin,
    creditorGitHubUserId: settlement.creditorGitHubUserId,
    debtorId: settlement.debtorId,
    openingComparisonPoints: settlement.openingComparisonPoints,
    settledLabel: settlement.settledLabel,
    settledPoints: settlement.settledPoints,
    settledLabelEventId: settlement.settledLabelEventId,
    settledLabelActorLogin: settlement.settledLabelActorLogin,
    settledLabelAppliedAt: settlement.settledLabelAppliedAt,
    settledRationaleCommentId: settlement.settledRationaleCommentId,
    settledRationaleActorLogin: settlement.settledRationaleActorLogin,
    settledRationaleCommentedAt: settlement.settledRationaleCommentedAt,
    mergeCommitOid: settlement.mergeCommitOid,
    mergedAt: settlement.mergedAt,
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
    creditorGitHubUserId: row.creditor_github_user_id === null ? null : toSafeInteger(row.creditor_github_user_id),
    debtorId: row.debtor_id,
    openingComparisonPoints: row.opening_comparison_points,
    settledLabel: row.settled_label,
    settledPoints: row.settled_points,
    settledLabelEventId: row.settled_label_event_id,
    settledLabelActorLogin: row.settled_label_actor_login,
    settledLabelAppliedAt: nullableTimestampToIso(row.settled_label_applied_at),
    settledRationaleCommentId: row.settled_rationale_comment_id,
    settledRationaleActorLogin: row.settled_rationale_actor_login,
    settledRationaleCommentedAt: nullableTimestampToIso(row.settled_rationale_commented_at),
    mergeCommitOid: row.merge_commit_oid,
    mergedAt: nullableTimestampToIso(row.merged_at),
    reviewRounds: row.review_rounds,
    credits: row.credits,
    proofSha256: row.proof_sha256,
    status: row.status,
  };
}

function selfWorkCalibrationKey(githubPullRequestId: number, githubIssueId: number): string {
  return `${githubPullRequestId}:${githubIssueId}`;
}

function selfWorkCalibrationKeyFromRow(row: SelfWorkCalibrationRow): string {
  return selfWorkCalibrationKey(
    toSafeInteger(row.github_pull_request_id),
    toSafeInteger(row.github_issue_id),
  );
}

function selfWorkCalibrationState(calibration: SelfWorkCalibration): JSONValue {
  return {
    githubIssueId: calibration.githubIssueId,
    githubPullRequestId: calibration.githubPullRequestId,
    userId: calibration.userId,
    openingComparisonPoints: calibration.openingComparisonPoints,
    actualLabel: calibration.actualLabel,
    actualPoints: calibration.actualPoints,
    actualLabelEventId: calibration.actualLabelEventId,
    actualLabelActorLogin: calibration.actualLabelActorLogin,
    actualLabelAppliedAt: calibration.actualLabelAppliedAt,
    rationaleCommentId: calibration.rationaleCommentId,
    rationaleActorLogin: calibration.rationaleActorLogin,
    rationaleCommentedAt: calibration.rationaleCommentedAt,
    mergeCommitOid: calibration.mergeCommitOid,
    mergedAt: calibration.mergedAt,
  };
}

function selfWorkCalibrationStateFromRow(row: SelfWorkCalibrationRow): JSONValue {
  return {
    githubIssueId: toSafeInteger(row.github_issue_id),
    githubPullRequestId: toSafeInteger(row.github_pull_request_id),
    userId: row.user_id,
    openingComparisonPoints: row.opening_comparison_points,
    actualLabel: row.actual_label,
    actualPoints: row.actual_points,
    actualLabelEventId: row.settled_label_event_id,
    actualLabelActorLogin: row.settled_label_actor_login,
    actualLabelAppliedAt: nullableTimestampToIso(row.settled_label_applied_at),
    rationaleCommentId: row.settled_rationale_comment_id,
    rationaleActorLogin: row.settled_rationale_actor_login,
    rationaleCommentedAt: nullableTimestampToIso(row.settled_rationale_commented_at),
    mergeCommitOid: row.merge_commit_oid,
    mergedAt: nullableTimestampToIso(row.merged_at),
  };
}

function unwritableClosureState(closure: UnwritableClosure): JSONValue {
  return {
    githubIssueId: closure.githubIssueId,
    kind: closure.kind,
    githubPullRequestId: closure.githubPullRequestId,
    reason: closure.reason,
  };
}

function unwritableClosureStateFromRow(row: UnwritableClosureRow): JSONValue {
  return unwritableClosureState({
    githubIssueId: toSafeInteger(row.github_issue_id),
    kind: row.kind,
    githubPullRequestId: row.github_pull_request_id === null ? null : toSafeInteger(row.github_pull_request_id),
    reason: row.reason,
  });
}

function combineDeltas(...deltas: readonly ReconciliationDeltas[]): ReconciliationDeltas {
  return deltas.reduce(
    (total, delta) => ({
      adds: total.adds + delta.adds,
      changes: total.changes + delta.changes,
      removals: total.removals + delta.removals,
    }),
    { adds: 0, changes: 0, removals: 0 },
  );
}

function toReconciliationRepository(row: RepositoryRow): ReconciliationRepository {
  return {
    id: row.id,
    ownerName: row.owner_name,
    active: row.active,
    difficultyScheme: row.difficulty_scheme,
    sponsor: {
      id: row.sponsor_id,
      githubUserId: toSafeInteger(row.sponsor_github_user_id),
      githubLogin: row.sponsor_github_login,
      enforcementState: row.sponsor_enforcement_state,
      moderationEvents: moderationEventsFromJson(row.sponsor_moderation_events),
    },
  };
}

function toFoldUser(row: UserRow): FoldUser {
  return {
    id: row.id,
    githubUserId: toSafeInteger(row.github_user_id),
    githubLogin: row.github_login,
    enforcementState: row.enforcement_state,
    moderationEvents: moderationEventsFromJson(row.moderation_events),
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

function timestampToIso(value: string | Date | null): string {
  const normalized = nullableTimestampToIso(value);
  if (normalized === null) {
    throw new Error("Database timestamp was missing.");
  }
  return normalized;
}

function nullableTimestampToIso(value: string | Date | null): string | null {
  if (value === null) {
    return null;
  }
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.valueOf())) {
    throw new Error("Database timestamp was invalid.");
  }
  return date.toISOString();
}

function moderationEventsFromJson(value: unknown): FoldModerationEvent[] {
  if (!Array.isArray(value)) {
    throw new Error("Moderation history was invalid.");
  }
  return value.map((candidate) => {
    if (!isRecord(candidate)) {
      throw new Error("Moderation history was invalid.");
    }
    const { id, priorState, newState, occurredAt } = candidate;
    if (
      typeof id !== "string" ||
      !isEnforcementState(priorState) ||
      !isEnforcementState(newState) ||
      (typeof occurredAt !== "string" && !(occurredAt instanceof Date))
    ) {
      throw new Error("Moderation history was invalid.");
    }
    return {
      id,
      priorState,
      newState,
      occurredAt: timestampToIso(occurredAt),
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isEnforcementState(value: unknown): value is EnforcementState {
  return value === "ACTIVE" ||
    value === "UNDER_AUDIT" ||
    value === "WARNED" ||
    value === "RECALIBRATING" ||
    value === "BANNED";
}
