import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import type { DifficultyScheme } from "@/lib/domain/difficulty-scheme";
import type { EnforcementState, SqlClient } from "@/lib/db/types";
import type { NewRegisteredRepository } from "@/lib/repositories/register";
import {
  RepositoryOwnerNameConflictError,
  RepositoryRegistrationEnforcementError,
  RepositorySchemeChangeForbiddenError,
  RepositorySchemeChangeOrderError,
  RepositoryWebhookIdConflictError,
} from "@/lib/repositories/register";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";

let container: StartedTestContainer | undefined;
let sql: Sql;
let store: PostgresRepositoryStore;
let externalId = 8_600_000;
const originalDatabaseUrl = process.env.DATABASE_URL;
const tokenEncryptionKey = Buffer.alloc(32, 19).toString("base64url");
const DAY_MS = 24 * 60 * 60 * 1000;

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

  it("reads the persisted webhook and sponsor only for an active registration", async () => {
    const created = await store.createRepository(newRepository({ sponsorId: await sponsor() }));
    expect(created).not.toBeNull();
    expect(await store.findActiveRepositoryById(created!.id)).toEqual(created);
    await sql`update registered_repositories set active = false where id = ${created!.id}`;
    expect(await store.findActiveRepositoryById(created!.id)).toBeNull();
    expect(await store.findActiveRepositoryById("00000000-0000-0000-0000-000000000000")).toBeNull();
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
      message: `The GitHub path ${held.ownerName} is already claimed by a registration.`,
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

  it("names the held GitHub webhook id when a new numeric identity is submitted under a claimed webhook id", async () => {
    const held = await registeredRepository();
    const submission = newRepository({
      sponsorId: await sponsor(),
      githubWebhookId: held.githubWebhookId,
    });

    await expect(store.createRepository(submission)).rejects.toThrow(RepositoryWebhookIdConflictError);
    await expect(countOf(submission.githubRepositoryId)).resolves.toBe(0);
  });

  it("carries the claimed webhook id on the webhook conflict it raises", async () => {
    const held = await registeredRepository();
    const submission = newRepository({
      sponsorId: await sponsor(),
      githubWebhookId: held.githubWebhookId,
    });

    await expect(store.createRepository(submission)).rejects.toMatchObject({
      name: "RepositoryWebhookIdConflictError",
      githubWebhookId: held.githubWebhookId,
      message: `The GitHub webhook id ${held.githubWebhookId} is already claimed by a registration.`,
    });
  });

  // Both conflict messages promise the sponsor that the submitted repository is not
  // registered. That holds only because PostgreSQL consults the on-conflict arbiter index
  // before the table's other unique indexes, so a submission that collides on the numeric
  // identity as well resolves to an absent row instead of raising. Which index arbitrates is
  // part of the property, not a detail of it: the two webhook-id cases submit an unclaimed
  // path, so they answer an absent row only while github_repository_id is the arbiter.
  it("reports a submission whose numeric identity and path are both held by one registration as an absent row", async () => {
    const held = await registeredRepository();
    const submission = newRepository({
      sponsorId: await sponsor(),
      githubRepositoryId: held.githubRepositoryId,
      ownerName: held.ownerName,
    });

    await expect(store.createRepository(submission)).resolves.toBeNull();
  });

  it("reports a submission whose numeric identity and path are held by different registrations as an absent row", async () => {
    const holdsIdentity = await registeredRepository();
    const holdsPath = await registeredRepository();
    const submission = newRepository({
      sponsorId: await sponsor(),
      githubRepositoryId: holdsIdentity.githubRepositoryId,
      ownerName: holdsPath.ownerName,
    });

    await expect(store.createRepository(submission)).resolves.toBeNull();
  });

  it("reports a submission whose numeric identity and webhook id are both held by one registration as an absent row", async () => {
    const held = await registeredRepository();
    const submission = newRepository({
      sponsorId: await sponsor(),
      githubRepositoryId: held.githubRepositoryId,
      githubWebhookId: held.githubWebhookId,
    });

    await expect(store.createRepository(submission)).resolves.toBeNull();
  });

  it("reports a submission whose numeric identity and webhook id are held by different registrations as an absent row", async () => {
    const holdsIdentity = await registeredRepository();
    const holdsWebhookId = await registeredRepository();
    const submission = newRepository({
      sponsorId: await sponsor(),
      githubRepositoryId: holdsIdentity.githubRepositoryId,
      githubWebhookId: holdsWebhookId.githubWebhookId,
    });

    await expect(store.createRepository(submission)).resolves.toBeNull();
  });

  it("rethrows a check-constraint violation, which names a constraint without being a unique violation", async () => {
    const submission = newRepository({ sponsorId: await sponsor(), ownerName: "   " });

    await expect(store.createRepository(submission)).rejects.toMatchObject({
      code: "23514",
      constraint_name: "registered_repositories_owner_name_check",
    });
    await expect(countOf(submission.githubRepositoryId)).resolves.toBe(0);
  });

  // The store recognises a collision by the constraint name PostgreSQL generates, so a
  // migration that renames one silently retires a conflict branch. Read the names back.
  it("declares the unique constraints the conflict branches are named after", async () => {
    const rows = await sql<{ conname: string }[]>`
      select conname
      from pg_constraint
      where conrelid = 'registered_repositories'::regclass
        and contype = 'u'
      order by conname
    `;

    expect(rows.map((row) => row.conname)).toEqual([
      "registered_repositories_github_repository_id_key",
      "registered_repositories_github_webhook_id_key",
      "registered_repositories_owner_name_key",
    ]);
  });

  it("refuses a sponsor whose enforcement state makes it ineligible", async () => {
    const submission = newRepository({ sponsorId: await sponsor("BANNED") });

    await expect(store.createRepository(submission)).rejects.toThrow(RepositoryRegistrationEnforcementError);
    await expect(countOf(submission.githubRepositoryId)).resolves.toBe(0);
  });

  it("seeds the registered catalog as the repository's first version row", async () => {
    const submission = newRepository({ sponsorId: await sponsor() });

    await expect(store.createRepository(submission)).resolves.toMatchObject({
      githubRepositoryId: submission.githubRepositoryId,
    });

    const rows = await sql<VersionRow[]>`
      select version_number, scheme, effective_from
      from repository_difficulty_scheme_versions
      where github_repository_id = ${submission.githubRepositoryId}
      order by version_number
    `;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.scheme).toEqual(difficultyScheme());
    expect(Number(rows[0]!.effective_from)).toBeGreaterThan(0);
  });
});

