import type { JSONValue } from "postgres";
import { getSql } from "@/lib/db/client";
import {
  type IssueState,
  type PullRequestState,
  type SqlClient,
  type TransactionClient,
} from "@/lib/db/types";
import { FOLD_REVISION } from "@/lib/fold/fold-revision";
import { recordNewPolicyViolations } from "@/lib/fold/policy-violation-record";
import type { FoldForgeIdentity } from "@/lib/fold/repository-fold";
import {
  type ReconciliationCostCharge,
  type ReconciliationFairnessAssessment,
} from "@/lib/fold/reconciliation-fairness";
import type { GitHubGraphqlBudgetAssessment } from "@/lib/github/rate-limit-budget";
import {
  DEFAULT_RECONCILIATION_FACT_BYTE_LIMIT,
  synchronizeReconciliationEvidence,
} from "@/lib/fold/evidence-facts";
import {
  type DirtyReconciliationSubject,
  type ReconciliationEvidence,
  type ReconciliationSynchronization,
} from "@/lib/fold/reconciliation-evidence";
import { PostgresReconciliationJobStore } from "@/lib/fold/reconciliation-job-store";
import { PostgresReconciliationPacingStore } from "@/lib/fold/reconciliation-pacing-store";
import { PostgresRepositoryLookupStore } from "@/lib/fold/repository-lookup-store";
import { reResolveIdentityClaims } from "@/lib/fold/identity-claims";
import { nullableTimestampToIso, timestampToIso, toSafeInteger, type SettlementRow } from "@/lib/fold/postgres-row-mapping";
import { PostgresSponsorCredentialStore } from "@/lib/fold/sponsor-credential-store";
import { RepositoryCoordinator } from "@/lib/fold/repository-coordination";
import { scrubSuppressedForgeData } from "@/lib/fold/data-subject-suppression";
import type {
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
  RepositoryUnavailableReason,
} from "@/lib/fold/reconcile";
import type {
  ClaimedReconciliationJob,
  ReconciliationJobReason,
} from "@/lib/fold/reconciliation-jobs";
import type { GitHubWebhookDelivery, GitHubWebhookIssue } from "@/lib/github/webhook-schema";
import {
  applyGrantedSelfWorkCalibrationOverride,
  applyGrantedSettlementOverride,
} from "@/lib/overrides/apply";
import type { WebhookDeliveryClaim, WebhookDeliveryStore, WebhookReceiptScope, WebhookRepositoryRegistration } from "@/lib/webhooks/processor";
import { PostgresWebhookDeliveryStore } from "@/lib/webhooks/postgres-delivery-store";

export { claimGitHubIdentity, claimForgeIdentity } from "@/lib/fold/identity-claims";
export { repositoryLockNamespace } from "@/lib/fold/repository-coordination";

type RepositoryFoldRevisionCountsRow = {
  repository_id: string;
  owner_name: string;
  rows_at_revision: number;
  rows_below_revision: number;
  rederivation_requested_at: Date | null;
};

