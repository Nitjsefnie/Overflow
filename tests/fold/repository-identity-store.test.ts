import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";

let container: StartedTestContainer | undefined;
let sql: Sql;
let store: PostgresFoldStore;
let externalId = 9_700_000;
const originalDatabaseUrl = process.env.DATABASE_URL;
const tokenEncryptionKey = Buffer.alloc(32, 26).toString("base64url");
const firstObservation = new Date("2030-01-02T03:04:05.678Z");
const laterObservation = new Date("2030-02-03T04:05:06.789Z");
const staleUpdate = new Date("2000-01-01T00:00:00.000Z");
const registrationInstant = new Date("2029-11-12T13:14:15.678Z");

describe("registered repository identity verification", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({ database: "identity", user: "identity", password: "identity" });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
    store = new PostgresFoldStore(sql, tokenEncryptionKey);
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it("reads the registered numeric identity reconciliation aims its GitHub reads with", async () => {
    const { repositoryId, githubRepositoryId, ownerName } = await registeredRepository();

    await expect(store.getRepository(repositoryId)).resolves.toMatchObject({
      id: repositoryId,
      githubRepositoryId,
      ownerName,
      active: true,
    });
  });

  it("reads the registration instant a closure's evidence window is measured against", async () => {
    const { repositoryId } = await registeredRepository();

    await expect(store.getRepository(repositoryId)).resolves.toMatchObject({
      registeredAt: registrationInstant.toISOString(),
    });
  });

  it("keeps the first observation of an unbroken unavailability and moves it when the reason changes", async () => {
    const { repositoryId } = await registeredRepository();
    await staleTimestamps(repositoryId);

    await store.markRepositoryUnavailable({ repositoryId, reason: "NOT_FOUND", at: firstObservation });
    const first = await unavailability(repositoryId);

    await store.markRepositoryUnavailable({ repositoryId, reason: "NOT_FOUND", at: laterObservation });
    const confirmed = await unavailability(repositoryId);

    await store.markRepositoryUnavailable({ repositoryId, reason: "NOT_PUBLIC", at: laterObservation });
    const changed = await unavailability(repositoryId);

    expect(first).toMatchObject({ unavailable_reason: "NOT_FOUND", unavailable_since: firstObservation });
    expect(first.updated_at.getTime()).toBeGreaterThan(staleUpdate.getTime());
    expect(confirmed).toMatchObject({ unavailable_reason: "NOT_FOUND", unavailable_since: firstObservation });
    expect(changed).toMatchObject({ unavailable_reason: "NOT_PUBLIC", unavailable_since: laterObservation });
  });

  it("writes nothing when a later tick repeats an unchanged unavailability", async () => {
    const { repositoryId } = await registeredRepository();
    await store.markRepositoryUnavailable({ repositoryId, reason: "NOT_FOUND", at: firstObservation });
    await staleTimestamps(repositoryId);

    await store.markRepositoryUnavailable({ repositoryId, reason: "NOT_FOUND", at: laterObservation });

    const row = await unavailability(repositoryId);
    expect(row).toMatchObject({ unavailable_reason: "NOT_FOUND", unavailable_since: firstObservation });
    expect(row.updated_at).toEqual(staleUpdate);
  });

  it("clears an unavailability and writes the verified path and visibility", async () => {
    const { repositoryId } = await registeredRepository();
    await store.markRepositoryUnavailable({ repositoryId, reason: "NOT_PUBLIC", at: firstObservation });
    await staleTimestamps(repositoryId);

    await store.recordVerifiedRepositoryIdentity({
      repositoryId,
      ownerName: `identity/renamed-${externalId++}`,
      visibility: "PUBLIC",
    });

    const row = await unavailability(repositoryId);
    expect(row).toMatchObject({
      unavailable_reason: null,
      unavailable_since: null,
      visibility: "PUBLIC",
    });
    expect(row.owner_name).toMatch(/^identity\/renamed-/);
    expect(row.updated_at.getTime()).toBeGreaterThan(staleUpdate.getTime());
  });

  it("writes nothing when a second verification finds the stored identity already correct", async () => {
    const { repositoryId, ownerName } = await registeredRepository();
    await store.recordVerifiedRepositoryIdentity({ repositoryId, ownerName, visibility: "PUBLIC" });
    await staleTimestamps(repositoryId);

    await store.recordVerifiedRepositoryIdentity({ repositoryId, ownerName, visibility: "PUBLIC" });

    const row = await unavailability(repositoryId);
    expect(row).toMatchObject({
      owner_name: ownerName,
      visibility: "PUBLIC",
      unavailable_reason: null,
      unavailable_since: null,
    });
    expect(row.updated_at).toEqual(staleUpdate);
  });

  it("still records availability when the verified path is held by another registration", async () => {
    const holder = await registeredRepository();
    const renamed = await registeredRepository();
    await store.markRepositoryUnavailable({ repositoryId: renamed.repositoryId, reason: "NOT_FOUND", at: firstObservation });
    // Start the stored visibility disagreeing with GitHub, so the write the unique
    // violation falls back to is observable in the column and not just in the reason.
    await sql`update registered_repositories set visibility = 'PRIVATE' where id = ${renamed.repositoryId}`;
    const warnings: unknown[][] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...args: unknown[]) => { warnings.push(args); });

    try {
      await expect(store.recordVerifiedRepositoryIdentity({
        repositoryId: renamed.repositoryId,
        ownerName: holder.ownerName,
        visibility: "PUBLIC",
      })).resolves.toBeUndefined();
    } finally {
      warn.mockRestore();
    }

    // The CLI resolves a path to a registration, so a rename left unpersisted sends
    // `scripts/reconcile.ts --repository <new path>` to the other row without a word.
    expect(warnings).toEqual([[expect.stringContaining(holder.ownerName)]]);
    expect(warnings[0]![0]).toContain(renamed.repositoryId);

    expect(await unavailability(renamed.repositoryId)).toMatchObject({
      owner_name: renamed.ownerName,
      visibility: "PUBLIC",
      unavailable_reason: null,
      unavailable_since: null,
    });
    expect(await unavailability(holder.repositoryId)).toMatchObject({
      owner_name: holder.ownerName,
      visibility: "PUBLIC",
    });
  });
});