describe("changing a registered repository's difficulty catalog", () => {
  let container: StartedTestContainer | undefined;
  const originalDatabaseUrl = process.env.DATABASE_URL;

  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "registration_catalog",
      user: "registration_catalog",
      password: "registration_catalog",
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

  it("appends a version and moves the current catalog when the sponsor changes it", async () => {
    const submission = await registeredViaStore();
    const effectiveFrom = new Date(Date.now() + DAY_MS);

    const result = await store.appendDifficultySchemeVersion({
      githubRepositoryId: submission.githubRepositoryId,
      sponsorId: submission.sponsorId,
      scheme: changedScheme(),
      effectiveFrom,
    });

    expect(result).toMatchObject({ changed: true, versionNumber: 2 });
    const [current] = await sql<{ scheme: unknown }[]>`
      select difficulty_scheme as scheme from registered_repositories
      where github_repository_id = ${submission.githubRepositoryId}
    `;
    expect(current?.scheme).toEqual(changedScheme());
    const versions = await sql<VersionRow[]>`
      select version_number, scheme, effective_from
      from repository_difficulty_scheme_versions
      where github_repository_id = ${submission.githubRepositoryId}
      order by version_number
    `;
    expect(versions.map((version) => version.scheme)).toEqual([difficultyScheme(), changedScheme()]);
    expect(Number(versions[1]!.effective_from)).toBe(effectiveFrom.getTime());
  });

  it("reports an identical catalog as unchanged and appends no version", async () => {
    const submission = await registeredViaStore();

    await expect(store.appendDifficultySchemeVersion({
      githubRepositoryId: submission.githubRepositoryId,
      sponsorId: submission.sponsorId,
      scheme: difficultyScheme(),
      effectiveFrom: new Date(Date.now() + DAY_MS),
    })).resolves.toMatchObject({ changed: false, versionNumber: null, effectiveFrom: null });

    const count = await sql<{ count: number | string }[]>`
      select count(*) as count from repository_difficulty_scheme_versions
      where github_repository_id = ${submission.githubRepositoryId}
    `;
    expect(Number(count[0]!.count)).toBe(1);
  });

  it("refuses a catalog change from anyone but the repository's sponsor", async () => {
    const submission = await registeredViaStore();
    const outsider = await sponsor();

    await expect(store.appendDifficultySchemeVersion({
      githubRepositoryId: submission.githubRepositoryId,
      sponsorId: outsider,
      scheme: changedScheme(),
      effectiveFrom: new Date(Date.now() + DAY_MS),
    })).rejects.toThrow(RepositorySchemeChangeForbiddenError);

    const versions = await sql<{ count: number | string }[]>`
      select count(*) as count from repository_difficulty_scheme_versions
      where github_repository_id = ${submission.githubRepositoryId}
    `;
    expect(Number(versions[0]!.count)).toBe(1);
  });

  it("answers null when no registration holds the submitted GitHub identity", async () => {
    await expect(store.appendDifficultySchemeVersion({
      githubRepositoryId: externalId++,
      sponsorId: await sponsor(),
      scheme: changedScheme(),
      effectiveFrom: new Date(Date.now() + DAY_MS),
    })).resolves.toBeNull();
  });

  it("leaves a scheme the validity check refuses to the database constraint", async () => {
    const submission = await registeredViaStore();
    const incomplete = difficultyScheme();
    incomplete.actualLabels = incomplete.actualLabels.slice(0, 9);

    await expect(store.appendDifficultySchemeVersion({
      githubRepositoryId: submission.githubRepositoryId,
      sponsorId: submission.sponsorId,
      scheme: incomplete,
      effectiveFrom: new Date(Date.now() + DAY_MS),
    })).rejects.toMatchObject({ code: "23514" });

    const versions = await sql<{ count: number | string }[]>`
      select count(*) as count from repository_difficulty_scheme_versions
      where github_repository_id = ${submission.githubRepositoryId}
    `;
    expect(Number(versions[0]!.count)).toBe(1);
  });

  it("reads a merely reordered resubmission as the unchanged catalog", async () => {
    const submission = await registeredViaStore(twoOpeningLabelScheme());
    const reordered = reorderedScheme();

    await expect(store.appendDifficultySchemeVersion({
      githubRepositoryId: submission.githubRepositoryId,
      sponsorId: submission.sponsorId,
      scheme: reordered,
      effectiveFrom: new Date(Date.now() + DAY_MS),
    })).resolves.toMatchObject({ changed: false, versionNumber: null, effectiveFrom: null });

    const versions = await sql<{ count: number | string }[]>`
      select count(*) as count from repository_difficulty_scheme_versions
      where github_repository_id = ${submission.githubRepositoryId}
    `;
    expect(Number(versions[0]!.count)).toBe(1);
  });

  it("refuses a version whose effective instant predates the latest version's", async () => {
    const submission = await registeredViaStore();

    await store.appendDifficultySchemeVersion({
      githubRepositoryId: submission.githubRepositoryId,
      sponsorId: submission.sponsorId,
      scheme: changedScheme(),
      effectiveFrom: new Date(Date.now() + 2 * DAY_MS),
    });

    await expect(store.appendDifficultySchemeVersion({
      githubRepositoryId: submission.githubRepositoryId,
      sponsorId: submission.sponsorId,
      scheme: difficultyScheme(),
      effectiveFrom: new Date(Date.now() + DAY_MS),
    })).rejects.toThrow(RepositorySchemeChangeOrderError);

    const versions = await sql<VersionRow[]>`
      select version_number, effective_from
      from repository_difficulty_scheme_versions
      where github_repository_id = ${submission.githubRepositoryId}
      order by version_number
    `;
    expect(versions).toHaveLength(2);
    expect(Number(versions[1]!.effective_from)).toBeGreaterThan(Date.now());
  });

  // The catalog-change tests register through the store rather than the direct
  // insert above: a registration that never passed through createRepository
  // carries no catalog version history for the append to continue.
  async function registeredViaStore(scheme: DifficultyScheme = difficultyScheme()): Promise<NewRegisteredRepository> {
    const submission = newRepository({ sponsorId: await sponsor(), difficultyScheme: scheme });
    await expect(store.createRepository(submission)).resolves.toMatchObject({
      githubRepositoryId: submission.githubRepositoryId,
    });
    return submission;
  }
});

