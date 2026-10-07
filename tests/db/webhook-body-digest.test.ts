import { createHash, createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { createGitHubWebhookPostHandler } from "@/app/api/github/webhooks/route";
import { createGitLabWebhookPostHandler } from "@/app/api/gitlab/webhooks/route";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import type { GitHubWebhookDelivery } from "@/lib/github/webhook-schema";
import { processWebhook, type WebhookProcessingResult } from "@/lib/webhooks/processor";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;

const GITHUB_SECRET = "body-digest-github-secret";
const GITHUB_CREDENTIAL_ID = "181a4fbb-64d1-44fd-82da-cd191613798c";
const GITLAB_SECRET = "body-digest-gitlab-secret";
const GITLAB_CREDENTIAL_ID = "181a4fbb-64d1-44fd-82da-cd191613798c";
const GITLAB_INSTANCE = "https://gitlab.example.com";

describe("webhook body-digest replay dedup", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "body_digest", user: "body_digest", password: "body_digest" });
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

  describe("github receiver", () => {
    it("records the signed body's digest on the processed receipt", async () => {
      const fixture = await materializeRepositoryFixture(sql);
      const sender = await githubSender(fixture);
      const body = sender.body(0);

      const response = await sender.send({ deliveryId: "gh-digest-1", body });

      expect(response.status).toBe(202);
      expect(sender.results).toEqual([{ status: "PROCESSED" }]);
      expect(await receiptRows(fixture.repositoryId)).toEqual([
        {
          delivery_key: "gh-digest-1", execution_id: "gh-digest-1", processing_state: "PROCESSED",
          attempt_count: 1, body_digest: sha256(body),
        },
      ]);
    });

    it("answers a fresh delivery id over an already-processed body as a duplicate", async () => {
      const fixture = await materializeRepositoryFixture(sql);
      const sender = await githubSender(fixture);
      const body = sender.body(0);
      expect((await sender.send({ deliveryId: "gh-replay-1", body })).status).toBe(202);
      const subjectsBefore = await dirtySubjects(fixture.repositoryId);
      const jobsBefore = await reconciliationJobs(fixture.repositoryId);
      expect(subjectsBefore).toHaveLength(1);

      expect((await sender.send({ deliveryId: "gh-replay-2", body })).status).toBe(202);

      expect(sender.results).toEqual([{ status: "PROCESSED" }, { status: "DUPLICATE" }]);
      expect(await receiptRows(fixture.repositoryId)).toEqual([
        {
          delivery_key: "gh-replay-1", execution_id: "gh-replay-1", processing_state: "PROCESSED",
          attempt_count: 1, body_digest: sha256(body),
        },
      ]);
      expect(await dirtySubjects(fixture.repositoryId)).toEqual(subjectsBefore);
      expect(await reconciliationJobs(fixture.repositoryId)).toEqual(jobsBefore);
    });

    it("still dedups a replayed delivery id by delivery id alone", async () => {
      const fixture = await materializeRepositoryFixture(sql);
      const sender = await githubSender(fixture);
      const body = sender.body(0);
      expect((await sender.send({ deliveryId: "gh-same-id-1", body })).status).toBe(202);

      expect((await sender.send({ deliveryId: "gh-same-id-1", body })).status).toBe(202);

      expect(sender.results).toEqual([{ status: "PROCESSED" }, { status: "DUPLICATE" }]);
      expect(await receiptRows(fixture.repositoryId)).toEqual([
        expect.objectContaining({ delivery_key: "gh-same-id-1", processing_state: "PROCESSED", attempt_count: 1 }),
      ]);
    });

    it("processes the redelivery of a failed body", async () => {
      const fixture = await materializeRepositoryFixture(sql);
      const body = (await githubSender(fixture)).body(0);
      const failing = await githubSender(fixture, { failEnqueue: true });
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
      let first: Response;
      try {
        first = await failing.send({ deliveryId: "gh-failed-1", body });
      } finally {
        errorSpy.mockRestore();
      }
      expect(first.status).toBe(503);
      expect(await receiptRows(fixture.repositoryId)).toEqual([
        {
          delivery_key: "gh-failed-1", execution_id: "gh-failed-1", processing_state: "FAILED",
          attempt_count: 1, body_digest: sha256(body),
        },
      ]);

      const real = await githubSender(fixture);
      expect((await real.send({ deliveryId: "gh-failed-1", body })).status).toBe(202);

      expect(real.results).toEqual([{ status: "PROCESSED" }]);
      expect(await receiptRows(fixture.repositoryId)).toEqual([
        {
          delivery_key: "gh-failed-1", execution_id: "gh-failed-1", processing_state: "PROCESSED",
          attempt_count: 2, body_digest: sha256(body),
        },
      ]);
    });

    it("answers a live-lease redelivery with 503 and processes it once the lease fails", async () => {
      const fixture = await materializeRepositoryFixture(sql);
      const sender = await githubSender(fixture);
      const body = sender.body(0);
      const store = new PostgresFoldStore(sql);
      const projectId = await projectIdOf(fixture);
      const claim = await store.claimDelivery(storeDelivery("gh-lease-1", projectId), {
        provider: "github", registrationId: fixture.repositoryId, bodyDigest: sha256(body),
      });
      expect(claim.status).toBe("CLAIMED");
      if (claim.status !== "CLAIMED") throw new Error("Expected the store claim to take the lease");
      expect(await receiptRows(fixture.repositoryId)).toEqual([
        {
          delivery_key: "gh-lease-1", execution_id: claimDeliveryExecution("gh-lease-1"),
          processing_state: "PENDING", attempt_count: 1, body_digest: sha256(body),
        },
      ]);

      const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
      let leased: Response;
      try {
        leased = await sender.send({ deliveryId: "gh-lease-1", body });
      } finally {
        warned.mockRestore();
      }
      expect(leased.status).toBe(503);
      expect(await receiptRows(fixture.repositoryId)).toEqual([
        {
          delivery_key: "gh-lease-1", execution_id: claimDeliveryExecution("gh-lease-1"),
          processing_state: "PENDING", attempt_count: 1, body_digest: sha256(body),
        },
      ]);

      expect(await store.markFailed(claim.receiptId, claim.leaseToken, "ignored")).toBe(true);
      expect((await sender.send({ deliveryId: "gh-lease-1", body })).status).toBe(202);

      expect(sender.results).toEqual([{ status: "PROCESSED" }]);
      expect(await receiptRows(fixture.repositoryId)).toEqual([
        {
          delivery_key: "gh-lease-1", execution_id: claimDeliveryExecution("gh-lease-1"),
          processing_state: "PROCESSED", attempt_count: 2, body_digest: sha256(body),
        },
      ]);
    });

    it("processes two distinct bodies for one registration", async () => {
      const fixture = await materializeRepositoryFixture(sql);
      const sender = await githubSender(fixture);
      const first = sender.body(0);
      const second = sender.body(1);

      expect((await sender.send({ deliveryId: "gh-distinct-1", body: first })).status).toBe(202);
      expect((await sender.send({ deliveryId: "gh-distinct-2", body: second })).status).toBe(202);

      expect(sender.results).toEqual([{ status: "PROCESSED" }, { status: "PROCESSED" }]);
      expect(await receiptRows(fixture.repositoryId)).toEqual([
        {
          delivery_key: "gh-distinct-1", execution_id: "gh-distinct-1", processing_state: "PROCESSED",
          attempt_count: 1, body_digest: sha256(first),
        },
        {
          delivery_key: "gh-distinct-2", execution_id: "gh-distinct-2", processing_state: "PROCESSED",
          attempt_count: 1, body_digest: sha256(second),
        },
      ]);
      expect(await dirtySubjects(fixture.repositoryId)).toHaveLength(2);
    });

    it("still dedups a digest-less processed receipt by delivery id alone", async () => {
      // The previous release's receipt shape: every column the current claim
      // writes, minus body_digest. The redelivery must dedup on the delivery
      // key exactly as it does today.
      const fixture = await materializeRepositoryFixture(sql);
      const sender = await githubSender(fixture);
      await seedLegacyReceipt(fixture.repositoryId, "gh-legacy-processed", "PROCESSED");
      const subjectsBefore = await dirtySubjects(fixture.repositoryId);
      expect(subjectsBefore).toHaveLength(0);

      expect((await sender.send({ deliveryId: "gh-legacy-processed", body: sender.body(0) })).status).toBe(202);

      expect(sender.results).toEqual([{ status: "DUPLICATE" }]);
      expect(await receiptRows(fixture.repositoryId)).toEqual([
        {
          delivery_key: "gh-legacy-processed", execution_id: legacyExecutionId("gh-legacy-processed"),
          processing_state: "PROCESSED", attempt_count: 1, body_digest: null,
        },
      ]);
      expect(await dirtySubjects(fixture.repositoryId)).toEqual(subjectsBefore);
    });

    it("redelivers a digest-less failed receipt and records the redelivery's digest", async () => {
      const fixture = await materializeRepositoryFixture(sql);
      const sender = await githubSender(fixture);
      const body = sender.body(0);
      await seedLegacyReceipt(fixture.repositoryId, "gh-legacy-failed", "FAILED");

      expect((await sender.send({ deliveryId: "gh-legacy-failed", body })).status).toBe(202);

      expect(sender.results).toEqual([{ status: "PROCESSED" }]);
      expect(await receiptRows(fixture.repositoryId)).toEqual([
        {
          delivery_key: "gh-legacy-failed", execution_id: legacyExecutionId("gh-legacy-failed"),
          processing_state: "PROCESSED", attempt_count: 2, body_digest: sha256(body),
        },
      ]);
    });

    it("processes a fresh delivery id over a digest-less processed body", async () => {
      // The mixed-version window's accepted cost: a PROCESSED receipt written
      // without a digest cannot match a digest-carrying replay, so a fresh
      // delivery id over the same body processes once more. The delivery-id
      // rule stays the only protection until this release has written the
      // digest itself.
      const fixture = await materializeRepositoryFixture(sql);
      const sender = await githubSender(fixture);
      await seedLegacyReceipt(fixture.repositoryId, "gh-legacy-window", "PROCESSED");

      expect((await sender.send({ deliveryId: "gh-window-fresh", body: sender.body(0) })).status).toBe(202);

      expect(sender.results).toEqual([{ status: "PROCESSED" }]);
      expect((await receiptRows(fixture.repositoryId)).map((row) => row.delivery_key))
        .toEqual(["gh-legacy-window", "gh-window-fresh"]);
    });
  });

  describe("gitlab receiver", () => {
    it("records the signed body's digest on the processed receipt", async () => {
      const fixture = await gitlabFixture();
      const sender = await gitlabSender(fixture);
      const body = sender.body(0);

      const response = await sender.send({ body, uuid: "gl-digest-uuid-1", deliveryKey: "gl-digest-key-1" });

      expect(response.status).toBe(202);
      expect(sender.results).toEqual([{ status: "PROCESSED" }]);
      expect(await receiptRows(fixture.repositoryId)).toEqual([
        {
          delivery_key: "gl-digest-key-1", execution_id: "gl-digest-uuid-1", processing_state: "PROCESSED",
          attempt_count: 1, body_digest: sha256(body),
        },
      ]);
    });

    it("answers a fresh receipt key over an already-processed body as a duplicate", async () => {
      const fixture = await gitlabFixture();
      const sender = await gitlabSender(fixture);
      const body = sender.body(0);
      expect((await sender.send({ body, uuid: "gl-replay-uuid-1", deliveryKey: "gl-replay-key-1" })).status).toBe(202);
      const subjectsBefore = await dirtySubjects(fixture.repositoryId);

      // The same Idempotency-Key under a fresh execution UUID is today's
      // delivery-id dedup and must stay one.
      expect((await sender.send({ body, uuid: "gl-replay-uuid-2", deliveryKey: "gl-replay-key-1" })).status).toBe(202);
      // The same execution UUID without the key derives a different receipt
      // key — the UUID itself — over a body this registration already
      // processed: the digest must answer it.
      expect((await sender.send({ body, uuid: "gl-replay-uuid-1" })).status).toBe(202);
      // A wholly fresh receipt key over the same body: deduped by digest too.
      expect((await sender.send({ body, uuid: "gl-replay-uuid-3" })).status).toBe(202);

      expect(sender.results).toEqual([
        { status: "PROCESSED" }, { status: "DUPLICATE" }, { status: "DUPLICATE" }, { status: "DUPLICATE" },
      ]);
      expect(await receiptRows(fixture.repositoryId)).toEqual([
        {
          delivery_key: "gl-replay-key-1", execution_id: "gl-replay-uuid-1", processing_state: "PROCESSED",
          attempt_count: 1, body_digest: sha256(body),
        },
      ]);
      expect(await dirtySubjects(fixture.repositoryId)).toEqual(subjectsBefore);
    });

    it("processes two distinct bodies for one registration", async () => {
      const fixture = await gitlabFixture();
      const sender = await gitlabSender(fixture);
      const first = sender.body(0);
      const second = sender.body(1);

      expect((await sender.send({ body: first, uuid: "gl-distinct-uuid-1", deliveryKey: distinctDeliveryKey(1) })).status).toBe(202);
      expect((await sender.send({ body: second, uuid: "gl-distinct-uuid-2", deliveryKey: distinctDeliveryKey(2) })).status).toBe(202);

      expect(sender.results).toEqual([{ status: "PROCESSED" }, { status: "PROCESSED" }]);
      expect((await receiptRows(fixture.repositoryId)).sort((a, b) => a.execution_id.localeCompare(b.execution_id))).toEqual([
        {
          delivery_key: distinctDeliveryKey(1), execution_id: "gl-distinct-uuid-1", processing_state: "PROCESSED",
          attempt_count: 1, body_digest: sha256(first),
        },
        {
          delivery_key: distinctDeliveryKey(2), execution_id: "gl-distinct-uuid-2", processing_state: "PROCESSED",
          attempt_count: 1, body_digest: sha256(second),
        },
      ]);
      expect(await dirtySubjects(fixture.repositoryId)).toHaveLength(2);
    });
  });

  describe("receipt claim scope and fallback", () => {
    it("scopes the digest to one registration", async () => {
      const a = await materializeRepositoryFixture(sql);
      const b = await materializeRepositoryFixture(sql);
      const sender = await githubSender(a);
      const body = sender.body(0);
      expect((await sender.send({ deliveryId: "gh-scope-1", body })).status).toBe(202);
      const store = new PostgresFoldStore(sql);
      const projectId = await projectIdOf(a);
      const digest = sha256(body);

      // The same body text under another registration is a different replay
      // key: it claims and processes.
      const other = await store.claimDelivery(storeDelivery("gh-scope-2", projectId), {
        provider: "github", registrationId: b.repositoryId, bodyDigest: digest,
      });
      expect(other.status).toBe("CLAIMED");
      if (other.status !== "CLAIMED") throw new Error("Expected the other registration to claim its own receipt");
      expect(await store.markProcessed(other.receiptId, other.leaseToken)).toBe(true);

      // The digest is what dedups the first registration's own fresh-key
      // redelivery — the delivery keys differ, so only the digest can.
      await expect(store.claimDelivery(storeDelivery("gh-scope-3", projectId), {
        provider: "github", registrationId: a.repositoryId, bodyDigest: digest,
      })).resolves.toEqual({ status: "DUPLICATE" });
    });

    it("never dedups by digest when the claim carries no digest", async () => {
      const fixture = await materializeRepositoryFixture(sql);
      const store = new PostgresFoldStore(sql);
      const projectId = await projectIdOf(fixture);
      const claim = await store.claimDelivery(storeDelivery("gh-nulldigest-1", projectId), {
        provider: "github", registrationId: fixture.repositoryId, bodyDigest: sha256("a processed body"),
      });
      expect(claim.status).toBe("CLAIMED");
      if (claim.status !== "CLAIMED") throw new Error("Expected the first claim to take the lease");
      expect(await store.markProcessed(claim.receiptId, claim.leaseToken)).toBe(true);

      // No claim-side digest: the replay lookup matches nothing and the
      // delivery-id-only rule decides, exactly as today.
      await expect(store.claimDelivery(storeDelivery("gh-nulldigest-2", projectId), {
        provider: "github", registrationId: fixture.repositoryId,
      })).resolves.toMatchObject({ status: "CLAIMED" });
      await expect(store.claimDelivery(storeDelivery("gh-nulldigest-1", projectId), {
        provider: "github", registrationId: fixture.repositoryId,
      })).resolves.toEqual({ status: "DUPLICATE" });
    });
  });
});