type RepositoryIdentityRow = {
  owner_name: string;
  visibility: "PUBLIC" | "PRIVATE";
  unavailable_reason: string | null;
  unavailable_since: Date | null;
  updated_at: Date;
};

async function unavailability(repositoryId: string): Promise<RepositoryIdentityRow> {
  const [row] = await sql<RepositoryIdentityRow[]>`
    select owner_name, visibility, unavailable_reason, unavailable_since, updated_at
    from registered_repositories where id = ${repositoryId}
  `;
  if (row === undefined) {
    throw new Error("Registered repository fixture was missing.");
  }
  return row;
}

// Park updated_at in the past so a write that bumps it is visible without timing the clock.
async function staleTimestamps(repositoryId: string): Promise<void> {
  await sql`update registered_repositories set updated_at = ${staleUpdate} where id = ${repositoryId}`;
}

async function registeredRepository() {
  const githubRepositoryId = externalId++;
  const ownerName = `identity/repo-${githubRepositoryId}`;
  const [sponsor] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${externalId++}, ${`sponsor-${githubRepositoryId}`}) returning id
  `;
  const difficultyScheme = {
    openingName: "Size", actualName: "Delivered",
    openingLabels: [{ label: "M", comparisonPoints: 5, reservePoints: 5 }],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
  };
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories
      (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme, created_at)
    values (
      ${githubRepositoryId}, ${ownerName}, ${sponsor!.id}, 'PUBLIC', ${externalId++},
      ${sql.json(difficultyScheme)}, ${registrationInstant}
    )
    returning id
  `;
  return { repositoryId: repository!.id, githubRepositoryId, ownerName };
}
