import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresRepositorySizeStore } from "@/lib/fold/repository-size";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";

let sql: Sql;
let container: StartedTestContainer;
const original = process.env.OVERFLOW_DATABASE_URL;
const at = new Date("2030-01-01T00:00:00Z");
let externalId = 0;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "sizes", user: "sizes", password: randomUUID() });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});
beforeEach(async () => {
  await sql`delete from repository_reconciliation_sizes`;
  await sql`delete from registered_repositories`;
  await sql`delete from users`;
});
afterAll(async () => {
  await closeSql();
  await container?.stop();
  if (original === undefined) delete process.env.OVERFLOW_DATABASE_URL; else process.env.OVERFLOW_DATABASE_URL = original;
});

async function insertSponsor(): Promise<string> {
  const githubUserId = 5_000_000 + (externalId += 1);
  const [row] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${`sponsor-${externalId}`}) returning id`;
  return row.id;
}

async function insertRepository(sponsorId: string, active = true): Promise<string> {
  const id = 6_000_000 + (externalId += 1);
  const [row] = await sql<{ id: string }[]>`
    insert into registered_repositories
      (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme, active)
    values (${id}, ${`owner/repo-${id}`}, ${sponsorId}, 'PUBLIC', ${id}, ${sql.json(validDifficultyScheme())}, ${active})
    returning id`;
  return row.id;
}

describe("the repository size store", () => {
  it("returns null for a repository never measured", async () => {
    const store = new PostgresRepositorySizeStore(sql);
    expect(await store.get(randomUUID())).toBeNull();
  });

  it("stores a measure and reads it back with its measured_at", async () => {
    const store = new PostgresRepositorySizeStore(sql);
    const sponsorId = await insertSponsor();
    const repositoryId = await insertRepository(sponsorId);
    await store.store(repositoryId, 1356, at);
    expect(await store.get(repositoryId)).toEqual({ totalCount: 1356, measuredAt: at });
  });

  it("upserts: a second store of the same repository replaces the first", async () => {
    const store = new PostgresRepositorySizeStore(sql);
    const sponsorId = await insertSponsor();
    const repositoryId = await insertRepository(sponsorId);
    await store.store(repositoryId, 100, at);
    const later = new Date(at.getTime() + 3_600_000);
    await store.store(repositoryId, 1356, later);
    const rows = await sql<{ total_count: number }[]>`select total_count from repository_reconciliation_sizes`;
    expect(rows).toEqual([{ total_count: 1356 }]);
    expect(await store.get(repositoryId)).toEqual({ totalCount: 1356, measuredAt: later });
  });

  it("sums the sponsor's active repositories, small rows summing past the threshold together", async () => {
    const store = new PostgresRepositorySizeStore(sql);
    const sponsorId = await insertSponsor();
    const first = await insertRepository(sponsorId);
    const second = await insertRepository(sponsorId);
    await store.store(first, 682, at);
    await store.store(second, 674, at);
    expect(await store.getSponsorBacklog(sponsorId)).toBe(1356);
  });

  it("counts an unmeasured repository as zero and excludes other sponsors' and inactive rows", async () => {
    const store = new PostgresRepositorySizeStore(sql);
    const sponsorId = await insertSponsor();
    const measured = await insertRepository(sponsorId);
    const unmeasured = await insertRepository(sponsorId);
    const inactive = await insertRepository(sponsorId, false);
    const otherSponsorId = await insertSponsor();
    const other = await insertRepository(otherSponsorId);
    await store.store(measured, 300, at);
    await store.store(inactive, 9000, at);
    await store.store(other, 9000, at);
    // Only the measured active row counts: the unmeasured one contributes zero.
    expect(await store.getSponsorBacklog(sponsorId)).toBe(300);
    expect(await store.getSponsorBacklog(otherSponsorId)).toBe(9000);
  });

  it("returns null when nothing of the sponsor's has been measured at all", async () => {
    const store = new PostgresRepositorySizeStore(sql);
    const sponsorId = await insertSponsor();
    await insertRepository(sponsorId);
    expect(await store.getSponsorBacklog(sponsorId)).toBeNull();
  });

  it("returns the boundary sum exactly, so a backlog equal to the threshold reads as not over", async () => {
    const store = new PostgresRepositorySizeStore(sql);
    const sponsorId = await insertSponsor();
    const first = await insertRepository(sponsorId);
    const second = await insertRepository(sponsorId);
    await store.store(first, 400, at);
    await store.store(second, 600, at);
    expect(await store.getSponsorBacklog(sponsorId)).toBe(1000);
  });
});
