import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { validDifficultyScheme } from "../support/difficulty-scheme";
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

/**
 * The settled status check exactly as `003_multi_issue_settlements_and_claims.sql` shipped it
 * before this branch — copied verbatim from `f361962`, enum literals and all.
 *
 * This is what every already-deployed database holds, and it is the reference the assertions
 * below compare 015's result against. It must never be regenerated from the current tree or read
 * back out of a database the branch built: both of those are the thing under test, and an
 * expectation taken from the subject cannot disagree with it.
 */
const deployedStatusCheckBody = `
  (
    status = 'SETTLED'
    and creditor_id is not null
    and settled_points is not null
    and settled_points between 1 and 10
    and credits = greatest(0, settled_points - review_rounds)
  )
  or (
    status = 'UNCLAIMED'
    and creditor_id is null
    and creditor_github_login is not null
    and length(trim(creditor_github_login)) > 0
    and settled_points is not null
    and settled_points between 1 and 10
    and credits = greatest(0, settled_points - review_rounds)
  )
  or (
    status = 'UNSETTLED'
    and settled_points is null
    and credits = 0
  )
`;

const originalDatabaseUrl = process.env.DATABASE_URL;
let container: StartedTestContainer | undefined;
let adminSql: Sql | undefined;
let adminDatabaseUrl = "";
/** `pg_get_constraintdef` of the check the pre-branch 003 installed — the independent reference. */
let deployedStatusCheck = "";
let freshInstallStatusCheck = "";

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "overflow_upgrade",
    user: "overflow_upgrade",
    password: "overflow_upgrade",
  });
  container = started.container;
  adminDatabaseUrl = started.databaseUrl;
  adminSql = postgres(adminDatabaseUrl, { max: 1 });

  deployedStatusCheck = await onNewDatabase("deployed_003_reference", async (sql) => {
    await runMigrations({ upTo: "003_multi_issue_settlements_and_claims.sql" });
    await installDeployedStatusCheck(sql);
    return settlementStatusCheck(sql);
  });

  freshInstallStatusCheck = await onNewDatabase("upgrade_from_empty", async (sql) => {
    await runMigrations();
    return settlementStatusCheck(sql);
  });
});

afterAll(async () => {
  await closeSql();
  await adminSql?.end();
  await container?.stop();
  restoreDatabaseUrl();
});

describe("upgrading an already-deployed database", () => {
  it("ends a fresh install on the check the original 003 installed", () => {
    // Not a rendering comparison: deployedStatusCheck comes from applying the pre-branch 003
    // constraint text, which nothing in this branch writes. A 015 that changes the rule — a
    // widened points bound, a dropped limb — disagrees with it here.
    expect(freshInstallStatusCheck).toBe(deployedStatusCheck);
    expect(freshInstallStatusCheck).toContain("'UNCLAIMED'::settlement_status");
    expect(freshInstallStatusCheck).not.toContain("(status)::text");
  });

  it.each(migrationNames.map((name, index) => ({ boundary: name, applied: index + 1 })))(
    "applies every migration after $boundary and keeps the rows written under it",
    async ({ boundary, applied }) => {
      await onNewDatabase(`upgrade_from_${applied}`, async (sql) => {
        await runMigrations({ upTo: boundary });
        await expect(appliedMigrationNames(sql)).resolves.toEqual(migrationNames.slice(0, applied));

        if (applied >= 3) {
          // A database deployed before this branch ran the old 003 and holds the enum-typed
          // check. Rebuilding it here is what makes this the population 015 exists to converge;
          // without it every boundary carries the transitional text form 015 also produces, and
          // the comparison below has nothing to disagree about.
          await installDeployedStatusCheck(sql);
        }

        const seeded = await seedDeployedRows(sql, applied);

        await runMigrations();

        await expect(appliedMigrationNames(sql)).resolves.toEqual(migrationNames);
        await expect(databaseContents(sql)).resolves.toEqual(seeded);
        await expect(settlementStatusCheck(sql)).resolves.toBe(deployedStatusCheck);
      });
    },
  );
});