describe("raising a database error the registration store must not convert", () => {
  it("rethrows a unique violation on a constraint neither conflict branch recognises", async () => {
    const reported = { code: "23505", constraint_name: "registered_repositories_pkey" };

    await expect(storeOverFailingSql(reported).createRepository(submissionShape())).rejects.toEqual(reported);
  });

  it("rethrows an error naming a constraint a conflict branch recognises when its SQLSTATE is not a unique violation", async () => {
    const reported = { code: "23514", constraint_name: "registered_repositories_owner_name_key" };

    await expect(storeOverFailingSql(reported).createRepository(submissionShape())).rejects.toEqual(reported);
  });
});

// The store reads the failing constraint off whatever the driver threw, so the guard is
// exercised by handing it a query that throws that shape. `sql.array` and `sql.json` are
// evaluated while building the statement, before the tagged template call raises.
function storeOverFailingSql(error: unknown): PostgresRepositoryStore {
  const failingSql = (() => {
    throw error;
  }) as unknown as Record<string, unknown>;
  failingSql.array = (value: unknown) => value;
  failingSql.json = (value: unknown) => value;
  return new PostgresRepositoryStore(failingSql as unknown as SqlClient, tokenEncryptionKey);
}

function submissionShape(): NewRegisteredRepository {
  return newRepository({ sponsorId: "00000000-0000-0000-0000-000000000000" });
}

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

