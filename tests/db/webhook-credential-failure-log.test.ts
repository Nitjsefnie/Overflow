import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { createGitHubWebhookPostHandler } from "@/app/api/github/webhooks/route";
import { createGitLabWebhookPostHandler } from "@/app/api/gitlab/webhooks/route";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import type { WebhookCredentialLookup } from "@/lib/webhooks/credentials";
import { logField } from "@/lib/webhooks/log-field";
import { startPostgresContainer } from "../support/postgres-container";
import { validDifficultyScheme } from "../support/difficulty-scheme";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;

// Issue 1057: the envelope shape the issue seeds — parseable as text, not a
// valid v2 envelope — so the store's decrypt inside the credential lookup
// throws and the route's catch answers the 503.
const INVALID_ENVELOPE = "v2.garbage.not-a-valid-envelope";

// The same key material the upgrade suite drives the real store with: the
// store decrypts the seeded envelope under it and fails deterministically.
const KEY = Buffer.alloc(32, 23).toString("base64url");

describe.each(["github", "gitlab"] as const)("%s receiver journals an unreadable credential", (provider) => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "credential_journal", user: "credential_journal", password: "credential_journal" });
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

  it("answers 503 and journals the phase, the encoded selector and the error class only", async () => {
    const selector = randomUUID();
    await seedCredentialRow(provider, selector);
    const store = new PostgresRepositoryStore(sql, KEY);
    const route = createRoute(provider, (inner, expected) => store.findWebhookCredential(inner, expected));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    let response: Response;
    try {
      response = await route(bareRequest(provider, selector));
    } finally {
      errorSpy.mockRestore();
    }

    expect(response.status).toBe(503);
    // The journal line is the issue's demand: the phase, the selector encoded
    // through logField, and the error's class name — never the message, which
    // for a decrypt failure names material.
    expect(errorSpy).toHaveBeenCalledExactlyOnceWith(
      `Webhook credential lookup failed (phase credential lookup, selector ${logField(selector)},`
        + ` error ${logField("Error")}); answered 503 so the forge retries.`,
    );
    expect(await receiptCount()).toBe(0);
  });

  it("bounds the line per selector: one detail, counted silence inside the quiet window", async () => {
    const selector = randomUUID();
    await seedCredentialRow(provider, selector);
    const store = new PostgresRepositoryStore(sql, KEY);
    const route = createRoute(provider, (inner, expected) => store.findWebhookCredential(inner, expected));
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      for (let i = 0; i < 4; i += 1) {
        expect((await route(bareRequest(provider, selector))).status).toBe(503);
      }
    } finally {
      errorSpy.mockRestore();
    }

    // The FailureLogger bounds the site: the first failure prints in full, the
    // rest inside the quiet window count silently (issue 661's bound).
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// harness

async function seedCredentialRow(provider: "github" | "gitlab", selector: string): Promise<string> {
  const [sponsor] = await sql`insert into users (github_user_id, github_login)
    values (${nextExternalId()}, ${`credential-journal-${randomUUID()}`}) returning id`;
  const [row] = await sql`insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme,
      webhook_credential_id, encrypted_webhook_secret, provider, instance_url, forge_project_id
    )
    values (
      ${nextExternalId()}, ${`journal/project-${randomUUID()}`}, ${sponsor!.id}, 'PUBLIC', ${nextExternalId()},
      ${sql.json(validDifficultyScheme())}, ${selector}::uuid, ${INVALID_ENVELOPE}::bytea,
      ${provider}, ${provider === "gitlab" ? "https://gitlab.example.com" : null},
      ${provider === "gitlab" ? nextExternalId() : null}
    )
    returning github_repository_id`;
  return String(row!.github_repository_id);
}

let externalId = 7_000_000;

function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

function createRoute(
  provider: "github" | "gitlab",
  lookupCredential: WebhookCredentialLookup,
): (request: Request) => Promise<Response> {
  const dependencies = {
    checkRateLimit: () => true,
    lookupCredential,
    // Unreachable in this suite: a delivery whose credential cannot be read
    // is refused before the body is parsed.
    processWebhook: async (): Promise<never> => {
      throw new Error("a delivery with an unreadable credential never reaches processing");
    },
  };
  return provider === "github"
    ? createGitHubWebhookPostHandler(dependencies)
    : createGitLabWebhookPostHandler(dependencies);
}

function bareRequest(provider: "github" | "gitlab", selector: string): Request {
  const url = `https://overflow.test/api/${provider}/webhooks?hook=${selector}`;
  return provider === "github"
    ? new Request(url, { method: "POST", body: "{}", headers: {
        "x-github-event": "issues", "x-github-delivery": randomUUID(), "x-hub-signature-256": "sha256=00",
      } })
    : new Request(url, { method: "POST", body: "{}", headers: {
        "x-gitlab-event": "Issue Hook", "x-gitlab-token": "anything", "x-gitlab-webhook-uuid": randomUUID(),
      } });
}

async function receiptCount(): Promise<number> {
  const [row] = await sql`select count(*)::int as count from webhook_deliveries`;
  return row!.count;
}
