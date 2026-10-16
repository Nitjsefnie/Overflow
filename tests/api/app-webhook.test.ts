import { createHash, createHmac, randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { createGitHubAppWebhookPostHandler, POST, type GitHubAppWebhookRouteDependencies } from "@/app/api/github/app-webhook/route";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { PostgresWebhookDeliveryStore } from "@/lib/webhooks/postgres-delivery-store";
import { processWebhook } from "@/lib/webhooks/processor";
import { parseGitHubWebhookDeliveryDetailed } from "@/lib/github/webhook-schema";
import { WEBHOOK_RATE_LIMIT_CAPACITY } from "@/lib/webhooks/rate-limit";
import { runMigrations } from "../../scripts/migrate";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";
import { webhookCredential } from "../support/webhook-credential";

vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

const secret = webhookCredential("github").secret;
const limit = 25 * 1024 * 1024;
let sql: Sql;
let container: StartedTestContainer | undefined;
let dependencies: GitHubAppWebhookRouteDependencies;
const originalDatabaseUrl = process.env.DATABASE_URL;

function request(body = payload(), overrides: Record<string, string | null> = {}): Request {
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  const headers = new Headers({
    "x-github-event": "pull_request", "x-github-delivery": randomUUID(),
    "x-hub-signature-256": `sha256=${signature}`,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) headers.delete(key);
    else headers.set(key, value);
  }
  return new Request("https://overflow.test/api/github/app-webhook", { method: "POST", body, headers });
}

function payload(repositoryId = 42, fullName = "owner/project"): string {
  return JSON.stringify({ action: "closed", repository: { id: repositoryId, full_name: fullName },
    pull_request: { id: 201, number: 11 } });
}

async function fixture(oauthHook = false) {
  const result = await materializeRepositoryFixture(sql);
  const [row] = await sql`update registered_repositories set registration_method = ${oauthHook ? "oauth_hook" : "app"}
    where id = ${result.repositoryId} returning github_repository_id`;
  return { ...result, githubId: Number(row.github_repository_id) };
}

async function effects(repositoryId?: string) {
  return {
    receipts: await sql`select * from webhook_deliveries where ${repositoryId ?? null}::uuid is null or registration_id = ${repositoryId ?? null}`,
    jobs: await sql`select * from repository_reconciliation_jobs where ${repositoryId ?? null}::uuid is null or repository_id = ${repositoryId ?? null}`,
    subjects: await sql`select * from repository_reconciliation_dirty_subjects where ${repositoryId ?? null}::uuid is null or repository_id = ${repositoryId ?? null}`,
  };
}

describe("registration App webhook receiver", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "app_webhook", user: "app_webhook" });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
    const repositoryStore = new PostgresRepositoryStore(sql);
    const store = new PostgresWebhookDeliveryStore(sql);
    dependencies = {
      secret, checkRateLimit: () => true,
      findActiveAppRegistrationByGitHubRepositoryId: (id) => repositoryStore.findActiveAppRegistrationByGitHubRepositoryId(id),
      processWebhook: (delivery, scope) => processWebhook({ store,
        enqueueReconciliation: (id, event) => store.enqueueWebhookReconciliation(id, event),
      }, delivery, scope),
    };
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it.each([
    { signature: null, status: 400 },
    { signature: "sha256=" + "0".repeat(64), status: 401 },
  ])("rejects missing or invalid signatures ($status) without effects", async ({ signature, status }) => {
    const before = await effects();
    const response = await createGitHubAppWebhookPostHandler(dependencies)(request(payload(), { "x-hub-signature-256": signature }));
    expect(response.status).toBe(status);
    expect(await effects()).toEqual(before);
  });

  it("authenticates the raw bytes before parsing or ignoring events", async () => {
    const response = await createGitHubAppWebhookPostHandler(dependencies)(request("{", {
      "x-github-event": "ping", "x-hub-signature-256": "sha256=" + "0".repeat(64),
    }));
    expect(response.status).toBe(401);
  });

  it.each([undefined, ""])("fails closed with secret %j for every delivery and bounds the outage log", async (missing) => {
    vi.stubEnv("GITHUB_REGISTRATION_APP_WEBHOOK_SECRET", missing);
    vi.stubEnv("GITHUB_APP_WEBHOOK_SECRET", secret);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const before = await effects();
    for (const req of [request(), new Request("https://overflow.test/api/github/app-webhook", { method: "POST" }),
      request("{", { "x-github-event": "ping" })]) {
      expect((await POST(req)).status).toBe(503);
    }
    expect(logged.mock.calls.length).toBeLessThanOrEqual(1);
    if (missing === undefined) expect(logged).toHaveBeenCalledTimes(1);
    for (const call of logged.mock.calls) {
      expect(call).toHaveLength(1);
      expect(String(call[0])).not.toMatch(/[\r\n]/);
      expect(String(call[0]).length).toBeLessThan(500);
    }
    expect(await effects()).toEqual(before);
  });

  it("declines at the rate gate before touching headers or body", async () => {
    const req = request();
    Object.defineProperties(req, {
      headers: { get() { throw new Error("headers touched"); } },
      body: { get() { throw new Error("body touched"); } },
    });
    const response = await createGitHubAppWebhookPostHandler({ ...dependencies, secret: undefined, checkRateLimit: () => false })(req);
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("1");
  });

  it.each(["installation", "installation_repositories", "ping", "unrecognized"])("ignores signed %s before JSON parsing", async (event) => {
    const before = await effects();
    expect((await createGitHubAppWebhookPostHandler(dependencies)(request("{", { "x-github-event": event }))).status).toBe(204);
    expect(await effects()).toEqual(before);
  });

  it.each(["{", "{}", JSON.stringify({ action: "closed", repository: { id: 42, full_name: "owner/project" } })])(
    "rejects invalid supported-event payload %s", async (body) => {
      expect((await createGitHubAppWebhookPostHandler(dependencies)(request(body))).status).toBe(400);
    },
  );

  it("preserves parsed-but-ignored semantics", async () => {
    const body = JSON.stringify({ action: "ready_for_review", repository: { id: 42, full_name: "owner/project" } });
    const before = await effects();
    expect((await createGitHubAppWebhookPostHandler(dependencies)(request(body))).status).toBe(204);
    expect(await effects()).toEqual(before);
  });

  it("rejects a declared oversize without reading the body", async () => {
    const req = request(payload(), { "content-length": String(limit + 1) });
    Object.defineProperty(req, "body", { get() { throw new Error("oversized body touched"); } });
    expect((await createGitHubAppWebhookPostHandler(dependencies)(req)).status).toBe(413);
  });

  it.each([limit, limit + 1])("enforces the strict-greater 25 MiB streamed boundary: %i", async (bytes) => {
    const body = payload().padEnd(bytes, " ");
    expect((await createGitHubAppWebhookPostHandler(dependencies)(request(body))).status).toBe(bytes === limit ? 204 : 413);
  });

  it.each(["missing", "oauth_hook", "unregistered", "inactive", "gitlab"])("ignores %s registrations with zero processing effects", async (state) => {
    const repo = await fixture(state === "oauth_hook");
    if (state === "unregistered") await sql`update registered_repositories set unregistered_at = now(), active = false where id = ${repo.repositoryId}`;
    if (state === "inactive") await sql`update registered_repositories set active = false where id = ${repo.repositoryId}`;
    if (state === "gitlab") await sql`update registered_repositories set provider = 'gitlab' where id = ${repo.repositoryId}`;
    const before = await effects();
    const response = await createGitHubAppWebhookPostHandler(dependencies)(request(payload(state === "missing" ? 42 : repo.githubId)));
    expect(response.status).toBe(204);
    expect(await effects()).toEqual(before);
  });

  it("binds the payload repository id to the found UUID and records issue, queue and scoped receipt effects", async () => {
    const repo = await fixture();
    const decoy = await fixture();
    const issue = repo.fold.issues[0];
    const body = JSON.stringify({ action: "edited", repository: { id: repo.githubId, full_name: `renamed/${decoy.githubId}` },
      issue: { id: issue.githubIssueId, number: issue.number, title: "App webhook update", state: "open",
        updated_at: "2026-10-15T00:00:00Z", body: null, html_url: "https://github.com/renamed/project/issues/1" } });
    const req = request(body, { "x-github-event": "issues" });
    const deliveryId = req.headers.get("x-github-delivery");
    expect((await createGitHubAppWebhookPostHandler(dependencies)(req)).status).toBe(202);
    const recorded = await effects(repo.repositoryId);
    expect(recorded.receipts).toMatchObject([{ provider: "github", registration_id: repo.repositoryId,
      delivery_key: deliveryId, processing_state: "PROCESSED", body_digest: createHash("sha256").update(body).digest("hex") }]);
    expect(recorded.jobs).toHaveLength(1);
    expect(recorded.subjects).toMatchObject([{ repository_id: repo.repositoryId, kind: "ISSUE" }]);
    const [updated] = await sql`select title, state from issues where repository_id = ${repo.repositoryId} and github_issue_id = ${issue.githubIssueId}`;
    expect(updated).toEqual({ title: "App webhook update", state: "OPEN" });
    expect(await effects(decoy.repositoryId)).toEqual({ receipts: [], jobs: [], subjects: [] });
    // Fresh delivery id over the same signed bytes must reuse the processed receipt.
    expect((await createGitHubAppWebhookPostHandler(dependencies)(request(body, { "x-github-event": "issues" }))).status).toBe(202);
    expect(await effects(repo.repositoryId)).toEqual(recorded);
  });

  it("answers a live receipt lease with 503 and a bounded warning", async () => {
    const repo = await fixture();
    const body = payload(repo.githubId);
    const req = request(body);
    const parsed = parseGitHubWebhookDeliveryDetailed("pull_request", req.headers.get("x-github-delivery"), JSON.parse(body));
    if (parsed.status !== "ok") throw new Error("invalid test delivery");
    const store = new PostgresWebhookDeliveryStore(sql);
    expect((await store.claimDelivery(parsed.delivery, { provider: "github", registrationId: repo.repositoryId,
      bodyDigest: createHash("sha256").update(body).digest("hex") })).status).toBe("CLAIMED");
    const before = await effects(repo.repositoryId);
    const warned = vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await createGitHubAppWebhookPostHandler(dependencies)(req);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(await effects(repo.repositoryId)).toEqual(before);
    expect(warned).toHaveBeenCalledTimes(1);
    expect(String(warned.mock.calls[0][0])).not.toMatch(/[\r\n]/);
  });

  it("returns 503 for processing failure with a failed receipt and bounded single-line logs", async () => {
    const repo = await fixture();
    const store = new PostgresWebhookDeliveryStore(sql);
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await createGitHubAppWebhookPostHandler({ ...dependencies,
      processWebhook: (delivery, scope) => processWebhook({ store,
        enqueueReconciliation: async () => { throw new Error("unsafe\n\u001b" + "x".repeat(10_000)); },
      }, delivery, scope),
    })(request(payload(repo.githubId, "owner/unsafe\n\u001b" + "z".repeat(10_000))));
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect((await effects(repo.repositoryId)).receipts).toMatchObject([{ processing_state: "FAILED" }]);
    expect(logged).toHaveBeenCalledTimes(1);
    expect(logged.mock.calls[0]).toHaveLength(2);
    for (const token of logged.mock.calls[0]) {
      expect(typeof token).toBe("string");
      expect(String(token)).not.toMatch(/[\r\n\u001b]/);
      expect(String(token).length).toBeLessThan(2000);
    }
  });

  it("returns a bounded retry response when registration lookup fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const response = await createGitHubAppWebhookPostHandler({ ...dependencies,
      findActiveAppRegistrationByGitHubRepositoryId: async () => { throw new Error("private database details"); },
    })(request());
    expect(response.status).toBe(503);
    expect(await response.text()).toBe("");
    expect(logged).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logged.mock.calls)).not.toContain("private database details");
  });

  it("production POST uses the registration secret, real stores and a persistent receiver bucket", async () => {
    const repo = await fixture();
    vi.stubEnv("GITHUB_REGISTRATION_APP_WEBHOOK_SECRET", secret);
    vi.spyOn(Date, "now").mockReturnValue(Date.now());
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const responses: number[] = [];
    for (let index = 0; index <= WEBHOOK_RATE_LIMIT_CAPACITY; index++) {
      responses.push((await POST(request(payload(repo.githubId)))).status);
    }
    expect(responses).toContain(202);
    expect(responses.at(-1)).toBe(429);
    expect((await effects(repo.repositoryId)).receipts).toHaveLength(1);
    expect(logged).toHaveBeenCalledTimes(1);
  });
});
