import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import type { GitHubWebhookDelivery } from "@/lib/github/webhook-schema";
import { processWebhook, type WebhookReceiptScope } from "@/lib/webhooks/processor";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe("scoped webhook receipts", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "receipt_scope", user: "receipt_scope", password: "receipt_scope" });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it.each(["github", "gitlab"] as const)("cannot consume another %s registration's receipt with a colliding header", async (provider) => {
    const a = await materializeRepositoryFixture(sql);
    const b = await materializeRepositoryFixture(sql);
    const first = await deliveryFor(a, `gitlab:${randomUUID()}`);
    const second = await deliveryFor(b, first.deliveryId);
    if (provider === "gitlab") {
      await sql`update registered_repositories set provider = 'gitlab', instance_url = 'https://gitlab.example.com',
        forge_project_id = github_repository_id where id = ${b.repositoryId}`;
      second.forge = { provider: "gitlab", instanceUrl: "https://gitlab.example.com" };
    }
    await expect(deliver(first, { provider: "github", registrationId: a.repositoryId })).resolves.toEqual({ status: "PROCESSED" });
    await expect(deliver(second, { provider, registrationId: b.repositoryId })).resolves.toEqual({ status: "PROCESSED" });
    expect(await sql`select state, github_updated_at from issues
      where repository_id = ${b.repositoryId} and github_issue_id = ${second.subject.id}`)
      .toEqual([{ state: "OPEN", github_updated_at: new Date("2026-09-26T12:00:00Z") }]);
    expect(await sql`select provider, registration_id, github_delivery_id from webhook_deliveries
      where delivery_key = ${first.deliveryId} order by received_at`)
      .toEqual([
        { provider: "github", registration_id: a.repositoryId, github_delivery_id: null },
        { provider, registration_id: b.repositoryId, github_delivery_id: null },
      ]);
  });

  it("deduplicates a processed receipt without changing dirty-subject generation", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    const delivery = await deliveryFor(fixture, randomUUID());
    const scope = { provider: "github" as const, registrationId: fixture.repositoryId };
    await expect(deliver(delivery, scope)).resolves.toEqual({ status: "PROCESSED" });
    const before = await sql`select generation from repository_reconciliation_dirty_subjects where repository_id = ${fixture.repositoryId}`;
    expect(before).toHaveLength(1);
    await expect(deliver({ ...delivery, executionId: "retry" }, scope)).resolves.toEqual({ status: "DUPLICATE" });
    expect(await sql`select generation from repository_reconciliation_dirty_subjects where repository_id = ${fixture.repositoryId}`).toEqual(before);
    expect(await sql`select attempt_count, execution_id from webhook_deliveries
      where provider = ${scope.provider} and registration_id = ${scope.registrationId} and delivery_key = ${delivery.deliveryId}`)
      .toEqual([{ attempt_count: 1, execution_id: delivery.executionId }]);
  });

  it("keeps provider in the receipt key even for the same registration UUID", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    const delivery = await deliveryFor(fixture, randomUUID());
    const store = new PostgresFoldStore(sql);
    const scope = { provider: "github" as const, registrationId: fixture.repositoryId };
    const first = await store.claimDelivery(delivery, scope);
    const second = await store.claimDelivery(delivery, { ...scope, provider: "gitlab" });
    expect(first.status).toBe("CLAIMED");
    expect(second.status).toBe("CLAIMED");
    if (first.status !== "CLAIMED" || second.status !== "CLAIMED") throw new Error("Expected independent receipts");
    expect(second.receiptId).not.toBe(first.receiptId);
  });

  it("keeps the previous writer's insert, failed re-lease and both completion statements working", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    const delivery = await deliveryFor(fixture, randomUUID());
    const firstToken = randomUUID();
    expect(await legacyClaim(delivery, firstToken)).toEqual([{ processing_lease_token: firstToken }]);
    const [legacy] = await sql`select id from webhook_deliveries where github_delivery_id = ${delivery.deliveryId}`;
    expect(await legacyClaim(delivery, randomUUID())).toEqual([]);
    expect(await legacyMarkFailed(delivery.deliveryId, firstToken)).toEqual([{ id: legacy.id }]);
    const retryToken = randomUUID();
    expect(await legacyClaim(delivery, retryToken)).toEqual([{ processing_lease_token: retryToken }]);
    expect(await sql`select id, attempt_count, processing_state, error_message from webhook_deliveries where id = ${legacy.id}`)
      .toEqual([{ id: legacy.id, attempt_count: 2, processing_state: "PENDING", error_message: null }]);
    expect(await legacyMarkProcessed(delivery.deliveryId, firstToken)).toEqual([]);
    expect(await legacyMarkProcessed(delivery.deliveryId, retryToken)).toEqual([{ id: legacy.id }]);
    expect(await legacyClaim(delivery, randomUUID())).toEqual([]);

    const store = new PostgresFoldStore(sql);
    const claim = await store.claimDelivery(delivery, { provider: "github", registrationId: fixture.repositoryId });
    expect(claim.status).toBe("CLAIMED");
    if (claim.status !== "CLAIMED") throw new Error("Legacy receipt consumed a scoped receipt");
    expect(claim.receiptId).not.toBe(legacy.id);
    expect(await store.markProcessed(claim.receiptId, claim.leaseToken)).toBe(true);
    expect(await sql`select github_delivery_id, delivery_key, processing_state from webhook_deliveries
      where github_delivery_id = ${delivery.deliveryId} or delivery_key = ${delivery.deliveryId} order by received_at`)
      .toEqual([
        { github_delivery_id: delivery.deliveryId, delivery_key: null, processing_state: "PROCESSED" },
        { github_delivery_id: null, delivery_key: delivery.deliveryId, processing_state: "PROCESSED" },
      ]);
  });

  it("rejects a receipt mixing legacy and scoped identities", async () => {
    await expect(sql`insert into webhook_deliveries
      (github_delivery_id, provider, registration_id, delivery_key, execution_id, event_name, processing_state)
      values (${randomUUID()}, 'github', ${randomUUID()}, 'key', 'execution', 'issues', 'PROCESSED')`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "webhook_deliveries_receipt_shape_check" });
  });

  it("rejects a scoped receipt from an unsupported provider", async () => {
    await expect(sql`insert into webhook_deliveries
      (provider, registration_id, delivery_key, execution_id, event_name, processing_state)
      values ('other', ${randomUUID()}, 'key', 'execution', 'issues', 'PROCESSED')`)
      .rejects.toMatchObject({ code: "23514", constraint_name: "webhook_deliveries_receipt_shape_check" });
  });
});

