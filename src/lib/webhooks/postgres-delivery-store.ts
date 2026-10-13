import { getSql } from "@/lib/db/client";
import type { SqlClient } from "@/lib/db/types";
import { PostgresReconciliationJobStore } from "@/lib/fold/reconciliation-job-store";
import type { GitHubWebhookDelivery, GitHubWebhookIssue } from "@/lib/github/webhook-schema";
import type { WebhookDeliveryClaim, WebhookDeliveryStore, WebhookReceiptScope, WebhookRepositoryRegistration } from "@/lib/webhooks/processor";
import * as webhookReceipts from "@/lib/webhooks/postgres-receipts";

export class PostgresWebhookDeliveryStore implements WebhookDeliveryStore {
  public constructor(private readonly sql: SqlClient = getSql()) {}

  public async claimDelivery(delivery: GitHubWebhookDelivery, scope: WebhookReceiptScope): Promise<WebhookDeliveryClaim> {
    return webhookReceipts.claimDelivery(this.sql, delivery, scope);
  }

  public async findRepositoryByGitHubId(githubRepositoryId: number): Promise<WebhookRepositoryRegistration | null> {
    const [row] = await this.sql<{ id: string; active: boolean; unavailable_reason: string | null }[]>`
      select id, active, unavailable_reason from registered_repositories where github_repository_id = ${githubRepositoryId} limit 1
    `;
    return row === undefined ? null : { id: row.id, active: row.active, unavailableReason: row.unavailable_reason };
  }

  public async findRepositoryByForgeIdentity(
    provider: string,
    instanceUrl: string,
    forgeProjectId: number,
  ): Promise<WebhookRepositoryRegistration | null> {
    // The forge triple is the resolution primitive for GitLab deliveries: a
    // numeric id alone could match a GitHub registration holding the same
    // number, so the provider and the normalized instance URL decide (issue
    // 547). The partial unique index from migration 038 keeps the triple
    // unique across non-GitHub registrations.
    const [row] = await this.sql<{ id: string; active: boolean; unavailable_reason: string | null }[]>`
      select id, active, unavailable_reason from registered_repositories
      where provider = ${provider} and instance_url = ${instanceUrl} and forge_project_id = ${forgeProjectId}
      limit 1
    `;
    return row === undefined ? null : { id: row.id, active: row.active, unavailableReason: row.unavailable_reason };
  }

  public async applyIssueView(repositoryId: string, githubIssueId: number, issue: GitHubWebhookIssue): Promise<void> {
    // Unknown issues need the fold's opening evidence before they can be inserted.
    // The body column is deliberately absent (issue 681): the view stops
    // persisting body text, and a body a row already holds is left as it is.
    await this.sql`
      update issues
      set state = ${issue.state}, title = ${issue.title}, url = ${issue.url},
          github_updated_at = ${issue.updatedAt}
      where repository_id = ${repositoryId} and github_issue_id = ${githubIssueId}
        and (github_updated_at is null or github_updated_at <= ${issue.updatedAt}::timestamptz)
    `;
  }

  public async markProcessed(receiptId: string, leaseToken: string): Promise<boolean> {
    return webhookReceipts.markProcessed(this.sql, receiptId, leaseToken);
  }

  public async markFailed(receiptId: string, leaseToken: string, errorMessage: string): Promise<boolean> {
    return webhookReceipts.markFailed(this.sql, receiptId, leaseToken, errorMessage);
  }

  public async enqueueWebhookReconciliation(repositoryId: string, delivery: GitHubWebhookDelivery): Promise<void> {
    return new PostgresReconciliationJobStore(this.sql).enqueueWebhookReconciliation(repositoryId, delivery);
  }
}
