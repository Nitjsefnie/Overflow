import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";
import type { EnforcementState } from "@/lib/db/types";
import type { NewRegisteredRepository } from "@/lib/repositories/register";
import {
  RepositoryOwnerNameConflictError,
  RepositoryRegistrationEnforcementError,
} from "@/lib/repositories/register";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";

let container: StartedTestContainer | undefined;
let sql: Sql;
let store: PostgresRepositoryStore;
let externalId = 8_600_000;
const originalDatabaseUrl = process.env.DATABASE_URL;
const tokenEncryptionKey = Buffer.alloc(32, 19).toString("base64url");

describe("registering a repository against the real registered_repositories constraints", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "registration",
      user: "registration",
      password: "registration",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
    store = new PostgresRepositoryStore(sql, tokenEncryptionKey);
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

  it("names the held owner/name path when a new numeric identity is submitted under a claimed path", async () => {
    const held = await registeredRepository();
    const submission = newRepository({ sponsorId: await sponsor(), ownerName: held.ownerName });

    await expect(store.createRepository(submission)).rejects.toThrow(RepositoryOwnerNameConflictError);
    await expect(countOf(submission.githubRepositoryId)).resolves.toBe(0);
  });

  it("carries the claimed path on the owner/name conflict it raises", async () => {
    const held = await registeredRepository();
    const submission = newRepository({ sponsorId: await sponsor(), ownerName: held.ownerName });

    await expect(store.createRepository(submission)).rejects.toMatchObject({
      name: "RepositoryOwnerNameConflictError",
      ownerName: held.ownerName,
    });
  });

  it("reports a duplicate numeric GitHub identity as an absent row whatever path it was submitted under", async () => {
    const existing = await registeredRepository();
    const submission = newRepository({
      sponsorId: await sponsor(),
      githubRepositoryId: existing.githubRepositoryId,
    });

    await expect(store.createRepository(submission)).resolves.toBeNull();
  });

  it("stores a registration whose numeric identity and path are both unclaimed", async () => {
    const submission = newRepository({ sponsorId: await sponsor() });

    await expect(store.createRepository(submission)).resolves.toMatchObject({
      githubRepositoryId: submission.githubRepositoryId,
      ownerName: submission.ownerName,
      githubWebhookId: submission.githubWebhookId,
      sponsorId: submission.sponsorId,
      visibility: "PUBLIC",
    });
  });

  it("raises a unique violation it does not recognise rather than reporting the repository as present", async () => {
    const held = await registeredRepository();
    const submission = newRepository({
      sponsorId: await sponsor(),
      githubWebhookId: held.githubWebhookId,
    });

    await expect(store.createRepository(submission)).rejects.toMatchObject({
      code: "23505",
      constraint_name: "registered_repositories_github_webhook_id_key",
    });
    await expect(countOf(submission.githubRepositoryId)).resolves.toBe(0);
  });

  it("refuses a sponsor whose enforcement state makes it ineligible", async () => {
    const submission = newRepository({ sponsorId: await sponsor("BANNED") });

    await expect(store.createRepository(submission)).rejects.toThrow(RepositoryRegistrationEnforcementError);
    await expect(countOf(submission.githubRepositoryId)).resolves.toBe(0);
  });
});

async function countOf(githubRepositoryId: number): Promise<number> {
  const [row] = await sql<{ count: string }[]>`
    select count(*)::text as count
    from registered_repositories
    where github_repository_id = ${githubRepositoryId}
  `;
  if (row === undefined) {
    throw new Error("Counting registered repositories returned no row.");
  }
  return Number(row.count);
}

async function sponsor(enforcementState: EnforcementState = "ACTIVE"): Promise<string> {
  const githubUserId = externalId++;
  const [row] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, enforcement_state)
    values (${githubUserId}, ${`sponsor-${githubUserId}`}, ${enforcementState})
    returning id
  `;
  if (row === undefined) {
    throw new Error("Sponsor fixture was missing.");
  }
  return row.id;
}

function difficultyScheme(): DifficultyScheme {
  return {
    openingName: "Size",
    actualName: "Delivered",
    openingLabels: [{ label: "size/M", comparisonPoints: 5, reservePoints: 5 }],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}

function newRepository(
  overrides: Partial<NewRegisteredRepository> & Pick<NewRegisteredRepository, "sponsorId">,
): NewRegisteredRepository {
  const githubRepositoryId = externalId++;
  return {
    githubRepositoryId,
    ownerName: `registration/repo-${githubRepositoryId}`,
    visibility: "PUBLIC",
    githubWebhookId: externalId++,
    difficultyScheme: difficultyScheme(),
    ...overrides,
  };
}

async function registeredRepository(): Promise<NewRegisteredRepository> {
  const submission = newRepository({ sponsorId: await sponsor() });
  await sql`
    insert into registered_repositories
      (github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme)
    values (
      ${submission.githubRepositoryId},
      ${submission.ownerName},
      ${submission.sponsorId},
      ${submission.visibility},
      ${submission.githubWebhookId},
      ${sql.json(submission.difficultyScheme)}
    )
  `;
  return submission;
}
