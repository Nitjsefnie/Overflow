import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import {
  postgresCredentialStore,
  runCredentialReencryptionCli,
  type CredentialStore,
} from "../../scripts/reencrypt-credentials";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { legacyV1Envelope, legacyV1Key, legacyV1Plaintext } from "../support/legacy-token-envelope";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresForgeIdentityStore } from "@/lib/forge/postgres-identities-store";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { credentialBinding, encryptToken, type TokenKeySet } from "@/lib/security/token-cipher";

// The real stores, migrations, and pool teardown must share this file's module
// graph, not consumers that captured another file's database mock.
vi.hoisted(() => { vi.resetModules(); });
afterAll(() => { vi.resetModules(); });

const currentKey = Buffer.alloc(32, 51).toString("base64url");
const previousKey = legacyV1Key;
const unknownKey = Buffer.alloc(32, 53).toString("base64url");
const keys: TokenKeySet = { current: currentKey, previous: previousKey };
const originalDatabaseUrl = process.env.DATABASE_URL;
const instanceUrl = "https://reencrypt.example.com";

let container: StartedTestContainer | undefined;
let databaseUrl: string;
let sql: Sql;
let externalId = 9_400_000;

/** The key id, derived here from the envelope contract rather than through the cipher module. */
function keyIdOf(key: string): string {
  return createHash("sha256").update("overflow-token-key-id:v2:", "utf8").update(Buffer.from(key, "base64url"))
    .digest().subarray(0, 8).toString("base64url");
}

type Snapshot = Map<string, string | null>;

async function snapshot(): Promise<Snapshot> {
  const rows = await sql<{ key: string; envelope: Buffer | null }[]>`
    select 'users:' || id as key, encrypted_oauth_token as envelope from users
    union all select 'user_forge_identities:' || id, encrypted_token from user_forge_identities
    union all select 'registered_repositories:' || id, encrypted_webhook_secret from registered_repositories
  `;
  return new Map(rows.map((row) => [row.key, row.envelope === null ? null : Buffer.from(row.envelope).toString("utf8")]));
}

