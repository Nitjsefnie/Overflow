import { readEnv } from "@/lib/env";
import { getSql } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";
import type { FoldForgeIdentity, FoldResult, FoldUser } from "@/lib/fold/repository-fold";
import type { ReconciliationCostCharge, ReconciliationFairnessAssessment } from "@/lib/fold/reconciliation-fairness";
import type { GitHubGraphqlBudgetAssessment } from "@/lib/github/rate-limit-budget";
import type { DirtyReconciliationSubject, ReconciliationEvidence, ReconciliationSynchronization } from "@/lib/fold/reconciliation-evidence";
import { PostgresReconciliationJobStore } from "@/lib/fold/reconciliation-job-store";
import { PostgresReconciliationPacingStore } from "@/lib/fold/reconciliation-pacing-store";
import { PostgresRepositoryLookupStore } from "@/lib/fold/repository-lookup-store";
import { PostgresFoldMaterializationStore, type RepositoryFoldRevisionCounts, type RepositoryRederivationRequest } from "@/lib/fold/fold-materialization-store";
import { PostgresSponsorCredentialStore } from "@/lib/fold/sponsor-credential-store";
import { RepositoryCoordinator } from "@/lib/fold/repository-coordination";
import type { ReconciliationDeltas, ReconciliationHeldBy, ReconciliationRepository, ReconciliationStore, RepositoryUnavailableReason } from "@/lib/fold/reconcile";
import type { ClaimedReconciliationJob, ReconciliationJobReason } from "@/lib/fold/reconciliation-jobs";
import type { GitHubWebhookDelivery, GitHubWebhookIssue } from "@/lib/github/webhook-schema";
import type { WebhookDeliveryClaim, WebhookDeliveryStore, WebhookReceiptScope, WebhookRepositoryRegistration } from "@/lib/webhooks/processor";
import { PostgresWebhookDeliveryStore } from "@/lib/webhooks/postgres-delivery-store";
import type { RegisteredRepository } from "@/lib/repositories/register";

export { claimGitHubIdentity, claimForgeIdentity } from "@/lib/fold/identity-claims";
export { repositoryLockNamespace, reclaimCoordinationConnection } from "@/lib/fold/repository-coordination";
export type { RepositoryFoldRevisionCounts, RepositoryRederivationRequest } from "@/lib/fold/fold-materialization-store";

export class PostgresFoldStore implements ReconciliationStore, WebhookDeliveryStore {
  private readonly coordinator: RepositoryCoordinator;
  private readonly repositoryLookup: PostgresRepositoryLookupStore;
  private readonly reconciliationJobs: PostgresReconciliationJobStore;
  private readonly webhookDeliveries: PostgresWebhookDeliveryStore;
  private readonly sponsorCredentials: PostgresSponsorCredentialStore;
  private readonly reconciliationPacing: PostgresReconciliationPacingStore;
  private readonly materialization: PostgresFoldMaterializationStore;

  public constructor(
    private readonly sql: SqlClient = getSql(),
    tokenEncryptionKey: string | undefined = readEnv("TOKEN_ENCRYPTION_KEY"),
    private readonly coordinationSql?: SqlClient,
    previousTokenEncryptionKey: string | undefined = readEnv("TOKEN_ENCRYPTION_KEY_PREVIOUS"),
    /**
     * Store-level tuning, injectable for tests. The only knob today is the
     * per-fact byte limit the evidence cache omits facts over (default 64 MiB,
     * shared with the write-batch byte budget).
     */
    private readonly options: { reconciliationFactByteLimit?: number } = {},
  ) {
    this.coordinator = new RepositoryCoordinator(sql, coordinationSql);
    this.materialization = new PostgresFoldMaterializationStore(sql, this.coordinator, this.options);
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

  public async findRepositoryByOwnerName(ownerName: string): Promise<Pick<RegisteredRepository, "id" | "registrationMethod"> | null> {
    return this.repositoryLookup.findRepositoryByOwnerName(ownerName);
  }

  public async listActiveRepositoryIds(): Promise<string[]> {
    return this.repositoryLookup.listActiveRepositoryIds();
  }

  public async listActiveRepositorySponsors(): Promise<{ repositoryId: string; sponsorId: string }[]> {
    return this.repositoryLookup.listActiveRepositorySponsors();
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
    return this.materialization.hasDerivedRowsBelowFoldRevision(repositoryId, revision);
  }

  public async listRepositoryFoldRevisionCounts(revision: number): Promise<RepositoryFoldRevisionCounts[]> {
    return this.materialization.listRepositoryFoldRevisionCounts(revision);
  }

  public async findRepositoryRederivationRequest(
    repositoryId: string,
  ): Promise<RepositoryRederivationRequest | null> {
    return this.materialization.findRepositoryRederivationRequest(repositoryId);
  }

  public async beginRun(repositoryId: string, options?: { rederivation: boolean }): Promise<string> {
    return this.materialization.beginRun(repositoryId, options);
  }

  public async failRun(runId: string, errorMessage: string, cost?: Omit<ReconciliationCostCharge, "completedAt"> | null): Promise<void> {
    return this.materialization.failRun(runId, errorMessage, cost);
  }

  public async holdRun(runId: string, message: string, heldBy: ReconciliationHeldBy, cost?: Omit<ReconciliationCostCharge, "completedAt"> | null): Promise<void> {
    return this.materialization.holdRun(runId, message, heldBy, cost);
  }

  public async completeRun(runId: string): Promise<void> {
    return this.materialization.completeRun(runId);
  }

  public async materialize(input: {
    repositoryId: string;
    runId: string;
    fold: FoldResult;
    synchronization?: ReconciliationSynchronization;
    cost?: ReconciliationCostCharge;
  }): Promise<ReconciliationDeltas> {
    return this.materialization.materialize(input);
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