describe("the settled status check an upgraded database enforces", () => {
  // The rendering assertions above pass whatever rule 015 installs. These drive it: every write
  // the check exists to refuse has to be refused, and the writes it exists to allow accepted.
  let sponsorId = "";
  let creditorId = "";

  beforeAll(async () => {
    await admin()`create database status_check_enforcement`;
    process.env.DATABASE_URL = databaseUrlFor("status_check_enforcement");
    await runMigrations();
    const sql = getSql();
    sponsorId = (await insertAccount(sql, "check-sponsor", "ACTIVE")).id;
    creditorId = (await insertAccount(sql, "check-creditor", "ACTIVE")).id;
  });

  afterAll(async () => {
    await closeSql();
    process.env.DATABASE_URL = adminDatabaseUrl;
  });

  it.each([
    { name: "a settled amount above the ten-point ceiling", row: { settledPoints: 11, credits: 9 } },
    { name: "a settled amount below the one-point floor", row: { settledPoints: 0, credits: 0 } },
    { name: "settled credit with no creditor", row: { creditorId: null } },
    { name: "settled credit that is not points minus review rounds", row: { credits: 3 } },
    { name: "settled credit with no settled amount", row: { settledPoints: null, credits: 0 } },
    {
      name: "unclaimed credit held by an account instead of a login",
      row: { status: "UNCLAIMED", creditorGitHubLogin: "holder" },
    },
    {
      name: "unclaimed credit with a blank holding login",
      row: { status: "UNCLAIMED", creditorId: null, creditorGitHubLogin: "   " },
    },
    {
      name: "unclaimed credit naming nobody at all",
      row: { status: "UNCLAIMED", creditorId: null, creditorGitHubLogin: null },
    },
    {
      name: "unsettled work carrying credit",
      row: { status: "UNSETTLED", settledPoints: null, credits: 1 },
    },
    {
      name: "unsettled work carrying a settled amount",
      row: { status: "UNSETTLED", settledPoints: 6, credits: 0 },
    },
  ])("refuses $name", async ({ row }) => {
    await expect(insertSettlementRow(getSql(), { sponsorId, creditorId, ...row }))
      .rejects.toThrow(/settlements_materialized_status_check/);
  });

  it.each([
    { name: "settled credit", row: {} },
    { name: "settled credit whose review rounds exceed its points", row: { reviewRounds: 9, credits: 0 } },
    {
      name: "unclaimed credit held by a login",
      row: { status: "UNCLAIMED", creditorId: null, creditorGitHubLogin: "holder" },
    },
    { name: "unsettled work", row: { status: "UNSETTLED", settledPoints: null, credits: 0 } },
  ])("accepts $name", async ({ row }) => {
    await expect(insertSettlementRow(getSql(), { sponsorId, creditorId, ...row }))
      .resolves.toBeUndefined();
  });
});

describe("a migration and the row that records it", () => {
  it("keeps neither the schema change nor the record when the record cannot be written", async () => {
    // The runner's atomicity claim only has a control if the ledger write can be made to fail:
    // with both halves in one transaction the migration goes back with it, and with the record
    // written in a transaction of its own the schema change survives a ledger failure.
    await onNewDatabase("ledger_atomicity", async (sql) => {
      await runMigrations({ upTo: "011_api_tokens.sql" });
      await sql.unsafe(`
        create function refuse_recording() returns trigger language plpgsql as $$
        begin
          if new.name = '012_unwritable_closure_kinds.sql' then
            raise exception 'the fixture refused to record %', new.name;
          end if;
          return new;
        end;
        $$;
        create trigger refuse_recording before insert on schema_migrations
        for each row execute function refuse_recording();
      `);

      await expect(runMigrations()).rejects.toThrow(
        "the fixture refused to record 012_unwritable_closure_kinds.sql",
      );

      // 012's whole schema effect is this type and the column it backs.
      await expect(sql`
        select typname from pg_type where typname = 'unwritable_closure_kind'
      `).resolves.toEqual([]);
      await expect(appliedMigrationNames(sql)).resolves.toEqual(migrationNames.slice(0, 11));
    });
  });
});

/** The admin connection to the container's own database, used to create the per-case databases. */
function admin(): Sql {
  if (adminSql === undefined) {
    throw new Error("The admin connection is not open.");
  }
  return adminSql;
}