async function deliveryFor(fixture: Awaited<ReturnType<typeof materializeRepositoryFixture>>, deliveryId: string): Promise<GitHubWebhookDelivery> {
  const [repository] = await sql`select github_repository_id from registered_repositories where id = ${fixture.repositoryId}`;
  return {
    deliveryId, executionId: deliveryId, event: "issues", action: "reopened",
    repositoryGitHubId: Number(repository.github_repository_id), repositoryFullName: "owner/project",
    subject: { kind: "ISSUE", id: fixture.fold.issues[0].githubIssueId, number: 1 },
    issue: { state: "OPEN", updatedAt: "2026-09-26T12:00:00Z", title: "Updated", body: "", url: "https://example.com/issue/1" },
  };
}

function deliver(delivery: GitHubWebhookDelivery, scope: WebhookReceiptScope) {
  const store = new PostgresFoldStore(sql);
  return processWebhook({ store,
    enqueueReconciliation: (repositoryId, event) => store.enqueueWebhookReconciliation(repositoryId, event),
  }, delivery, scope);
}

// SQL copied verbatim from origin/main at 09d9baa2: these run throughout the
// next release's build and again after a rollback against the migrated schema.

function legacyClaim(delivery: GitHubWebhookDelivery, leaseToken: string) {
  return sql`
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
}

function legacyMarkProcessed(deliveryId: string, leaseToken: string) {
  return sql`
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
}

function legacyMarkFailed(deliveryId: string, leaseToken: string) {
  return sql`
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
}
