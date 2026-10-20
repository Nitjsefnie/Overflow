import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;
beforeAll(async () => {
  const started = await startPostgresContainer({ database: "reconciliation_auth_path_test", user: "reconciliation_auth_path_test" });
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

describe("repository reconciliation authentication path", () => {
  // Dropping either assignment, the repository predicate, or the migration breaks persistence.
  it("starts null and replaces both columns for only the selected repository on each path", async () => {
    const { repositoryId } = await materializeRepositoryFixture(sql);
    const other = await materializeRepositoryFixture(sql);
    const read = (id: string) => sql`
      select reconciliation_auth_path, reconciliation_auth_path_at from registered_repositories where id = ${id}
    `;
    expect(await read(repositoryId)).toEqual([{ reconciliation_auth_path: null, reconciliation_auth_path_at: null }]);
    const { recordReconciliationAuthPath } = await import("@/lib/fold/reconciliation-auth-path");
    const paths = ["github-app-installation", "registration-app-installation", "sponsor-oauth-fallback"] as const;
    for (const [index, path] of paths.entries()) {
      const at = new Date(Date.UTC(2030, 0, 1, 0, index));
      await recordReconciliationAuthPath(sql, repositoryId, path, at);
      expect(await read(repositoryId)).toEqual([{ reconciliation_auth_path: path, reconciliation_auth_path_at: at }]);
    }
    expect(await read(other.repositoryId)).toEqual([{ reconciliation_auth_path: null, reconciliation_auth_path_at: null }]);
  });

  // Removing the check would allow a value the dashboard cannot interpret.
  it("rejects an unknown authentication path", async () => {
    const { repositoryId } = await materializeRepositoryFixture(sql);
    await expect(sql`update registered_repositories set reconciliation_auth_path = 'unknown' where id = ${repositoryId}`)
      .rejects.toMatchObject({ code: "23514" });
  });
});
