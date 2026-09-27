import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import postgres from "postgres";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getCoordinationSql, getSql } from "@/lib/db/client";
import { claimGitHubIdentity, PostgresFoldStore } from "@/lib/fold/postgres-store";
import { runNextReconciliationJob } from "@/lib/fold/reconciliation-worker";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { AccountModerationService } from "@/lib/moderation/service";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";
import { createModeratorPostHandler } from "@/app/api/moderation/moderators/route";
import { POST } from "@/app/api/github/webhooks/route";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { guardedRequests, useTrustedOrigin } from "../support/trusted-origin";
import { startPostgresContainer } from "../support/postgres-container";

/**
 * Issue 661, task 5: what a lock-wait cancellation (57014) does to each caller
 * path, and the deadline posture the rescope landed on.
 *
 * The fold's publication transaction legitimately holds its repository's
 * registered_repositories row for the whole transaction, and at real scale
 * that transaction outruns a 30 s per-statement deadline (measured on seeded
 * data: 12-93 s against the 30 s default, single statements at milliseconds;
 * production reconciliation runs p95 207 s, max 995 s). Every waiter that
 * queues behind it is cancelled by the server. These tests hold real locks
 * past a tight deadline and pin what each caller does:
 *
 * - the worker requeues the job into retry backoff, and the job refolds once
 *   the lock clears — not lost;
 * - a cancelled completeReconciliationJob leaves the job RUNNING under its
 *   lease, so expiry and reclaim — not a half-applied completion — own what
 *   happens next;
 * - the webhook route answers the retryable 503, and the redelivery after the
 *   lock clears succeeds;
 * - the moderation route answers a structured error and changes nothing, and
 *   the same request after the lock clears succeeds;
 * - a webhook enqueue's foreign-key wait on the repository row rejects rather
 *   than hanging;
 * - an identity claim is cancelled at the deadline and the same claim after
 *   the lock clears succeeds.
 */
