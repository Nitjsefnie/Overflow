import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";

const migrationsDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../db/migrations",
);

/** Every shipped migration, in application order. Each one is an upgrade boundary. */
const migrationNames = readdirSync(migrationsDirectory)
  .filter((name) => /^\d+_.+\.sql$/.test(name))
  .sort();

let container: StartedTestContainer | undefined;
let adminSql: Sql | undefined;
let adminDatabaseUrl = "";
const originalDatabaseUrl = process.env.DATABASE_URL;

describe("upgrading an already-deployed database", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "overflow_upgrade",
      user: "overflow_upgrade",
      password: "overflow_upgrade",
    });
    container = started.container;
    adminDatabaseUrl = started.databaseUrl;
    adminSql = postgres(adminDatabaseUrl, { max: 1 });
  });

  afterAll(async () => {
    await closeSql();
    await adminSql?.end();
    await container?.stop();

    if (originalDatabaseUrl === undefined) {
      delete process.env.DATABASE_URL;
    } else {
      process.env.DATABASE_URL = originalDatabaseUrl;
    }
  });

  it.each(migrationNames.map((name, index) => ({ boundary: name, applied: index + 1 })))(
    "applies every migration after $boundary and keeps the rows written under it",
    async ({ boundary, applied }) => {
      const databaseName = `upgrade_from_${applied}`;
      await adminSql!`create database ${adminSql!(databaseName)}`;
      process.env.DATABASE_URL = databaseUrlFor(databaseName);

      try {
        await runMigrations({ upTo: boundary });
        const sql = getSql();
        await expect(appliedMigrationNames(sql)).resolves.toEqual(migrationNames.slice(0, applied));

        const seeded = await seedDeployedRows(sql, applied);

        await runMigrations();

        await expect(appliedMigrationNames(sql)).resolves.toEqual(migrationNames);
        await expect(seededAccounts(sql, applied)).resolves.toEqual(seeded.accounts);
        await expect(seededSettlements(sql, applied)).resolves.toEqual(seeded.settlements);
      } finally {
        await closeSql();
        process.env.DATABASE_URL = adminDatabaseUrl;
      }
    },
  );
});

function databaseUrlFor(databaseName: string): string {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

async function appliedMigrationNames(sql: Sql): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`select name from schema_migrations order by name`;
  return rows.map((row) => row.name);
}

interface SeededAccount {
  github_login: string;
  enforcement_state: string;
}

interface SeededSettlement {
  proof_sha256: string;
  status: string;
  settled_points: number | null;
  review_rounds: number;
  credits: number;
  creditor_github_login: string | null;
}

interface SeededRows {
  accounts: SeededAccount[];
  settlements: SeededSettlement[];
}

/**
 * Rows a deployment could really hold at this boundary, written with only the columns the
 * boundary's schema has. At boundary 001 that is accounts alone: 002 adds
 * `registered_repositories.difficulty_scheme` as `not null` with no default and no backfill, so a
 * database that already holds repositories at 001 cannot reach 002 at all.
 */
async function seedDeployedRows(sql: Sql, applied: number): Promise<SeededRows> {
  const accounts: SeededAccount[] = [];
  const settlements: SeededSettlement[] = [];

  const memberId = await insertAccount(sql, applied, "member", "RECALIBRATING", accounts);
  if (applied >= 6) {
    // 006 extends enforcement_state; a deployment past it can already hold the new labels.
    await insertAccount(sql, applied, "warned", "WARNED", accounts);
  }

  if (applied < 2) {
    return { accounts, settlements };
  }

  const sponsorId = await insertAccount(sql, applied, "sponsor", "ACTIVE", accounts);
  const repositoryId = await insertRepository(sql, applied, sponsorId);

  settlements.push(await insertSettlement(sql, {
    applied, repositoryId, sponsorId, ordinal: 1,
    status: "SETTLED", creditorId: memberId, creditorGitHubLogin: null,
    settledPoints: 6, reviewRounds: 2, credits: 4,
  }));

  if (applied >= 3) {
    // 003 extends settlement_status; a deployment past it can already hold unclaimed credit.
    settlements.push(await insertSettlement(sql, {
      applied, repositoryId, sponsorId, ordinal: 2,
      status: "UNCLAIMED", creditorId: null, creditorGitHubLogin: `unclaimed-holder-${applied}`,
      settledPoints: 7, reviewRounds: 1, credits: 6,
    }));
  }

  accounts.sort(byLogin);
  settlements.sort(byProof);
  return { accounts, settlements };
}

async function insertAccount(
  sql: Sql,
  applied: number,
  role: string,
  enforcementState: string,
  accounts: SeededAccount[],
): Promise<string> {
  const githubLogin = `legacy-${role}-${applied}`;
  const [account] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, enforcement_state)
    values (${nextExternalId()}, ${githubLogin}, ${enforcementState}::enforcement_state)
    returning id
  `;
  accounts.push({ github_login: githubLogin, enforcement_state: enforcementState });
  return account.id;
}

async function insertRepository(sql: Sql, applied: number, sponsorId: string): Promise<string> {
  const githubRepositoryId = nextExternalId();
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    )
    values (
      ${githubRepositoryId}, ${`legacy-owner-${applied}/legacy-repository-${applied}`}, ${sponsorId},
      ${"PUBLIC"}, ${nextExternalId()}, ${sql.json(difficultyScheme())}::jsonb
    )
    returning id
  `;
  return repository.id;
}