function databaseUrlFor(databaseName: string): string {
  const url = new URL(adminDatabaseUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
}

function restoreDatabaseUrl(): void {
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
}

/** Runs `body` against a database of its own, then closes the client and restores DATABASE_URL. */
async function onNewDatabase<T>(databaseName: string, body: (sql: Sql) => Promise<T>): Promise<T> {
  await admin()`create database ${admin()(databaseName)}`;
  process.env.DATABASE_URL = databaseUrlFor(databaseName);
  try {
    return await body(getSql());
  } finally {
    await closeSql();
    process.env.DATABASE_URL = adminDatabaseUrl;
  }
}

async function appliedMigrationNames(sql: Sql): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`select name from schema_migrations order by name`;
  return rows.map((row) => row.name);
}

/** How PostgreSQL renders the settled status check this database currently enforces. */
async function settlementStatusCheck(sql: Sql): Promise<string> {
  const [constraint] = await sql<{ definition: string }[]>`
    select pg_get_constraintdef(oid) as definition
    from pg_constraint
    where conrelid = 'settlements'::regclass
      and conname = 'settlements_materialized_status_check'
  `;
  return constraint.definition;
}

/** Replaces whatever check this database holds with the one the pre-branch 003 installed. */
async function installDeployedStatusCheck(sql: Sql): Promise<void> {
  await sql.unsafe(`
    alter table settlements
    drop constraint settlements_materialized_status_check,
    add constraint settlements_materialized_status_check check (${deployedStatusCheckBody})
  `);
}

interface SeededAccount {
  github_user_id: number;
  github_login: string;
  enforcement_state: string;
}

interface SeededRepository {
  github_repository_id: number;
  owner_name: string;
  sponsor_login: string;
  visibility: string;
  github_webhook_id: number;
  difficulty_scheme: unknown;
}

interface SeededIssue {
  github_issue_id: number;
  issue_number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  opening_label: string;
  opening_comparison_points: number;
  opening_reserve_points: number;
}

interface SeededPullRequest {
  github_pull_request_id: number;
  pull_request_number: number;
  title: string;
  body: string;
  url: string;
  state: string;
  merged_at: Date;
  author_login: string;
}

interface SeededLink {
  github_pull_request_id: number;
  github_issue_id: number;
}

interface SeededSettlement {
  proof_sha256: string;
  status: string;
  settled_points: number | null;
  review_rounds: number;
  credits: number;
  opening_comparison_points: number;
  creditor_login: string | null;
  creditor_github_login: string | null;
  debtor_login: string;
}

interface DatabaseContents {
  accounts: SeededAccount[];
  repositories: SeededRepository[];
  issues: SeededIssue[];
  pullRequests: SeededPullRequest[];
  pullRequestIssues: SeededLink[];
  settlements: SeededSettlement[];
}

/**
 * Rows a deployment could really hold at this boundary, written with only the columns the
 * boundary's schema has, and the whole contents the database should hold once it is upgraded.
 *
 * At boundary 001 that is accounts alone: 002 adds `registered_repositories.difficulty_scheme` as
 * `not null` with no default and no backfill, so a database that already holds repositories at
 * 001 cannot reach 002 at all (issue 114).
 */
async function seedDeployedRows(sql: Sql, applied: number): Promise<DatabaseContents> {
  const contents: DatabaseContents = {
    accounts: [], repositories: [], issues: [], pullRequests: [],
    pullRequestIssues: [], settlements: [],
  };

  const member = await insertAccount(sql, "member", "RECALIBRATING");
  contents.accounts.push(member.row);
  if (applied >= 6) {
    // 006 extends enforcement_state; a deployment past it can already hold the new labels.
    contents.accounts.push((await insertAccount(sql, "warned", "WARNED")).row);
  }

  if (applied < 2) {
    return sortContents(contents);
  }

  const sponsor = await insertAccount(sql, "sponsor", "ACTIVE");
  contents.accounts.push(sponsor.row);
  const repository = await insertRepository(sql, sponsor);
  contents.repositories.push(repository.row);

  await insertSettlement(sql, contents, {
    applied, repository, sponsor, ordinal: 1,
    status: "SETTLED", creditor: member, creditorGitHubLogin: null,
    settledPoints: 6, reviewRounds: 2, credits: 4,
  });

  if (applied >= 3) {
    // 003 extends settlement_status; a deployment past it can already hold unclaimed credit.
    await insertSettlement(sql, contents, {
      applied, repository, sponsor, ordinal: 2,
      status: "UNCLAIMED", creditor: null, creditorGitHubLogin: "unclaimed-holder",
      settledPoints: 7, reviewRounds: 1, credits: 6,
    });
  }

  return sortContents(contents);
}