// ---------------------------------------------------------------------------
// harness

type Fixture = Awaited<ReturnType<typeof materializeRepositoryFixture>>;

async function projectIdOf(fixture: Fixture): Promise<number> {
  const [repository] = await sql`select github_repository_id from registered_repositories where id = ${fixture.repositoryId}`;
  return Number(repository.github_repository_id);
}

async function gitlabFixture(): Promise<Fixture> {
  const fixture = await materializeRepositoryFixture(sql);
  await sql`update registered_repositories
    set provider = 'gitlab', instance_url = ${GITLAB_INSTANCE}, forge_project_id = github_repository_id
    where id = ${fixture.repositoryId}`;
  return fixture;
}

/**
 * Drives the real GitHub route handler over the real processor and store; the
 * credential lookup is the only stand-in, pinned to the fixture's
 * registration. `failEnqueue` swaps the fold enqueue for a rejection so a
 * delivery fails processing the way a real store fault would.
 */
async function githubSender(fixture: Fixture, options: { failEnqueue?: boolean } = {}) {
  const projectId = await projectIdOf(fixture);
  const results: WebhookProcessingResult[] = [];
  const store = new PostgresFoldStore(sql);
  const route = createGitHubWebhookPostHandler({
    checkRateLimit: () => true,
    lookupCredential: async () => ({
      repositoryId: fixture.repositoryId, credentialId: GITHUB_CREDENTIAL_ID, provider: "github" as const,
      secret: GITHUB_SECRET, projectId, webhookId: 4242, configuredAt: null, instanceUrl: null,
    }),
    processWebhook: async (delivery, scope) => {
      const result = await processWebhook({
        store,
        enqueueReconciliation: options.failEnqueue === true
          ? async () => { throw new Error("enqueue refused"); }
          : (repositoryId, event) => store.enqueueWebhookReconciliation(repositoryId, event),
      }, delivery, scope);
      results.push(result);
      return result;
    },
  });
  return {
    results,
    body: (pullRequestIndex: 0 | 1) => JSON.stringify({
      action: "closed", repository: { id: projectId, full_name: "owner/project" },
      pull_request: {
        id: fixture.fold.pullRequests[pullRequestIndex].githubPullRequestId,
        number: fixture.fold.pullRequests[pullRequestIndex].number,
      },
    }),
    send: async (options: { deliveryId: string; body: string }) => route(new Request(
      `https://overflow.test/api/github/webhooks?hook=${GITHUB_CREDENTIAL_ID}`,
      {
        method: "POST", body: options.body,
        headers: {
          "x-github-event": "pull_request", "x-github-delivery": options.deliveryId,
          "x-hub-signature-256": `sha256=${createHmac("sha256", GITHUB_SECRET).update(options.body).digest("hex")}`,
        },
      },
    )),
  };
}

