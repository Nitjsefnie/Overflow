import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import {
  createRederivationGetHandler,
  createRederivationPostHandler,
} from "@/app/api/moderation/rederivation/route";
import { closeSql, getSql } from "@/lib/db/client";
import { FOLD_REVISION } from "@/lib/fold/fold-revision";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import {
  RepositoryRederivationService,
  type RepositoryRederivationStatus,
} from "@/lib/moderation/rederivation-service";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";
import { guardedRequests, useTrustedOrigin } from "../support/trusted-origin";

const tables = ["settlements", "self_work_calibrations", "unwritable_closures"] as const;
const moderator = { user: { id: "", role: "MODERATOR" as const } };
const firstRequestedAt = new Date("2026-09-07T09:00:00.000Z");
const laterRequestedAt = new Date("2026-09-07T10:00:00.000Z");
const absentRepositoryId = "00000000-0000-4000-8000-0000000000ff";

let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.DATABASE_URL;

useTrustedOrigin();

const { json: jsonRequest } = guardedRequests("/api/moderation/rederivation");

describe("repository re-derivation status", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "rederivation_status_test",
      user: "rederivation_status_test",
      password: "rederivation_status_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
    const [account] = await sql<{ id: string }[]>`
      insert into users (github_user_id, github_login) values (9000001, 'status-moderator')
      returning id
    `;
    moderator.user.id = account.id;
  });

  afterAll(async () => {
    await closeSql();
    await container?.stop();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it.each(tables)("counts a stale %s row below the revision and back at it once restamped", async (table) => {
    const { repositoryId } = await materializeRepositoryFixture(sql);
    const untouched = await materializeRepositoryFixture(sql);
    const [row] = await sql<{ id: string }[]>`
      select derived.id from ${sql(table)} as derived
      join issues on issues.id = derived.issue_id
      where issues.repository_id = ${repositoryId}
    `;

    expect(await statusFor(repositoryId)).toMatchObject({
      rowsAtCurrentRevision: 3,
      rowsBelowCurrentRevision: 0,
    });

    await sql`update ${sql(table)} set fold_revision = ${FOLD_REVISION - 1} where id = ${row.id}`;

    expect(await statusFor(repositoryId)).toMatchObject({
      rowsAtCurrentRevision: 2,
      rowsBelowCurrentRevision: 1,
    });
    // The counts are per repository: a stale row in one must not read as staleness
    // in another, which a query grouped on the wrong column would report.
    expect(await statusFor(untouched.repositoryId)).toMatchObject({
      rowsAtCurrentRevision: 3,
      rowsBelowCurrentRevision: 0,
    });

    await sql`update ${sql(table)} set fold_revision = ${FOLD_REVISION} where id = ${row.id}`;

    expect(await statusFor(repositoryId)).toMatchObject({
      rowsAtCurrentRevision: 3,
      rowsBelowCurrentRevision: 0,
    });
  });

  // The counts name one revision each. A row written by logic NEWER than the
  // caller's — what a rollback leaves behind — is neither current nor stale, and
  // an at-count widened to `>=` would silently claim it had been recomputed.
  it("counts a row stamped above the revision as neither current nor stale", async () => {
    const { repositoryId } = await materializeRepositoryFixture(sql);
    const [row] = await sql<{ id: string }[]>`
      select settlements.id from settlements
      join issues on issues.id = settlements.issue_id
      where issues.repository_id = ${repositoryId}
    `;

    await sql`update settlements set fold_revision = ${FOLD_REVISION + 1} where id = ${row.id}`;

    expect(await statusFor(repositoryId)).toMatchObject({
      rowsAtCurrentRevision: 2,
      rowsBelowCurrentRevision: 0,
    });
  });

  it("lists a repository holding no derived rows at all", async () => {
    const { repositoryId } = await materializeRepositoryFixture(sql);
    for (const table of tables) {
      await sql`
        delete from ${sql(table)} where issue_id in (select id from issues where repository_id = ${repositoryId})
      `;
    }

    expect(await statusFor(repositoryId)).toMatchObject({
      rowsAtCurrentRevision: 0,
      rowsBelowCurrentRevision: 0,
      rederivationRequestedAt: null,
    });
  });

  it("omits a repository moderation has deactivated", async () => {
    const { repositoryId } = await materializeRepositoryFixture(sql);
    await sql`update registered_repositories set active = false where id = ${repositoryId}`;

    expect(await listStatus()).not.toContainEqual(expect.objectContaining({ repositoryId }));
  });

  it("names each repository by its registered path and reports the current revision", async () => {
    const { repositoryId } = await materializeRepositoryFixture(sql);
    const [repository] = await sql<{ owner_name: string }[]>`
      select owner_name from registered_repositories where id = ${repositoryId}
    `;

    const response = await createRederivationGetHandler(dependencies())();
    const body = (await response.json()) as { rederivation: { foldRevision: number; repositories: RepositoryRederivationStatus[] } };

    expect(response.status).toBe(200);
    expect(body.rederivation.foldRevision).toBe(FOLD_REVISION);
    expect(body.rederivation.repositories).toContainEqual({
      repositoryId,
      ownerName: repository.owner_name,
      rowsAtCurrentRevision: 3,
      rowsBelowCurrentRevision: 0,
      rederivationRequestedAt: null,
    });
  });

  it("records a request through the route and keeps one queue row across repeats", async () => {
    const { repositoryId } = await materializeRepositoryFixture(sql);

    const first = await createRederivationPostHandler(dependencies(firstRequestedAt))(
      jsonRequest({ repositoryId }),
    );

    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toMatchObject({
      request: { repositoryId, rederivationRequestedAt: firstRequestedAt.toISOString() },
    });
    expect(await jobRowsFor(repositoryId)).toEqual([
      { reason: "REDERIVATION", rederivation_requested_at: firstRequestedAt },
    ]);

    const second = await createRederivationPostHandler(dependencies(laterRequestedAt))(
      jsonRequest({ repositoryId }),
    );

    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({
      request: { repositoryId, rederivationRequestedAt: laterRequestedAt.toISOString() },
    });
    // A repository owns exactly one queue row, so a moderator pressing the control
    // twice must not queue a second fold of the same repository.
    expect(await jobRowsFor(repositoryId)).toEqual([
      { reason: "REDERIVATION", rederivation_requested_at: laterRequestedAt },
    ]);
    expect(await statusFor(repositoryId)).toMatchObject({
      rederivationRequestedAt: laterRequestedAt.toISOString(),
    });
  });

  it("reports the standing request when a later one carries an earlier clock", async () => {
    const { repositoryId } = await materializeRepositoryFixture(sql);
    await createRederivationPostHandler(dependencies(laterRequestedAt))(jsonRequest({ repositoryId }));

    const response = await createRederivationPostHandler(dependencies(firstRequestedAt))(
      jsonRequest({ repositoryId }),
    );

    // The queue keeps the later of the two timestamps, so a route that answered
    // with the clock it just used would name a request that is not outstanding.
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      request: { rederivationRequestedAt: laterRequestedAt.toISOString() },
    });
    expect(await jobRowsFor(repositoryId)).toEqual([
      { reason: "REDERIVATION", rederivation_requested_at: laterRequestedAt },
    ]);
  });

  it("refuses a request for a repository this deployment does not serve, queueing nothing", async () => {
    const response = await createRederivationPostHandler(dependencies())(
      jsonRequest({ repositoryId: absentRepositoryId }),
    );

    expect(response.status).toBe(404);
    expect(await jobRowsFor(absentRepositoryId)).toEqual([]);
  });

  it("refuses a request for a deactivated repository, queueing nothing", async () => {
    const { repositoryId } = await materializeRepositoryFixture(sql);
    await sql`update registered_repositories set active = false where id = ${repositoryId}`;

    const response = await createRederivationPostHandler(dependencies())(jsonRequest({ repositoryId }));

    expect(response.status).toBe(404);
    expect(await jobRowsFor(repositoryId)).toEqual([]);
  });
});

function dependencies(now: Date = firstRequestedAt) {
  return {
    getSession: async () => moderator,
    getCurrentRole: async () => "MODERATOR" as const,
    createService: async () =>
      new RepositoryRederivationService(new PostgresFoldStore(sql), () => now),
  };
}

async function listStatus(): Promise<RepositoryRederivationStatus[]> {
  const service = new RepositoryRederivationService(new PostgresFoldStore(sql));
  return (await service.listRederivationStatus(moderator.user)).repositories;
}

async function statusFor(repositoryId: string): Promise<RepositoryRederivationStatus | undefined> {
  return (await listStatus()).find((entry) => entry.repositoryId === repositoryId);
}

function jobRowsFor(repositoryId: string) {
  return sql`
    select reason, rederivation_requested_at from repository_reconciliation_jobs
    where repository_id = ${repositoryId}
  `;
}