interface SeededAccountHandle {
  id: string;
  row: SeededAccount;
}

interface SeededRepositoryHandle {
  id: string;
  row: SeededRepository;
}

async function insertAccount(
  sql: Sql,
  role: string,
  enforcementState: string,
): Promise<SeededAccountHandle> {
  const githubUserId = nextExternalId();
  const githubLogin = `legacy-${role}`;
  const [account] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, enforcement_state)
    values (${githubUserId}, ${githubLogin}, ${enforcementState}::enforcement_state)
    returning id
  `;
  return {
    id: account.id,
    row: {
      github_user_id: githubUserId,
      github_login: githubLogin,
      enforcement_state: enforcementState,
    },
  };
}

async function insertRepository(
  sql: Sql,
  sponsor: SeededAccountHandle,
): Promise<SeededRepositoryHandle> {
  const row: SeededRepository = {
    github_repository_id: nextExternalId(),
    owner_name: "legacy-owner/legacy-repository",
    sponsor_login: sponsor.row.github_login,
    visibility: "PUBLIC",
    github_webhook_id: nextExternalId(),
    difficulty_scheme: validDifficultyScheme(),
  };
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    )
    values (
      ${row.github_repository_id}, ${row.owner_name}, ${sponsor.id}, ${row.visibility},
      ${row.github_webhook_id}, ${asJson(sql, row.difficulty_scheme)}::jsonb
    )
    returning id
  `;
  return { id: repository.id, row };
}

