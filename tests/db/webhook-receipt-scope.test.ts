import { createHmac, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql, TransactionSql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { createGitHubWebhookPostHandler } from "@/app/api/github/webhooks/route";
import { createGitLabWebhookPostHandler } from "@/app/api/gitlab/webhooks/route";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import type { GitHubWebhookDelivery } from "@/lib/github/webhook-schema";
import { processWebhook, type WebhookDeliveryClaim, type WebhookReceiptScope } from "@/lib/webhooks/processor";
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

  it("answers a claim that finds a live lease as in progress and leaves the receipt untouched", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    const delivery = await deliveryFor(fixture, randomUUID());
    const scope = { provider: "gitlab" as const, registrationId: fixture.repositoryId };
    const store = new PostgresFoldStore(sql);
    const first = await store.claimDelivery(delivery, scope);
    if (first.status !== "CLAIMED") throw new Error("Expected the first attempt to claim the receipt");
    const before = await receiptRows(scope, delivery.deliveryId);
    expect(before).toEqual([expect.objectContaining({
      processing_state: "PENDING", attempt_count: 1, execution_id: delivery.executionId, processing_lease_token: first.leaseToken,
    })]);

    await expect(store.claimDelivery({ ...delivery, executionId: "retry" }, scope)).resolves.toEqual({ status: "IN_PROGRESS" });

    expect(await receiptRows(scope, delivery.deliveryId)).toEqual(before);
  });

  it.each([
    { prior: "PROCESSED", expected: "DUPLICATE", attempts: 1 },
    { prior: "FAILED", expected: "CLAIMED", attempts: 2 },
    { prior: "EXPIRED", expected: "CLAIMED", attempts: 2 },
  ] as const)("classifies a claim over a $prior receipt as $expected", async ({ prior, expected, attempts }) => {
    const fixture = await materializeRepositoryFixture(sql);
    const delivery = await deliveryFor(fixture, randomUUID());
    const scope = { provider: "github" as const, registrationId: fixture.repositoryId };
    const store = new PostgresFoldStore(sql);
    const first = await store.claimDelivery(delivery, scope);
    if (first.status !== "CLAIMED") throw new Error("Expected the first attempt to claim the receipt");
    if (prior === "PROCESSED") expect(await store.markProcessed(first.receiptId, first.leaseToken)).toBe(true);
    // The lease holder's own receipt id and token, in that order, mark the row
    // FAILED through the store; a swapped delegation would answer false here.
    if (prior === "FAILED") expect(await store.markFailed(first.receiptId, first.leaseToken, "ignored")).toBe(true);
    if (prior === "EXPIRED") await sql`update webhook_deliveries set lease_expires_at = now() - interval '1 second' where id = ${first.receiptId}`;
    expect(await receiptRows(scope, delivery.deliveryId)).toEqual([expect.objectContaining({
      processing_state: prior === "EXPIRED" ? "PENDING" : prior,
      error_message: prior === "FAILED" ? "Webhook processing failed." : null,
    })]);

    const second = await store.claimDelivery({ ...delivery, executionId: "retry" }, scope);

    expect(second.status).toBe(expected);
    expect(await receiptRows(scope, delivery.deliveryId)).toEqual([expect.objectContaining({
      processing_state: expected === "CLAIMED" ? "PENDING" : "PROCESSED",
      attempt_count: attempts,
      execution_id: expected === "CLAIMED" ? "retry" : delivery.executionId,
      processing_lease_token: second.status === "CLAIMED" ? second.leaseToken : null,
    })]);
  });

  it("does not let a leased legacy receipt with the same key hold up a scoped claim", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    const delivery = await deliveryFor(fixture, randomUUID());
    const legacyToken = randomUUID();
    expect(await legacyClaim(delivery, legacyToken)).toEqual([{ processing_lease_token: legacyToken }]);
    const legacyBefore = await sql`select * from webhook_deliveries where github_delivery_id = ${delivery.deliveryId}`;
    expect(legacyBefore).toEqual([expect.objectContaining({ processing_state: "PENDING", processing_lease_token: legacyToken })]);

    const claim = await new PostgresFoldStore(sql).claimDelivery(delivery, { provider: "github", registrationId: fixture.repositoryId });

    expect(claim.status).toBe("CLAIMED");
    expect(await sql`select * from webhook_deliveries where github_delivery_id = ${delivery.deliveryId}`).toEqual(legacyBefore);
  });

  it.each([
    { other: "another registration under the same provider", provider: "github", otherRegistration: true },
    { other: "the same registration id under the other provider", provider: "gitlab", otherRegistration: false },
  ] as const)("does not let a processed receipt for $other turn an in-flight claim into a duplicate", async ({ provider, otherRegistration }) => {
    const fixture = await materializeRepositoryFixture(sql);
    const delivery = await deliveryFor(fixture, randomUUID());
    const scope = { provider: "github" as const, registrationId: fixture.repositoryId };
    const otherScope = {
      provider, registrationId: otherRegistration ? (await materializeRepositoryFixture(sql)).repositoryId : fixture.repositoryId,
    };
    const store = new PostgresFoldStore(sql);
    const processed = await store.claimDelivery(delivery, otherScope);
    if (processed.status !== "CLAIMED") throw new Error("Expected the other scope to claim its own receipt");
    expect(await store.markProcessed(processed.receiptId, processed.leaseToken)).toBe(true);
    expect((await store.claimDelivery(delivery, scope)).status).toBe("CLAIMED");
    const before = [await receiptRows(scope, delivery.deliveryId), await receiptRows(otherScope, delivery.deliveryId)];
    expect(before).toEqual([
      [expect.objectContaining({ processing_state: "PENDING" })],
      [expect.objectContaining({ processing_state: "PROCESSED" })],
    ]);

    await expect(store.claimDelivery({ ...delivery, executionId: "retry" }, scope)).resolves.toEqual({ status: "IN_PROGRESS" });

    expect([await receiptRows(scope, delivery.deliveryId), await receiptRows(otherScope, delivery.deliveryId)]).toEqual(before);
  });

  it("does not let a processed legacy receipt with the same key turn an in-flight scoped claim into a duplicate", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    const delivery = await deliveryFor(fixture, randomUUID());
    const legacyToken = randomUUID();
    await legacyClaim(delivery, legacyToken);
    expect(await legacyMarkProcessed(delivery.deliveryId, legacyToken)).toHaveLength(1);
    const scope = { provider: "github" as const, registrationId: fixture.repositoryId };
    const store = new PostgresFoldStore(sql);
    expect((await store.claimDelivery(delivery, scope)).status).toBe("CLAIMED");

    await expect(store.claimDelivery({ ...delivery, executionId: "retry" }, scope)).resolves.toEqual({ status: "IN_PROGRESS" });
  });

  // The two claims below run while another transaction holds the conflicting
  // row, so the claim's snapshot predates that row's final state: it must
  // still answer IN_PROGRESS, never DUPLICATE, since nothing it can see proves
  // the other attempt's work durable.
  it("answers in progress when the conflicting receipt is inserted and committed while the claim waits", async () => {
    const scope = { provider: "github" as const, registrationId: randomUUID() };
    const key = randomUUID();
    const store = new PostgresFoldStore(sql);

    const result = await claimWhileHeld(
      (tx) => tx`insert into webhook_deliveries (provider, registration_id, delivery_key, execution_id, event_name,
          processing_state, processing_lease_token, lease_expires_at, attempt_count)
        values (${scope.provider}, ${scope.registrationId}, ${key}, 'first', 'issues',
          'PENDING', ${randomUUID()}, now() + interval '5 minutes', 1)`,
      () => store.claimDelivery(raceDelivery(key), scope),
    );

    expect(result).toEqual({ status: "IN_PROGRESS" });
  });

  it("answers in progress when another attempt reclaims a FAILED receipt while the claim waits, and keeps that lease", async () => {
    const scope = { provider: "github" as const, registrationId: randomUUID() };
    const key = randomUUID();
    await sql`insert into webhook_deliveries (provider, registration_id, delivery_key, execution_id, event_name,
        processing_state, attempt_count, error_message, processed_at)
      values (${scope.provider}, ${scope.registrationId}, ${key}, 'first', 'issues',
        'FAILED', 1, 'Webhook processing failed.', now())`;
    const store = new PostgresFoldStore(sql);
    const otherToken = randomUUID();

    const result = await claimWhileHeld(
      (tx) => tx`update webhook_deliveries
        set processing_state = 'PENDING', processing_lease_token = ${otherToken},
            lease_expires_at = now() + interval '5 minutes', attempt_count = attempt_count + 1,
            error_message = null, processed_at = null
        where registration_id = ${scope.registrationId} and delivery_key = ${key}`,
      () => store.claimDelivery(raceDelivery(key), scope),
    );

    expect(result).toEqual({ status: "IN_PROGRESS" });
    expect(await sql`select processing_state, processing_lease_token::text, attempt_count, execution_id from webhook_deliveries
      where registration_id = ${scope.registrationId} and delivery_key = ${key}`)
      .toEqual([{ processing_state: "PENDING", processing_lease_token: otherToken, attempt_count: 2, execution_id: "first" }]);
  });

  it.each(["github", "gitlab"] as const)(
    "asks %s to retry while the first attempt holds the lease, then processes the retry once that attempt fails",
    async (provider) => {
      const fixture = await materializeRepositoryFixture(sql);
      const [repository] = provider === "gitlab"
        ? await sql`update registered_repositories
            set provider = 'gitlab', instance_url = 'https://gitlab.example.com', forge_project_id = github_repository_id
            where id = ${fixture.repositoryId} returning github_repository_id`
        : await sql`select github_repository_id from registered_repositories where id = ${fixture.repositoryId}`;
      const projectId = Number(repository.github_repository_id);
      const store = new PostgresFoldStore(sql);
      const scope = { provider, registrationId: fixture.repositoryId };
      const key = randomUUID();
      const send = routeSender(provider, fixture, projectId, store, key);
      const jobs = () => sql`select repository_id from repository_reconciliation_jobs where repository_id = ${fixture.repositoryId}`;
      expect(await jobs()).toEqual([]);

      const first = await store.claimDelivery({ ...(await deliveryFor(fixture, key)), executionId: provider === "gitlab" ? "execution-1" : key }, scope);
      if (first.status !== "CLAIMED") throw new Error("Expected the first attempt to claim the receipt");
      const leased = await receiptRows(scope, key);

      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect((await send("execution-2")).status).toBe(503);
      } finally {
        warned.mockRestore();
      }
      expect(await receiptRows(scope, key)).toEqual(leased);

      expect(await store.markFailed(first.receiptId, first.leaseToken, "ignored")).toBe(true);

      expect((await send("execution-3")).status).toBe(202);
      expect(await receiptRows(scope, key)).toEqual([expect.objectContaining({ processing_state: "PROCESSED", attempt_count: 2 })]);
      expect(await jobs()).toEqual([{ repository_id: fixture.repositoryId }]);
    },
  );

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

  it.each([
    { name: "null registration", registrationId: null, deliveryKey: "key", executionId: "execution" },
    { name: "blank delivery key", registrationId: randomUUID(), deliveryKey: "   ", executionId: "execution" },
    { name: "blank execution id", registrationId: randomUUID(), deliveryKey: "key", executionId: "   " },
  ])("rejects a scoped receipt with $name", async ({ registrationId, deliveryKey, executionId }) => {
    await expect(sql`insert into webhook_deliveries
      (provider, registration_id, delivery_key, execution_id, event_name, processing_state)
      values ('gitlab', ${registrationId}, ${deliveryKey}, ${executionId}, 'issues', 'PROCESSED')`)
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

function receiptRows(scope: WebhookReceiptScope, deliveryKey: string) {
  return sql`select processing_state, attempt_count, execution_id, processing_lease_token::text, lease_expires_at, error_message, processed_at
    from webhook_deliveries
    where provider = ${scope.provider} and registration_id = ${scope.registrationId} and delivery_key = ${deliveryKey}`;
}

// Drives the real route handler factory over the real processor and store; the
// credential lookup is the only stand-in, pinned to the fixture's registration.
function routeSender(
  provider: "github" | "gitlab",
  fixture: Awaited<ReturnType<typeof materializeRepositoryFixture>>,
  projectId: number,
  store: PostgresFoldStore,
  key: string,
): (execution: string) => Promise<Response> {
  const secret = "receipt-scope-secret";
  const credentialId = "181a4fbb-64d1-44fd-82da-cd191613798c";
  const credential = {
    repositoryId: fixture.repositoryId, credentialId, provider, secret, projectId, webhookId: 4242, configuredAt: null,
    instanceUrl: provider === "gitlab" ? "https://gitlab.example.com" : null,
  };
  const dependencies = {
    checkRateLimit: () => true,
    lookupCredential: async () => credential,
    processWebhook: (delivery: GitHubWebhookDelivery, scope: WebhookReceiptScope) => processWebhook({ store,
      enqueueReconciliation: (repositoryId, event) => store.enqueueWebhookReconciliation(repositoryId, event),
    }, delivery, scope),
  };
  const url = `https://overflow.test/api/${provider}/webhooks?hook=${credentialId}`;
  if (provider === "github") {
    const route = createGitHubWebhookPostHandler(dependencies);
    const body = JSON.stringify({
      action: "closed", repository: { id: projectId, full_name: "owner/project" },
      pull_request: { id: fixture.fold.pullRequests[0].githubPullRequestId, number: 11 },
    });
    const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
    return () => route(new Request(url, { method: "POST", body, headers: {
      "x-github-event": "pull_request", "x-github-delivery": key, "x-hub-signature-256": signature,
    } }));
  }
  const route = createGitLabWebhookPostHandler(dependencies);
  const body = JSON.stringify({
    object_kind: "issue",
    project: { id: projectId, path_with_namespace: "group/project", web_url: "https://gitlab.example.com/group/project" },
    object_attributes: {
      id: fixture.fold.issues[0].githubIssueId, iid: 1, title: "Updated", description: "", state: "opened",
      updated_at: "2026-09-26T12:00:00Z", url: "https://gitlab.example.com/group/project/-/issues/1", action: "reopen",
    },
  });
  return (execution: string) => route(new Request(url, { method: "POST", body, headers: {
    "x-gitlab-event": "Issue Hook", "x-gitlab-token": secret, "x-gitlab-webhook-uuid": execution, "Idempotency-Key": key,
  } }));
}

function raceDelivery(key: string): GitHubWebhookDelivery {
  return { deliveryId: key, executionId: "retry", event: "issues", action: "reopened",
    repositoryGitHubId: 1, repositoryFullName: "owner/project", subject: { kind: "ISSUE", id: 1, number: 1 } };
}

/**
 * Runs `claim` while a transaction holding `hold`'s row change is still open,
 * commits that transaction only once the claim is queued behind it on a row
 * lock, and returns the claim's answer. The wait has no deadline: it ends when
 * Postgres reports the claim blocked by the holder, or fails when the claim
 * settles without ever blocking, since the race was then never staged. The
 * transaction always ends, commit or rollback, so a failure cannot leave the
 * claim queued behind it.
 */
async function claimWhileHeld(
  hold: (tx: TransactionSql) => Promise<unknown>,
  claim: () => Promise<WebhookDeliveryClaim>,
): Promise<WebhookDeliveryClaim> {
  let pending: Promise<WebhookDeliveryClaim> | undefined;
  try {
    await sql.begin(async (tx) => {
      await hold(tx);
      const [holder] = await tx<{ pid: number }[]>`select pg_backend_pid() as pid`;
      let settled = false;
      const started = claim();
      pending = started;
      started.then(() => { settled = true; }, () => { settled = true; });
      while (!settled) {
        const [queued] = await sql<{ blocked: boolean }[]>`
          select exists (
            select 1 from pg_stat_activity
            where ${holder.pid}::int = any(pg_blocking_pids(pid)) and wait_event_type = 'Lock'
          ) as blocked`;
        if (queued.blocked) return;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error("The claim settled without queueing behind the held receipt");
    });
  } finally {
    await pending?.catch(() => undefined);
  }
  if (pending === undefined) throw new Error("The claim never started");
  return pending;
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