describe("statement deadline waiter paths", () => {
  useTrustedOrigin();

  const databaseUrlOriginal = process.env.DATABASE_URL;
  const statementTimeoutOriginal = process.env.DATABASE_STATEMENT_TIMEOUT_MS;
  const tokenKeyOriginal = process.env.TOKEN_ENCRYPTION_KEY;
  const tokenKey = Buffer.alloc(32, 23).toString("base64url");

  let container: StartedTestContainer | undefined;
  let databaseUrl: string;
  let sql: Sql;

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "deadline_waiters_test",
      user: "deadline_waiters_test",
      password: "deadline_waiters_test",
      initScripts: [{ name: "661_waiter_own_container.sql", content: "select 1;" }],
    });
    container = started.container;
    databaseUrl = started.databaseUrl;
    process.env.DATABASE_URL = started.databaseUrl;
    process.env.TOKEN_ENCRYPTION_KEY = tokenKey;
    sql = getSql() as unknown as Sql;
    await runMigrations();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (databaseUrlOriginal === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = databaseUrlOriginal;
    if (statementTimeoutOriginal === undefined) delete process.env.DATABASE_STATEMENT_TIMEOUT_MS;
    else process.env.DATABASE_STATEMENT_TIMEOUT_MS = statementTimeoutOriginal;
    if (tokenKeyOriginal === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
    else process.env.TOKEN_ENCRYPTION_KEY = tokenKeyOriginal;
  });

  /**
   * A pool is a module singleton whose options are read once at construction.
   * Every test opens the deadline it pins first, so the pool under test
   * advertises it from construction. The suite's `sql` handle follows the
   * singleton: a handle taken before this call points at an ended pool.
   */
  async function openPoolWithDeadline(statementTimeoutMs: string): Promise<Sql> {
    await closeSql();
    process.env.DATABASE_STATEMENT_TIMEOUT_MS = statementTimeoutMs;
    sql = getSql() as unknown as Sql;
    return sql;
  }

  async function showStatementTimeout(client: Sql): Promise<string> {
    const [row] = await client`show statement_timeout`;
    return row?.statement_timeout ?? "";
  }

  /**
   * Holds one row's lock until released. The holder lifts its own deadline —
   * it is the simulated long transaction — and the readiness promise resolving
   * is the proof the row is locked: it runs only after the locking statement
   * has returned, so no test sequences itself by sleeps.
   */
  async function holdRow(table: string, where: string): Promise<{ release: () => Promise<void> }> {
    const holder = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
    let lockHeld: () => void = () => {};
    const held = new Promise<void>((resolve) => { lockHeld = resolve; });
    let releaseHolder: () => void = () => {};
    const released = new Promise<void>((resolve) => { releaseHolder = resolve; });
    const holderDone = (async () => holder.begin(async (tx) => {
      await tx`set local statement_timeout = 0`;
      await tx.unsafe(`select id from ${table} where ${where} for update`);
      lockHeld();
      await released;
    }))();
    await held;
    return {
      release: async () => {
        releaseHolder();
        await holderDone;
      },
    };
  }

  it("requeues a fold whose publication is cancelled behind a repository row held past the deadline", async () => {
    const workPool = await openPoolWithDeadline("500");
    expect(await showStatementTimeout(workPool)).toBe("500ms");

    const fixture = await materializeRepositoryFixture(sql);
    const store = newStore();
    const [job] = await sql<{ id: string }[]>`
      insert into repository_reconciliation_jobs (repository_id, reason)
      values (${fixture.repositoryId}, 'WEBHOOK') returning id`;

    const lock = await holdRow("registered_repositories", `id = '${fixture.repositoryId}'`);
    try {
      // The fold's cancelled statement is whichever statement of the fold
      // first queues on the repository row — the publication's row lock or
      // beginRun's foreign-key wait. Whichever pays, the worker's contract is
      // the same: the job is requeued, not lost.
      const outcome = await runNextReconciliationJob({
        store,
        reconcile: (repositoryId) => publishFold(store, repositoryId, publishedIssue(0)),
      });
      expect(outcome).toBe("RETRY_SCHEDULED");

      // The job is requeued, not lost: PENDING again, retry backoff ahead of
      // it, and the cancellation recorded on the row.
      const [row] = await sql<{ state: string; attempt_count: number; run_after: Date; last_failure_at: Date | null }[]>`
        select state, attempt_count, run_after, last_failure_at
        from repository_reconciliation_jobs where id = ${job.id}`;
      expect(row.state).toBe("PENDING");
      expect(row.attempt_count).toBe(1);
      expect(row.run_after.getTime()).toBeGreaterThan(Date.now());
      expect(row.last_failure_at).not.toBeNull();
    } finally {
      await lock.release();
    }

    // Once the lock clears, the same job is picked up and completes: the
    // cancellation cost one retry, not the job.
    await sql`update repository_reconciliation_jobs set run_after = now() where id = ${job.id}`;
    const secondOutcome = await runNextReconciliationJob({
      store,
      reconcile: (repositoryId) => publishFold(store, repositoryId, publishedIssue(1)),
    });
    expect(secondOutcome).toBe("RECONCILED");
    const [gone] = await sql<{ id: string }[]>`
      select id from repository_reconciliation_jobs where id = ${job.id}`;
    expect(gone).toBeUndefined();
  });
  it("leaves a job whose completeReconciliationJob is cancelled RUNNING under its lease", async () => {
    const workPool = await openPoolWithDeadline("500");
    expect(await showStatementTimeout(workPool)).toBe("500ms");
    const fixture = await materializeRepositoryFixture(sql);
    const store = newStore();
    const leaseToken = "11111111-1111-4111-8111-111111111111";
    const [job] = await sql<{ id: string }[]>`
      insert into repository_reconciliation_jobs (repository_id, reason, state, lease_token, lease_duration_ms, lease_expires_at, attempt_count)
      values (${fixture.repositoryId}, 'WEBHOOK', 'RUNNING', ${leaseToken}, 20000, now() + interval '20 seconds', 1)
      returning id`;

    const lock = await holdRow("repository_reconciliation_jobs", `id = '${job.id}'`);
    try {
      await expect(
        store.completeReconciliationJob(job.id, leaseToken, 0),
      ).rejects.toMatchObject({ code: "57014" });

      // The transaction rolled back whole: the job keeps its lease, so expiry
      // and reclaim own what happens next.
      const [row] = await sql<{ state: string; lease_token: string | null }[]>`
        select state, lease_token from repository_reconciliation_jobs where id = ${job.id}`;
      expect(row.state).toBe("RUNNING");
      expect(row.lease_token).toBe(leaseToken);
    } finally {
      await lock.release();
    }

    expect(await store.completeReconciliationJob(job.id, leaseToken, 0)).toBe(true);
    const [gone] = await sql<{ id: string }[]>`
      select id from repository_reconciliation_jobs where id = ${job.id}`;
    expect(gone).toBeUndefined();
  });

  it("answers a webhook redelivery 503 when its receipt claim is cancelled behind a held receipt row", async () => {
    await openPoolWithDeadline("500");
    const fixture = await materializeRepositoryFixture(sql);

    const repositoryStore = new PostgresRepositoryStore(sql, tokenKey);
    const [repoRow] = await sql<{ github_repository_id: string; github_webhook_id: string }[]>`
      select github_repository_id, github_webhook_id from registered_repositories where id = ${fixture.repositoryId}`;
    const staged = await repositoryStore.stageWebhookCredential({
      repositoryId: fixture.repositoryId, provider: "github", instanceUrl: null,
      projectId: Number(repoRow.github_repository_id), webhookId: Number(repoRow.github_webhook_id),
    });
    if (staged === null) {
      throw new Error("stageWebhookCredential returned no credential");
    }
    expect(await repositoryStore.finalizeWebhookCredential(staged)).toBe(true);

    const deliveryId = "661-waiter-delivery";
    await sql`
      insert into webhook_deliveries (provider, registration_id, delivery_key, execution_id, event_name, processing_state, processing_lease_token, lease_expires_at)
      values ('github', ${fixture.repositoryId}, ${deliveryId}, 'exec-1', 'pull_request', 'PROCESSED', null, null)`;

    const lock = await holdRow("webhook_deliveries", `delivery_key = '${deliveryId}'`);
    try {
      const response = await POST(deliveryRequest(staged, deliveryId, Number(repoRow.github_repository_id)));

      // A cancellation is a processing failure, so the route answers GitHub's
      // retryable 503 — the delivery is re-delivered, not acknowledged and
      // lost — and the receipt keeps its processed state.
      expect(response.status).toBe(503);
      const [receiptRow] = await sql<{ processing_state: string }[]>`
        select processing_state from webhook_deliveries where delivery_key = ${deliveryId}`;
      expect(receiptRow.processing_state).toBe("PROCESSED");
    } finally {
      await lock.release();
    }

    // The redelivery after the lock clears is the retry the 503 promised.
    const recovered = await POST(deliveryRequest(staged, `${deliveryId}-2`, Number(repoRow.github_repository_id)));
    expect(recovered.status).toBe(202);
  });

  it("returns a structured error and changes nothing when a moderation write is cancelled behind a held account row", async () => {
    await openPoolWithDeadline("500");
    const [moderator] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login, role)
      values (661000001, 'deadline-waiter-moderator', 'MODERATOR') returning id`;
    const [target] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login)
      values (661000002, 'deadline-waiter-target') returning id`;

    const lock = await holdRow("users", `id = '${target.id}'`);
    try {
      const response = await moderationHandler(moderator.id)({ targetAccountId: target.id, moderator: true });
      expect(response.status).toBe(502);
      await expect(response.json()).resolves.toEqual({
        error: { code: "UPSTREAM_FAILURE", message: "Unable to complete the moderator request." },
      });
      const [unchanged] = await sql<{ role: string }[]>`
        select role from users where id = ${target.id}`;
      expect(unchanged.role).toBe("MEMBER");
    } finally {
      await lock.release();
    }

    // After the lock clears the same request succeeds.
    const recovered = await moderationHandler(moderator.id)({ targetAccountId: target.id, moderator: true });
    expect(recovered.status).toBe(200);
    const [promoted] = await sql<{ role: string }[]>`
      select role from users where id = ${target.id}`;
    expect(promoted.role).toBe("MODERATOR");
  });

  it("rejects a webhook enqueue whose foreign-key wait on the repository row is cancelled", async () => {
    await openPoolWithDeadline("500");
    const fixture = await materializeRepositoryFixture(sql);
    const store = newStore();
    const [repoRow] = await sql<{ github_repository_id: string }[]>`
      select github_repository_id from registered_repositories where id = ${fixture.repositoryId}`;

    const lock = await holdRow("registered_repositories", `id = '${fixture.repositoryId}'`);
    try {
      await expect(store.enqueueWebhookReconciliation(fixture.repositoryId, waiterDelivery(Number(repoRow.github_repository_id))))
        .rejects.toMatchObject({ code: "57014" });
    } finally {
      await lock.release();
    }

    // The enqueue is retried with the delivery (the route answered 503); after
    // the lock clears it succeeds.
    await expect(store.enqueueWebhookReconciliation(fixture.repositoryId, waiterDelivery(Number(repoRow.github_repository_id))))
      .resolves.toBeUndefined();
  });

  it("cancels an identity claim at the deadline behind a held fence and retries clean", async () => {
    await openPoolWithDeadline("500");
    await materializeRepositoryFixture(sql);
    const [contributor] = await sql<{ id: string; github_user_id: string }[]>`
      insert into users (github_user_id, github_login)
      values (661000003, 'deadline-waiter-claimant') returning id, github_user_id`;

    const lock = await holdRow("registered_repositories", "true");
    try {
      await expect(claimGitHubIdentity(getSql(), contributor.id, Number(contributor.github_user_id)))
        .rejects.toMatchObject({ code: "57014" });
    } finally {
      await lock.release();
    }

    // The same claim after the lock clears succeeds: the cancellation is
    // bounded and retryable, and the fence runs once the holder commits.
    await expect(claimGitHubIdentity(getSql(), contributor.id, Number(contributor.github_user_id)))
      .resolves.toBeUndefined();
  });

  function deliveryRequest(
    credential: { credentialId: string; secret: string },
    deliveryId: string,
    repositoryGitHubId: number,
  ): Request {
    const payload = JSON.stringify({
      action: "closed", repository: { id: repositoryGitHubId, full_name: "owner/repo" },
      pull_request: { id: 201, number: 11 },
    });
    const signature = createHmac("sha256", credential.secret).update(payload).digest("hex");
    return new Request(`https://overflow.test/api/github/webhooks?hook=${credential.credentialId}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-github-event": "pull_request",
        "x-github-delivery": deliveryId,
        "x-hub-signature-256": `sha256=${signature}`,
      },
      body: payload,
    });
  }

  function waiterDelivery(repositoryGitHubId: number): Parameters<PostgresFoldStore["enqueueWebhookReconciliation"]>[1] {
    return {
      deliveryId: "enqueue-delivery", executionId: "exec", event: "pull_request", action: "closed",
      repositoryGitHubId, repositoryFullName: "owner/repo",
      subject: { kind: "PULL_REQUEST", id: 201, number: 11 },
    };
  }

  function moderationHandler(moderatorId: string): (input: { targetAccountId: string; moderator: boolean }) => Promise<Response> {
    const handler = createModeratorPostHandler({
      getSession: async () => ({ user: { id: moderatorId, role: "MODERATOR" } }),
      findAccountByTokenHash: async () => null,
      getCurrentRole: async () => "MODERATOR",
      createService: async () => new AccountModerationService(new PostgresModerationStore()),
    });
    const { json } = guardedRequests("/api/moderation/moderators");
    return (input) => handler(json(input));
  }
});

/**
 * A minimal full publication, the shape the worker's real reconcile call takes.
 */
async function publishFold(
  store: PostgresFoldStore,
  repositoryId: string,
  issue: { githubIssueId: number; number: number },
): Promise<void> {
  const githubIssueId = issue.githubIssueId;
  const fold = {
    issues: [{
      githubIssueId, number: issue.number, title: "Deadline waiter fixture", body: "", url: "https://example.test/issue",
      state: "CLOSED" as const, updatedAt: "2026-09-01T12:05:00.000Z", openingLabel: "M", openingComparisonPoints: 5,
      openingReservePoints: 5, ownerGitHubLogin: "deadline-waiter-sponsor",
      openingSourceEventId: `opening-${githubIssueId}`, openingSourceActorLogin: "deadline-waiter-sponsor",
      openingSourceAt: "2026-09-01T08:00:00.000Z",
      claimAssigneeGitHubLogin: null, claimAssigneeGitHubUserId: null,
      settledLabel: null, settledPoints: null, settledLabelEventId: null, settledLabelActorLogin: null,
      settledLabelAppliedAt: null, settledRationaleCommentId: null, settledRationaleActorLogin: null,
      settledRationaleCommentedAt: null,
    }],
    pullRequests: [],
    settlements: [],
    selfWorkCalibrations: [],
    unwritableClosures: [],
    policyViolations: [],
    ledgerEntries: [],
  };
  const runId = await store.beginRun(repositoryId);
  try {
    await store.withRepositoryReconciliation(
      repositoryId,
      async () => store.materialize({ repositoryId, runId, fold }),
    );
    await store.completeRun(runId);
  } catch (error) {
    await store.failRun(runId, "Reconciliation failed.").catch(() => undefined);
    throw error;
  }
}

function publishedIssue(seq: number): { githubIssueId: number; number: number } {
  return { githubIssueId: 700_000_000 + seq, number: 900 + seq };
}

/**
 * The fold store reads its pools at construction, so every store is built
 * after the deadline-under-test pool exists — with the real work and
 * coordination clients.
 */
function newStore(): PostgresFoldStore {
  return new PostgresFoldStore(getSql(), process.env.TOKEN_ENCRYPTION_KEY, getCoordinationSql());
}