async function insertSettlement(
  sql: Sql,
  contents: DatabaseContents,
  input: {
    applied: number;
    repository: SeededRepositoryHandle;
    sponsor: SeededAccountHandle;
    ordinal: number;
    status: string;
    creditor: SeededAccountHandle | null;
    creditorGitHubLogin: string | null;
    settledPoints: number;
    reviewRounds: number;
    credits: number;
  },
): Promise<void> {
  const issueRow: SeededIssue = {
    github_issue_id: nextExternalId(),
    issue_number: nextExternalId(),
    title: `A legacy issue ${input.ordinal}`,
    body: "Legacy issue evidence",
    url: `https://github.com/example/legacy/issues/${input.ordinal}`,
    state: "CLOSED",
    opening_label: "size/M",
    opening_comparison_points: 5,
    opening_reserve_points: 5,
  };
  const [issue] = await sql<{ id: string }[]>`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    values (
      ${issueRow.github_issue_id}, ${input.repository.id}, ${issueRow.issue_number},
      ${issueRow.title}, ${issueRow.body}, ${issueRow.url}, ${issueRow.state},
      ${issueRow.opening_label}, ${issueRow.opening_comparison_points},
      ${issueRow.opening_reserve_points}
    )
    returning id
  `;
  contents.issues.push(issueRow);

  const pullRequestRow: SeededPullRequest = {
    github_pull_request_id: nextExternalId(),
    pull_request_number: nextExternalId(),
    title: `A legacy contribution ${input.ordinal}`,
    body: "Legacy pull request evidence",
    url: `https://github.com/example/legacy/pull/${input.ordinal}`,
    state: "MERGED",
    merged_at: new Date("2026-01-01T00:00:00.000Z"),
    author_login: input.sponsor.row.github_login,
  };
  const [pullRequest] = await sql<{ id: string }[]>`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
      author_id, state, merged_at
    )
    values (
      ${pullRequestRow.github_pull_request_id}, ${input.repository.id}, ${issue.id},
      ${pullRequestRow.pull_request_number}, ${pullRequestRow.url}, ${pullRequestRow.title},
      ${pullRequestRow.body}, ${input.sponsor.id}, ${pullRequestRow.state},
      ${pullRequestRow.merged_at}
    )
    returning id
  `;
  contents.pullRequests.push(pullRequestRow);
  // 003 creates the association table and backfills it from pull_requests.issue_id, so a boundary
  // before it still ends the upgrade with this link.
  contents.pullRequestIssues.push({
    github_pull_request_id: pullRequestRow.github_pull_request_id,
    github_issue_id: issueRow.github_issue_id,
  });

  if (input.applied >= 5) {
    // 005 adds the repository column to the association table 003 introduced.
    await sql`
      insert into pull_request_issues (pull_request_id, issue_id, repository_id)
      values (${pullRequest.id}, ${issue.id}, ${input.repository.id})
    `;
  } else if (input.applied >= 3) {
    await sql`
      insert into pull_request_issues (pull_request_id, issue_id)
      values (${pullRequest.id}, ${issue.id})
    `;
  }

  const settlementRow: SeededSettlement = {
    proof_sha256: proofFingerprint(input.ordinal),
    status: input.status,
    settled_points: input.settledPoints,
    review_rounds: input.reviewRounds,
    credits: input.credits,
    opening_comparison_points: 5,
    creditor_login: input.creditor?.row.github_login ?? null,
    creditor_github_login: input.creditorGitHubLogin,
    debtor_login: input.sponsor.row.github_login,
  };
  if (input.applied >= 3) {
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${issue.id}, ${input.creditor?.id ?? null},
        ${input.creditorGitHubLogin}, ${input.sponsor.id},
        ${settlementRow.opening_comparison_points}, ${input.settledPoints}, ${input.reviewRounds},
        ${input.credits}, ${settlementRow.proof_sha256}, ${input.status}::settlement_status
      )
    `;
  } else {
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${issue.id}, ${input.creditor?.id ?? null}, ${input.sponsor.id},
        ${settlementRow.opening_comparison_points}, ${input.settledPoints}, ${input.reviewRounds},
        ${input.credits}, ${settlementRow.proof_sha256}, ${input.status}::settlement_status
      )
    `;
  }
  contents.settlements.push(settlementRow);
}

/**
 * Every row of every table the seeder writes. No migration creates an account, a repository, an
 * issue, a pull request or a settlement, so reading the tables whole catches a row an upgrade
 * invented as well as one it rewrote or dropped.
 */
async function databaseContents(sql: Sql): Promise<DatabaseContents> {
  const [accounts, repositories, issues, pullRequests, pullRequestIssues, settlements] =
    await Promise.all([
      sql<SeededAccount[]>`
        select github_user_id::integer, github_login, enforcement_state::text as enforcement_state
        from users
      `,
      sql<SeededRepository[]>`
        select
          registered_repositories.github_repository_id::integer,
          registered_repositories.owner_name,
          sponsor.github_login as sponsor_login,
          registered_repositories.visibility::text as visibility,
          registered_repositories.github_webhook_id::integer,
          registered_repositories.difficulty_scheme
        from registered_repositories
        join users as sponsor on sponsor.id = registered_repositories.sponsor_id
      `,
      sql<SeededIssue[]>`
        select github_issue_id::integer, issue_number, title, body, url, state::text as state,
          opening_label, opening_comparison_points, opening_reserve_points
        from issues
      `,
      sql<SeededPullRequest[]>`
        select
          pull_requests.github_pull_request_id::integer,
          pull_requests.pull_request_number,
          pull_requests.title,
          pull_requests.body,
          pull_requests.url,
          pull_requests.state::text as state,
          pull_requests.merged_at,
          author.github_login as author_login
        from pull_requests
        join users as author on author.id = pull_requests.author_id
      `,
      sql<SeededLink[]>`
        select
          pull_requests.github_pull_request_id::integer,
          issues.github_issue_id::integer
        from pull_request_issues
        join pull_requests on pull_requests.id = pull_request_issues.pull_request_id
        join issues on issues.id = pull_request_issues.issue_id
      `,
      sql<SeededSettlement[]>`
        select
          settlements.proof_sha256,
          settlements.status::text as status,
          settlements.settled_points,
          settlements.review_rounds,
          settlements.credits,
          settlements.opening_comparison_points,
          creditor.github_login as creditor_login,
          settlements.creditor_github_login,
          debtor.github_login as debtor_login
        from settlements
        join users as debtor on debtor.id = settlements.debtor_id
        left join users as creditor on creditor.id = settlements.creditor_id
      `,
    ]);

  return sortContents({
    accounts: [...accounts],
    repositories: [...repositories],
    issues: [...issues],
    pullRequests: [...pullRequests],
    pullRequestIssues: [...pullRequestIssues],
    settlements: [...settlements],
  });
}