async function insertUser(envelope: ((githubUserId: number) => string) | null) {
  const githubUserId = externalId++;
  const encrypted = envelope === null ? null : Buffer.from(envelope(githubUserId), "utf8");
  const [row] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, encrypted_oauth_token)
    values (${githubUserId}, ${`reencrypt-${githubUserId}`}, ${encrypted}) returning id
  `;
  return { id: row!.id, githubUserId };
}

async function insertForgeIdentity(userId: string, envelope: (forgeUserId: number) => string) {
  const forgeUserId = externalId++;
  const [row] = await sql<{ id: string }[]>`
    insert into user_forge_identities
      (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token, verified_at)
    values (${userId}, 'gitlab', ${instanceUrl}, ${forgeUserId}, ${`forge-${forgeUserId}`},
      ${Buffer.from(envelope(forgeUserId), "utf8")}, now())
    returning id
  `;
  return { id: row!.id, forgeUserId };
}

async function registerRepository(sealingKey: string, sponsorId: string, secret: string | null) {
  const githubRepositoryId = externalId++;
  const credentialId = randomUUID();
  const created = await new PostgresRepositoryStore(sql, sealingKey, "").createRepository({
    githubRepositoryId,
    ownerName: `reencrypt/repo-${githubRepositoryId}`,
    sponsorId,
    visibility: "PUBLIC",
    githubWebhookId: externalId++,
    webhookCredential: secret === null ? null : { id: credentialId, secret },
    difficultyScheme: validDifficultyScheme(),
  });
  return { id: created!.id, credentialId };
}

/** One of every stored shape: v1, v2 under the previous key, v2 under the current key, and NULL. */
async function seedMixedRows() {
  const legacyUser = await insertUser(() => legacyV1Envelope);
  const previousUser = await insertUser((id) =>
    encryptToken("previous-oauth", previousKey, credentialBinding.userOAuthToken(id)));
  const currentUser = await insertUser((id) =>
    encryptToken("current-oauth", currentKey, credentialBinding.userOAuthToken(id)));
  const emptyUser = await insertUser(null);
  const legacyForge = await insertForgeIdentity(legacyUser.id, () => legacyV1Envelope);
  const previousForge = await insertForgeIdentity(previousUser.id, (forgeUserId) =>
    encryptToken("previous-pat", previousKey, credentialBinding.forgeToken({ provider: "gitlab", instanceUrl, forgeUserId })));
  const previousRepository = await registerRepository(previousKey, currentUser.id, "previous-secret");
  const currentRepository = await registerRepository(currentKey, currentUser.id, "current-secret");
  const emptyRepository = await registerRepository(currentKey, currentUser.id, null);
  const legacyRepository = await registerRepository(currentKey, currentUser.id, "replaced-by-legacy");
  await sql`update registered_repositories set encrypted_webhook_secret = ${Buffer.from(legacyV1Envelope, "utf8")}
    where id = ${legacyRepository.id}`;
  return {
    legacyUser, previousUser, currentUser, emptyUser, legacyForge, previousForge,
    previousRepository, currentRepository, emptyRepository, legacyRepository,
  };
}

async function run(
  argumentsList: readonly string[],
  options: { keys?: TokenKeySet; store?: CredentialStore; batchSize?: number } = {},
) {
  const lines: string[] = [];
  const code = await runCredentialReencryptionCli(argumentsList, {
    store: options.store ?? postgresCredentialStore(sql),
    keys: options.keys ?? keys,
    batchSize: options.batchSize,
    write: (line) => { lines.push(line); },
  });
  return { code, lines, output: lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

function summary(table: string, column: string, reencrypted: number, alreadyCurrent: number, skipped = 0, failed = 0) {
  return { table, column, reencrypted, alreadyCurrent, skipped, failed };
}

function checkSummary(table: string, column: string, current: number, notCurrent: number) {
  return { table, column, current, notCurrent };
}

describe("re-encrypting stored credentials under the current key", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "reencrypt", user: "reencrypt", password: "reencrypt" });
    container = started.container;
    databaseUrl = started.databaseUrl;
    process.env.DATABASE_URL = databaseUrl;
    sql = getSql();
    await runMigrations();
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  beforeEach(async () => {
    await sql`truncate users, user_forge_identities, registered_repositories cascade`;
  });

  it("reports what is not yet current under --check and writes nothing", async () => {
    await seedMixedRows();
    const before = await snapshot();

    const checked = await run(["--check"], { batchSize: 1 });

    expect(checked.code).toBe(1);
    expect(checked.output).toEqual([
      checkSummary("users", "encrypted_oauth_token", 1, 2),
      checkSummary("user_forge_identities", "encrypted_token", 0, 2),
      checkSummary("registered_repositories", "encrypted_webhook_secret", 1, 2),
    ]);
    expect(await snapshot()).toEqual(before);
  });

  it("seals every v1 and previous-key row under the current key, where the stores read it with no previous key", async () => {
    const seeded = await seedMixedRows();
    const before = await snapshot();

    const result = await run([], { batchSize: 1 });

    expect(result.code).toBe(0);
    expect(result.output).toEqual([
      summary("users", "encrypted_oauth_token", 2, 1),
      summary("user_forge_identities", "encrypted_token", 2, 0),
      summary("registered_repositories", "encrypted_webhook_secret", 2, 1),
    ]);
    const after = await snapshot();
    for (const [row, envelope] of after) {
      if (before.get(row) === null) {
        expect(envelope, row).toBeNull();
        continue;
      }
      const [version, keyId] = envelope!.split(".");
      expect({ row, version, keyId }).toEqual({ row, version: "v2", keyId: keyIdOf(currentKey) });
      expect(keyId).not.toBe(keyIdOf(previousKey));
    }
    expect(after.get(`users:${seeded.currentUser.id}`)).toBe(before.get(`users:${seeded.currentUser.id}`));
    expect(after.get(`registered_repositories:${seeded.currentRepository.id}`))
      .toBe(before.get(`registered_repositories:${seeded.currentRepository.id}`));

    const repositories = new PostgresRepositoryStore(sql, currentKey, "");
    const forge = new PostgresForgeIdentityStore(sql, currentKey, "");
    await expect(repositories.getGitHubAccessToken(seeded.legacyUser.id)).resolves.toBe(legacyV1Plaintext);
    await expect(repositories.getGitHubAccessToken(seeded.previousUser.id)).resolves.toBe("previous-oauth");
    await expect(repositories.getGitHubAccessToken(seeded.currentUser.id)).resolves.toBe("current-oauth");
    await expect(repositories.getGitHubAccessToken(seeded.emptyUser.id)).resolves.toBeNull();
    await expect(forge.getForgeToken(seeded.legacyUser.id, instanceUrl))
      .resolves.toEqual({ token: legacyV1Plaintext, identityId: seeded.legacyForge.id });
    await expect(forge.getForgeToken(seeded.previousUser.id, instanceUrl))
      .resolves.toEqual({ token: "previous-pat", identityId: seeded.previousForge.id });
    await expect(repositories.findWebhookCredential(seeded.previousRepository.credentialId, "github"))
      .resolves.toMatchObject({ secret: "previous-secret" });
    await expect(repositories.findWebhookCredential(seeded.currentRepository.credentialId, "github"))
      .resolves.toMatchObject({ secret: "current-secret" });
    await expect(repositories.findWebhookCredential(seeded.legacyRepository.credentialId, "github"))
      .resolves.toMatchObject({ secret: legacyV1Plaintext });

    const output = result.lines.join("\n");
    for (const secret of [currentKey, previousKey, legacyV1Plaintext, "previous-oauth", "previous-pat", "previous-secret"]) {
      expect(output).not.toContain(secret);
    }

    const checked = await run(["--check"]);
    expect(checked.code).toBe(0);
    expect(checked.output).toEqual([
      checkSummary("users", "encrypted_oauth_token", 3, 0),
      checkSummary("user_forge_identities", "encrypted_token", 2, 0),
      checkSummary("registered_repositories", "encrypted_webhook_secret", 3, 0),
    ]);
  });

  it("changes nothing on a second run", async () => {
    await seedMixedRows();
    expect((await run([])).code).toBe(0);
    const afterFirst = await snapshot();

    const second = await run([], { batchSize: 2 });

    expect(second.code).toBe(0);
    expect(second.output).toEqual([
      summary("users", "encrypted_oauth_token", 0, 3),
      summary("user_forge_identities", "encrypted_token", 0, 2),
      summary("registered_repositories", "encrypted_webhook_secret", 0, 3),
    ]);
    expect(await snapshot()).toEqual(afterFirst);
  });

  it("upgrades v1 rows under the current key when no previous key is configured", async () => {
    const user = await insertUser(() => legacyV1Envelope);

    const result = await run([], { keys: { current: legacyV1Key } });

    expect(result.code).toBe(0);
    expect(result.output[0]).toEqual(summary("users", "encrypted_oauth_token", 1, 0));
    const envelope = (await snapshot()).get(`users:${user.id}`)!;
    expect(envelope.split(".").slice(0, 2)).toEqual(["v2", keyIdOf(legacyV1Key)]);
    await expect(new PostgresRepositoryStore(sql, legacyV1Key, "").getGitHubAccessToken(user.id))
      .resolves.toBe(legacyV1Plaintext);
  });

  it("leaves a row a concurrent writer replaced first, and counts it as skipped", async () => {
    const raced = await insertUser(() => legacyV1Envelope);
    const untouched = await insertUser(() => legacyV1Envelope);
    const real = postgresCredentialStore(sql);
    const store: CredentialStore = {
      readBatch: real.readBatch,
      async replaceIfUnchanged(column, credential, next) {
        if (credential.id === raced.id) {
          await sql`update users set encrypted_oauth_token = ${Buffer.from(encryptToken("concurrent-oauth", currentKey,
            credentialBinding.userOAuthToken(raced.githubUserId)), "utf8")} where id = ${raced.id}`;
        }
        return real.replaceIfUnchanged(column, credential, next);
      },
    };

    const result = await run([], { store });

    expect(result.code).toBe(0);
    expect(result.output[0]).toEqual(summary("users", "encrypted_oauth_token", 1, 0, 1, 0));
    const repositories = new PostgresRepositoryStore(sql, currentKey, "");
    await expect(repositories.getGitHubAccessToken(raced.id)).resolves.toBe("concurrent-oauth");
    await expect(repositories.getGitHubAccessToken(untouched.id)).resolves.toBe(legacyV1Plaintext);
  });

  // Each case moves one natural-key column the row's binding was built from,
  // after the read and before the compare-and-swap, leaving the ciphertext
  // untouched. `provider` has no case: its check constraint admits one value.
  it.each([
    {
      table: "users", keyColumn: "github_user_id",
      async seed() { return (await insertUser(() => legacyV1Envelope)).id; },
      async move(id: string) { await sql`update users set github_user_id = ${externalId++} where id = ${id}`; },
    },
    {
      table: "user_forge_identities", keyColumn: "instance_url",
      async seed() { return (await insertForgeIdentity((await insertUser(null)).id, () => legacyV1Envelope)).id; },
      async move(id: string) {
        await sql`update user_forge_identities set instance_url = 'https://moved.example.com' where id = ${id}`;
      },
    },
    {
      table: "user_forge_identities", keyColumn: "forge_user_id",
      async seed() { return (await insertForgeIdentity((await insertUser(null)).id, () => legacyV1Envelope)).id; },
      async move(id: string) { await sql`update user_forge_identities set forge_user_id = ${externalId++} where id = ${id}`; },
    },
    {
      table: "registered_repositories", keyColumn: "webhook_credential_id",
      async seed() {
        const sponsor = await insertUser(null);
        const repository = await registerRepository(previousKey, sponsor.id, "moved-secret");
        return repository.id;
      },
      async move(id: string) {
        await sql`update registered_repositories set webhook_credential_id = ${randomUUID()} where id = ${id}`;
      },
    },
  ])("skips a $table row whose $keyColumn changed between read and write", async ({ table, seed, move }) => {
    const id = await seed();
    const real = postgresCredentialStore(sql);
    const store: CredentialStore = {
      readBatch: real.readBatch,
      async replaceIfUnchanged(column, credential, next) {
        if (credential.id === id) await move(id);
        return real.replaceIfUnchanged(column, credential, next);
      },
    };
    const before = (await snapshot()).get(`${table}:${id}`);

    const result = await run([], { store });

    const tableSummary = result.output.find((line) => line.table === table && "reencrypted" in line);
    expect(tableSummary).toMatchObject({ reencrypted: 0, skipped: 1, failed: 0 });
    expect((await snapshot()).get(`${table}:${id}`)).toBe(before);
  });

  it("reports an undecryptable row by table and id only, keeps going, and exits non-zero", async () => {
    const donor = await insertUser((id) => encryptToken("donor-oauth", previousKey, credentialBinding.userOAuthToken(id)));
    const [donorRow] = await sql<{ encrypted_oauth_token: Buffer }[]>`
      select encrypted_oauth_token from users where id = ${donor.id}`;
    const copied = await insertUser(() => Buffer.from(donorRow!.encrypted_oauth_token).toString("utf8"));
    const foreign = await insertUser((id) => encryptToken("foreign-oauth", unknownKey, credentialBinding.userOAuthToken(id)));
    const before = await snapshot();

    const result = await run([], { batchSize: 1 });

    expect(result.code).toBe(1);
    expect(result.output).toEqual(expect.arrayContaining([
      { table: "users", id: copied.id, failure: "UNDECRYPTABLE" },
      { table: "users", id: foreign.id, failure: "UNDECRYPTABLE" },
      summary("users", "encrypted_oauth_token", 1, 0, 0, 2),
    ]));
    expect(result.output).toHaveLength(5);
    const after = await snapshot();
    expect(after.get(`users:${copied.id}`)).toBe(before.get(`users:${copied.id}`));
    expect(after.get(`users:${foreign.id}`)).toBe(before.get(`users:${foreign.id}`));
    await expect(new PostgresRepositoryStore(sql, currentKey, "").getGitHubAccessToken(donor.id))
      .resolves.toBe("donor-oauth");
    const output = result.lines.join("\n");
    for (const envelope of [before.get(`users:${copied.id}`)!, before.get(`users:${foreign.id}`)!]) {
      expect(output).not.toContain(envelope);
      expect(output).not.toContain(envelope.split(".").at(-1)!);
    }
  });

  it("runs as the package script with keys from the environment", async () => {
    await seedMixedRows();
    const invoke = (argumentsList: string[], previous: string) => spawnSync(
      "pnpm", ["--silent", "credentials:reencrypt", ...argumentsList], {
        cwd: process.cwd(), encoding: "utf8", timeout: 60_000,
        env: { ...process.env, NODE_OPTIONS: "", DATABASE_URL: databaseUrl,
          TOKEN_ENCRYPTION_KEY: currentKey, TOKEN_ENCRYPTION_KEY_PREVIOUS: previous },
      });
    const before = await snapshot();

    const misconfigured = invoke([], "not-a-key");
    expect(misconfigured.error).toBeUndefined();
    expect(misconfigured.status, misconfigured.stderr).toBe(1);
    expect(misconfigured.stdout.trim()).toBe(JSON.stringify({ failure: "KEYS_INVALID" }));
    expect(await snapshot()).toEqual(before);

    const pending = invoke(["--check"], previousKey);
    expect(pending.status, pending.stderr).toBe(1);
    const reencrypted = invoke([], previousKey);
    expect(reencrypted.status, reencrypted.stderr).toBe(0);
    expect(reencrypted.stdout.trim().split("\n").map((line) => JSON.parse(line))).toEqual([
      summary("users", "encrypted_oauth_token", 2, 1),
      summary("user_forge_identities", "encrypted_token", 2, 0),
      summary("registered_repositories", "encrypted_webhook_secret", 2, 1),
    ]);
    const settled = invoke(["--check"], "");
    expect(settled.status, settled.stderr).toBe(0);
    expect(`${reencrypted.stdout}${reencrypted.stderr}`).not.toContain(legacyV1Plaintext);
    expect(reencrypted.stderr).not.toContain("Error:");
  });
});