type RepositoryRederivationRequestRow = {
  repository_id: string;
  owner_name: string;
  rederivation_requested_at: Date | null;
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

type SelfWorkCalibrationRow = {
  id: string;
  fold_revision: number;
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
  fold_revision: number;
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
  | "ISSUE"
  | "PULL_REQUEST";

type ReconciliationChangeKind = "ADD" | "CHANGE" | "REMOVE";

/**
 * How many of one repository's derived rows carry the fold revision asked about,
 * and how many were written by an older revision of the fold.
 *
 * Rows stamped above the revision asked about are in neither count: they were
 * written by logic newer than the caller's, so calling them stale would be
 * wrong and calling them current would hide the rollback that produced them.
 */
export type RepositoryFoldRevisionCounts = {
  repositoryId: string;
  ownerName: string;
  rowsAtRevision: number;
  rowsBelowRevision: number;
  rederivationRequestedAt: Date | null;
};

/**
 * A repository together with the re-derivation request outstanding against it,
 * where a null timestamp means none is.
 */
export type RepositoryRederivationRequest = {
  repositoryId: string;
  ownerName: string;
  rederivationRequestedAt: Date | null;
};

export class PostgresFoldStore implements ReconciliationStore, WebhookDeliveryStore {
  private readonly coordinator: RepositoryCoordinator;
  private readonly repositoryLookup: PostgresRepositoryLookupStore;
  private readonly reconciliationJobs: PostgresReconciliationJobStore;
  private readonly webhookDeliveries: PostgresWebhookDeliveryStore;
  private readonly sponsorCredentials: PostgresSponsorCredentialStore;
  private readonly reconciliationPacing: PostgresReconciliationPacingStore;

  public constructor(
    private readonly sql: SqlClient = getSql(),
    tokenEncryptionKey: string | undefined = process.env.TOKEN_ENCRYPTION_KEY,
    private readonly coordinationSql?: SqlClient,
    previousTokenEncryptionKey: string | undefined = process.env.TOKEN_ENCRYPTION_KEY_PREVIOUS,
    /**
     * Store-level tuning, injectable for tests. The only knob today is the
     * per-fact byte limit the evidence cache omits facts over (default 64 MiB,
     * shared with the write-batch byte budget).
     */
    private readonly options: { reconciliationFactByteLimit?: number } = {},
  ) {
    this.coordinator = new RepositoryCoordinator(sql, coordinationSql);
    this.repositoryLookup = new PostgresRepositoryLookupStore(sql, this.coordinator);
    this.reconciliationPacing = new PostgresReconciliationPacingStore(sql, this.coordinator);
    this.reconciliationJobs = new PostgresReconciliationJobStore(sql);
    this.webhookDeliveries = new PostgresWebhookDeliveryStore(sql);
    this.sponsorCredentials = new PostgresSponsorCredentialStore(sql, tokenEncryptionKey, previousTokenEncryptionKey);
  }

  public async withRepositoryReconciliation<T>(
    repositoryId: string,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.coordinator.withRepositoryReconciliation(repositoryId, work);
  }

  public async findForgeIdentitiesByForgeUserIds(
    repositoryId: string,
    forgeUserIds: number[],
  ): Promise<FoldForgeIdentity[]> {
    return this.repositoryLookup.findForgeIdentitiesByForgeUserIds(repositoryId, forgeUserIds);
  }

  public async getRepository(repositoryId: string): Promise<ReconciliationRepository | null> {
    return this.repositoryLookup.getRepository(repositoryId);
  }

  public async recordVerifiedRepositoryIdentity(input: {
    repositoryId: string;
    ownerName: string;
    visibility: "PUBLIC";
  }): Promise<void> {
    return this.repositoryLookup.recordVerifiedRepositoryIdentity(input);
  }

  public async markRepositoryUnavailable(input: {
    repositoryId: string;
    reason: RepositoryUnavailableReason;
    at: Date;
  }): Promise<void> {
    return this.repositoryLookup.markRepositoryUnavailable(input);
  }

  public async findRepositoryByOwnerName(ownerName: string): Promise<{ id: string } | null> {
    return this.repositoryLookup.findRepositoryByOwnerName(ownerName);
  }

  public async listActiveRepositoryIds(): Promise<string[]> {
    return this.repositoryLookup.listActiveRepositoryIds();
  }

  public async getReconciliationCooldown(repositoryId: string): Promise<Date | null> {
    return this.reconciliationPacing.getReconciliationCooldown(repositoryId);
  }

  public async setReconciliationCooldown(repositoryId: string, notBefore: Date | null): Promise<void> {
    return this.reconciliationPacing.setReconciliationCooldown(repositoryId, notBefore);
  }

  public async assessReconciliationFairness(input: {
    repositoryId: string;
    sponsorId: string;
    budget: GitHubGraphqlBudgetAssessment;
    now: Date;
  }): Promise<ReconciliationFairnessAssessment> {
    return this.reconciliationPacing.assessReconciliationFairness(input);
  }

  public async getGitHubAccessToken(userId: string): Promise<string | null> {
    return this.sponsorCredentials.getGitHubAccessToken(userId);
  }

  public async findUsersByGitHubUserIds(githubUserIds: readonly number[]): Promise<FoldUser[]> {
    return this.repositoryLookup.findUsersByGitHubUserIds(githubUserIds);
  }

  public async hasDerivedRowsBelowFoldRevision(repositoryId: string, revision: number): Promise<boolean> {
    const [row] = await this.sql<{ stale: boolean }[]>`
      select exists (
        select 1 from settlements
        join issues on issues.id = settlements.issue_id
        where issues.repository_id = ${repositoryId} and settlements.fold_revision < ${revision}
      ) or exists (
        select 1 from self_work_calibrations
        join issues on issues.id = self_work_calibrations.issue_id
        where issues.repository_id = ${repositoryId} and self_work_calibrations.fold_revision < ${revision}
      ) or exists (
        select 1 from unwritable_closures
        join issues on issues.id = unwritable_closures.issue_id
        where issues.repository_id = ${repositoryId} and unwritable_closures.fold_revision < ${revision}
      ) as stale
    `;
    return row.stale;
  }

  /**
   * Every active repository's derived-row stamp counts, in one pass over the
   * three derived tables rather than one read per issue: a moderator asking
   * "what is still the output of older logic?" must not cost a query per row.
   *
   * Reported for every active repository, including one holding no derived rows
   * at all, so the answer is the registered catalog rather than only the
   * repositories that happen to have been folded.
   */
  public async listRepositoryFoldRevisionCounts(revision: number): Promise<RepositoryFoldRevisionCounts[]> {
    const rows = await this.sql<RepositoryFoldRevisionCountsRow[]>`
      select
        repositories.id as repository_id,
        repositories.owner_name,
        coalesce(derived.rows_at_revision, 0)::int as rows_at_revision,
        coalesce(derived.rows_below_revision, 0)::int as rows_below_revision,
        jobs.rederivation_requested_at
      from registered_repositories as repositories
      left join (
        select
          issues.repository_id,
          count(*) filter (where derived_rows.fold_revision = ${revision}) as rows_at_revision,
          count(*) filter (where derived_rows.fold_revision < ${revision}) as rows_below_revision
        from (
          select issue_id, fold_revision from settlements
          union all
          select issue_id, fold_revision from self_work_calibrations
          union all
          select issue_id, fold_revision from unwritable_closures
        ) as derived_rows
        join issues on issues.id = derived_rows.issue_id
        group by issues.repository_id
      ) as derived on derived.repository_id = repositories.id
      -- A repository owns at most one queue row, so this join cannot fan the counts out.
      left join repository_reconciliation_jobs as jobs on jobs.repository_id = repositories.id
      where repositories.active = true
      order by repositories.owner_name, repositories.id
    `;
    return rows.map((row) => ({
      repositoryId: row.repository_id,
      ownerName: row.owner_name,
      rowsAtRevision: row.rows_at_revision,
      rowsBelowRevision: row.rows_below_revision,
      rederivationRequestedAt: row.rederivation_requested_at,
    }));
  }

  /**
   * The outstanding re-derivation request for one active repository, or null
   * when this deployment serves no such repository. Answering null is what lets
   * a caller refuse an unknown target before writing a queue row for it.
   */
  public async findRepositoryRederivationRequest(
    repositoryId: string,
  ): Promise<RepositoryRederivationRequest | null> {
    const [row] = await this.sql<RepositoryRederivationRequestRow[]>`
      select
        repositories.id as repository_id,
        repositories.owner_name,
        jobs.rederivation_requested_at
      from registered_repositories as repositories
      left join repository_reconciliation_jobs as jobs on jobs.repository_id = repositories.id
      where repositories.id = ${repositoryId} and repositories.active = true
    `;
    if (row === undefined) {
      return null;
    }
    return {
      repositoryId: row.repository_id,
      ownerName: row.owner_name,
      rederivationRequestedAt: row.rederivation_requested_at,
    };
  }

  public async beginRun(repositoryId: string, options?: { rederivation: boolean }): Promise<string> {
    const [row] = await this.sql<{ id: string }[]>`
      insert into reconciliation_runs (repository_id, status, rederivation)
      values (${repositoryId}, ${"PENDING"}, ${options?.rederivation ?? false})
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
      where id = ${runId} and status = 'PENDING'
    `;
  }

  public async completeRun(runId: string): Promise<void> {
    await this.sql`
      update reconciliation_runs
      set status = ${"COMPLETED"}, completed_at = now(), error_message = null
      where id = ${runId} and status = 'PENDING'
    `;
  }

  public async materialize(input: {
    repositoryId: string;
    runId: string;
    fold: FoldResult;
    synchronization?: ReconciliationSynchronization;
    cost?: ReconciliationCostCharge;
  }): Promise<ReconciliationDeltas> {
    const cost = input.cost;
    if (cost !== undefined && (
      !Number.isSafeInteger(cost.observedResponses) || cost.observedResponses < 0
      || !Number.isSafeInteger(cost.unmeasuredResponses) || cost.unmeasuredResponses < 0
      || !(cost.completedAt instanceof Date) || !Number.isFinite(cost.completedAt.getTime())
      || (cost.observedCost === null ? cost.observedResponses !== 0
        : !Number.isSafeInteger(cost.observedCost) || cost.observedCost < 0 || cost.observedResponses === 0)
    )) {
      throw new Error("Invalid reconciliation cost observation.");
    }
    return this.coordinator.withRepositoryPublication(input.repositoryId, async (transaction) => {
      const [run] = await transaction<{ status: string; graphql_cost_sponsor_id: string | null }[]>`
        select status, graphql_cost_sponsor_id from reconciliation_runs
        where id = ${input.runId} and repository_id = ${input.repositoryId} for update
      `;
      // Reject terminal or charged runs before any derived write.
      if (run?.status !== "PENDING" || (cost !== undefined && run.graphql_cost_sponsor_id !== null)) {
        throw new Error(cost === undefined ? "Reconciliation publication requires a pending run."
          : "Reconciliation cost publication requires a pending run.");
      }
      // Data-subject suppressions check the import write itself (issue 1071):
      // inside the publication transaction, before any derived row or evidence
      // fact is written, so a pass that commits after a removal can never
      // re-write a suppressed person's identifiers.
      const scrubbed = await scrubSuppressedForgeData(transaction, input.repositoryId, input);
      if (scrubbed.synchronization !== undefined) {
        await synchronizeReconciliationEvidence(transaction, input.repositoryId, scrubbed.synchronization,
          this.options.reconciliationFactByteLimit ?? DEFAULT_RECONCILIATION_FACT_BYTE_LIMIT);
      }
      // A stale snapshot must not replay a pre-claim state over rows an
      // identity claim has since written (issue 446), so resolve the fold's
      // unclaimed GitHub identities inside this publication transaction before
      // any materialization applies fold state.
      const resolved = await reResolveIdentityClaims(transaction, scrubbed.fold);
      const publication = { ...scrubbed, fold: resolved };
      // One snapshot of the granted corrections for the whole run: settlements
      // and calibrations are two ways of recording the same issue's outcome, so
      // reading the table twice could price one against a grant the other never
      // saw. Reading it before `upsertIssues` cannot miss one: migration 009
      // gives `settlement_override_requests.issue_id` a foreign key to
      // `issues.id`, so a request exists only for an issue already in the
      // table, and an issue this run is about to insert can carry no grant.
      const [existingSettlements, existingSelfWorkCalibrations, grantedOverrides] = await Promise.all([
        loadExistingSettlements(transaction, input.repositoryId),
        loadExistingSelfWorkCalibrations(transaction, input.repositoryId),
        loadGrantedSettlementOverrides(transaction, input.repositoryId),
      ]);
      const issueIds = await upsertIssues(transaction, input.repositoryId, publication.fold);
      const pullRequestIds = await upsertPullRequests(transaction, input.repositoryId, publication.fold, issueIds);
      await replacePullRequestIssueLinks(transaction, input.repositoryId, publication.fold, issueIds, pullRequestIds);
      const settlementDeltas = await materializeSettlements(
        transaction,
        publication,
        issueIds,
        pullRequestIds,
        existingSettlements,
        grantedOverrides,
      );
      const selfWorkDeltas = await materializeSelfWorkCalibrations(
        transaction,
        publication,
        issueIds,
        pullRequestIds,
        existingSelfWorkCalibrations,
        grantedOverrides,
      );
      const unwritableClosureDeltas = await materializeUnwritableClosures(transaction, publication, issueIds, pullRequestIds);
      await materializeReviewRounds(transaction, publication.fold, pullRequestIds);
      const removalDeltas = await deleteAbsentMaterialization(
        transaction,
        input.repositoryId,
        publication.fold,
        issueIds,
        pullRequestIds,
        input.runId,
      );
      await recordNewPolicyViolations(transaction, input.repositoryId, input.runId, publication.fold.policyViolations);
      if (input.synchronization !== undefined) {
        await transaction`update registered_repositories set reconciliation_not_before = null where id = ${input.repositoryId}`;
      }
      if (cost !== undefined) {
        await transaction`
          insert into repository_reconciliation_usage
            (sponsor_id, repository_id, debt, measured_at, rate_per_second)
          values (${cost.sponsorId}, ${input.repositoryId}, ${cost.observedCost ?? 0}, ${cost.completedAt}, 0)
          on conflict (sponsor_id, repository_id) do update set
            debt = greatest(0, repository_reconciliation_usage.debt
              - repository_reconciliation_usage.rate_per_second
              * greatest(0, extract(epoch from (excluded.measured_at - repository_reconciliation_usage.measured_at))))
              + excluded.debt,
            measured_at = greatest(repository_reconciliation_usage.measured_at, excluded.measured_at)
        `;
        const completed = await transaction`
          update reconciliation_runs
          set status = ${"COMPLETED"}, completed_at = now(), error_message = null,
            graphql_cost = ${cost.observedCost}, graphql_cost_sponsor_id = ${cost.sponsorId},
            graphql_observed_responses = ${cost.observedResponses}, graphql_unmeasured_responses = ${cost.unmeasuredResponses}
          where id = ${input.runId} and repository_id = ${input.repositoryId}
            and status = 'PENDING' and graphql_cost_sponsor_id is null
          returning id
        `;
        if (completed.length !== 1) throw new Error("Reconciliation cost publication requires a pending run.");
      } else {
        const completed = await transaction`
          update reconciliation_runs
          set status = ${"COMPLETED"}, completed_at = now(), error_message = null
          where id = ${input.runId} and repository_id = ${input.repositoryId} and status = 'PENDING'
          returning id
        `;
        if (completed.length !== 1) throw new Error("Reconciliation publication requires a pending run.");
      }
      return combineDeltas(settlementDeltas, selfWorkDeltas, unwritableClosureDeltas, removalDeltas);
    });
  }

  public async getReconciliationEvidence(repositoryId: string): Promise<ReconciliationEvidence | null> {
    return this.reconciliationPacing.getReconciliationEvidence(repositoryId);
  }

  public async getDirtyReconciliationSubjects(repositoryId: string): Promise<DirtyReconciliationSubject[]> {
    return this.reconciliationPacing.getDirtyReconciliationSubjects(repositoryId);
  }

  public async discardDirtyReconciliationSubject(input: {
    repositoryId: string;
    kind: DirtyReconciliationSubject["kind"];
    githubSubjectId: number;
    generation: number;
  }): Promise<void> {
    return this.reconciliationPacing.discardDirtyReconciliationSubject(input);
  }

  public async claimDelivery(delivery: GitHubWebhookDelivery, scope: WebhookReceiptScope): Promise<WebhookDeliveryClaim> {
    return this.webhookDeliveries.claimDelivery(delivery, scope);
  }

  public async findRepositoryByGitHubId(githubRepositoryId: number): Promise<WebhookRepositoryRegistration | null> {
    return this.webhookDeliveries.findRepositoryByGitHubId(githubRepositoryId);
  }

  public async findRepositoryByForgeIdentity(
    provider: string,
    instanceUrl: string,
    forgeProjectId: number,
  ): Promise<WebhookRepositoryRegistration | null> {
    return this.webhookDeliveries.findRepositoryByForgeIdentity(provider, instanceUrl, forgeProjectId);
  }

  public async applyIssueView(repositoryId: string, githubIssueId: number, issue: GitHubWebhookIssue): Promise<void> {
    return this.webhookDeliveries.applyIssueView(repositoryId, githubIssueId, issue);
  }

  public async markProcessed(receiptId: string, leaseToken: string): Promise<boolean> {
    return this.webhookDeliveries.markProcessed(receiptId, leaseToken);
  }

  public async markFailed(receiptId: string, leaseToken: string, errorMessage: string): Promise<boolean> {
    return this.webhookDeliveries.markFailed(receiptId, leaseToken, errorMessage);
  }

  public async enqueueReconciliationJob(
    repositoryId: string,
    reason: ReconciliationJobReason,
  ): Promise<void> {
    return this.reconciliationJobs.enqueueReconciliationJob(repositoryId, reason);
  }

  public async enqueueWebhookReconciliation(repositoryId: string, delivery: GitHubWebhookDelivery): Promise<void> {
    return this.reconciliationJobs.enqueueWebhookReconciliation(repositoryId, delivery);
  }

  public async requestRepositoryRederivation(repositoryId: string, at: Date): Promise<void> {
    return this.reconciliationJobs.requestRepositoryRederivation(repositoryId, at);
  }

  public async claimNextReconciliationJob(): Promise<ClaimedReconciliationJob | null> {
    return this.reconciliationJobs.claimNextReconciliationJob();
  }

  public async renewReconciliationJobLease(jobId: string, leaseToken: string, renewalDeadline: Date): Promise<boolean> {
    return this.reconciliationJobs.renewReconciliationJobLease(jobId, leaseToken, renewalDeadline);
  }

  public async completeReconciliationJob(
    jobId: string,
    leaseToken: string,
    rederivationGeneration: number,
  ): Promise<boolean> {
    return this.reconciliationJobs.completeReconciliationJob(jobId, leaseToken, rederivationGeneration);
  }

  public async deferReconciliationJob(
    jobId: string,
    leaseToken: string,
    runAfter: Date,
  ): Promise<boolean> {
    return this.reconciliationJobs.deferReconciliationJob(jobId, leaseToken, runAfter);
  }

  public async retryReconciliationJob(
    jobId: string,
    leaseToken: string,
    runAfter: Date,
  ): Promise<boolean> {
    return this.reconciliationJobs.retryReconciliationJob(jobId, leaseToken, runAfter);
  }

  public async failReconciliationJob(jobId: string, leaseToken: string): Promise<boolean> {
    return this.reconciliationJobs.failReconciliationJob(jobId, leaseToken);
  }
}

async function upsertIssues(
  sql: TransactionClient,
  repositoryId: string,
  fold: FoldResult,
): Promise<Map<number, string>> {
  const ids = new Map<number, string>();
  // Raw fields share GitHub's clock with webhooks. A cached or in-flight fold
  // may be older; its derived evidence must still be materialized below.
  const acceptsRawView = sql`issues.github_updated_at is null or excluded.github_updated_at >= issues.github_updated_at`;
  for (const issue of fold.issues) {
    const [row] = await sql<IssueRow[]>`
      insert into issues (
        github_issue_id, repository_id, issue_number, title, url, state, github_updated_at,
        owner_github_login, opening_label, opening_comparison_points, opening_reserve_points,
        opening_source_event_id, opening_source_actor_login, opening_source_at,
        settled_label, settled_points, settled_label_event_id, settled_label_actor_login,
        settled_label_applied_at, settled_rationale_comment_id, settled_rationale_actor_login,
        settled_rationale_commented_at, claim_assignee_github_login, claim_assignee_github_user_id
      )
      values (
        ${issue.githubIssueId}, ${repositoryId}, ${issue.number}, ${issue.title}, ${issue.url}, ${issue.state}, ${issue.updatedAt},
        ${issue.ownerGitHubLogin}, ${issue.openingLabel}, ${issue.openingComparisonPoints}, ${issue.openingReservePoints},
        ${issue.openingSourceEventId}, ${issue.openingSourceActorLogin}, ${issue.openingSourceAt},
        ${issue.settledLabel}, ${issue.settledPoints}, ${issue.settledLabelEventId}, ${issue.settledLabelActorLogin},
        ${issue.settledLabelAppliedAt}, ${issue.settledRationaleCommentId}, ${issue.settledRationaleActorLogin},
        ${issue.settledRationaleCommentedAt}, ${issue.claimAssigneeGitHubLogin}, ${issue.claimAssigneeGitHubUserId}
      )
      on conflict (github_issue_id) do update
      set issue_number = excluded.issue_number,
          title = case when ${acceptsRawView} then excluded.title else issues.title end,
          url = case when ${acceptsRawView} then excluded.url else issues.url end,
          state = case when ${acceptsRawView} then excluded.state else issues.state end,
          github_updated_at = case when ${acceptsRawView} then excluded.github_updated_at else issues.github_updated_at end,
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
          owner_github_login = excluded.owner_github_login,
          opening_source_event_id = coalesce(issues.opening_source_event_id, excluded.opening_source_event_id),
          opening_source_actor_login = excluded.opening_source_actor_login,
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
          claim_assignee_github_user_id = excluded.claim_assignee_github_user_id,
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
      row.opening_source_event_id !== issue.openingSourceEventId ||
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
        github_pull_request_id, repository_id, issue_id, pull_request_number, url, title,
        author_id, author_github_login, author_github_user_id, state, merged_at, merge_commit_oid, final_commit_at, proof_sha256
      )
      values (
        ${pullRequest.githubPullRequestId}, ${repositoryId}, ${firstIssueId}, ${pullRequest.number},
        ${pullRequest.url}, ${pullRequest.title}, ${pullRequest.authorId},
        ${pullRequest.authorGitHubLogin}, ${pullRequest.authorGitHubUserId}, ${pullRequest.state}, ${pullRequest.mergedAt},
        ${pullRequest.mergeCommitOid}, ${pullRequest.finalCommitAt}, ${pullRequest.proofSha256}
      )
      on conflict (github_pull_request_id) do update
      set issue_id = excluded.issue_id,
          pull_request_number = excluded.pull_request_number,
          url = excluded.url,
          title = excluded.title,
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
  grantedOverrides: ReadonlyMap<number, number>,
): Promise<ReconciliationDeltas> {
  const existingByIssue = new Map(existingRows.map((row) => [toSafeInteger(row.github_issue_id), row]));
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
    } else if (current.fold_revision < FOLD_REVISION) {
      // Recomputed but unchanged: refresh the stamp without creating a CHANGE
      // record or counting a delta for every row after a revision bump (issue 197).
      await sql`update settlements set fold_revision = ${FOLD_REVISION} where id = ${current.id}`;
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
 * The points a moderator granted for each of this repository's issues.
 *
 * Keyed on the issue, because a settlement and a self-work calibration are the
 * two ways one issue's outcome is recorded and either can be corrected. A
 * correction cannot live in the row it corrects: materialization deletes and
 * rewrites both tables from immutable GitHub history on every run, so it is
 * read back here and applied to the fold's result before the row is written.
 * Where an issue has been corrected more than once the most recent grant wins,
 * so the map is filled in decision order and later grants overwrite earlier
 * ones.
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

function applyGrantedCalibrationOverride(
  calibration: SelfWorkCalibration,
  grantedOverrides: ReadonlyMap<number, number>,
): SelfWorkCalibration {
  const actualPoints = grantedOverrides.get(calibration.githubIssueId);
  return actualPoints === undefined
    ? calibration
    : applyGrantedSelfWorkCalibrationOverride(calibration, actualPoints);
}

async function loadExistingSettlements(
  sql: TransactionClient,
  repositoryId: string,
): Promise<SettlementRow[]> {
  return sql<SettlementRow[]>`
    select
      settlements.id, settlements.fold_revision, settlements.issue_id, settlements.pull_request_id,
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
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status, fold_revision,
      provider, instance_url
    )
    values (
      ${pullRequestId}, ${issueId}, ${settlement.creditorId}, ${settlement.creditorGitHubLogin}, ${settlement.creditorGitHubUserId}, ${settlement.debtorId},
      ${settlement.openingComparisonPoints}, ${settlement.settledPoints}, ${settlement.reviewRounds},
      ${settlement.credits}, ${settlement.proofSha256}, ${settlement.status}, ${FOLD_REVISION},
      ${settlement.provider ?? "github"}, ${settlement.instanceUrl ?? null}
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
        status = ${settlement.status}, fold_revision = ${FOLD_REVISION},
        provider = ${settlement.provider ?? "github"}, instance_url = ${settlement.instanceUrl ?? null}
    where issue_id = ${issueId}
  `;
}

async function updateSelfWorkCalibration(
  sql: TransactionClient,
  calibration: SelfWorkCalibration,
  issueId: string,
  pullRequestId: string,
): Promise<void> {
  await sql`
    update self_work_calibrations
    set pull_request_id = ${pullRequestId}, issue_id = ${issueId}, user_id = ${calibration.userId},
        opening_comparison_points = ${calibration.openingComparisonPoints},
        actual_points = ${calibration.actualPoints}, fold_revision = ${FOLD_REVISION}
    where issue_id = ${issueId}
  `;
}

async function materializeSelfWorkCalibrations(
  sql: TransactionClient,
  input: { repositoryId: string; runId: string; fold: FoldResult },
  issueIds: Map<number, string>,
  pullRequestIds: Map<number, string>,
  existingRows: readonly SelfWorkCalibrationRow[],
  grantedOverrides: ReadonlyMap<number, number>,
): Promise<ReconciliationDeltas> {
  const existingByIssue = new Map(
    existingRows.map((row) => [toSafeInteger(row.github_issue_id), row]),
  );
  let adds = 0;
  let changes = 0;
  let removals = 0;

  for (const folded of input.fold.selfWorkCalibrations) {
    // Corrected before the desired state is computed, so the reconciliation
    // change this run records is the row it goes on to write.
    const calibration = applyGrantedCalibrationOverride(folded, grantedOverrides);
    const pullRequestId = requiredId(pullRequestIds, calibration.githubPullRequestId, "Pull request");
    const issueId = requiredId(issueIds, calibration.githubIssueId, "Issue");
    const current = existingByIssue.get(calibration.githubIssueId);
    const desired = selfWorkCalibrationState(calibration);
    if (current === undefined) {
      await sql`
        insert into self_work_calibrations (
          pull_request_id, issue_id, user_id, opening_comparison_points, actual_points, fold_revision
        )
        values (
          ${pullRequestId}, ${issueId}, ${calibration.userId},
          ${calibration.openingComparisonPoints}, ${calibration.actualPoints}, ${FOLD_REVISION}
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

    existingByIssue.delete(calibration.githubIssueId);
    const before = selfWorkCalibrationStateFromRow(current);
    if (JSON.stringify(before) !== JSON.stringify(desired)) {
      await updateSelfWorkCalibration(sql, calibration, issueId, pullRequestId);
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
    } else if (current.fold_revision < FOLD_REVISION) {
      await sql`update self_work_calibrations set fold_revision = ${FOLD_REVISION} where id = ${current.id}`;
    }
  }

  for (const row of existingByIssue.values()) {
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
      self_work_calibrations.fold_revision,
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
    select unwritable_closures.id, unwritable_closures.fold_revision, unwritable_closures.issue_id, issues.github_issue_id,
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
        insert into unwritable_closures (issue_id, pull_request_id, kind, reason, fold_revision)
        values (${issueId}, ${pullRequestId}, ${closure.kind}, ${closure.reason}, ${FOLD_REVISION})
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
        set pull_request_id = ${pullRequestId}, kind = ${closure.kind}, reason = ${closure.reason},
            fold_revision = ${FOLD_REVISION}
        where id = ${current.id}
      `;
      await recordChange(sql, input.runId, null, "UNWRITABLE_CLOSURE", "CHANGE", before, desired);
      changes += 1;
    } else if (current.fold_revision < FOLD_REVISION) {
      await sql`update unwritable_closures set fold_revision = ${FOLD_REVISION} where id = ${current.id}`;
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

/**
 * The columns each removal snapshot records, named per query rather than
 * borrowed from the shared `IssueRow` and `PullRequestRow`. Those two describe
 * what the upserts return, which neither contains nor is contained by what
 * these selects fetch: `IssueRow` declares no number, state, title or url, and
 * `PullRequestRow` declares only its two ids and the merge pair, so reusing
 * either here would not compile at all.
 *
 * The other direction is the one worth guarding once it does compile.
 * `IssueRow` carries the opening-source and settlement columns that neither
 * removal select fetches, and a column declared on the row type but absent
 * from the query arrives `undefined`: `JSON.stringify` drops the key on its
 * way into `before_state`, so the snapshot quietly loses a field and nothing
 * fails. Naming the fetched columns here makes reading anything else a
 * compile error.
 *
 * `id` is the one column both selects fetch that no snapshot records — it
 * addresses the delete that follows, not the item that left — so the call
 * sites intersect it in rather than putting it on these types.
 */
type RemovedIssueRow = {
  github_issue_id: number | string;
  issue_number: number;
  title: string;
  url: string;
  state: IssueState;
  opening_label: string;
  opening_comparison_points: number;
  opening_reserve_points: number;
  owner_github_login: string | null;
};

type RemovedPullRequestRow = {
  github_pull_request_id: number | string;
  pull_request_number: number;
  title: string;
  url: string;
  state: PullRequestState;
  author_github_login: string | null;
  merge_commit_oid: string | null;
  merged_at: string | Date | null;
};

/**
 * Deletes the issues and pull requests the fold no longer contains, counting
 * each one and recording it in the change log.
 *
 * A deletion here is the reconciliation's most consequential act — a fold that
 * stops naming a repository's work erases every materialized row of it — so it
 * is reported rather than performed in silence. The record is written before
 * the delete, so the state it carries is read from the row that existed, and it
 * carries no `pull_request_id`: migration 004 gives that column
 * `on delete set null`, so a reference to the row being deleted is nulled by the
 * delete that follows in the same transaction. `before_state` is therefore where
 * a removal is legible, so each snapshot names the row it deleted — its number,
 * url, state and the login it carried — and not only what the fold priced.
 */
async function deleteAbsentMaterialization(
  sql: TransactionClient,
  repositoryId: string,
  fold: FoldResult,
  issueIds: Map<number, string>,
  pullRequestIds: Map<number, string>,
  runId: string,
): Promise<ReconciliationDeltas> {
  const desiredIssueIds = new Set(issueIds.values());
  const desiredPullRequestIds = new Set(pullRequestIds.values());
  let removals = 0;
  const currentPullRequests = await sql<({ id: string } & RemovedPullRequestRow)[]>`
    select
      id, github_pull_request_id, pull_request_number, title, url, state,
      author_github_login, merge_commit_oid, merged_at
    from pull_requests where repository_id = ${repositoryId}
  `;
  const currentIssues = await sql<({ id: string } & RemovedIssueRow)[]>`
    select
      id, github_issue_id, issue_number, title, url, state,
      opening_label, opening_comparison_points, opening_reserve_points, owner_github_login
    from issues where repository_id = ${repositoryId}
  `;

  await deleteAbsentPullRequestIssueLinks(sql, repositoryId, fold);
  for (const pullRequest of currentPullRequests) {
    if (!desiredPullRequestIds.has(pullRequest.id)) {
      await recordChange(sql, runId, null, "PULL_REQUEST", "REMOVE", removedPullRequestState(pullRequest), null);
      await sql`delete from review_rounds where pull_request_id = ${pullRequest.id}`;
      await sql`delete from pull_request_issues where pull_request_id = ${pullRequest.id}`;
      await sql`delete from pull_requests where id = ${pullRequest.id}`;
      removals += 1;
    }
  }
  for (const issue of currentIssues) {
    if (!desiredIssueIds.has(issue.id)) {
      await recordChange(sql, runId, null, "ISSUE", "REMOVE", removedIssueState(issue), null);
      await sql`delete from issues where id = ${issue.id}`;
      removals += 1;
    }
  }

  return { adds: 0, changes: 0, removals };
}

function removedIssueState(row: RemovedIssueRow): JSONValue {
  return {
    githubIssueId: toSafeInteger(row.github_issue_id),
    issueNumber: row.issue_number,
    title: row.title,
    url: row.url,
    state: row.state,
    ownerGitHubLogin: row.owner_github_login,
    openingLabel: row.opening_label,
    openingComparisonPoints: row.opening_comparison_points,
    openingReservePoints: row.opening_reserve_points,
  };
}

function removedPullRequestState(row: RemovedPullRequestRow): JSONValue {
  return {
    githubPullRequestId: toSafeInteger(row.github_pull_request_id),
    pullRequestNumber: row.pull_request_number,
    title: row.title,
    url: row.url,
    state: row.state,
    authorGitHubLogin: row.author_github_login,
    mergeCommitOid: row.merge_commit_oid,
    mergedAt: nullableTimestampToIso(row.merged_at),
  };
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
    settledLabelAppliedAt: nullableTimestampToIso(settlement.settledLabelAppliedAt),
    settledRationaleCommentId: settlement.settledRationaleCommentId,
    settledRationaleActorLogin: settlement.settledRationaleActorLogin,
    settledRationaleCommentedAt: nullableTimestampToIso(settlement.settledRationaleCommentedAt),
    mergeCommitOid: settlement.mergeCommitOid,
    mergedAt: nullableTimestampToIso(settlement.mergedAt),
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
    actualLabelAppliedAt: nullableTimestampToIso(calibration.actualLabelAppliedAt),
    rationaleCommentId: calibration.rationaleCommentId,
    rationaleActorLogin: calibration.rationaleActorLogin,
    rationaleCommentedAt: nullableTimestampToIso(calibration.rationaleCommentedAt),
    mergeCommitOid: calibration.mergeCommitOid,
    mergedAt: nullableTimestampToIso(calibration.mergedAt),
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

function requiredId(ids: Map<number, string>, githubId: number, label: string): string {
  const id = ids.get(githubId);
  if (id === undefined) {
    throw new Error(`${label} materialization was missing.`);
  }
  return id;
}
