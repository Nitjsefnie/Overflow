import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresForgeIdentityStore } from "@/lib/forge/postgres-identities-store";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { upgradeRepositoryWebhooks, type WebhookUpgradeDependencies } from "@/lib/repositories/upgrade-webhooks";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
// 32 raw bytes, base64url: a real key for the real cipher round-trips these tests exercise.
const TEST_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url");
let container: StartedTestContainer;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "forge", user: "forge", password: "forge" });
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

/** A linked identity row for one user, with the fields the caller wants to vary. */
async function insertIdentity(
  userId: string,
  overrides: { instanceUrl?: string; provider?: string; forgeUserId?: number } = {},
): Promise<void> {
  await sql`
    insert into user_forge_identities
      (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token, verified_at)
    values (
      ${userId}, ${overrides.provider ?? "gitlab"}, ${overrides.instanceUrl ?? "https://gitlab.com"},
      ${overrides.forgeUserId ?? 4242}, 'tester', ${Buffer.from("token-bytes")}, now()
    )
  `;
}

describe("migration 038: forge identities and provider columns", () => {
  it("creates user_forge_identities keyed on the exact provider, instance and forge-user triple", async () => {
    const constraints = await sql<{ conname: string }[]>`
      select conname from pg_constraint
      where conrelid = 'user_forge_identities'::regclass and contype = 'u'
    `;
    expect(constraints).toHaveLength(1);
    const triple = await sql<{ attname: string }[]>`
      select a.attname from pg_index i
      join pg_attribute a on a.attrelid = i.indrelid and a.attnum = any(i.indkey)
      where i.indrelid = 'user_forge_identities'::regclass and i.indisunique and not i.indisprimary
      order by a.attname
    `;
    expect(triple.map((row) => row.attname)).toEqual(["forge_user_id", "instance_url", "provider"]);
  });

  it("accepts two identities differing only in instance_url and rejects a duplicate triple", async () => {
    const [user] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login) values (910001, 'forge-tester') returning id
    `;
    // gitlab.com and a self-hosted instance are distinct namespaces: the same
    // forge user id under both is two identities, not one.
    await insertIdentity(user.id);
    await insertIdentity(user.id, { instanceUrl: "https://gitlab.example.com" });
    await expect(insertIdentity(user.id)).rejects.toThrow();
  });

  it("rejects a provider outside the accepted set and a malformed instance_url", async () => {
    const [user] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login) values (910002, 'forge-typo') returning id
    `;
    // The partial message names the violated CHECK constraint, so the case
    // cannot pass vacuously on some other rejection the insert could hit.
    await expect(insertIdentity(user.id, { provider: "gitea" })).rejects.toThrow(
      /user_forge_identities_provider_check/,
    );
    await expect(insertIdentity(user.id, { instanceUrl: "https://gitlab.com/group/project" })).rejects.toThrow(
      /user_forge_identities_instance_url_check/,
    );
  });

  it("keeps the identity foreign key on the house convention: no on-delete cascade", async () => {
    // Migration 011's rule, the reason this table shape carries a bare
    // `references users`: an account that still holds a credential is not
    // deleted out from under it. `confdeltype` 'a' is NO ACTION; a cascade
    // ('c') here is the regression this pin exists to catch.
    const [foreignKey] = await sql<{ confdeltype: string }[]>`
      select confdeltype from pg_constraint
      where conrelid = 'user_forge_identities'::regclass and contype = 'f'
        and conname = 'user_forge_identities_user_id_fkey'
    `;
    expect(foreignKey, "the user_id foreign key constraint exists").toBeDefined();
    expect(foreignKey!.confdeltype).toBe("a");
  });

  it("defaults fresh GitHub-shaped registered_repositories and settlements rows to github and null", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    const [repository] = await sql<{ provider: string; instance_url: string | null; forge_project_id: number | null }[]>`
      select provider, instance_url, forge_project_id from registered_repositories where id = ${fixture.repositoryId}
    `;
    expect(repository).toEqual({ provider: "github", instance_url: null, forge_project_id: null });
    // Filtered to the fixture's own settlement by its pull request, not the
    // first settlements row, so the case reads the row it created.
    const fixturePullRequestId = fixture.fold.settlements[0]!.githubPullRequestId;
    const [settlement] = await sql<{ provider: string; instance_url: string | null }[]>`
      select settlements.provider, settlements.instance_url
      from settlements
      join pull_requests on pull_requests.id = settlements.pull_request_id
      where pull_requests.github_pull_request_id = ${fixturePullRequestId}
    `;
    expect(settlement).toEqual({ provider: "github", instance_url: null });
  });

  it("keeps the partial unique index off GitHub rows, so they never collide on the null forge key", async () => {
    const index = await sql<{ indexdef: string }[]>`
      select indexdef from pg_indexes
      where tablename = 'registered_repositories' and indexdef like '%forge_project_id%'
    `;
    expect(index).toHaveLength(1);
    expect(index[0]!.indexdef).toContain("WHERE (provider <> 'github'::text)");
  });

  it("stores a GitLab-shaped registration row whose webhook id is null, and reads it back", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    const [row] = await sql<{ sponsor_id: string }[]>`
      select sponsor_id from registered_repositories where id = ${fixture.repositoryId}
    `;
    const store = new PostgresRepositoryStore();
    const created = await store.createRepository({
      githubRepositoryId: 920_001,
      ownerName: "gitlab-group/gitlab-project",
      sponsorId: row!.sponsor_id,
      visibility: "PUBLIC",
      githubWebhookId: null,
      difficultyScheme: validDifficultyScheme(),
    });
    expect(created).not.toBeNull();
    expect(created!.githubWebhookId).toBeNull();
    const reread = await store.findRepositoryByGitHubId(920_001);
    expect(reread).not.toBeNull();
    expect(reread!.githubWebhookId).toBeNull();
  });

  it("skips a null-webhook-id registration in the webhook upgrade drain before any credential or gateway work", async () => {
    // A repository registered without a webhook has nothing to drain. The
    // drain's skip is load-bearing: with it removed the run would reach for
    // the sponsor's GitHub credentials and build a gateway, so this case
    // kills that mutant three ways — the reported outcome shape, the summary
    // counts, and the credential-read log.
    const fixture = await materializeRepositoryFixture(sql);
    const [row] = await sql<{ sponsor_id: string }[]>`
      select sponsor_id from registered_repositories where id = ${fixture.repositoryId}
    `;
    const store = new PostgresRepositoryStore();
    const created = await store.createRepository({
      githubRepositoryId: 920_002,
      ownerName: "gitlab-group/another-project",
      sponsorId: row!.sponsor_id,
      visibility: "PUBLIC",
      githubWebhookId: null,
      difficultyScheme: validDifficultyScheme(),
    });
    expect(created).not.toBeNull();

    const outcomes: unknown[] = [];
    const credentialReads: string[] = [];
    const dependencies: WebhookUpgradeDependencies = {
      store: {
        listActiveRepositoryIds: async () => [created!.id],
        findActiveRepositoryById: async (id) => (created!.id === id ? { ...created! } : null),
        getGitHubAccessToken: async (sponsorId) => {
          credentialReads.push(sponsorId);
          return `token-${sponsorId}`;
        },
        requestRepositoryRederivation: async () => {
          throw new Error("no queue work may be requested for a webhook-less repository");
        },
      },
      webhookSecret: "secret",
      createGateway: () => {
        throw new Error("no gateway may be built for a webhook-less repository");
      },
      report: (outcome) => {
        outcomes.push(outcome);
      },
    };

    expect(await upgradeRepositoryWebhooks(dependencies)).toEqual({ succeeded: 1, failed: 0 });
    expect(outcomes).toEqual([
      { repositoryId: created!.id, subscription: "NOT_APPLICABLE", queue: "NOT_ATTEMPTED", failure: null },
    ]);
    expect(credentialReads).toEqual([]);
  });

  it("refreshes the owner's re-link on the same row and refuses the same triple for another account", async () => {
    const store = new PostgresForgeIdentityStore(sql, TEST_ENCRYPTION_KEY);
    const [owner] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login) values (930001, 'forge-owner') returning id
    `;
    const [outsider] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login) values (930002, 'forge-outsider') returning id
    `;
    const link = {
      provider: "gitlab",
      instanceUrl: "https://gitlab.example.com",
      forgeUserId: 7007,
      encryptedToken: "v1.test.envelope",
    };
    const first = await store.upsertIdentity({
      userId: owner!.id, forgeLogin: "tester-v1", ...link,
    });
    expect(first).not.toBeNull();

    // The owner's re-link refreshes login and verification on the SAME row.
    const refreshed = await store.upsertIdentity({
      userId: owner!.id, forgeLogin: "tester-v2", ...link,
    });
    expect(refreshed).not.toBeNull();
    expect(refreshed!.id).toBe(first!.id);
    expect(refreshed!.forgeLogin).toBe("tester-v2");

    // Another account presenting the same triple must not take the row over:
    // the conditional upsert inserts nothing and answers null.
    const stolen = await store.upsertIdentity({
      userId: outsider!.id, forgeLogin: "outsider", ...link,
    });
    expect(stolen).toBeNull();
    const after = await sql<{ forge_login: string; user_id: string }[]>`
      select forge_login, user_id::text as user_id from user_forge_identities
      where provider = 'gitlab' and instance_url = 'https://gitlab.example.com' and forge_user_id = 7007
    `;
    expect(after).toEqual([{ forge_login: "tester-v2", user_id: owner!.id }]);
  });

  it("deletes only the owner's identity: a foreign user's delete is a no-op", async () => {
    const store = new PostgresForgeIdentityStore(sql, TEST_ENCRYPTION_KEY);
    const [owner] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login) values (930003, 'delete-owner') returning id
    `;
    const [foreign] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login) values (930004, 'delete-foreign') returning id
    `;
    const identity = await store.upsertIdentity({
      userId: owner!.id,
      provider: "gitlab",
      instanceUrl: "https://delete-test.example.com",
      forgeUserId: 7008,
      forgeLogin: "deletable",
      encryptedToken: "v1.test.envelope",
    });
    expect(identity).not.toBeNull();

    // A foreign id deletes nothing and reports it.
    expect(await store.deleteForUser({ identityId: identity!.id, userId: foreign!.id })).toBe(false);
    // The owner's delete removes the row.
    expect(await store.deleteForUser({ identityId: identity!.id, userId: owner!.id })).toBe(true);
  });

  it("lists exactly the identity view fields and never the encrypted token", async () => {
    const store = new PostgresForgeIdentityStore(sql, TEST_ENCRYPTION_KEY);
    const [user] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login) values (930005, 'list-owner') returning id
    `;
    await store.upsertIdentity({
      userId: user!.id,
      provider: "gitlab",
      instanceUrl: "https://list-test.example.com",
      forgeUserId: 7009,
      forgeLogin: "lister",
      encryptedToken: "v1.secret.never-leak",
    });
    const listed = await store.listForUser(user!.id);
    const mine = listed.filter((identity) => identity.instanceUrl === "https://list-test.example.com");
    expect(mine).toHaveLength(1);
    // The view's exact field set: no encrypted_token, no user_id, no envelope.
    expect(Object.keys(mine[0]!).sort()).toEqual([
      "forgeLogin", "id", "instanceUrl", "provider", "verifiedAt",
    ]);
    expect(JSON.stringify(mine[0])).not.toContain("never-leak");
  });

  it("keeps the token column out of the list query itself, not just out of the view mapping", async () => {
    // The view mapping already projects the token away; this pin holds the
    // QUERY to the same containment, so a secret is never fetched to be
    // dropped. Reviewed mutant: re-adding encrypted_token to the select.
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const storeSource = await readFile(
      fileURLToPath(new URL("../../src/lib/forge/postgres-identities-store.ts", import.meta.url)),
      "utf8",
    );
    const listSelect = storeSource.slice(
      storeSource.indexOf("async listForUser"),
      storeSource.indexOf("upsertIdentity(input"),
    );
    expect(listSelect).toContain("select id, provider, instance_url, forge_login, verified_at");
    expect(listSelect).not.toContain("encrypted_token");
  });
});
