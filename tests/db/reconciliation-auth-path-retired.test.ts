import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepositoryAsSponsor } from "@/lib/fold/reconcile-as-sponsor";
import type { ReconciliationGateway } from "@/lib/fold/reconcile";
import { credentialBinding, encryptToken } from "@/lib/security/token-cipher";

/**
 * Issue 1362, item 10: a repository whose row holds
 * `reconciliation_auth_path = 'github-app-installation'`, and one registered
 * through the registration App (`registration_method = 'app'`), folds with the
 * sponsor's stored OAuth token and the stored columns keep their values: the
 * fold reads the column never, and no writer exists any more.
 */

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 9_600_000;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;
const tokenEncryptionKey = Buffer.alloc(32, 31).toString("base64url");

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "auth_path_retired", user: "auth_path_retired", password: "auth_path_retired" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});

afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.OVERFLOW_DATABASE_URL;
  else process.env.OVERFLOW_DATABASE_URL = originalDatabaseUrl;
});

afterEach(() => { vi.unstubAllGlobals(); });

const storedPathAt = new Date("2026-10-20T09:00:00Z");

async function registeredRepository(options: { storedPath?: string; registrationMethod?: "app" }): Promise<{
  repositoryId: string;
  sponsorId: string;
  oauthToken: string;
}> {
  const githubRepositoryId = externalId++;
  const ownerName = `auth-path/retired-${githubRepositoryId}`;
  const sponsorGitHubUserId = externalId++;
  const oauthToken = ["stored", "sponsor", "oauth", "token"].join("-");
  const [{ id: sponsorId }] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, encrypted_oauth_token)
    values (${sponsorGitHubUserId}, ${ownerName},
      ${Buffer.from(encryptToken(oauthToken, tokenEncryptionKey, credentialBinding.userOAuthToken(sponsorGitHubUserId)), "utf8")})
    returning id
  `;
  const difficultyScheme = {
    openingName: "Size",
    actualName: "Delivered",
    openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
  };
  const [{ id: repositoryId }] = await sql<{ id: string }[]>`
    insert into registered_repositories
      (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme,
       reconciliation_auth_path, reconciliation_auth_path_at, registration_method)
    values (${githubRepositoryId}, ${ownerName}, ${sponsorId}, 'PUBLIC',
      ${externalId++}, ${sql.json(difficultyScheme)},
      ${options.storedPath ?? null}, ${options.storedPath === undefined ? null : storedPathAt},
      ${options.registrationMethod ?? 'oauth_hook'})
    returning id
  `;
  return { repositoryId, sponsorId, oauthToken };
}

describe("repositories carrying a stored reconciliation auth path fold on the sponsor's OAuth token", () => {
  it("folds a repository whose row holds reconciliation_auth_path = 'github-app-installation' without touching the stored columns", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("the fold must not reach the forge through a fetch here");
    });
    const built: Array<{ token: string; owner: string }> = [];
    const createGateway = (token: string, owner: string): ReconciliationGateway => {
      built.push({ token, owner });
      return {
        getRepositoryById: async () => null,
        listIssues: async () => [],
        getIssue: async () => null,
        getPullRequestClosingIssues: async () => [],
        getPullRequestReviews: async () => [],
        getPullRequestDiff: async () => "",
      };
    };
    const { repositoryId, sponsorId, oauthToken } = await registeredRepository({ storedPath: "github-app-installation" });

    await expect(reconcileRepositoryAsSponsor(new PostgresFoldStore(sql, tokenEncryptionKey), repositoryId, createGateway))
      .resolves.toMatchObject({ repositoryId, skipped: false });

    expect(built).toEqual([{ token: oauthToken, owner: sponsorId }]);
    await expect(sql`
      select reconciliation_auth_path, reconciliation_auth_path_at
      from registered_repositories where id = ${repositoryId}
    `).resolves.toEqual([{ reconciliation_auth_path: "github-app-installation", reconciliation_auth_path_at: storedPathAt }]);
  });

  it("folds an app-registered repository (registration_method = 'app') without touching the stored columns", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("the fold must not reach the forge through a fetch here");
    });
    const built: Array<{ token: string; owner: string }> = [];
    const createGateway = (token: string, owner: string): ReconciliationGateway => {
      built.push({ token, owner });
      return {
        getRepositoryById: async () => null,
        listIssues: async () => [],
        getIssue: async () => null,
        getPullRequestClosingIssues: async () => [],
        getPullRequestReviews: async () => [],
        getPullRequestDiff: async () => "",
      };
    };
    const { repositoryId, sponsorId, oauthToken } = await registeredRepository({ registrationMethod: "app" });

    await expect(reconcileRepositoryAsSponsor(new PostgresFoldStore(sql, tokenEncryptionKey), repositoryId, createGateway))
      .resolves.toMatchObject({ repositoryId, skipped: false });

    expect(built).toEqual([{ token: oauthToken, owner: sponsorId }]);
    await expect(sql`
      select reconciliation_auth_path, reconciliation_auth_path_at
      from registered_repositories where id = ${repositoryId}
    `).resolves.toEqual([{ reconciliation_auth_path: null, reconciliation_auth_path_at: null }]);
  });
});
