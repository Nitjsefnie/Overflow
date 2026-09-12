import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import { runMigrations } from "../../scripts/migrate";
import { runWebhookUpgradeCli } from "../../scripts/upgrade-webhooks";
import { startPostgresContainer, type StartedPostgres } from "../support/postgres-container";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { GitHubGateway } from "@/lib/github/client";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { encryptToken } from "@/lib/security/token-cipher";
import { POST } from "@/app/api/github/webhooks/route";
import { runNextReconciliationJob } from "@/lib/fold/reconciliation-worker";

const key = Buffer.alloc(32, 23).toString("base64url");
const originalDatabaseUrl = process.env.DATABASE_URL;
let started: StartedPostgres;
let sql: Sql;
const repositoryIds: string[] = [];
const sponsorIds: string[] = [];

beforeAll(async () => {
  started = await startPostgresContainer({ database: "hook_upgrade", user: "upgrade", password: "upgrade" });
  process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
  for (let index = 0; index < 3; index++) {
    const [sponsor] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login) values (${500 + index}, ${`sponsor-${index}`}) returning id
    `;
    sponsorIds.push(sponsor!.id);
    const [registration] = await sql<{ id: string }[]>`
      insert into registered_repositories
        (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme, active)
      values (${42 + index}, ${`old/old-${index}`}, ${sponsor!.id}, 'PUBLIC', ${81 + index}, ${sql.json(validDifficultyScheme())}, ${index < 2})
      returning id
    `;
    repositoryIds.push(registration!.id);
  }
});

afterAll(async () => {
  await closeSql();
  await started?.container.stop();
  if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = originalDatabaseUrl;
});

describe("upgrading actual persisted registrations", () => {
  it("reuses durable material after timeout, finalization failure, and queue failure", async () => {
    const [registered] = await sql<{ id: string }[]>`
      insert into registered_repositories
        (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
      values (46, 'retry/project', ${sponsorIds[0]!}, 'PUBLIC', 85, ${sql.json(validDifficultyScheme())}) returning id
    `;
    const registrations = new PostgresRepositoryStore(sql, key);
    const queue = new PostgresFoldStore(sql, key);
    let phase = "timeout";
    let remote = { id: 85, name: "web", type: "Repository", active: true,
      events: ["issues", "issue_comment", "pull_request", "pull_request_review"],
      config: { url: "https://old.test/hook", content_type: "json", insecure_ssl: "0", secret: "masked" },
    };
    const writes: Array<{ url: string; secret: string }> = [];
    const outcomes: string[] = [];
    const dependencies = {
      store: {
        listActiveRepositoryIds: async () => [registered.id],
        findActiveRepositoryById: registrations.findActiveRepositoryById.bind(registrations),
        findActiveRepositoryForgeById: registrations.findActiveRepositoryForgeById.bind(registrations),
        getGitHubAccessToken: async () => "synthetic-sponsor-token",
        getForgeToken: async () => null,
        stageWebhookCredential: registrations.stageWebhookCredential.bind(registrations),
        withWebhookUpgradeLock: registrations.withWebhookUpgradeLock.bind(registrations),
        finalizeWebhookCredential: async (credential: Parameters<typeof registrations.finalizeWebhookCredential>[0]) => {
          if (phase === "finalize") throw new Error("synthetic database failure");
          return registrations.finalizeWebhookCredential(credential);
        },
        requestRepositoryRederivation: async (id: string, at: Date) => {
          if (phase === "queue") throw new Error("synthetic queue failure");
          return queue.requestRepositoryRederivation(id, at);
        },
      },
      webhookUrls: { github: "https://overflow.test/api/github/webhooks", gitlab: "" },
      createGateway: () => new GitHubGateway({ accessToken: "synthetic-sponsor-token", fetch: async (input, init) => {
        const request = new Request(input, init);
        if (request.url.endsWith("/repositories/46")) return Response.json({ id: 46, name: "project",
          full_name: "retry/project", private: false, owner: { login: "retry" },
          html_url: "https://github.com/retry/project", permissions: { admin: true } });
        if (request.method === "PATCH") {
          const body = await request.json();
          remote = { ...remote, ...body };
          writes.push({ url: body.config.url, secret: body.config.secret });
          if (phase === "timeout") throw new Error("synthetic timeout after remote success");
        }
        return Response.json(remote);
      } }),
      createGitLabGateway: () => { throw new Error("unexpected GitLab gateway"); },
      write: (line: string) => { outcomes.push(line); },
    };
    try {
      let material: { webhook_credential_id: string; encrypted_webhook_secret: Buffer } | undefined;
      for (const step of ["timeout", "finalize", "queue", "ok"]) {
        phase = step;
        expect(await runWebhookUpgradeCli([], dependencies)).toBe(step === "ok" ? 0 : 1);
        const [row] = await sql<{ webhook_credential_id: string; encrypted_webhook_secret: Buffer; webhook_configured_at: Date | null }[]>`
          select webhook_credential_id, encrypted_webhook_secret, webhook_configured_at
          from registered_repositories where id = ${registered.id}
        `;
        material ??= { webhook_credential_id: row.webhook_credential_id, encrypted_webhook_secret: row.encrypted_webhook_secret };
        expect(row).toMatchObject(material);
        expect(row.webhook_configured_at !== null, JSON.stringify({ step, outcomes })).toBe(step === "queue" || step === "ok");
      }
      expect(writes).toHaveLength(4);
      expect(writes.every((write) => write.url === writes[0].url && write.secret === writes[0].secret)).toBe(true);
      expect(outcomes.join("\n")).not.toContain(writes[0].secret);
      expect(await sql`select reason, state from repository_reconciliation_jobs where repository_id = ${registered.id}`)
        .toEqual([{ reason: "REDERIVATION", state: "PENDING" }]);
    } finally {
      await sql`delete from repository_reconciliation_jobs where repository_id = ${registered.id}`;
      await sql`delete from registered_repositories where id = ${registered.id}`;
    }
  });

  it("persists the same dirty issue and WEBHOOK job for signed issue and comment deliveries", async () => {
    const [registered] = await sql<{ id: string }[]>`
      insert into registered_repositories
        (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
      values (45, 'comments/current', ${sponsorIds[0]!}, 'PUBLIC', 84, ${sql.json(validDifficultyScheme())}) returning id
    `;
    const previousKey = process.env.TOKEN_ENCRYPTION_KEY;
    process.env.TOKEN_ENCRYPTION_KEY = key;
    const credential = (await new PostgresRepositoryStore(sql, key).stageWebhookCredential({
      repositoryId: registered.id, provider: "github", instanceUrl: null, projectId: 45, webhookId: 84,
    }))!;
    try {
      for (const [event, action] of [["issues", "edited"], ["issue_comment", "created"], ["issue_comment", "edited"], ["issue_comment", "deleted"]]) {
        // Each delivery must create both effects itself; an earlier issue
        // event must not conceal a comment whose queue operation was skipped.
        await sql`delete from repository_reconciliation_jobs where repository_id = ${registered!.id}`;
        await sql`delete from repository_reconciliation_dirty_subjects where repository_id = ${registered!.id}`;
        const body = JSON.stringify({ action, repository: { id: 45, full_name: "comments/current" },
          issue: { id: 201, number: 11, state: "closed", labels: [], updated_at: "2026-09-08T10:00:00Z",
            title: "Issue", body: null, html_url: "https://github.com/comments/current/issues/11" },
          comment: { body: "unrelated text", user: { login: "other-author" } },
        });
        const signature = createHmac("sha256", credential.secret).update(body).digest("hex");
        const response = await POST(new Request(`https://overflow.test/api/github/webhooks?hook=${credential.credentialId}`, {
          method: "POST", body, headers: { "x-github-event": event!, "x-github-delivery": `${event}-${action}`,
            "x-hub-signature-256": `sha256=${signature}` },
        }));
        expect(response.status, `${event}/${action}`).toBe(202);
        expect(await sql`select kind, github_subject_id::int, subject_number from repository_reconciliation_dirty_subjects where repository_id = ${registered!.id}`).toEqual([
          { kind: "ISSUE", github_subject_id: 201, subject_number: 11 },
        ]);
        expect(await sql`select reason, state from repository_reconciliation_jobs where repository_id = ${registered!.id}`).toEqual([
          { reason: "WEBHOOK", state: "PENDING" },
        ]);
      }
    } finally {
      await sql`delete from repository_reconciliation_jobs where repository_id = ${registered!.id}`;
      await sql`delete from repository_reconciliation_dirty_subjects where repository_id = ${registered!.id}`;
      await sql`delete from registered_repositories where id = ${registered!.id}`;
      if (previousKey === undefined) delete process.env.TOKEN_ENCRYPTION_KEY;
      else process.env.TOKEN_ENCRYPTION_KEY = previousKey;
    }
  });

  it("enumerates only active registrations and reports missing sponsor tokens through the actual command", () => {
    const result = spawnSync("pnpm", ["--silent", "webhooks:upgrade"], {
      cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
      env: { ...process.env, NODE_OPTIONS: "", DATABASE_URL: started.databaseUrl, TOKEN_ENCRYPTION_KEY: key, GITHUB_WEBHOOK_SECRET: "" },
    });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const outcomes = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
    expect(outcomes.slice(0, -1)).toEqual(repositoryIds.slice(0, 2).sort().map((repositoryId) => ({
      repositoryId, subscription: "FAILED", queue: "NOT_ATTEMPTED", failure: "CREDENTIALS_FAILED",
    })));
    expect(outcomes.at(-1)).toEqual({ succeeded: 0, failed: 2 });
    expect(result.stderr).not.toContain("Error:");
  });

  it("decrypts each sponsor's credentials and persists one repair job per active repository across reruns", async () => {
    for (let index = 0; index < 2; index++) {
      const encrypted = Buffer.from(encryptToken(`oauth-token-${index}`, key));
      await sql`update users set encrypted_oauth_token = ${encrypted} where id = ${sponsorIds[index]!}`;
    }
    const registrations = new PostgresRepositoryStore(sql, key);
    const queue = new PostgresFoldStore(sql, key);
    const requests: { method: string; path: string; token: string | null }[] = [];
    const remoteEvents = new Map([[42, ["issues", "pull_request", "pull_request_review", "push"]], [43, ["issues", "pull_request", "pull_request_review", "push"]]]);
    const remoteUrls = new Map<number, string>();
    const lines: string[] = [];
    const dependencies = {
      store: {
        withWebhookUpgradeLock: registrations.withWebhookUpgradeLock.bind(registrations),
        stageWebhookCredential: registrations.stageWebhookCredential.bind(registrations),
        finalizeWebhookCredential: registrations.finalizeWebhookCredential.bind(registrations),
        listActiveRepositoryIds: () => queue.listActiveRepositoryIds(),
        findActiveRepositoryById: (id: string) => registrations.findActiveRepositoryById(id),
        findActiveRepositoryForgeById: (id: string) => registrations.findActiveRepositoryForgeById(id),
        getGitHubAccessToken: (id: string) => registrations.getGitHubAccessToken(id),
        getForgeToken: async () => { throw new Error("must not read a forge identity for a GitHub registration"); },
        requestRepositoryRederivation: queue.requestRepositoryRederivation.bind(queue),
      },
      webhookUrls: { github: "https://overflow.example/api/github/webhooks", gitlab: "https://overflow.example/api/gitlab/webhooks" },
      createGateway: (accessToken: string) => new GitHubGateway({ accessToken, fetch: async (input, init) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        requests.push({ method: request.method, path, token: request.headers.get("authorization") });
        const repositoryId = path.startsWith("/repositories/") ? Number(path.split("/").at(-1)) : Number(path.split("/")[3]);
        if (path.startsWith("/repositories/")) {
          return Response.json({
            id: repositoryId, name: String(repositoryId), full_name: `current/${repositoryId}`, private: false,
            owner: { login: "current" }, html_url: `https://github.com/current/${repositoryId}`, permissions: { admin: true },
          });
        }
        if (request.method === "PATCH") {
          const update = await request.json();
          remoteEvents.get(repositoryId)!.push(...update.add_events);
          remoteUrls.set(repositoryId, update.config.url);
        }
        return Response.json({
          id: repositoryId + 39, name: "web", type: "Repository", active: true,
          events: remoteEvents.get(repositoryId),
          config: { url: remoteUrls.get(repositoryId) ?? "https://overflow.example/api/github/webhooks", content_type: "json", insecure_ssl: "0", secret: "********" },
        });
      } }),
      createGitLabGateway: () => { throw new Error("must not build a GitLab gateway for a GitHub registration"); },
      write: (line: string) => { lines.push(line); },
    };
    expect(await runWebhookUpgradeCli([], dependencies)).toBe(0);
    expect(await runWebhookUpgradeCli([], dependencies)).toBe(0);
    expect(requests.filter((request) => request.method === "PATCH").sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { method: "PATCH", path: "/repos/current/42/hooks/81", token: "Bearer oauth-token-0" },
      { method: "PATCH", path: "/repos/current/42/hooks/81", token: "Bearer oauth-token-0" },
      { method: "PATCH", path: "/repos/current/43/hooks/82", token: "Bearer oauth-token-1" },
      { method: "PATCH", path: "/repos/current/43/hooks/82", token: "Bearer oauth-token-1" },
    ]);
    expect(await sql`select repository_id, reason, state, rederivation_generation::int from repository_reconciliation_jobs order by repository_id`).toEqual(
      repositoryIds.slice(0, 2).sort().map((repository_id) => ({ repository_id, reason: "REDERIVATION", state: "PENDING", rederivation_generation: 2 })),
    );
    expect(lines.map((line) => JSON.parse(line)).filter((line) => line.succeeded !== undefined)).toEqual([
      { succeeded: 2, failed: 0 }, { succeeded: 2, failed: 0 },
    ]);
    expect(lines.join("\n")).not.toMatch(/oauth-token|original-secret|encrypted/);
    const refreshes: { repositoryId: string; rederive: boolean }[] = [];
    for (let index = 0; index < 2; index++) {
      expect(await runNextReconciliationJob({
        store: queue,
        reconcile: async (repositoryId, { rederive }) => { refreshes.push({ repositoryId, rederive }); },
      })).toBe("RECONCILED");
    }
    expect(refreshes.sort((a, b) => a.repositoryId.localeCompare(b.repositoryId))).toEqual(
      repositoryIds.slice(0, 2).sort().map((repositoryId) => ({ repositoryId, rederive: true })),
    );
  });
});