function sortContents(contents: DatabaseContents): DatabaseContents {
  contents.accounts.sort(by((account) => account.github_login));
  contents.repositories.sort(by((repository) => repository.owner_name));
  contents.issues.sort(by((issue) => issue.title));
  contents.pullRequests.sort(by((pullRequest) => pullRequest.title));
  contents.pullRequestIssues.sort(by((link) => String(link.github_pull_request_id)));
  contents.settlements.sort(by((settlement) => settlement.proof_sha256));
  return contents;
}

function by<T>(key: (value: T) => string): (left: T, right: T) => number {
  return (left, right) => key(left).localeCompare(key(right), "en");
}

/**
 * One settlement written straight at the check, on its own issue and pull request so that a
 * rejection can only come from the check and never from a uniqueness constraint.
 */
async function insertSettlementRow(
  sql: Sql,
  input: {
    sponsorId: string;
    creditorId: string | null;
    status?: string;
    creditorGitHubLogin?: string | null;
    settledPoints?: number | null;
    reviewRounds?: number;
    credits?: number;
  },
): Promise<void> {
  const githubIssueId = nextExternalId();
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
    )
    values (
      ${nextExternalId()}, ${`check-owner/check-${githubIssueId}`}, ${input.sponsorId},
      ${"PUBLIC"}, ${nextExternalId()}, ${asJson(sql, validDifficultyScheme())}::jsonb
    )
    returning id
  `;
  const [issue] = await sql<{ id: string }[]>`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    values (
      ${githubIssueId}, ${repository.id}, ${nextExternalId()}, ${"A check issue"},
      ${"Check evidence"}, ${`https://github.com/example/check/issues/${githubIssueId}`},
      ${"CLOSED"}, ${"size/M"}, 5, 5
    )
    returning id
  `;
  const [pullRequest] = await sql<{ id: string }[]>`
    insert into pull_requests (
      github_pull_request_id, repository_id, issue_id, pull_request_number, url, title, body,
      author_id, state, merged_at
    )
    values (
      ${nextExternalId()}, ${repository.id}, ${issue.id}, ${nextExternalId()},
      ${`https://github.com/example/check/pull/${githubIssueId}`}, ${"A check contribution"},
      ${"Check evidence"}, ${input.sponsorId}, ${"MERGED"}, ${"2026-01-01T00:00:00.000Z"}
    )
    returning id
  `;
  await sql`
    insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequest.id}, ${issue.id}, ${repository.id})
  `;

  await sql`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, creditor_github_login, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
    )
    values (
      ${pullRequest.id}, ${issue.id},
      ${input.creditorId === undefined ? null : input.creditorId},
      ${input.creditorGitHubLogin ?? null}, ${input.sponsorId}, 5,
      ${input.settledPoints === undefined ? 6 : input.settledPoints},
      ${input.reviewRounds ?? 2}, ${input.credits ?? 4},
      ${proofFingerprint(githubIssueId)}, ${input.status ?? "SETTLED"}::settlement_status
    )
  `;
}

function asJson(sql: Sql, value: unknown): ReturnType<Sql["json"]> {
  return sql.json(value as Parameters<Sql["json"]>[0]);
}

function proofFingerprint(ordinal: number): string {
  return ordinal.toString(16).padStart(64, "0");
}

let externalId = 5_000_000;
function nextExternalId(): number {
  externalId += 1;
  return externalId;
}
