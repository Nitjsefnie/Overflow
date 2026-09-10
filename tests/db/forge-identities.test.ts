import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
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
    await expect(insertIdentity(user.id, { provider: "gitea" })).rejects.toThrow();
    await expect(insertIdentity(user.id, { instanceUrl: "https://gitlab.com/group/project" })).rejects.toThrow();
  });

  it("defaults fresh GitHub-shaped registered_repositories and settlements rows to github and null", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    const [repository] = await sql<{ provider: string; instance_url: string | null; forge_project_id: number | null }[]>`
      select provider, instance_url, forge_project_id from registered_repositories where id = ${fixture.repositoryId}
    `;
    expect(repository).toEqual({ provider: "github", instance_url: null, forge_project_id: null });
    const [settlement] = await sql<{ provider: string; instance_url: string | null }[]>`
      select provider, instance_url from settlements
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
});