async function insertSettlement(
  sql: Sql,
  input: {
    applied: number;
    repositoryId: string;
    sponsorId: string;
    ordinal: number;
    status: string;
    creditorId: string | null;
    creditorGitHubLogin: string | null;
    settledPoints: number;
    reviewRounds: number;
    credits: number;
  },
): Promise<SeededSettlement> {
  const githubIssueId = nextExternalId();
  const [issue] = await sql<{ id: string }[]>`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    values (
      ${githubIssueId}, ${input.repositoryId}, ${nextExternalId()}, ${"A legacy issue"},
      ${"Legacy issue evidence"}, ${`https://github.com/example/legacy/issues/${githubIssueId}`},
      ${"CLOSED"}, ${"size/M"}, 5, 5
    )
    returning id
  `;

  const githubPullRequestId = nextExternalId();
  const [pullRequest] = await sql<{ id: string }[]>`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
      author_id, state, merged_at
    )
    values (
      ${githubPullRequestId}, ${input.repositoryId}, ${issue.id}, ${nextExternalId()},
      ${`https://github.com/example/legacy/pull/${githubPullRequestId}`}, ${"A legacy contribution"},
      ${"Legacy pull request evidence"}, ${input.sponsorId}, ${"MERGED"},
      ${"2026-01-01T00:00:00.000Z"}
    )
    returning id
  `;

  if (input.applied >= 5) {
    // 005 adds the repository column to the association table 003 introduced.
    await sql`
      insert into pull_request_issues (pull_request_id, issue_id, repository_id)
      values (${pullRequest.id}, ${issue.id}, ${input.repositoryId})
    `;
  } else if (input.applied >= 3) {
    await sql`
      insert into pull_request_issues (pull_request_id, issue_id)
      values (${pullRequest.id}, ${issue.id})
    `;
  }

  const proofSha256 = proofFingerprint(input.applied, input.ordinal);
  if (input.applied >= 3) {
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${issue.id}, ${input.creditorId}, ${input.creditorGitHubLogin},
        ${input.sponsorId}, 5, ${input.settledPoints}, ${input.reviewRounds}, ${input.credits},
        ${proofSha256}, ${input.status}::settlement_status
      )
    `;
  } else {
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${issue.id}, ${input.creditorId}, ${input.sponsorId}, 5,
        ${input.settledPoints}, ${input.reviewRounds}, ${input.credits}, ${proofSha256},
        ${input.status}::settlement_status
      )
    `;
  }

  return {
    proof_sha256: proofSha256,
    status: input.status,
    settled_points: input.settledPoints,
    review_rounds: input.reviewRounds,
    credits: input.credits,
    creditor_github_login: input.applied >= 3 ? input.creditorGitHubLogin : null,
  };
}

async function seededAccounts(sql: Sql, applied: number): Promise<SeededAccount[]> {
  const rows = await sql<SeededAccount[]>`
    select github_login, enforcement_state::text as enforcement_state
    from users
    where github_login like ${`legacy-%-${applied}`}
  `;
  return [...rows].sort(byLogin);
}

async function seededSettlements(sql: Sql, applied: number): Promise<SeededSettlement[]> {
  const rows = await sql<SeededSettlement[]>`
    select
      proof_sha256,
      status::text as status,
      settled_points::integer as settled_points,
      review_rounds::integer as review_rounds,
      credits::integer as credits,
      creditor_github_login
    from settlements
    where proof_sha256 like ${`${fingerprintPrefix(applied)}%`}
  `;
  return [...rows].sort(byProof);
}

function byLogin(left: SeededAccount, right: SeededAccount): number {
  return left.github_login.localeCompare(right.github_login, "en");
}

function byProof(left: SeededSettlement, right: SeededSettlement): number {
  return left.proof_sha256.localeCompare(right.proof_sha256, "en");
}

function fingerprintPrefix(applied: number): string {
  return applied.toString(16).padStart(8, "0");
}

function proofFingerprint(applied: number, ordinal: number): string {
  return `${fingerprintPrefix(applied)}${ordinal.toString(16).padStart(56, "0")}`;
}

let externalId = 5_000_000;
function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

function difficultyScheme() {
  return {
    openingName: "Scope",
    actualName: "Delivered difficulty",
    openingLabels: [
      { label: "S", comparisonPoints: 2, reservePoints: 2 },
      { label: "M", comparisonPoints: 5, reservePoints: 5 },
      { label: "L", comparisonPoints: 8, reservePoints: 8 },
    ],
    actualLabels: Array.from({ length: 10 }, (_, index) => ({
      label: `delivered/${index + 1}`,
      points: index + 1,
    })),
  };
}