// One opening label added and one point mapping traded: a catalog change a
// dashboard can see and a re-priced label the fold must not apply backwards.
function changedScheme(): DifficultyScheme {
  const scheme = difficultyScheme();
  return {
    ...scheme,
    openingLabels: [...scheme.openingLabels, { label: "size/XL", comparisonPoints: 9, reservePoints: 9 }],
    actualLabels: scheme.actualLabels.map((label) => {
      if (label.label === "delivered/6") return { ...label, points: 7 };
      if (label.label === "delivered/7") return { ...label, points: 6 };
      return label;
    }),
  };
}

type VersionRow = {
  version_number: number | string;
  scheme: unknown;
  effective_from: Date | string;
};

// The same catalog as difficultyScheme() with both label orders reversed: a
// resubmission that reordered its labels changed nothing the validation or the
// fold reads, so it must read as the unchanged catalog.
// Two opening labels, so the reordered fixture below genuinely differs from
// canonical order in BOTH arrays — reversing a one-label array is the identity
// and would pin nothing about the opening-label comparator.
function twoOpeningLabelScheme(): DifficultyScheme {
  const scheme = difficultyScheme();
  return {
    ...scheme,
    openingLabels: [...scheme.openingLabels, { label: "size/XL", comparisonPoints: 9, reservePoints: 9 }],
  };
}

function reorderedScheme(): DifficultyScheme {
  const scheme = twoOpeningLabelScheme();
  return {
    ...scheme,
    openingLabels: [...scheme.openingLabels].reverse(),
    actualLabels: [...scheme.actualLabels].reverse(),
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
