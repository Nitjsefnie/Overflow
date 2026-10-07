import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { legacyV1Envelope, legacyV1Key } from "../support/legacy-token-envelope";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { PostgresForgeIdentityStore } from "@/lib/forge/postgres-identities-store";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { credentialBinding, encryptToken, isEnvelopeCurrent } from "@/lib/security/token-cipher";

// The real stores, migrations, and pool teardown must share this file's module
// graph, not consumers that captured another file's database mock.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

const decryptionFailure = "Unable to decrypt stored credential.";
const currentKey = Buffer.alloc(32, 41).toString("base64url");
const retiredKey = Buffer.alloc(32, 42).toString("base64url");
const originalDatabaseUrl = process.env.DATABASE_URL;

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 9_300_000;

async function insertUser(): Promise<{ id: string; githubUserId: number }> {
  const githubUserId = externalId++;
  const [row] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (${githubUserId}, ${`binding-${githubUserId}`}) returning id
  `;
  return { id: row!.id, githubUserId };
}

async function setOAuthToken(userId: string, envelope: string): Promise<void> {
  await sql`update users set encrypted_oauth_token = ${Buffer.from(envelope, "utf8")} where id = ${userId}`;
}

async function registerWithWebhook(store: PostgresRepositoryStore, sponsorId: string, secret: string) {
  const githubRepositoryId = externalId++;
  const credentialId = randomUUID();
  const created = await store.createRepository({
    githubRepositoryId,
    ownerName: `binding/repo-${githubRepositoryId}`,
    sponsorId,
    visibility: "PUBLIC",
    githubWebhookId: externalId++,
    webhookCredential: { id: credentialId, secret },
    difficultyScheme: validDifficultyScheme(),
  });
  return { repositoryId: created!.id, credentialId };
}

describe("stored credentials are bound to their row", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "binding", user: "binding", password: "binding" });
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

  it("refuses a webhook secret copied into another repository's row", async () => {
    const store = new PostgresRepositoryStore(sql, currentKey, "");
    const sponsor = await insertUser();
    const source = await registerWithWebhook(store, sponsor.id, "source-secret");
    const target = await registerWithWebhook(store, sponsor.id, "target-secret");

    await expect(store.findWebhookCredential(target.credentialId, "github"))
      .resolves.toMatchObject({ secret: "target-secret" });
    await sql`
      update registered_repositories
      set encrypted_webhook_secret = (select encrypted_webhook_secret from registered_repositories where id = ${source.repositoryId})
      where id = ${target.repositoryId}
    `;

    await expect(store.findWebhookCredential(target.credentialId, "github")).rejects.toThrow(decryptionFailure);
    await expect(store.findWebhookCredential(source.credentialId, "github"))
      .resolves.toMatchObject({ secret: "source-secret" });
  });

  it("refuses an OAuth token copied into another user's row through both stores", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    await setOAuthToken(owner.id, encryptToken("owner-token", currentKey,
      credentialBinding.userOAuthToken(owner.githubUserId)));
    await sql`
      update users set encrypted_oauth_token = (select encrypted_oauth_token from users where id = ${owner.id})
      where id = ${other.id}
    `;
    const repositories = new PostgresRepositoryStore(sql, currentKey, "");
    const fold = new PostgresFoldStore(sql, currentKey, undefined, "");

    await expect(repositories.getGitHubAccessToken(owner.id)).resolves.toBe("owner-token");
    await expect(fold.getGitHubAccessToken(owner.id)).resolves.toBe("owner-token");
    await expect(repositories.getGitHubAccessToken(other.id)).rejects.toThrow(decryptionFailure);
    await expect(fold.getGitHubAccessToken(other.id)).rejects.toThrow(decryptionFailure);
  });

  it("refuses a forge token copied into another identity's row", async () => {
    const owner = await insertUser();
    const other = await insertUser();
    const store = new PostgresForgeIdentityStore(sql, currentKey, "");
    const instanceUrl = "https://binding.example.com";
    const identity = { provider: "gitlab", instanceUrl, forgeLogin: "binder" };
    const owned = await store.upsertIdentity({ ...identity, userId: owner.id, forgeUserId: 71,
      encryptedToken: encryptToken("owner-pat", currentKey, credentialBinding.forgeToken({ ...identity, forgeUserId: 71 })) });
    await store.upsertIdentity({ ...identity, userId: other.id, forgeUserId: 72,
      encryptedToken: encryptToken("other-pat", currentKey, credentialBinding.forgeToken({ ...identity, forgeUserId: 72 })) });

    await expect(store.getForgeToken(owner.id, instanceUrl)).resolves.toEqual({ token: "owner-pat", identityId: owned!.id });
    await sql`
      update user_forge_identities
      set encrypted_token = (select encrypted_token from user_forge_identities where user_id = ${other.id})
      where id = ${owned!.id}
    `;

    await expect(store.getForgeToken(owner.id, instanceUrl)).rejects.toThrow(decryptionFailure);
    await expect(store.getForgeToken(other.id, instanceUrl)).resolves.toMatchObject({ token: "other-pat" });
  });

  it("refuses a pre-change v1 credential stored in a row, whatever key or column holds it", async () => {
    const user = await insertUser();
    await setOAuthToken(user.id, legacyV1Envelope);

    await expect(new PostgresRepositoryStore(sql, legacyV1Key, "").getGitHubAccessToken(user.id))
      .rejects.toThrow(decryptionFailure);
    await expect(new PostgresFoldStore(sql, currentKey, undefined, legacyV1Key).getGitHubAccessToken(user.id))
      .rejects.toThrow(decryptionFailure);

    const forgeOwner = await insertUser();
    await sql`
      insert into user_forge_identities
        (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token, verified_at)
      values (${forgeOwner.id}, 'gitlab', 'https://legacy.example.com', 73, 'legacy',
        ${Buffer.from(legacyV1Envelope, "utf8")}, now())
    `;
    await expect(new PostgresForgeIdentityStore(sql, currentKey, legacyV1Key)
      .getForgeToken(forgeOwner.id, "https://legacy.example.com")).rejects.toThrow(decryptionFailure);
  });

  it("seals new webhook secrets under the current key only while a previous key is configured", async () => {
    const sponsor = await insertUser();
    const store = new PostgresRepositoryStore(sql, currentKey, retiredKey);
    const created = await registerWithWebhook(store, sponsor.id, "rotation-window");
    const staged = await registerWithWebhook(store, sponsor.id, "unused");
    await sql`update registered_repositories set webhook_credential_id = null, encrypted_webhook_secret = null,
      webhook_configured_at = null where id = ${staged.repositoryId}`;
    const [target] = await sql<{ github_repository_id: string; github_webhook_id: string }[]>`
      select github_repository_id, github_webhook_id from registered_repositories where id = ${staged.repositoryId}`;
    await store.stageWebhookCredential({ repositoryId: staged.repositoryId, provider: "github", instanceUrl: null,
      projectId: Number(target!.github_repository_id), webhookId: Number(target!.github_webhook_id) });

    const rows = await sql<{ encrypted_webhook_secret: Buffer }[]>`
      select encrypted_webhook_secret from registered_repositories where id in ${sql([created.repositoryId, staged.repositoryId])}`;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(isEnvelopeCurrent(Buffer.from(row.encrypted_webhook_secret).toString("utf8"), currentKey)).toBe(true);
    }
  });

  it("reads a credential sealed under the previous key after the current key rotates", async () => {
    const sponsor = await insertUser();
    const sealed = await registerWithWebhook(new PostgresRepositoryStore(sql, retiredKey, ""), sponsor.id, "pre-rotation");

    await expect(new PostgresRepositoryStore(sql, currentKey, "").findWebhookCredential(sealed.credentialId, "github"))
      .rejects.toThrow(decryptionFailure);
    await expect(new PostgresRepositoryStore(sql, currentKey, retiredKey).findWebhookCredential(sealed.credentialId, "github"))
      .resolves.toMatchObject({ secret: "pre-rotation" });
  });
});
