import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { runNextReconciliationJob } from "@/lib/fold/reconciliation-worker";
import { GitHubApiError } from "@/lib/github/errors";
import { startPostgresContainer } from "../support/postgres-container";
import { validDifficultyScheme } from "../support/difficulty-scheme";

let sql: Sql;
let container: StartedTestContainer | undefined;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "rate_limit", user: "rate_limit" });
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

describe("durable GitHub rate-limit deferral", () => {
  it("writes GitHub's deadline and refunds only the claim attempt on every rate-limited failure", async () => {
    const [sponsor] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login) values (1, 'sponsor') returning id
    `;
    const [repository] = await sql<{ id: string }[]>`
      insert into registered_repositories
        (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
      values (1, 'owner/rate-limit', ${sponsor.id}, 'PUBLIC', 1, ${sql.json(validDifficultyScheme())}) returning id
    `;
    const store = new PostgresFoldStore(sql);
    await store.enqueueReconciliationJob(repository.id, "SWEEP");
    // Previous ordinary failures must survive; only the current claim is refunded.
    await sql`update repository_reconciliation_jobs set attempt_count = 2 where repository_id = ${repository.id}`;
    const failure = new Error("Fold failed", { cause: new GitHubApiError(403, true, 120, null, { "retry-after": "120" }) });
    const reported: unknown[] = [];
    for (let index = 0; index < 8; index++) {
      const outcome = await runNextReconciliationJob({
        store, now: () => new Date("2030-01-02T03:04:05.678Z"),
        scheduleLeaseRenewal: () => () => {},
        reconcile: async () => { throw failure; },
        onFailure: (_id, error) => { reported.push(error); },
      });
      expect(await sql`
        select state, attempt_count, run_after, lease_token, lease_expires_at
        from repository_reconciliation_jobs where repository_id = ${repository.id}
      `).toEqual([{
        state: "PENDING", attempt_count: 2, run_after: new Date("2030-01-02T03:06:05.678Z"),
        lease_token: null, lease_expires_at: null,
      }]);
      expect(outcome).toBe("DEFERRED");
      // Make the same row due again without consulting or asserting wall-clock margins.
      await sql`update repository_reconciliation_jobs set run_after = now() - interval '1 minute' where repository_id = ${repository.id}`;
    }
    expect(reported).toEqual(Array.from({ length: 8 }, () => failure));
  });
});
