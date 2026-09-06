import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createGitHubWebhookPostHandler } from "@/app/api/github/webhooks/route";
import type { ClaimedReconciliationJob, ReconciliationJobReason } from "@/lib/fold/reconciliation-jobs";
import { drainReconciliationJobs, type ReconciliationWorkerStore } from "@/lib/fold/reconciliation-worker";
import { processWebhook, type WebhookDeliveryStore } from "@/lib/webhooks/processor";
import { guardedRequests, useTrustedOrigin } from "../support/trusted-origin";

/**
 * The wiring these two tests cover is the production `POST` handlers' own
 * dependency construction, which no other suite reaches: every route test above
 * supplies its own dependencies and so cannot see what the real ones pass.
 */

const { enqueued, readSession, registerRepositoryMock } = vi.hoisted(() => ({
  enqueued: [] as { repositoryId: string; reason: string }[],
  readSession: vi.fn(),
  registerRepositoryMock: vi.fn(),
}));

vi.mock("@/auth", () => ({ auth: readSession }));
vi.mock("@/lib/db/client", () => ({ getSql: () => vi.fn() }));
vi.mock("@/lib/fold/postgres-store", () => ({
  PostgresFoldStore: class {
    async claimDelivery() {
      return { status: "CLAIMED" as const, leaseToken: "lease-1" };
    }
    async findRepositoryByGitHubId() {
      return { id: "repository-from-webhook", active: true };
    }
    async markProcessed() {
      return true;
    }
    async markFailed() {
      return true;
    }
    async enqueueReconciliationJob(repositoryId: string, reason: ReconciliationJobReason) {
      enqueued.push({ repositoryId, reason });
    }
  },
}));
vi.mock("@/lib/repositories/postgres-store", () => ({
  PostgresRepositoryStore: class {
    async getGitHubAccessToken() {
      return "sponsor-token";
    }
    async getEnforcementState() {
      return "ACTIVE" as const;
    }
  },
}));
vi.mock("@/lib/repositories/register", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/repositories/register")>()),
  registerRepository: registerRepositoryMock,
}));

const secret = "webhook-secret";

useTrustedOrigin();

beforeEach(() => {
  enqueued.length = 0;
  readSession.mockReset();
  registerRepositoryMock.mockReset();
});

describe("production reconciliation wiring", () => {
  it("records the reason each route's own dependencies enqueue with", async () => {
    const { POST: postWebhook } = await import("@/app/api/github/webhooks/route");
    const { POST: postRepository } = await import("@/app/api/repositories/route");
    vi.stubEnv("GITHUB_WEBHOOK_SECRET", secret);
    vi.stubEnv("GITHUB_WEBHOOK_URL", "https://overflow.example/api/github/webhooks");
    readSession.mockResolvedValue({ user: { id: "member-1", role: "MEMBER" } });
    registerRepositoryMock.mockImplementation(
      async (dependencies: { scheduleInitialImport?: (id: string) => Promise<unknown> }) => {
        await dependencies.scheduleInitialImport?.("repository-from-registration");
        return { id: "repository-from-registration", initialImportScheduled: true };
      },
    );

    const webhookResponse = await postWebhook(webhookRequest());
    const registrationResponse = await postRepository(registrationRequest());

    expect([webhookResponse.status, registrationResponse.status]).toEqual([202, 201]);
    // A swap between two valid members of the reason union compiles, so the
    // pairing of route to literal is what this asserts.
    expect(enqueued).toEqual([
      { repositoryId: "repository-from-webhook", reason: "WEBHOOK" },
      { repositoryId: "repository-from-registration", reason: "REGISTRATION" },
    ]);
  });

  it("folds and completes the job a webhook delivery enqueued", async () => {
    const store = createQueueingStore();
    const folded: string[] = [];
    const route = createGitHubWebhookPostHandler({
      secret,
      processWebhook: (delivery) =>
        processWebhook(
          {
            store,
            enqueueReconciliation: (repositoryId) =>
              store.enqueueReconciliationJob(repositoryId, "WEBHOOK"),
          },
          delivery,
        ),
    });

    const response = await route(webhookRequest());
    // Nothing folds inside the request: the fold is the worker's, on the job the
    // delivery left behind.
    expect([response.status, folded]).toEqual([202, []]);

    await expect(
      drainReconciliationJobs({
        store,
        reconcile: async (repositoryId) => {
          folded.push(repositoryId);
        },
      }),
    ).resolves.toEqual(["RECONCILED"]);

    expect(folded).toEqual(["repository-from-webhook"]);
    expect(store.completed).toEqual(["repository-from-webhook"]);
    expect(store.outstanding()).toEqual([]);
  });
});

function webhookRequest(): Request {
  const body = JSON.stringify({
    action: "closed",
    repository: { id: 42, full_name: "octo/example" },
  });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  return new Request("https://overflow.test/api/github/webhooks", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-github-event": "pull_request",
      "x-github-delivery": "delivery-wiring",
      "x-hub-signature-256": `sha256=${signature}`,
    },
    body,
  });
}

function registrationRequest(): Request {
  return guardedRequests("/api/repositories").json({
    repositoryUrl: "https://github.com/octo/example",
    openingName: "Size",
    actualName: "Delivered",
    openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
    actualLabels: [{ label: "delivered/1", points: 1 }],
  });
}

/**
 * A queue and a delivery log in one object, because the point of the test using
 * it is that the row the webhook writes is the row the worker reads.
 */
function createQueueingStore() {
  const pending: { repositoryId: string; reason: ReconciliationJobReason; leaseToken: string | null }[] = [];
  const completed: string[] = [];

  const store: WebhookDeliveryStore &
    ReconciliationWorkerStore & {
      enqueueReconciliationJob(repositoryId: string, reason: ReconciliationJobReason): Promise<void>;
      completed: string[];
      outstanding(): string[];
    } = {
    completed,
    outstanding: () => pending.map((job) => job.repositoryId),
    async claimDelivery() {
      return { status: "CLAIMED" as const, leaseToken: "delivery-lease" };
    },
    async findRepositoryByGitHubId() {
      return { id: "repository-from-webhook", active: true };
    },
    async markProcessed() {
      return true;
    },
    async markFailed() {
      return true;
    },
    async enqueueReconciliationJob(repositoryId, reason) {
      // One row per repository, as the table's unique constraint enforces.
      if (!pending.some((job) => job.repositoryId === repositoryId)) {
        pending.push({ repositoryId, reason, leaseToken: null });
      }
    },
    async claimNextReconciliationJob(): Promise<ClaimedReconciliationJob | null> {
      const job = pending.find((candidate) => candidate.leaseToken === null);
      if (job === undefined) {
        return null;
      }
      job.leaseToken = `lease-${job.repositoryId}`;
      return {
        id: `job-${job.repositoryId}`,
        repositoryId: job.repositoryId,
        reason: job.reason,
        attemptCount: 1,
        leaseToken: job.leaseToken,
      };
    },
    async completeReconciliationJob(jobId, leaseToken) {
      const index = pending.findIndex(
        (job) => `job-${job.repositoryId}` === jobId && job.leaseToken === leaseToken,
      );
      if (index === -1) {
        return false;
      }
      completed.push(pending[index]!.repositoryId);
      pending.splice(index, 1);
      return true;
    },
    async deferReconciliationJob() {
      return true;
    },
    async retryReconciliationJob() {
      return true;
    },
    async failReconciliationJob() {
      return true;
    },
    async getReconciliationCooldown() {
      return null;
    },
  };

  return store;
}