/** The GitLab twin of `githubSender`, over issue-hook bodies. */
async function gitlabSender(fixture: Fixture) {
  const projectId = await projectIdOf(fixture);
  const results: WebhookProcessingResult[] = [];
  const store = new PostgresFoldStore(sql);
  const route = createGitLabWebhookPostHandler({
    checkRateLimit: () => true,
    lookupCredential: async () => ({
      repositoryId: fixture.repositoryId, credentialId: GITLAB_CREDENTIAL_ID, provider: "gitlab" as const,
      secret: GITLAB_SECRET, projectId, webhookId: 4242, configuredAt: null, instanceUrl: GITLAB_INSTANCE,
    }),
    processWebhook: async (delivery, scope) => {
      const result = await processWebhook({
        store,
        enqueueReconciliation: (repositoryId, event) => store.enqueueWebhookReconciliation(repositoryId, event),
      }, delivery, scope);
      results.push(result);
      return result;
    },
  });
  return {
    results,
    body: (issueIndex: 0 | 1) => {
      const issue = fixture.fold.issues[issueIndex];
      return JSON.stringify({
        object_kind: "issue",
        project: { id: projectId, path_with_namespace: "group/project", web_url: `${GITLAB_INSTANCE}/group/project` },
        object_attributes: {
          id: issue.githubIssueId, iid: issue.number, title: "Updated", description: "", state: "opened",
          updated_at: "2026-09-26T12:00:00Z",
          url: `${GITLAB_INSTANCE}/group/project/-/issues/${issue.number}`, action: "reopen",
        },
      });
    },
    send: async (options: { body: string; uuid: string; deliveryKey?: string }) => route(new Request(
      `https://overflow.test/api/gitlab/webhooks?hook=${GITLAB_CREDENTIAL_ID}`,
      {
        method: "POST", body: options.body,
        headers: {
          "x-gitlab-event": "Issue Hook", "x-gitlab-token": GITLAB_SECRET, "x-gitlab-webhook-uuid": options.uuid,
          ...(options.deliveryKey === undefined ? {} : { "Idempotency-Key": options.deliveryKey }),
        },
      },
    )),
  };
}

/** A delivery for the claim layer, whose receipt reads only the key fields. */
function storeDelivery(deliveryKey: string, projectId: number): GitHubWebhookDelivery {
  return {
    deliveryId: deliveryKey, executionId: claimDeliveryExecution(deliveryKey), event: "issues", action: "reopened",
    repositoryGitHubId: projectId, repositoryFullName: "owner/project",
    subject: { kind: "ISSUE", id: 1, number: 1 },
  };
}

function claimDeliveryExecution(deliveryKey: string): string {
  return `${deliveryKey}-execution`;
}

/**
 * Seeds a receipt in the previous release's shape — every column the current
 * claim writes, minus body_digest — so the mixed-version window is exercised
 * against real rows.
 */
async function seedLegacyReceipt(registrationId: string, deliveryKey: string, processingState: "PROCESSED" | "FAILED") {
  await sql`insert into webhook_deliveries (
      provider, registration_id, delivery_key, execution_id, event_name, processing_state, attempt_count, error_message, processed_at
    )
    values (
      'github', ${registrationId}, ${deliveryKey}, ${legacyExecutionId(deliveryKey)}, 'pull_request',
      ${processingState}, 1, ${processingState === "FAILED" ? "Webhook processing failed." : null},
      ${processingState === "FAILED" ? sql`now()` : sql`now() - interval '1 hour'`}
    )`;
}

function legacyExecutionId(deliveryKey: string): string {
  return `${deliveryKey}-execution`;
}

function receiptRows(registrationId: string) {
  return sql`select delivery_key, execution_id, processing_state, attempt_count, body_digest
    from webhook_deliveries
    where registration_id = ${registrationId} order by delivery_key`;
}

function dirtySubjects(repositoryId: string) {
  return sql`select kind, github_subject_id, subject_number, generation
    from repository_reconciliation_dirty_subjects
    where repository_id = ${repositoryId} order by github_subject_id`;
}

function reconciliationJobs(repositoryId: string) {
  return sql`select id, state, attempt_count, follow_up_requested
    from repository_reconciliation_jobs
    where repository_id = ${repositoryId}`;
}

const distinctDeliveryKey = (n: number): string => sha256(`overflow-1041 distinct delivery key ${n}`);

function sha256(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}
