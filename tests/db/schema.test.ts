import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres, { type Sql, type TransactionSql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { startPostgresContainer } from "../support/postgres-container";
import {
  RECONCILIATION_COORDINATION_POOL_MAX,
  closeSql,
  getCoordinationSql,
  getSql,
  withTransaction,
} from "@/lib/db/client";
import { listUnwritableClosures } from "@/lib/dashboard/queries";
import { claimGitHubIdentity } from "@/lib/fold/postgres-store";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { reconcileRepository, type ReconciliationGateway } from "@/lib/fold/reconcile";
import { verifiedRepositoryAt } from "../support/verified-repository";
import { foldRepository, type RepositoryFoldSnapshot } from "@/lib/fold/repository-fold";
import type { GitHubIssue, GitHubPullRequest } from "@/lib/github/types";
import { encryptToken } from "@/lib/security/token-cipher";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { processWebhook } from "@/lib/webhooks/processor";

let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 1_000_000;
const originalDatabaseUrl = process.env.DATABASE_URL;
type QueryableSql = Sql | TransactionSql;

describe("initial PostgreSQL materialization", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "overflow_test",
      user: "overflow_test",
      password: "overflow_test",
    });
    container = started.container;
    process.env.DATABASE_URL = started.databaseUrl;
    sql = getSql();
    await runMigrations();
    await runMigrations();
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

  it("creates every required relational table and derived view", async () => {
    const rows = await sql<{ table_name: string }[]>`
      select table_name from information_schema.tables where table_schema = 'public'
    `;

    for (const table of [
      "users",
      "registered_repositories",
      "issues",
      "pull_requests",
      "review_rounds",
      "settlements",
      "self_work_calibrations",
      "unwritable_closures",
      "webhook_deliveries",
      "reconciliation_runs",
      "reconciliation_changes",
      "calibration_audits",
      "moderation_events",
      "settlement_override_requests",
      "api_tokens",
    ]) {
      expect(rows.some((row) => row.table_name === table)).toBe(true);
    }

    const views = await sql<{ table_name: string }[]>`
      select table_name from information_schema.views where table_schema = 'public'
    `;
    expect(views.map((view) => view.table_name)).toEqual(
      expect.arrayContaining(["ledger_entries", "balances", "calibration_statistics"]),
    );
  });

  it("loads fold users and the repository sponsor by immutable GitHub ids", async () => {
    const firstId = await insertUserWithLogin(sql, "id-lookup-before-rename");
    const secondId = await insertUserWithLogin(sql, "id-lookup-second");
    const firstGitHubId = await githubUserIdOf(sql, firstId);
    const secondGitHubId = await githubUserIdOf(sql, secondId);
    await sql`update users set github_login = ${"id-lookup-renamed"} where id = ${firstId}`;
    const store = new PostgresFoldStore(sql);
    const repositoryId = await insertRepository(sql, firstId, nextExternalId());

    expect((await store.getRepository(repositoryId))?.sponsor).toMatchObject({
      id: firstId, githubUserId: firstGitHubId, githubLogin: "id-lookup-renamed",
    });
    const users = await store.findUsersByGitHubUserIds([
      firstGitHubId, secondGitHubId, firstGitHubId, 0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1,
    ]);
    expect(users).toHaveLength(2);
    expect(users).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: firstId, githubUserId: firstGitHubId, githubLogin: "id-lookup-renamed" }),
      expect.objectContaining({ id: secondId, githubUserId: secondGitHubId, githubLogin: "id-lookup-second" }),
    ]));
    expect(await store.findUsersByGitHubUserIds([secondGitHubId])).toEqual([
      expect.objectContaining({ id: secondId, githubUserId: secondGitHubId }),
    ]);
    expect(await store.findUsersByGitHubUserIds([])).toEqual([]);
    expect(await store.findUsersByGitHubUserIds([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])).toEqual([]);

    const secondRepositoryId = await insertRepository(sql, secondId, nextExternalId());
    expect((await store.getRepository(secondRepositoryId))?.sponsor).toMatchObject({
      id: secondId, githubUserId: secondGitHubId, githubLogin: "id-lookup-second",
    });
    const snapshot = materializationSnapshot({
      repositoryId, ownerName: "example/id-lookup", githubRepositoryId: 9_100_000,
      sponsorId: firstId, contributorId: secondId,
      sponsorGitHubUserId: firstGitHubId, contributorGitHubUserId: secondGitHubId,
      sponsorLogin: "id-lookup-renamed", contributorLogin: "id-lookup-second",
      issueLabels: ["M"], actualLabel: "delivered/6",
    });
    snapshot.users = users;

    const fold = foldRepository(snapshot);

    expect(fold.settlements[0]).toMatchObject({
      creditorId: secondId, creditorGitHubUserId: secondGitHubId, status: "SETTLED", credits: 6,
    });
    expect(fold.pullRequests[0]).toMatchObject({ authorId: secondId, authorGitHubUserId: secondGitHubId });
    expect(fold.ledgerEntries).toEqual([
      { accountId: secondId, counterpartyId: firstId, amount: 6 },
      { accountId: firstId, counterpartyId: secondId, amount: -6 },
    ]);
  });

  it("never looks up a user by numeric login text instead of their GitHub id", async () => {
    const accountId = await insertUserWithLogin(sql, "numeric-login-account");
    const githubUserId = await githubUserIdOf(sql, accountId);
    const otherAccountId = await insertUserWithLogin(sql, String(githubUserId));
    const otherGitHubUserId = await githubUserIdOf(sql, otherAccountId);
    expect(otherGitHubUserId).not.toBe(githubUserId);
    const store = new PostgresFoldStore(sql);

    expect(await store.findUsersByGitHubUserIds([githubUserId])).toEqual([
      expect.objectContaining({ id: accountId, githubUserId, githubLogin: "numeric-login-account" }),
    ]);
    expect(await store.findUsersByGitHubUserIds([otherGitHubUserId])).toEqual([
      expect.objectContaining({ id: otherAccountId, githubUserId: otherGitHubUserId, githubLogin: String(githubUserId) }),
    ]);
  });

  it("rejects zero before querying fold users and removes it from mixed id lookups", async () => {
    const accountId = await insertUserWithLogin(sql, "zero-boundary-account");
    const githubUserId = await githubUserIdOf(sql, accountId);
    const queries: unknown[][] = [];
    // Record the store's SQL boundary while executing every query against the real database.
    const recordingSql = new Proxy(sql, {
      apply(target, thisArg, args) {
        queries.push(args);
        return Reflect.apply(target, thisArg, args);
      },
    });
    const array = vi.spyOn(sql, "array");
    try {
      const store = new PostgresFoldStore(recordingSql);
      expect(await store.findUsersByGitHubUserIds([0])).toEqual([]);
      expect(queries).toEqual([]);
      expect(array).not.toHaveBeenCalled();

      expect(await store.findUsersByGitHubUserIds([githubUserId, 0])).toEqual([
        expect.objectContaining({ id: accountId, githubUserId }),
      ]);
      expect(queries).toHaveLength(1);
      expect(array).toHaveBeenCalledExactlyOnceWith([String(githubUserId)]);
    } finally {
      array.mockRestore();
    }
  });

  it("records each numbered migration only once", async () => {
    const rows = await sql<{ name: string; count: number }[]>`
      select name, count(*)::integer as count
      from schema_migrations
      group by name
      order by name
    `;

    expect(rows).toEqual([
      "001_initial.sql",
      "002_repository_difficulty_scheme.sql",
      "003_multi_issue_settlements_and_claims.sql",
      "004_preserve_reconciliation_provenance.sql",
      "005_harden_materialization_invariants.sql",
      "006_account_moderation_snapshots.sql",
      "007_authoritative_history_and_merge_proof.sql",
      "008_moderator_role_changes.sql",
      "009_settlement_override_requests.sql",
      "010_settled_evidence_ordering_grace.sql",
      "011_api_tokens.sql",
      "012_unwritable_closure_kinds.sql",
      "013_immutable_github_identity.sql",
      "013_reconciliation_cooldown.sql",
      "014_opening_authority_precondition.sql",
      "015_normalize_settlement_status_check.sql",
      "016_repository_identity_verification.sql",
      "017_cross_repository_closures.sql",
      "018_refreshable_display_logins.sql",
    ].map((name) => ({ name, count: 1 })));
  });

  it("applies the opening authority precondition to an empty database", async () => {
    // beforeAll migrates the fresh container database twice, exercising clean install and replay.
    await expect(sql`
      select name from schema_migrations where name = '014_opening_authority_precondition.sql'
    `).resolves.toEqual([{ name: "014_opening_authority_precondition.sql" }]);
  });

  it.each([
    { name: "non-sponsor", sponsorAuthored: false },
    { name: "sponsor with different login case", sponsorAuthored: true },
  ])("checks opening authority on upgrade with $name evidence", async ({ sponsorAuthored }) => {
    const databaseUrl = process.env.DATABASE_URL!;
    const upgradeDatabaseUrl = new URL(databaseUrl);
    const databaseName = `opening_authority_upgrade_${nextExternalId()}`;
    upgradeDatabaseUrl.pathname = `/${databaseName}`;
    await sql`create database ${sql(databaseName)}`;
    await closeSql();

    try {
      process.env.DATABASE_URL = upgradeDatabaseUrl.toString();
      const upgradeSql = getSql();
      await runMigrations({ upTo: "012_unwritable_closure_kinds.sql" });
      const issue = await insertIssue(upgradeSql);
      const [sponsor] = await upgradeSql<{ github_login: string }[]>`
        select github_login from users where id = ${issue.sponsorId}
      `;
      await upgradeSql`
        update issues set owner_github_login = 'contributor',
          opening_source_event_id = 'opening-before-upgrade',
          opening_source_actor_login = ${sponsorAuthored ? sponsor.github_login.toUpperCase() : "outsider"},
          opening_source_at = '2026-09-01T10:00:00.000Z'
        where id = ${issue.id}
      `;
      const readIssue = () => upgradeSql`select * from issues where id = ${issue.id}`;
      const before = await readIssue();

      if (sponsorAuthored) {
        await expect(runMigrations()).resolves.toBeUndefined();
      } else {
        await expect(runMigrations()).rejects.toThrow(
          `Opening authority precondition failed: 1 issue(s) have non-sponsor opening evidence. Issue ids: ${issue.id}`,
        );
      }
      await expect(readIssue()).resolves.toEqual(before);
      // Each migration commits on its own, so a raised precondition rolls back only the migration
      // that raised it: 013 stays applied and a re-run resumes at 014 instead of replaying it.
      await expect(upgradeSql`
        select name from schema_migrations
        where name in (${"013_immutable_github_identity.sql"}, ${"014_opening_authority_precondition.sql"})
        order by name
      `).resolves.toEqual(sponsorAuthored
        ? [
            { name: "013_immutable_github_identity.sql" },
            { name: "014_opening_authority_precondition.sql" },
          ]
        : [{ name: "013_immutable_github_identity.sql" }]);
    } finally {
      await closeSql();
      process.env.DATABASE_URL = databaseUrl;
      sql = getSql();
    }
  });

  it("backfills legacy unwritable closures before enforcing the kind/pull-request constraint", async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    const upgradeDatabaseUrl = new URL(databaseUrl);
    upgradeDatabaseUrl.pathname = "/overflow_upgrade_test";
    await sql`create database overflow_upgrade_test`;
    await closeSql();

    try {
      process.env.DATABASE_URL = upgradeDatabaseUrl.toString();
      const upgradeSql = getSql();
      // Apply every predecessor, including API tokens, before testing the closure migration upgrade.
      await runMigrations({ upTo: "011_api_tokens.sql" });
      const [applied] = await upgradeSql`
        select count(*)::integer as count, max(name) as latest from schema_migrations
      `;
      expect(applied).toEqual({ count: 11, latest: "011_api_tokens.sql" });

      const pullRequest = await insertPullRequest(upgradeSql);
      const reason = "Legacy closure with a pull request reference.";
      const [legacy] = await upgradeSql<{ id: string; pull_request_id: string }[]>`
        insert into unwritable_closures (issue_id, pull_request_id, reason)
        values (${pullRequest.issueId}, ${pullRequest.id}, ${reason})
        returning id, pull_request_id
      `;
      expect(legacy.pull_request_id).toBe(pullRequest.id);

      await expect(runMigrations()).resolves.toBeUndefined();
      const readClosure = () => upgradeSql`
        select id, issue_id, reason, kind::text, pull_request_id
        from unwritable_closures where id = ${legacy.id}
      `;
      const expected = [{
        id: legacy.id,
        issue_id: pullRequest.issueId,
        reason,
        kind: "NO_CLOSING_PULL_REQUEST",
        pull_request_id: null,
      }];
      await expect(readClosure()).resolves.toEqual(expected);
      await expect(upgradeSql`
        select conname from pg_constraint
        where conrelid = 'unwritable_closures'::regclass
          and conname = 'unwritable_closures_kind_pull_request_check'
      `).resolves.toEqual([{ conname: "unwritable_closures_kind_pull_request_check" }]);

      await runMigrations();
      await expect(readClosure()).resolves.toEqual(expected);
    } finally {
      await closeSql();
      process.env.DATABASE_URL = databaseUrl;
      sql = getSql();
    }
  });

  it("refuses the difficulty scheme upgrade while a legacy repository has no scheme", async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    const upgradeDatabaseUrl = new URL(databaseUrl);
    const databaseName = `difficulty_scheme_refusal_${nextExternalId()}`;
    upgradeDatabaseUrl.pathname = `/${databaseName}`;
    await sql`create database ${sql(databaseName)}`;
    await closeSql();

    try {
      process.env.DATABASE_URL = upgradeDatabaseUrl.toString();
      const upgradeSql = getSql();
      await runMigrations({ upTo: "001_initial.sql" });
      const ownerName = "legacy/awaiting-a-scheme";
      await insertSchemelessRepository(upgradeSql, ownerName);
      const readRepository = () => upgradeSql`
        select * from registered_repositories where owner_name = ${ownerName}
      `;
      const before = await readRepository();

      await expect(runMigrations()).rejects.toThrow(difficultySchemePreconditionMessage(1, ownerName));
      await expect(readRepository()).resolves.toEqual(before);
      await expect(upgradeSql`
        select name from schema_migrations where name = '002_repository_difficulty_scheme.sql'
      `).resolves.toEqual([]);
    } finally {
      await closeSql();
      process.env.DATABASE_URL = databaseUrl;
      sql = getSql();
    }
  });

  it("refuses the difficulty scheme upgrade when the hand-added column is still null", async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    const upgradeDatabaseUrl = new URL(databaseUrl);
    const databaseName = `difficulty_scheme_unbackfilled_${nextExternalId()}`;
    upgradeDatabaseUrl.pathname = `/${databaseName}`;
    await sql`create database ${sql(databaseName)}`;
    await closeSql();

    try {
      process.env.DATABASE_URL = upgradeDatabaseUrl.toString();
      const upgradeSql = getSql();
      await runMigrations({ upTo: "001_initial.sql" });
      const ownerName = "legacy/still-awaiting-a-scheme";
      await insertSchemelessRepository(upgradeSql, ownerName);
      await upgradeSql`alter table registered_repositories add column difficulty_scheme jsonb`;

      await expect(runMigrations()).rejects.toHaveProperty(
        "message", difficultySchemePreconditionMessage(1, ownerName),
      );
      await expect(upgradeSql`
        select name from schema_migrations where name = '002_repository_difficulty_scheme.sql'
      `).resolves.toEqual([]);
    } finally {
      await closeSql();
      process.env.DATABASE_URL = databaseUrl;
      sql = getSql();
    }
  });

  it("refuses the difficulty scheme upgrade with a null hand-added column outside public", async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    const upgradeDatabaseUrl = new URL(databaseUrl);
    const databaseName = `difficulty_scheme_nonpublic_${nextExternalId()}`;
    const schemaName = "overflow_upgrade";
    upgradeDatabaseUrl.pathname = `/${databaseName}`;
    upgradeDatabaseUrl.searchParams.set("options", `-c search_path=${schemaName}`);
    await sql`create database ${sql(databaseName)}`;
    await closeSql();

    try {
      process.env.DATABASE_URL = upgradeDatabaseUrl.toString();
      const upgradeSql = getSql();
      await upgradeSql`create schema ${upgradeSql(schemaName)}`;
      await runMigrations({ upTo: "001_initial.sql" });
      await expect(upgradeSql`
        select current_schema() as schema_name,
          to_regclass('public.registered_repositories')::text as public_repository_table
      `).resolves.toEqual([{ schema_name: schemaName, public_repository_table: null }]);
      const ownerName = "legacy/z-nonpublic-awaiting-a-scheme";
      const backfilledOwnerName = "legacy/a-nonpublic-backfilled";
      await insertSchemelessRepository(upgradeSql, ownerName);
      await insertSchemelessRepository(upgradeSql, backfilledOwnerName);
      await upgradeSql`alter table registered_repositories add column difficulty_scheme jsonb`;
      await upgradeSql`
        update registered_repositories
        set difficulty_scheme = ${upgradeSql.json(validDifficultyScheme())}::jsonb
        where owner_name = ${backfilledOwnerName}
      `;

      await expect(runMigrations()).rejects.toHaveProperty(
        "message", difficultySchemePreconditionMessage(1, ownerName),
      );
      await expect(upgradeSql`
        select name from schema_migrations where name = '002_repository_difficulty_scheme.sql'
      `).resolves.toEqual([]);
    } finally {
      await closeSql();
      process.env.DATABASE_URL = databaseUrl;
      sql = getSql();
    }
  });

  it("rejects an invalid difficulty scheme already backfilled by hand", async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    const upgradeDatabaseUrl = new URL(databaseUrl);
    const databaseName = `difficulty_scheme_invalid_${nextExternalId()}`;
    upgradeDatabaseUrl.pathname = `/${databaseName}`;
    await sql`create database ${sql(databaseName)}`;
    await closeSql();

    try {
      process.env.DATABASE_URL = upgradeDatabaseUrl.toString();
      const upgradeSql = getSql();
      await runMigrations({ upTo: "001_initial.sql" });
      const ownerName = "legacy/invalid-scheme";
      await insertSchemelessRepository(upgradeSql, ownerName);
      await upgradeSql`alter table registered_repositories add column difficulty_scheme jsonb`;
      await upgradeSql`
        update registered_repositories
        set difficulty_scheme = '{"openingName":"","actualLabels":[]}'::jsonb
        where owner_name = ${ownerName}
      `;

      await expect(runMigrations()).rejects.toMatchObject({
        code: "23514",
        constraint_name: "registered_repositories_difficulty_scheme_check",
      });
      await expect(upgradeSql`
        select name from schema_migrations where name = '002_repository_difficulty_scheme.sql'
      `).resolves.toEqual([]);
    } finally {
      await closeSql();
      process.env.DATABASE_URL = databaseUrl;
      sql = getSql();
    }
  });

  it("counts and lists legacy repositories in owner-name order in the difficulty scheme refusal", async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    const upgradeDatabaseUrl = new URL(databaseUrl);
    const databaseName = `difficulty_scheme_ordered_${nextExternalId()}`;
    upgradeDatabaseUrl.pathname = `/${databaseName}`;
    await sql`create database ${sql(databaseName)}`;
    await closeSql();

    try {
      process.env.DATABASE_URL = upgradeDatabaseUrl.toString();
      const upgradeSql = getSql();
      await runMigrations({ upTo: "001_initial.sql" });
      await insertSchemelessRepository(upgradeSql, "legacy/z-last");
      await insertSchemelessRepository(upgradeSql, "legacy/a-first");

      await expect(runMigrations()).rejects.toMatchObject({
        code: "P0001",
        message: difficultySchemePreconditionMessage(2, "legacy/a-first", "legacy/z-last"),
      });
      await expect(upgradeSql`
        select name from schema_migrations where name = '002_repository_difficulty_scheme.sql'
      `).resolves.toEqual([]);
    } finally {
      await closeSql();
      process.env.DATABASE_URL = databaseUrl;
      sql = getSql();
    }
  });

  it("upgrades a refused database once its difficulty scheme is backfilled by hand", async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    const upgradeDatabaseUrl = new URL(databaseUrl);
    const databaseName = `difficulty_scheme_recovery_${nextExternalId()}`;
    upgradeDatabaseUrl.pathname = `/${databaseName}`;
    await sql`create database ${sql(databaseName)}`;
    await closeSql();

    try {
      process.env.DATABASE_URL = upgradeDatabaseUrl.toString();
      const upgradeSql = getSql();
      await runMigrations({ upTo: "001_initial.sql" });
      const ownerName = "legacy/backfilled-by-hand";
      await insertSchemelessRepository(upgradeSql, ownerName);
      await expect(runMigrations()).rejects.toThrow(difficultySchemePreconditionMessage(1, ownerName));

      // The recovery the refusal message prescribes: add the column and backfill it by hand.
      await upgradeSql`alter table registered_repositories add column difficulty_scheme jsonb`;
      await upgradeSql`
        update registered_repositories
        set difficulty_scheme = ${upgradeSql.json(validDifficultyScheme())}::jsonb
        where owner_name = ${ownerName}
      `;

      // Stops at 002: 003 adds an enum value and uses it in the same transaction, which
      // PostgreSQL rejects (55P04) whenever 001 was committed by an earlier run.
      await expect(runMigrations({ upTo: "002_repository_difficulty_scheme.sql" }))
        .resolves.toBeUndefined();
      await expect(upgradeSql`
        select name from schema_migrations where name = '002_repository_difficulty_scheme.sql'
      `).resolves.toEqual([{ name: "002_repository_difficulty_scheme.sql" }]);
      await expect(upgradeSql`
        select is_nullable from information_schema.columns
        where table_schema = 'public'
          and table_name = 'registered_repositories'
          and column_name = 'difficulty_scheme'
      `).resolves.toEqual([{ is_nullable: "NO" }]);
      await expect(upgradeSql`
        select conname, convalidated from pg_constraint
        where conrelid = 'registered_repositories'::regclass
          and conname = 'registered_repositories_difficulty_scheme_check'
      `).resolves.toEqual([{
        conname: "registered_repositories_difficulty_scheme_check",
        convalidated: true,
      }]);

      // A constraint that exists but does not bite is the false green the split risks.
      const invalidScheme = validDifficultyScheme();
      invalidScheme.actualLabels = invalidScheme.actualLabels.slice(0, 3);
      await expect(upgradeSql`
        update registered_repositories
        set difficulty_scheme = ${upgradeSql.json(invalidScheme)}::jsonb
        where owner_name = ${ownerName}
      `).rejects.toThrow(/registered_repositories_difficulty_scheme_check/);
      await expect(upgradeSql<{ difficulty_scheme: unknown }[]>`
        select difficulty_scheme from registered_repositories where owner_name = ${ownerName}
      `).resolves.toEqual([{ difficulty_scheme: validDifficultyScheme() }]);
    } finally {
      await closeSql();
      process.env.DATABASE_URL = databaseUrl;
      sql = getSql();
    }
  });

  it("upgrades a database holding no repository through the difficulty scheme migration", async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    const upgradeDatabaseUrl = new URL(databaseUrl);
    const databaseName = `difficulty_scheme_empty_${nextExternalId()}`;
    upgradeDatabaseUrl.pathname = `/${databaseName}`;
    await sql`create database ${sql(databaseName)}`;
    await closeSql();

    try {
      process.env.DATABASE_URL = upgradeDatabaseUrl.toString();
      const upgradeSql = getSql();
      await runMigrations({ upTo: "001_initial.sql" });
      await expect(upgradeSql`select count(*)::integer as count from registered_repositories`)
        .resolves.toEqual([{ count: 0 }]);

      // Stops at 002: 003 adds an enum value and uses it in the same transaction, which
      // PostgreSQL rejects (55P04) whenever 001 was committed by an earlier run.
      await expect(runMigrations({ upTo: "002_repository_difficulty_scheme.sql" }))
        .resolves.toBeUndefined();
      await expect(upgradeSql`
        select name from schema_migrations where name = '002_repository_difficulty_scheme.sql'
      `).resolves.toEqual([{ name: "002_repository_difficulty_scheme.sql" }]);
    } finally {
      await closeSql();
      process.env.DATABASE_URL = databaseUrl;
      sql = getSql();
    }
  });

  it.each([
    { kind: "SETTLEMENT_EVIDENCE_REJECTED", hasPullRequest: false },
    { kind: "NO_CLOSING_PULL_REQUEST", hasPullRequest: true },
    { kind: "CROSS_REPOSITORY_CLOSING_PULL_REQUEST", hasPullRequest: true },
  ])("rejects $kind with hasPullRequest=$hasPullRequest", async ({ kind, hasPullRequest }) => {
    const pullRequest = await insertPullRequest(sql);
    await expect(sql`
      insert into unwritable_closures (issue_id, pull_request_id, kind, reason)
      values (${pullRequest.issueId}, ${hasPullRequest ? pullRequest.id : null}, ${kind}, ${"Rejected evidence"})
    `).rejects.toThrow(/unwritable_closures_kind_pull_request_check/);
  });

  it("records a cross-repository closure that references no pull request row", async () => {
    // A foreign closing pull request is never materialized, so the kind has to
    // survive the check constraint tying a pull request to the rejected kind.
    const issue = await insertIssue(sql);
    const reason = "Closing pull request 11 belongs to other/fork, not the registered repository.";
    const [closure] = await sql<{ id: string }[]>`
      insert into unwritable_closures (issue_id, pull_request_id, kind, reason)
      values (${issue.id}, ${null}, ${"CROSS_REPOSITORY_CLOSING_PULL_REQUEST"}, ${reason})
      returning id
    `;
    await expect(sql`
      select kind::text, pull_request_id, reason from unwritable_closures where id = ${closure.id}
    `).resolves.toEqual([{ kind: "CROSS_REPOSITORY_CLOSING_PULL_REQUEST", pull_request_id: null, reason }]);
  });

  it("adds the cross-repository closure kind to a database already migrated to 016", async () => {
    const databaseUrl = process.env.DATABASE_URL!;
    const upgradeDatabaseUrl = new URL(databaseUrl);
    const databaseName = `cross_repository_upgrade_${nextExternalId()}`;
    upgradeDatabaseUrl.pathname = `/${databaseName}`;
    await sql`create database ${sql(databaseName)}`;
    await closeSql();

    try {
      process.env.DATABASE_URL = upgradeDatabaseUrl.toString();
      const upgradeSql = getSql();
      await runMigrations({ upTo: "016_repository_identity_verification.sql" });
      await expect(upgradeSql`
        select 'CROSS_REPOSITORY_CLOSING_PULL_REQUEST'::unwritable_closure_kind
      `).rejects.toThrow(/invalid input value for enum unwritable_closure_kind/);

      // The migration runs inside a transaction, so the added enum value has to
      // survive an ALTER TYPE against a type that predates it.
      await expect(runMigrations()).resolves.toBeUndefined();

      const issue = await insertIssue(upgradeSql);
      await expect(upgradeSql`
        insert into unwritable_closures (issue_id, pull_request_id, kind, reason)
        values (${issue.id}, ${null}, ${"CROSS_REPOSITORY_CLOSING_PULL_REQUEST"}, ${"Foreign closing pull request."})
        returning kind::text
      `).resolves.toEqual([{ kind: "CROSS_REPOSITORY_CLOSING_PULL_REQUEST" }]);
    } finally {
      await closeSql();
      process.env.DATABASE_URL = databaseUrl;
      sql = getSql();
    }
  });

  it("defaults the reconciliation cooldown to null in a nullable timestamp column", async () => {
    const sponsorId = await insertUser(sql);
    const repositoryId = await insertRepository(sql, sponsorId);
    await expect(sql`
      select data_type, is_nullable from information_schema.columns
      where table_name = 'registered_repositories' and column_name = 'reconciliation_not_before'
    `).resolves.toEqual([{ data_type: "timestamp with time zone", is_nullable: "YES" }]);
    await expect(sql`
      select reconciliation_not_before from registered_repositories where id = ${repositoryId}
    `).resolves.toEqual([{ reconciliation_not_before: null }]);
  });

  it("carries unavailability as a nullable reason beside a nullable first observation", async () => {
    await expect(sql`
      select column_name, data_type, is_nullable from information_schema.columns
      where table_name = 'registered_repositories'
        and column_name in ('unavailable_reason', 'unavailable_since')
      order by column_name
    `).resolves.toEqual([
      { column_name: "unavailable_reason", data_type: "text", is_nullable: "YES" },
      { column_name: "unavailable_since", data_type: "timestamp with time zone", is_nullable: "YES" },
    ]);
  });

  it.each(["NOT_FOUND", "NOT_PUBLIC", "IDENTITY_MISMATCH"])(
    "records %s unavailability with the moment it was first observed",
    async (reason) => {
      const sponsorId = await insertUser(sql);
      const repositoryId = await insertRepository(sql, sponsorId);
      await expect(sql`
        select unavailable_reason, unavailable_since from registered_repositories where id = ${repositoryId}
      `).resolves.toEqual([{ unavailable_reason: null, unavailable_since: null }]);

      await sql`
        update registered_repositories
        set unavailable_reason = ${reason}, unavailable_since = ${"2026-09-01T10:00:00.000Z"}
        where id = ${repositoryId}
      `;

      await expect(sql`
        select unavailable_reason, unavailable_since from registered_repositories where id = ${repositoryId}
      `).resolves.toEqual([{
        unavailable_reason: reason,
        unavailable_since: new Date("2026-09-01T10:00:00.000Z"),
      }]);
    },
  );

  it.each([
    {
      name: "a reason with no first observation",
      reason: "NOT_FOUND",
      since: null,
      constraint: /registered_repositories_unavailability_check/,
    },
    {
      name: "a first observation with no reason",
      reason: null,
      since: "2026-09-01T10:00:00.000Z",
      constraint: /registered_repositories_unavailability_check/,
    },
    {
      name: "a reason outside the verified set",
      reason: "ARCHIVED",
      since: "2026-09-01T10:00:00.000Z",
      constraint: /registered_repositories_unavailable_reason_check/,
    },
  ])("rejects $name on a registered repository", async ({ reason, since, constraint }) => {
    const sponsorId = await insertUser(sql);
    const repositoryId = await insertRepository(sql, sponsorId);

    await expect(sql`
      update registered_repositories
      set unavailable_reason = ${reason}, unavailable_since = ${since}
      where id = ${repositoryId}
    `).rejects.toThrow(constraint);
    await expect(sql`
      select unavailable_reason, unavailable_since from registered_repositories where id = ${repositoryId}
    `).resolves.toEqual([{ unavailable_reason: null, unavailable_since: null }]);
  });

  it("rejects out-of-range opening and issue-owned settled difficulty points", async () => {
    await expect(insertIssue(sql, { comparisonPoints: 11 })).rejects.toThrow();
    const issue = await insertIssue(sql);
    await expect(sql`
      update issues
      set settled_label = ${"delivered/0"}, settled_points = 0,
          settled_label_event_id = ${"settled-event-0"},
          settled_label_actor_login = ${"issue-owner"},
          settled_label_applied_at = ${"2026-09-01T11:00:00.000Z"},
          settled_rationale_comment_id = ${"comment-0"},
          settled_rationale_actor_login = ${"issue-owner"},
          settled_rationale_commented_at = ${"2026-09-01T11:30:00.000Z"}
      where id = ${issue.id}
    `).rejects.toThrow();
  });

  it("accepts a settled rationale comment up to fifteen minutes before its label and rejects an older one", async () => {
    const settle = (issueId: string, commentedAt: string) => sql`
      update issues
      set settled_label = ${"delivered/6"}, settled_points = 6,
          settled_label_event_id = ${"settled-event-6"},
          settled_label_actor_login = ${"issue-owner"},
          settled_label_applied_at = ${"2026-09-01T11:00:00.000Z"},
          settled_rationale_comment_id = ${"comment-6"},
          settled_rationale_actor_login = ${"issue-owner"},
          settled_rationale_commented_at = ${commentedAt}
      where id = ${issueId}
    `;

    const withinGrace = await insertIssue(sql);
    await settle(withinGrace.id, "2026-09-01T10:45:00.000Z");
    const [settled] = await sql<{ settled_points: number | null }[]>`
      select settled_points from issues where id = ${withinGrace.id}
    `;
    expect(settled).toEqual({ settled_points: 6 });

    const beyondGrace = await insertIssue(sql);
    await expect(settle(beyondGrace.id, "2026-09-01T10:44:59.000Z")).rejects.toThrow(
      /issues_settled_evidence_complete_check/,
    );
  });

  it("rejects duplicate GitHub user and repository identifiers", async () => {
    const githubUserId = nextExternalId();
    await insertUser(sql, githubUserId);
    await expect(insertUser(sql, githubUserId)).rejects.toThrow();

    const sponsorId = await insertUser(sql);
    const githubRepositoryId = nextExternalId();
    await insertRepository(sql, sponsorId, githubRepositoryId);
    await expect(insertRepository(sql, sponsorId, githubRepositoryId)).rejects.toThrow();
  });

  it("allows two accounts to display the same login while keeping the GitHub user id unique", async () => {
    const first = await insertIdentity(sql, "recycled-login");
    const second = await insertIdentity(sql, "recycled-login");
    expect(first.id).not.toBe(second.id);
    await expect(insertIdentity(sql, "another-login", first.githubUserId)).rejects.toThrow();
  });

  it.each([0, -1])("rejects non-positive GitHub user id %s on pull requests and settlements", async (githubUserId) => {
    const pullRequest = await insertPullRequest(sql);
    await expect(sql`
      update pull_requests set author_github_user_id = ${githubUserId} where id = ${pullRequest.id}
    `).rejects.toThrow(/check/);
    await expect(sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, creditor_github_login, creditor_github_user_id, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${pullRequest.issueId}, null, ${"someone"}, ${githubUserId}, ${pullRequest.sponsorId},
        5, 6, 0, 6, ${"c".repeat(64)}, ${"UNCLAIMED"}
      )
    `).rejects.toThrow(/check/);
  });

  it("requires every repository to persist a complete explicit difficulty scheme", async () => {
    const sponsorId = await insertUser(sql);
    const validScheme = validDifficultyScheme();

    await expect(
      insertRepositoryWithDifficultyScheme(sql, sponsorId, validScheme),
    ).resolves.toEqual(expect.any(String));

    const incompleteActualCatalog = validDifficultyScheme();
    incompleteActualCatalog.actualLabels.pop();
    const emptyOpeningCatalog = validDifficultyScheme();
    emptyOpeningCatalog.openingLabels = [];
    const duplicateAndMissingActualPoints = validDifficultyScheme();
    duplicateAndMissingActualPoints.actualLabels[9] = { label: "delivered/10", points: 9 };
    const outOfRangeOpeningPoints = validDifficultyScheme();
    outOfRangeOpeningPoints.openingLabels[0] = {
      ...outOfRangeOpeningPoints.openingLabels[0],
      comparisonPoints: 11,
    };
    const wrongPointType = validDifficultyScheme() as unknown as {
      actualLabels: Array<{ label: string; points: unknown }>;
    };
    wrongPointType.actualLabels[0] = { label: "delivered/1", points: "1" };
    const overlappingCatalogs = validDifficultyScheme();
    overlappingCatalogs.actualLabels[0] = { label: "S", points: 1 };
    const blankDisplayName = validDifficultyScheme();
    blankDisplayName.actualName = " ";

    for (const scheme of [
      null,
      {},
      emptyOpeningCatalog,
      incompleteActualCatalog,
      duplicateAndMissingActualPoints,
      outOfRangeOpeningPoints,
      wrongPointType,
      overlappingCatalogs,
      blankDisplayName,
    ]) {
      await expect(insertRepositoryWithDifficultyScheme(sql, sponsorId, scheme)).rejects.toThrow();
    }
  });

  it("rejects updates to an issue's original opening rating", async () => {
    const issue = await insertIssue(sql);

    await expect(updateOriginalOpeningDifficulty(sql, issue.id)).rejects.toThrow();
  });

  it("refreshes an issue's display logins while its opening event proof stays immutable", async () => {
    const issue = await insertIssue(sql);
    const loginBeforeRename = `login-before-rename-${nextExternalId()}`;
    const loginAfterRename = `login-after-rename-${nextExternalId()}`;
    const openingEventId = `opening-event-rename-${nextExternalId()}`;
    await sql`
      update issues
      set owner_github_login = ${loginBeforeRename},
          opening_source_event_id = ${openingEventId},
          opening_source_actor_login = ${loginBeforeRename},
          opening_source_at = ${"2026-09-01T09:00:00.000Z"}
      where id = ${issue.id}
    `;

    await sql`
      update issues
      set owner_github_login = ${loginAfterRename},
          opening_source_actor_login = ${loginAfterRename}
      where id = ${issue.id}
    `;

    await expect(sql`
      select owner_github_login, opening_source_actor_login, opening_source_event_id, opening_source_at
      from issues where id = ${issue.id}
    `).resolves.toEqual([{
      owner_github_login: loginAfterRename,
      opening_source_actor_login: loginAfterRename,
      opening_source_event_id: openingEventId,
      opening_source_at: new Date("2026-09-01T09:00:00.000Z"),
    }]);

    // The event proof itself, and the rating it justifies, stay immutable.
    await expect(sql`
      update issues set opening_source_event_id = ${"rewritten-opening-event"} where id = ${issue.id}
    `).rejects.toThrow("Issue opening rating is immutable");
    await expect(sql`
      update issues set opening_source_at = ${"2026-09-02T09:00:00.000Z"} where id = ${issue.id}
    `).rejects.toThrow("Issue opening rating is immutable");
    await expect(updateOriginalOpeningDifficulty(sql, issue.id))
      .rejects.toThrow("Issue opening rating is immutable");
    // A login still cannot be blanked away while opening evidence remains
    // attached. The trigger refuses every blanking transition, including the
    // whitespace spellings that the completeness check's space-only trim admits.
    for (const blanked of [null, "", "   ", "\t", "\n", " \t\n "]) {
      await expect(sql`
        update issues set owner_github_login = ${blanked} where id = ${issue.id}
      `).rejects.toThrow("Issue opening rating is immutable");
      await expect(sql`
        update issues set opening_source_actor_login = ${blanked} where id = ${issue.id}
      `).rejects.toThrow("Issue opening rating is immutable");
    }
    await expect(sql`
      select owner_github_login, opening_source_actor_login
      from issues where id = ${issue.id}
    `).resolves.toEqual([{
      owner_github_login: loginAfterRename,
      opening_source_actor_login: loginAfterRename,
    }]);
  });

  it("keeps a row that already holds a whitespace-only display login writable", async () => {
    // `issues_opening_source_complete_check` trims spaces only, so a row written
    // before the trigger carried a whitespace arm can already hold a tab. The arm
    // is keyed on the transition rather than on the new value precisely so such a
    // row stays writable: a clause reading only the new value would refuse every
    // later update to its logins and wedge the row with no way back.
    const issue = await insertIssue(sql);
    const openingEventId = `opening-event-whitespace-${nextExternalId()}`;
    const recoveredLogin = `login-recovered-${nextExternalId()}`;
    await sql`
      update issues
      set owner_github_login = ${"\t"},
          opening_source_event_id = ${openingEventId},
          opening_source_actor_login = ${"\t"},
          opening_source_at = ${"2026-09-01T09:00:00.000Z"}
      where id = ${issue.id}
    `;

    // The owner login stays whitespace-only across this update, so a value-keyed
    // arm would refuse it even though nothing is being blanked.
    await sql`
      update issues set opening_source_actor_login = ${recoveredLogin} where id = ${issue.id}
    `;
    await sql`
      update issues set owner_github_login = ${recoveredLogin} where id = ${issue.id}
    `;

    await expect(sql`
      select owner_github_login, opening_source_actor_login
      from issues where id = ${issue.id}
    `).resolves.toEqual([{
      owner_github_login: recoveredLogin,
      opening_source_actor_login: recoveredLogin,
    }]);
  });

  it("persists immutable issue-owned rating evidence and an exact merge commit OID", async () => {
    const pullRequest = await insertPullRequest(sql);
    const mergeCommitOid = "0123456789abcdef0123456789abcdef01234567";
    await sql`
      update issues
      set owner_github_login = ${"issue-owner"},
          opening_source_event_id = ${"opening-event-1"},
          opening_source_actor_login = ${"issue-owner"},
          opening_source_at = ${"2026-09-01T09:00:00.000Z"},
          settled_label = ${"delivered/6"},
          settled_points = 6,
          settled_label_event_id = ${"settled-event-1"},
          settled_label_actor_login = ${"issue-owner"},
          settled_label_applied_at = ${"2026-09-01T11:00:00.000Z"},
          settled_rationale_comment_id = ${"comment-1"},
          settled_rationale_actor_login = ${"issue-owner"},
          settled_rationale_commented_at = ${"2026-09-01T11:30:00.000Z"}
      where id = ${pullRequest.issueId}
    `;
    await sql`
      update pull_requests
      set merge_commit_oid = ${mergeCommitOid}, final_commit_at = ${"2026-09-01T10:00:00.000Z"}
      where id = ${pullRequest.id}
    `;

    const [proof] = await sql<{
      opening_source_event_id: string;
      settled_label_event_id: string;
      settled_rationale_comment_id: string;
      merge_commit_oid: string;
    }[]>`
      select
        issues.opening_source_event_id,
        issues.settled_label_event_id,
        issues.settled_rationale_comment_id,
        pull_requests.merge_commit_oid
      from issues
      join pull_request_issues on pull_request_issues.issue_id = issues.id
      join pull_requests on pull_requests.id = pull_request_issues.pull_request_id
      where issues.id = ${pullRequest.issueId}
    `;
    expect(proof).toEqual({
      opening_source_event_id: "opening-event-1",
      settled_label_event_id: "settled-event-1",
      settled_rationale_comment_id: "comment-1",
      merge_commit_oid: mergeCommitOid,
    });
    const pullRequestColumns = await sql<{ column_name: string }[]>`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'pull_requests'
    `;
    expect(pullRequestColumns.map((column) => column.column_name)).not.toEqual(
      expect.arrayContaining(["actual_label", "actual_points"]),
    );

    await expect(sql`
      update issues set opening_source_event_id = ${"rewritten-event"} where id = ${pullRequest.issueId}
    `).rejects.toThrow(/immutable/i);
    await expect(sql`
      update pull_requests set merge_commit_oid = ${"not-forty-hex"} where id = ${pullRequest.id}
    `).rejects.toThrow();
  });

  it("keeps moderation history immutable and resolves eligibility at the merge timestamp", async () => {
    const targetId = await insertUser(sql);
    const actorId = await insertUser(sql);
    const [event] = await sql<{ id: string }[]>`
      insert into moderation_events (
        target_user_id, actor_id, prior_state, new_state, reason, created_at
      )
      values (
        ${targetId}, ${actorId}, ${"ACTIVE"}, ${"BANNED"}, ${"Historical sanction"},
        ${"2026-09-02T00:00:00.000Z"}
      )
      returning id
    `;

    const [before] = await sql<{ eligible: boolean }[]>`
      select participation_eligible_at(${targetId}, ${"2026-09-01T12:00:00.000Z"}) as eligible
    `;
    const [after] = await sql<{ eligible: boolean }[]>`
      select participation_eligible_at(${targetId}, ${"2026-09-03T12:00:00.000Z"}) as eligible
    `;
    expect(before.eligible).toBe(true);
    expect(after.eligible).toBe(false);
    await expect(sql`
      update moderation_events set reason = ${"Rewritten"} where id = ${event.id}
    `).rejects.toThrow(/immutable/i);
    await expect(sql`delete from moderation_events where id = ${event.id}`).rejects.toThrow(/immutable/i);
  });

  it("rejects a pull request whose issue belongs to another repository", async () => {
    const issue = await insertIssue(sql);
    const foreignRepository = await insertRepository(sql, await insertUser(sql));
    const githubPullRequestId = nextExternalId();

    await expect(sql`
      insert into pull_requests (
        github_pull_request_id,
        repository_id,
        issue_id,
        pull_request_number,
        url,
        title,
        body,
        state,
        merged_at
      )
      values (
        ${githubPullRequestId},
        ${foreignRepository},
        ${issue.id},
        ${nextExternalId()},
        ${`https://github.com/example/repository/pull/${githubPullRequestId}`},
        ${"A mismatched contribution"},
        ${"Pull request evidence"},
        ${"MERGED"},
        now()
      )
    `).rejects.toThrow();
  });

  it("rejects a settlement whose issue does not match its pull request", async () => {
    const pullRequest = await insertPullRequest(sql);
    const unrelatedIssue = await insertIssue(sql);
    const creditorId = await insertUser(sql);

    await expect(sql`
      insert into settlements (
        pull_request_id,
        issue_id,
        creditor_id,
        debtor_id,
        opening_comparison_points,
        settled_points,
        review_rounds,
        credits,
        proof_sha256,
        status
      )
      values (
        ${pullRequest.id},
        ${unrelatedIssue.id},
        ${creditorId},
        ${pullRequest.sponsorId},
        5,
        6,
        2,
        4,
        ${"c".repeat(64)},
        ${"SETTLED"}
      )
    `).rejects.toThrow();
  });

  it("allows one merged PR to settle each of several issues with its one raw-diff proof", async () => {
    const pullRequest = await insertPullRequest(sql);
    const secondIssueId = await insertSiblingIssue(sql, pullRequest.issueId);
    const contributorId = await insertUser(sql);
    const proofFingerprint = "a".repeat(64);

    await sql`
      insert into pull_request_issues (pull_request_id, issue_id, repository_id)
      values (${pullRequest.id}, ${secondIssueId}, ${pullRequest.repositoryId})
    `;
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values
        (${pullRequest.id}, ${pullRequest.issueId}, ${contributorId}, ${pullRequest.sponsorId}, 5, 6, 2, 4, ${proofFingerprint}, ${"SETTLED"}),
        (${pullRequest.id}, ${secondIssueId}, ${contributorId}, ${pullRequest.sponsorId}, 5, 6, 2, 4, ${proofFingerprint}, ${"SETTLED"})
    `;

    const rows = await sql<{ issue_id: string; proof_sha256: string }[]>`
      select issue_id, proof_sha256 from settlements where pull_request_id = ${pullRequest.id} order by issue_id
    `;
    expect(rows).toEqual([
      { issue_id: pullRequest.issueId, proof_sha256: proofFingerprint },
      { issue_id: secondIssueId, proof_sha256: proofFingerprint },
    ].sort((left, right) => left.issue_id.localeCompare(right.issue_id)));
  });

  it("rejects a cross-repository PR/issue association before any settlement can reference it", async () => {
    const pullRequest = await insertPullRequest(sql);
    const foreignIssue = await insertIssue(sql);
    const [pullRequestRow] = await sql<{ repository_id: string }[]>`
      select repository_id from pull_requests where id = ${pullRequest.id}
    `;

    await expect(sql`
      insert into pull_request_issues (pull_request_id, issue_id, repository_id)
      values (${pullRequest.id}, ${foreignIssue.id}, ${pullRequestRow.repository_id})
    `).rejects.toThrow(/foreign key/);
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    "rejects an invalid GitHub identity claim id %s",
    async (githubUserId) => {
      const claimant = await insertIdentity(sql, `invalid-claim-${nextExternalId()}`);
      await expect(claimGitHubIdentity(sql, claimant.id, githubUserId))
        .rejects.toThrow("GitHub user id must be a positive integer.");
    },
  );

  it("converts unclaimed self-work by account id after a rename without claiming a recycled login", async () => {
    const pullRequest = await insertPullRequest(sql);
    const sponsorGitHubUserId = await githubUserIdOf(sql, pullRequest.sponsorId);
    await sql`update users set github_login = ${"self-work-renamed"} where id = ${pullRequest.sponsorId}`;
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, creditor_github_login, creditor_github_user_id, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${pullRequest.issueId}, null, ${"self-work-old-login"}, ${sponsorGitHubUserId},
        ${pullRequest.sponsorId}, 5, 6, 0, 6, ${"a".repeat(64)}, ${"UNCLAIMED"}
      )
    `;
    const impostor = await insertIdentity(sql, "self-work-old-login");
    await claimGitHubIdentity(sql, impostor.id, impostor.githubUserId);
    await expect(sql<{ status: string }[]>`
      select status from settlements where issue_id = ${pullRequest.issueId}
    `).resolves.toEqual([{ status: "UNCLAIMED" }]);

    await claimGitHubIdentity(sql, pullRequest.sponsorId, sponsorGitHubUserId);
    await expect(sql`select id from settlements where issue_id = ${pullRequest.issueId}`)
      .resolves.toHaveLength(0);
    await expect(sql<{ user_id: string; opening_comparison_points: number; actual_points: number }[]>`
      select user_id, opening_comparison_points, actual_points
      from self_work_calibrations where issue_id = ${pullRequest.issueId}
    `).resolves.toEqual([{ user_id: pullRequest.sponsorId, opening_comparison_points: 5, actual_points: 6 }]);
  });

  it("never converts another account's credits to self-work when the sponsor holds its recycled login", async () => {
    const pullRequest = await insertPullRequest(sql);
    const originalGitHubUserId = nextExternalId();
    const sponsorGitHubUserId = await githubUserIdOf(sql, pullRequest.sponsorId);
    const login = `recycled-self-${nextExternalId()}`;
    await sql`update users set github_login = ${login} where id = ${pullRequest.sponsorId}`;
    await insertUnclaimedIdentitySettlement(sql, pullRequest, originalGitHubUserId, login);

    await claimGitHubIdentity(sql, pullRequest.sponsorId, sponsorGitHubUserId);

    await expect(sql`
      select creditor_id, creditor_github_user_id, status, credits, proof_sha256
      from settlements where issue_id = ${pullRequest.issueId}
    `).resolves.toEqual([{
      creditor_id: null, creditor_github_user_id: String(originalGitHubUserId),
      status: "UNCLAIMED", credits: 6, proof_sha256: "a".repeat(64),
    }]);
    await expect(sql`select id from self_work_calibrations where issue_id = ${pullRequest.issueId}`)
      .resolves.toHaveLength(0);

    const original = await insertIdentity(sql, `${login}-renamed`, originalGitHubUserId);
    await claimGitHubIdentity(sql, original.id, original.githubUserId);
    await expect(sql`select creditor_id, status, credits from settlements where issue_id = ${pullRequest.issueId}`)
      .resolves.toEqual([{ creditor_id: original.id, status: "SETTLED", credits: 6 }]);
  });

  it.each(["BANNED", "RECALIBRATING"] as const)("leaves self-work unclaimed when the claimant was %s at merge", async (state) => {
    const pullRequest = await insertPullRequest(sql);
    const githubUserId = await githubUserIdOf(sql, pullRequest.sponsorId);
    await insertUnclaimedIdentitySettlement(sql, pullRequest, githubUserId, "ineligible-self");
    await sql`update users set enforcement_state = ${state} where id = ${pullRequest.sponsorId}`;

    await claimGitHubIdentity(sql, pullRequest.sponsorId, githubUserId);

    await expect(sql`select creditor_id, status, credits from settlements where issue_id = ${pullRequest.issueId}`)
      .resolves.toEqual([{ creditor_id: null, status: "UNCLAIMED", credits: 6 }]);
    await expect(sql`select id from self_work_calibrations where issue_id = ${pullRequest.issueId}`)
      .resolves.toHaveLength(0);
  });

  it.each([1, Number.MAX_SAFE_INTEGER])("claims credits for valid boundary account id %s", async (githubUserId) => {
    const pullRequest = await insertPullRequest(sql);
    const claimant = await insertIdentity(sql, `boundary-${githubUserId}`, githubUserId);
    await insertUnclaimedIdentitySettlement(sql, pullRequest, githubUserId, "boundary-old-login");

    await claimGitHubIdentity(sql, claimant.id, githubUserId);

    await expect(sql`select creditor_id, status, credits from settlements where issue_id = ${pullRequest.issueId}`)
      .resolves.toEqual([{ creditor_id: claimant.id, status: "SETTLED", credits: 6 }]);
  });

  it.each(["self-work", "outside work"])("leaves %s unclaimed without a merged pull request", async (kind) => {
    const pullRequest = await insertPullRequest(sql);
    const claimantId = kind === "self-work" ? pullRequest.sponsorId : await insertUser(sql);
    const githubUserId = await githubUserIdOf(sql, claimantId);
    await sql`update pull_requests set state = ${"OPEN"}, merged_at = null where id = ${pullRequest.id}`;
    await insertUnclaimedIdentitySettlement(sql, pullRequest, githubUserId, "unmerged-author");

    await claimGitHubIdentity(sql, claimantId, githubUserId);

    await expect(sql`select creditor_id, status, credits from settlements where issue_id = ${pullRequest.issueId}`)
      .resolves.toEqual([{ creditor_id: null, status: "UNCLAIMED", credits: 6 }]);
    await expect(sql`select id from self_work_calibrations where issue_id = ${pullRequest.issueId}`)
      .resolves.toHaveLength(0);
  });

  it("claims authorship and other credits in the same call after converting self-work", async () => {
    const selfWork = await insertPullRequest(sql);
    const otherWork = await insertPullRequest(sql);
    const claimantId = selfWork.sponsorId;
    const githubUserId = await githubUserIdOf(sql, claimantId);
    for (const pullRequest of [selfWork, otherWork]) {
      await sql`
        update pull_requests set author_id = null, author_github_user_id = ${githubUserId}
        where id = ${pullRequest.id}
      `;
      await insertUnclaimedIdentitySettlement(sql, pullRequest, githubUserId, "both-kinds-author");
    }

    await claimGitHubIdentity(sql, claimantId, githubUserId);

    await expect(sql`select id from settlements where issue_id = ${selfWork.issueId}`).resolves.toHaveLength(0);
    await expect(sql`
      select user_id, actual_points from self_work_calibrations where issue_id = ${selfWork.issueId}
    `).resolves.toEqual([{ user_id: claimantId, actual_points: 6 }]);
    await expect(sql`select creditor_id, status, credits from settlements where issue_id = ${otherWork.issueId}`)
      .resolves.toEqual([{ creditor_id: claimantId, status: "SETTLED", credits: 6 }]);
    await expect(sql`
      select author_id from pull_requests where id in (${selfWork.id}, ${otherWork.id})
    `).resolves.toEqual([{ author_id: claimantId }, { author_id: claimantId }]);
  });

  it("claims an unclaimed GitHub identity without rewriting its proof or amount", async () => {
    const pullRequest = await insertPullRequest(sql);
    const contributor = await insertIdentity(sql, "later-contributor");
    const proofFingerprint = "f".repeat(64);

    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, creditor_github_login, creditor_github_user_id, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${pullRequest.issueId}, null, ${"later-contributor"}, ${contributor.githubUserId}, ${pullRequest.sponsorId},
        5, 6, 2, 4, ${proofFingerprint}, ${"UNCLAIMED"}
      )
    `;

    await claimGitHubIdentity(sql, contributor.id, contributor.githubUserId);

    const [claimed] = await sql<{
      creditor_id: string;
      credits: number;
      proof_sha256: string;
      status: string;
    }[]>`
      select creditor_id, credits, proof_sha256, status
      from settlements where issue_id = ${pullRequest.issueId}
    `;
    expect(claimed).toEqual({
      creditor_id: contributor.id,
      credits: 4,
      proof_sha256: proofFingerprint,
      status: "SETTLED",
    });
  });

  it("never lets a recycled login claim another account's unclaimed credits", async () => {
    const pullRequest = await insertPullRequest(sql);
    const originalGitHubUserId = nextExternalId();
    const proofFingerprint = "e".repeat(64);
    await sql`
      update pull_requests set author_id = null, author_github_login = ${"shared-login"},
        author_github_user_id = ${originalGitHubUserId}
      where id = ${pullRequest.id}
    `;
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, creditor_github_login, creditor_github_user_id, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${pullRequest.issueId}, null, ${"shared-login"}, ${originalGitHubUserId}, ${pullRequest.sponsorId},
        5, 6, 0, 6, ${proofFingerprint}, ${"UNCLAIMED"}
      )
    `;
    const impostor = await insertIdentity(sql, "shared-login");

    await claimGitHubIdentity(sql, impostor.id, impostor.githubUserId);

    await expect(sql<{ creditor_id: string | null; status: string; credits: number }[]>`
      select creditor_id, status, credits from settlements where issue_id = ${pullRequest.issueId}
    `).resolves.toEqual([{ creditor_id: null, status: "UNCLAIMED", credits: 6 }]);
    await expect(sql<{ author_id: string | null }[]>`
      select author_id from pull_requests where id = ${pullRequest.id}
    `).resolves.toEqual([{ author_id: null }]);

    const original = await insertIdentity(sql, "shared-login-renamed", originalGitHubUserId);
    await claimGitHubIdentity(sql, original.id, original.githubUserId);

    await expect(sql<{ creditor_id: string | null; status: string; credits: number }[]>`
      select creditor_id, status, credits from settlements where issue_id = ${pullRequest.issueId}
    `).resolves.toEqual([{ creditor_id: original.id, status: "SETTLED", credits: 6 }]);
    await expect(sql<{ author_id: string | null }[]>`
      select author_id from pull_requests where id = ${pullRequest.id}
    `).resolves.toEqual([{ author_id: original.id }]);
  });

  it("leaves a legacy unclaimed settlement without a creditor id unclaimable by login", async () => {
    const pullRequest = await insertPullRequest(sql);
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, creditor_github_login, creditor_github_user_id, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${pullRequest.issueId}, null, ${"legacy-login"}, null, ${pullRequest.sponsorId},
        5, 6, 0, 6, ${"d".repeat(64)}, ${"UNCLAIMED"}
      )
    `;
    const claimant = await insertIdentity(sql, "legacy-login");

    await claimGitHubIdentity(sql, claimant.id, claimant.githubUserId);

    await expect(sql<{ creditor_id: string | null; status: string }[]>`
      select creditor_id, status from settlements where issue_id = ${pullRequest.issueId}
    `).resolves.toEqual([{ creditor_id: null, status: "UNCLAIMED" }]);
  });

  it.each([
    ["creditor", "WARNED"],
    ["creditor", "UNDER_AUDIT"],
    ["sponsor", "WARNED"],
    ["sponsor", "UNDER_AUDIT"],
  ] as const)("claims an unclaimed identity when the %s is %s", async (eligibleActor, state) => {
    const pullRequest = await insertPullRequest(sql);
    const contributorLogin = `eligible-${nextExternalId()}`;
    const contributor = await insertIdentity(sql, contributorLogin);
    const eligibleUserId = eligibleActor === "creditor" ? contributor.id : pullRequest.sponsorId;
    const proofFingerprint = `${state === "WARNED" ? "a" : "d"}`.repeat(64);

    await sql`
      update users set enforcement_state = ${state} where id = ${eligibleUserId}
    `;
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, creditor_github_login, creditor_github_user_id, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${pullRequest.issueId}, null, ${contributorLogin}, ${contributor.githubUserId}, ${pullRequest.sponsorId},
        5, 6, 2, 4, ${proofFingerprint}, ${"UNCLAIMED"}
      )
    `;

    await claimGitHubIdentity(sql, contributor.id, contributor.githubUserId);

    const [claimed] = await sql<{
      creditor_id: string | null;
      status: string;
      credits: number;
      proof_sha256: string;
    }[]>`
      select creditor_id, status, credits, proof_sha256
      from settlements where issue_id = ${pullRequest.issueId}
    `;
    expect(claimed).toEqual({
      creditor_id: contributor.id,
      status: "SETTLED",
      credits: 4,
      proof_sha256: proofFingerprint,
    });
  });

  it.each([
    ["creditor", "BANNED"],
    ["creditor", "RECALIBRATING"],
    ["sponsor", "BANNED"],
    ["sponsor", "RECALIBRATING"],
  ])("leaves an unclaimed settlement unclaimed when its %s is %s", async (ineligibleActor, state) => {
    const pullRequest = await insertPullRequest(sql);
    const contributorLogin = `ineligible-${nextExternalId()}`;
    const contributor = await insertIdentity(sql, contributorLogin);
    const ineligibleUserId = ineligibleActor === "creditor" ? contributor.id : pullRequest.sponsorId;
    const proofFingerprint = `${state === "BANNED" ? "b" : "c"}`.repeat(64);

    await sql`
      update users set enforcement_state = ${state} where id = ${ineligibleUserId}
    `;
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, creditor_github_login, creditor_github_user_id, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${pullRequest.issueId}, null, ${contributorLogin}, ${contributor.githubUserId}, ${pullRequest.sponsorId},
        5, 6, 2, 4, ${proofFingerprint}, ${"UNCLAIMED"}
      )
    `;

    await claimGitHubIdentity(sql, contributor.id, contributor.githubUserId);

    const [claimed] = await sql<{
      creditor_id: string | null;
      status: string;
      credits: number;
    }[]>`
      select creditor_id, status, credits
      from settlements where issue_id = ${pullRequest.issueId}
    `;
    expect(claimed).toEqual({ creditor_id: null, status: "UNCLAIMED", credits: 4 });
  });

  it("claims historically eligible unclaimed work after the contributor is sanctioned later", async () => {
    const pullRequest = await insertPullRequest(sql);
    const contributorLogin = `later-sanctioned-${nextExternalId()}`;
    const contributor = await insertIdentity(sql, contributorLogin);
    const moderatorId = await insertUser(sql);
    await sql`
      insert into settlements (
        pull_request_id, issue_id, creditor_id, creditor_github_login, creditor_github_user_id, debtor_id,
        opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
      )
      values (
        ${pullRequest.id}, ${pullRequest.issueId}, null, ${contributorLogin}, ${contributor.githubUserId}, ${pullRequest.sponsorId},
        5, 6, 0, 6, ${"9".repeat(64)}, ${"UNCLAIMED"}
      )
    `;
    await sql`
      insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason, created_at)
      select ${contributor.id}, ${moderatorId}, ${"ACTIVE"}, ${"BANNED"}, ${"Sanction after eligible merge"},
        pull_requests.merged_at + interval '1 minute'
      from pull_requests where id = ${pullRequest.id}
    `;
    await sql`update users set enforcement_state = ${"BANNED"} where id = ${contributor.id}`;

    await claimGitHubIdentity(sql, contributor.id, contributor.githubUserId);

    await expect(sql<{ creditor_id: string | null; status: string }[]>`
      select creditor_id, status from settlements where issue_id = ${pullRequest.issueId}
    `).resolves.toEqual([{ creditor_id: contributor.id, status: "SETTLED" }]);
  });

  it.each([
    ["exactly at merge", "2026-09-01T12:00:00.000Z", "UNCLAIMED"],
    ["one millisecond after merge", "2026-09-01T12:00:00.001Z", "SETTLED"],
    ["one millisecond before merge", "2026-09-01T11:59:59.999Z", "UNCLAIMED"],
  ] as const)("resolves a claim when the claimant is banned %s", async (_boundary, sanctionedAt, status) => {
    const pullRequest = await insertPullRequest(sql);
    const contributorLogin = `merge-boundary-${nextExternalId()}`;
    const contributor = await insertIdentity(sql, contributorLogin);
    const moderatorId = await insertUser(sql);
    await sql`
      update pull_requests set merged_at = ${"2026-09-01T12:00:00.000Z"}
      where id = ${pullRequest.id}
    `;
    await insertUnclaimedIdentitySettlement(sql, pullRequest, contributor.githubUserId, contributorLogin);
    await sql`
      insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason, created_at)
      values
        (${contributor.id}, ${moderatorId}, ${"WARNED"}, ${"ACTIVE"}, ${"Restored before merge"},
          ${"2026-09-01T11:00:00.000Z"}),
        (${contributor.id}, ${moderatorId}, ${"ACTIVE"}, ${"BANNED"}, ${"Sanction at merge boundary"},
          ${sanctionedAt})
    `;
    await sql`update users set enforcement_state = ${"BANNED"} where id = ${contributor.id}`;

    await claimGitHubIdentity(sql, contributor.id, contributor.githubUserId);

    await expect(sql<{ creditor_id: string | null; status: string; credits: number }[]>`
      select creditor_id, status, credits from settlements where issue_id = ${pullRequest.issueId}
    `).resolves.toEqual([{
      creditor_id: status === "SETTLED" ? contributor.id : null,
      status,
      credits: 6,
    }]);
  });

  it("derives zero-sum ledger entries and account balances from settlements", async () => {
    const settlement = await insertSettledRecord("b".repeat(64));

    expect(await sumLedgerEntries(sql)).toBe(0);

    const balances = await sql<{ account_id: string; balance: number }[]>`
      select account_id, balance from balances
      where account_id in (${settlement.creditorId}, ${settlement.debtorId})
      order by account_id
    `;
    expect(balances).toEqual([
      { account_id: settlement.creditorId, balance: 4 },
      { account_id: settlement.debtorId, balance: -4 },
    ].sort((left, right) => left.account_id.localeCompare(right.account_id)));
  });

  it("retains self-work only in self-work calibrations", async () => {
    const pullRequest = await insertPullRequest(sql);

    await expect(sql`
      insert into settlements (
        pull_request_id,
        issue_id,
        creditor_id,
        debtor_id,
        opening_comparison_points,
        settled_points,
        review_rounds,
        credits,
        proof_sha256,
        status
      )
      values (
        ${pullRequest.id},
        ${pullRequest.issueId},
        ${pullRequest.sponsorId},
        ${pullRequest.sponsorId},
        5,
        6,
        2,
        4,
        ${"d".repeat(64)},
        ${"SETTLED"}
      )
    `).rejects.toThrow();

    const [calibration] = await sql<{ pull_request_id: string; user_id: string }[]>`
      insert into self_work_calibrations (
        pull_request_id,
        issue_id,
        user_id,
        opening_comparison_points,
        actual_points
      )
      values (
        ${pullRequest.id},
        ${pullRequest.issueId},
        ${pullRequest.sponsorId},
        5,
        6
      )
      returning pull_request_id, user_id
    `;

    expect(calibration).toEqual({
      pull_request_id: pullRequest.id,
      user_id: pullRequest.sponsorId,
    });
  });

  it("records calibration audits as account evaluation periods without settlement rerating fields", async () => {
    const accountId = await insertUser(sql);
    const reporterId = await insertUser(sql);
    const [audit] = await sql<{ account_id: string; settled_sample_size: number }[]>`
      insert into calibration_audits (
        account_id,
        reporter_id,
        rationale,
        sample_started_at,
        sample_ended_at,
        settled_sample_size
      )
      values (
        ${accountId},
        ${reporterId},
        ${"The account's settled sample warrants evaluation."},
        now() - interval '30 days',
        now(),
        3
      )
      returning account_id, settled_sample_size
    `;

    expect(audit).toEqual({ account_id: accountId, settled_sample_size: 3 });

    const columns = await sql<{ column_name: string }[]>`
      select column_name
      from information_schema.columns
      where table_schema = 'public' and table_name = 'calibration_audits'
    `;
    const columnNames = columns.map((column) => column.column_name);
    expect(columnNames).toEqual(
      expect.arrayContaining([
        "account_id",
        "sample_started_at",
        "sample_ended_at",
        "settled_sample_size",
      ]),
    );
    expect(columnNames).not.toContain("settlement_id");
    expect(columnNames).not.toContain("corrected_points");
  });

  it("derives account calibration statistics from settled facts only", async () => {
    const settled = await insertSettledRecord("e".repeat(64));
    const unsettled = await insertUnsettledRecord("f".repeat(64));

    const [settledStatistics] = await sql<{
      account_id: string;
      settlement_count: number;
      average_points_delta: number | string;
    }[]>`
      select account_id, settlement_count, average_points_delta
      from calibration_statistics
      where account_id = ${settled.debtorId}
    `;
    expect(settledStatistics).toMatchObject({
      account_id: settled.debtorId,
      settlement_count: 1,
    });
    expect(Number(settledStatistics.average_points_delta)).toBe(1);

    const unsettledStatistics = await sql<{ account_id: string }[]>`
      select account_id
      from calibration_statistics
      where account_id = ${unsettled.debtorId}
    `;
    expect(unsettledStatistics).toEqual([]);
  });

  it("rejects direct writes to every derived view", async () => {
    await expect(sql`insert into ledger_entries default values`).rejects.toThrow();
    await expect(sql`insert into balances default values`).rejects.toThrow();
    await expect(sql`insert into calibration_statistics default values`).rejects.toThrow();
  });

  it("rebuilds the original opening proof and mutation violation into an empty materialization", async () => {
    const sponsorLogin = `opening-owner-${nextExternalId()}`;
    const contributorLogin = `opening-worker-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string; github_repository_id: number | string }[]>`
      select owner_name, github_repository_id from registered_repositories where id = ${repositoryId}
    `;
    const snapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      githubRepositoryId: Number(repository.github_repository_id),
      sponsorId,
      contributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      githubIssueId: nextExternalId(),
      githubPullRequestId: nextExternalId(),
    });
    const issue = snapshot.issues[0]!;
    issue.labels = ["L", "delivered/6"];
    issue.history.push(
      {
        kind: "UNLABELED",
        id: "opening-M-removed-after-assignment",
        actorLogin: sponsorLogin,
        label: "M",
        createdAt: "2026-09-01T09:30:00.000Z",
      },
      {
        kind: "LABELED",
        id: "opening-L-added-after-assignment",
        actorLogin: sponsorLogin,
        label: "L",
        createdAt: "2026-09-01T09:31:00.000Z",
      },
    );
    const fold = foldRepository(snapshot);
    expect(fold.issues[0]).toMatchObject({
      openingLabel: "M",
      openingComparisonPoints: 5,
      openingSourceEventId: `opening-${issue.id}`,
      openingSourceActorLogin: sponsorLogin,
    });
    expect(fold.policyViolations).toContainEqual({
      code: "OPENING_LABEL_MUTATED",
      githubIssueId: issue.id,
    });

    const store = new PostgresFoldStore(sql);
    const runId = await store.beginRun(repositoryId);
    await store.materialize({ repositoryId, runId, fold });

    await expect(sql`
      select opening_label, opening_comparison_points, opening_source_event_id,
             opening_source_actor_login
      from issues where repository_id = ${repositoryId}
    `).resolves.toEqual([{
      opening_label: "M",
      opening_comparison_points: 5,
      opening_source_event_id: `opening-${issue.id}`,
      opening_source_actor_login: sponsorLogin,
    }]);
    await expect(sql`
      select after_state
      from reconciliation_changes
      where reconciliation_run_id = ${runId} and change_kind = ${"POLICY_VIOLATION"}
    `).resolves.toEqual([{
      after_state: { code: "OPENING_LABEL_MUTATED", githubIssueId: issue.id },
    }]);
  });

  it("repairs a legacy opening once when immutable GitHub source proof is first attached", async () => {
    const sponsorLogin = `legacy-opening-owner-${nextExternalId()}`;
    const contributorLogin = `legacy-opening-worker-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string; github_repository_id: number | string }[]>`
      select owner_name, github_repository_id from registered_repositories where id = ${repositoryId}
    `;
    const githubIssueId = nextExternalId();
    const snapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      githubRepositoryId: Number(repository.github_repository_id),
      sponsorId,
      contributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      githubIssueId,
      githubPullRequestId: nextExternalId(),
    });
    const authoritativeIssue = snapshot.issues[0]!;

    await sql`
      insert into issues (
        github_issue_id, repository_id, issue_number, title, body, url, state,
        opening_label, opening_comparison_points, opening_reserve_points
      )
      values (
        ${githubIssueId}, ${repositoryId}, ${authoritativeIssue.number}, ${authoritativeIssue.title},
        ${authoritativeIssue.body}, ${authoritativeIssue.url}, ${authoritativeIssue.state},
        ${"L"}, 8, 8
      )
    `;

    const store = new PostgresFoldStore(sql);
    const runId = await store.beginRun(repositoryId);
    await store.materialize({ repositoryId, runId, fold: foldRepository(snapshot) });

    await expect(sql`
      select opening_label, opening_comparison_points, opening_reserve_points,
             opening_source_event_id, opening_source_actor_login
      from issues where github_issue_id = ${githubIssueId}
    `).resolves.toEqual([{
      opening_label: "M",
      opening_comparison_points: 5,
      opening_reserve_points: 5,
      opening_source_event_id: `opening-${githubIssueId}`,
      opening_source_actor_login: sponsorLogin,
    }]);
  });

  it("refreshes both display logins when the account behind unchanged opening evidence is renamed", async () => {
    const sponsorLogin = `rename-owner-old-${nextExternalId()}`;
    const renamedSponsorLogin = `rename-owner-new-${nextExternalId()}`;
    const contributorLogin = `rename-worker-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string }[]>`
      select owner_name from registered_repositories where id = ${repositoryId}
    `;
    const githubIssueId = nextExternalId();
    const githubPullRequestId = nextExternalId();
    const sponsorGitHubUserId = await githubUserIdOf(sql, sponsorId);
    const contributorGitHubUserId = await githubUserIdOf(sql, contributorId);
    const snapshotAs = (ownerLogin: string) => materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      sponsorId,
      contributorId,
      sponsorGitHubUserId,
      contributorGitHubUserId,
      sponsorLogin: ownerLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      githubIssueId,
      githubPullRequestId,
    });
    const store = new PostgresFoldStore(sql);
    await store.materialize({
      repositoryId,
      runId: await store.beginRun(repositoryId),
      fold: foldRepository(snapshotAs(sponsorLogin)),
    });

    // GitHub renames the account: the snapshot's issue author and opening label
    // actor report the new login while the labelling event itself is untouched.
    // What the rename does to the rest of the product is a reconciliation
    // concern, covered by tests/fold/renamed-owner-reconciliation.test.ts.
    const renameRun = await store.beginRun(repositoryId);
    // The one recorded change is the settled evidence's display text following the rename.
    await expect(store.materialize({
      repositoryId,
      runId: renameRun,
      fold: foldRepository(snapshotAs(renamedSponsorLogin)),
    })).resolves.toEqual({ adds: 0, changes: 1, removals: 0 });
    await expect(sql`
      select before_state, after_state from reconciliation_changes
      where reconciliation_run_id = ${renameRun} and entity_kind = ${"SETTLEMENT"}
    `).resolves.toEqual([{
      before_state: expect.objectContaining({
        settledLabelActorLogin: sponsorLogin,
        settledRationaleActorLogin: sponsorLogin,
      }),
      after_state: expect.objectContaining({
        settledLabelActorLogin: renamedSponsorLogin,
        settledRationaleActorLogin: renamedSponsorLogin,
      }),
    }]);

    await expect(sql`
      select owner_github_login, opening_source_actor_login, opening_source_event_id,
             opening_source_at, opening_label, opening_comparison_points, opening_reserve_points
      from issues where github_issue_id = ${githubIssueId}
    `).resolves.toEqual([{
      owner_github_login: renamedSponsorLogin,
      opening_source_actor_login: renamedSponsorLogin,
      opening_source_event_id: `opening-${githubIssueId}`,
      opening_source_at: new Date("2026-09-01T08:01:00.000Z"),
      opening_label: "M",
      opening_comparison_points: 5,
      opening_reserve_points: 5,
    }]);
  });

  it("refuses a materialization carrying a different opening event for an already proven issue", async () => {
    const sponsorLogin = `rewritten-owner-${nextExternalId()}`;
    const renamedSponsorLogin = `rewritten-owner-renamed-${nextExternalId()}`;
    const contributorLogin = `rewritten-worker-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string }[]>`
      select owner_name from registered_repositories where id = ${repositoryId}
    `;
    const githubIssueId = nextExternalId();
    const githubPullRequestId = nextExternalId();
    const sponsorGitHubUserId = await githubUserIdOf(sql, sponsorId);
    const contributorGitHubUserId = await githubUserIdOf(sql, contributorId);
    const snapshotAs = (ownerLogin: string) => materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      sponsorId,
      contributorId,
      sponsorGitHubUserId,
      contributorGitHubUserId,
      sponsorLogin: ownerLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      githubIssueId,
      githubPullRequestId,
    });
    const store = new PostgresFoldStore(sql);
    await store.materialize({
      repositoryId,
      runId: await store.beginRun(repositoryId),
      fold: foldRepository(snapshotAs(sponsorLogin)),
    });
    const storedIssue = async () => sql`
      select title, owner_github_login, opening_source_actor_login, opening_source_event_id,
             opening_source_at, opening_label, opening_comparison_points, opening_reserve_points
      from issues where github_issue_id = ${githubIssueId}
    `;
    const before = await storedIssue();

    // The refused payload also carries edits the store writes willingly — a
    // renamed account and a retitled issue — so a store that wrote the row and
    // skipped the rollback would leave a visibly different row behind.
    const rewrittenSnapshot = snapshotAs(renamedSponsorLogin);
    rewrittenSnapshot.issues[0]!.title = "A retitled materialized issue";
    rewrittenSnapshot.issues[0]!.history[0]!.id = `opening-rewritten-${githubIssueId}`;
    const rewritten = foldRepository(rewrittenSnapshot);
    expect(rewritten.issues[0]).toMatchObject({
      title: "A retitled materialized issue",
      ownerGitHubLogin: renamedSponsorLogin,
      openingSourceActorLogin: renamedSponsorLogin,
      openingSourceEventId: `opening-rewritten-${githubIssueId}`,
    });

    await expect(store.materialize({
      repositoryId,
      runId: await store.beginRun(repositoryId),
      fold: rewritten,
    })).rejects.toThrow("Issue opening evidence did not match immutable GitHub history.");
    await expect(storedIssue()).resolves.toEqual(before);
    expect(before).toEqual([expect.objectContaining({
      title: "A materialized issue",
      owner_github_login: sponsorLogin,
      opening_source_actor_login: sponsorLogin,
      opening_source_event_id: `opening-${githubIssueId}`,
    })]);
  });

  it("refuses a materialization redating the same opening event for an already proven issue", async () => {
    const sponsorLogin = `redated-owner-${nextExternalId()}`;
    const contributorLogin = `redated-worker-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string }[]>`
      select owner_name from registered_repositories where id = ${repositoryId}
    `;
    const githubIssueId = nextExternalId();
    const githubPullRequestId = nextExternalId();
    const snapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      sponsorId,
      contributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      githubIssueId,
      githubPullRequestId,
    });
    const store = new PostgresFoldStore(sql);
    await store.materialize({
      repositoryId,
      runId: await store.beginRun(repositoryId),
      fold: foldRepository(snapshot),
    });
    const storedIssue = async () => sql`
      select owner_github_login, opening_source_actor_login, opening_source_event_id,
             opening_source_at, opening_label, opening_comparison_points, opening_reserve_points
      from issues where github_issue_id = ${githubIssueId}
    `;
    const before = await storedIssue();

    // The opening event keeps its node id and only its timestamp moves, so the
    // event-id comparison alone cannot see this rewritten history.
    const redatedSnapshot = structuredClone(snapshot);
    redatedSnapshot.issues[0]!.history[0]!.createdAt = "2026-09-01T08:02:00.000Z";
    const redated = foldRepository(redatedSnapshot);
    expect(redated.issues[0]).toMatchObject({
      openingSourceEventId: `opening-${githubIssueId}`,
      openingSourceAt: "2026-09-01T08:02:00.000Z",
    });

    await expect(store.materialize({
      repositoryId,
      runId: await store.beginRun(repositoryId),
      fold: redated,
    })).rejects.toThrow("Issue opening evidence did not match immutable GitHub history.");
    await expect(storedIssue()).resolves.toEqual(before);
    expect(before).toEqual([expect.objectContaining({
      opening_source_event_id: `opening-${githubIssueId}`,
      opening_source_at: new Date("2026-09-01T08:01:00.000Z"),
    })]);
  });

  it("establishes a legacy unclaimed settlement's creditor id on rebuild so the original account can claim it", async () => {
    const sponsorLogin = `backfill-sponsor-${nextExternalId()}`;
    const sponsor = await insertIdentity(sql, sponsorLogin);
    const contributorGitHubUserId = nextExternalId();
    const contributorLogin = `backfill-contributor-${contributorGitHubUserId}`;
    const repositoryId = await insertRepository(sql, sponsor.id);
    const [repository] = await sql<{ owner_name: string; github_repository_id: number | string }[]>`
      select owner_name, github_repository_id from registered_repositories where id = ${repositoryId}
    `;
    const githubIssueId = nextExternalId();
    const githubPullRequestId = nextExternalId();
    const snapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      githubRepositoryId: Number(repository.github_repository_id),
      sponsorId: sponsor.id,
      sponsorGitHubUserId: sponsor.githubUserId,
      contributorId: "not-a-member",
      contributorGitHubUserId,
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      githubIssueId,
      githubPullRequestId,
    });
    snapshot.users = snapshot.users.filter((user) => user.id === sponsor.id);
    const store = new PostgresFoldStore(sql);

    // A row as the previous release wrote it: login only, no id.
    await store.materialize({ repositoryId, runId: await store.beginRun(repositoryId), fold: foldRepository(snapshot) });
    await sql`
      update settlements set creditor_github_user_id = null
      from issues where issues.id = settlements.issue_id and issues.github_issue_id = ${githubIssueId}
    `;
    await sql`
      update pull_requests set author_github_user_id = null where github_pull_request_id = ${githubPullRequestId}
    `;

    const unknownAuthorSnapshot = structuredClone(snapshot);
    unknownAuthorSnapshot.issues[0]!.closingPullRequests[0]!.authorGitHubUserId = null;
    await expect(store.materialize({
      repositoryId, runId: await store.beginRun(repositoryId), fold: foldRepository(unknownAuthorSnapshot),
    })).resolves.toEqual({ adds: 0, changes: 0, removals: 0 });

    const rebuildRun = await store.beginRun(repositoryId);
    await expect(store.materialize({ repositoryId, runId: rebuildRun, fold: foldRepository(snapshot) }))
      .resolves.toEqual({ adds: 0, changes: 1, removals: 0 });
    const changes = await sql`
      select before_state, after_state from reconciliation_changes
      where reconciliation_run_id = ${rebuildRun} and entity_kind = ${"SETTLEMENT"} and change_kind = ${"CHANGE"}
    `;
    expect(changes).toEqual([{
      before_state: expect.objectContaining({ creditorGitHubUserId: null }),
      after_state: expect.objectContaining({ creditorGitHubUserId: contributorGitHubUserId }),
    }]);
    await expect(sql<{ creditor_github_user_id: number; status: string }[]>`
      select settlements.creditor_github_user_id::integer, settlements.status
      from settlements join issues on issues.id = settlements.issue_id
      where issues.github_issue_id = ${githubIssueId}
    `).resolves.toEqual([{ creditor_github_user_id: contributorGitHubUserId, status: "UNCLAIMED" }]);
    await expect(sql<{ author_github_user_id: number }[]>`
      select author_github_user_id::integer from pull_requests where github_pull_request_id = ${githubPullRequestId}
    `).resolves.toEqual([{ author_github_user_id: contributorGitHubUserId }]);

    const contributor = await insertIdentity(sql, contributorLogin, contributorGitHubUserId);
    await claimGitHubIdentity(sql, contributor.id, contributor.githubUserId);

    await expect(sql<{ creditor_id: string | null; status: string; credits: number }[]>`
      select settlements.creditor_id, settlements.status, settlements.credits
      from settlements join issues on issues.id = settlements.issue_id
      where issues.github_issue_id = ${githubIssueId}
    `).resolves.toEqual([{ creditor_id: contributor.id, status: "SETTLED", credits: 6 }]);
  });

  it("replaces a repository materialization atomically while retaining the first observed opening rating", async () => {
    const sponsorId = await insertUserWithLogin(sql, "materialization-sponsor");
    const contributorId = await insertUserWithLogin(sql, "materialization-contributor");
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string; github_repository_id: number | string }[]>`
      select owner_name, github_repository_id from registered_repositories where id = ${repositoryId}
    `;
    const store = new PostgresFoldStore(sql);
    const initial = foldRepository(materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      githubRepositoryId: Number(repository.github_repository_id),
      sponsorId,
      contributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
      issueLabels: ["M"],
      actualLabel: "delivered/6",
    }));
    const initialRun = await store.beginRun(repositoryId);

    await expect(store.materialize({ repositoryId, runId: initialRun, fold: initial })).resolves.toEqual({
      adds: 1,
      changes: 0,
      removals: 0,
    });

    const changedSnapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      githubRepositoryId: Number(repository.github_repository_id),
      sponsorId,
      contributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
      issueLabels: ["M"],
      actualLabel: "delivered/7",
    });
    changedSnapshot.issues[0]!.labels = ["L", "delivered/7"];
    changedSnapshot.issues[0]!.history.push(
      {
        kind: "UNLABELED",
        id: "opening-M-removed",
        actorLogin: "materialization-sponsor",
        label: "M",
        createdAt: "2026-09-01T09:30:00.000Z",
      },
      {
        kind: "LABELED",
        id: "opening-L-added",
        actorLogin: "materialization-sponsor",
        label: "L",
        createdAt: "2026-09-01T09:31:00.000Z",
      },
    );
    const changed = foldRepository(changedSnapshot);
    expect(changed.policyViolations).toContainEqual({
      code: "OPENING_LABEL_MUTATED",
      githubIssueId: initial.issues[0]!.githubIssueId,
    });
    const changedRun = await store.beginRun(repositoryId);

    await expect(store.materialize({ repositoryId, runId: changedRun, fold: changed })).resolves.toEqual({
      adds: 0,
      changes: 1,
      removals: 0,
    });
    const [issue] = await sql<{
      opening_label: string;
      opening_comparison_points: number;
      opening_reserve_points: number;
    }[]>`
      select opening_label, opening_comparison_points, opening_reserve_points
      from issues where repository_id = ${repositoryId}
    `;
    expect(issue).toEqual({
      opening_label: "M",
      opening_comparison_points: 5,
      opening_reserve_points: 5,
    });
    const [run] = await sql<{ repository_id: string; status: string }[]>`
      select repository_id, status from reconciliation_runs where id = ${changedRun}
    `;
    expect(run).toEqual({ repository_id: repositoryId, status: "COMPLETED" });

    const removedRun = await store.beginRun(repositoryId);
    await expect(
      store.materialize({
        repositoryId,
        runId: removedRun,
        fold: foldRepository({
          ...materializationSnapshot({
            repositoryId,
            ownerName: repository.owner_name,
            githubRepositoryId: Number(repository.github_repository_id),
            sponsorId,
            contributorId,
            sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
            contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
            issueLabels: ["M"],
            actualLabel: "delivered/6",
          }),
          issues: [],
        }),
      }),
    ).resolves.toEqual({ adds: 0, changes: 0, removals: 1 });
    expect(await sql`select id from issues where repository_id = ${repositoryId}`).toEqual([]);
    expect(await sql`select id from pull_requests where repository_id = ${repositoryId}`).toEqual([]);
    expect(await sql`select id from settlements where debtor_id = ${sponsorId}`).toEqual([]);
    const [removalChange] = await sql<{ change_kind: string; pull_request_id: string | null }[]>`
      select change_kind, pull_request_id
      from reconciliation_changes
      where reconciliation_run_id = ${removedRun} and change_kind = ${"REMOVE"}
    `;
    expect(removalChange).toEqual({ change_kind: "REMOVE", pull_request_id: null });
  });

  it("records proof-only issue-history and merge-OID changes with the true prior canonical state", async () => {
    const sponsorLogin = `proof-sponsor-${nextExternalId()}`;
    const contributorLogin = `proof-contributor-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string; github_repository_id: number | string }[]>`
      select owner_name, github_repository_id from registered_repositories where id = ${repositoryId}
    `;
    const snapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      githubRepositoryId: Number(repository.github_repository_id),
      sponsorId,
      contributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      githubIssueId: nextExternalId(),
      githubPullRequestId: nextExternalId(),
    });
    const store = new PostgresFoldStore(sql);
    const initialRun = await store.beginRun(repositoryId);
    await store.materialize({ repositoryId, runId: initialRun, fold: foldRepository(snapshot) });

    const changedSnapshot = structuredClone(snapshot);
    const issue = changedSnapshot.issues[0]!;
    const actualEvent = issue.history.find((event) => event.kind === "LABELED" && event.label === "delivered/6");
    if (actualEvent === undefined) throw new Error("Expected actual label proof fixture.");
    actualEvent.id = "replacement-actual-event";
    issue.comments[0]!.id = "replacement-rationale-comment";
    issue.closingPullRequests[0]!.mergeCommitOid = "f".repeat(40);

    const changedRun = await store.beginRun(repositoryId);
    await expect(store.materialize({
      repositoryId,
      runId: changedRun,
      fold: foldRepository(changedSnapshot),
    })).resolves.toEqual({ adds: 0, changes: 1, removals: 0 });

    const [change] = await sql<{
      before_state: { settledLabelEventId: string; settledRationaleCommentId: string; mergeCommitOid: string };
      after_state: { settledLabelEventId: string; settledRationaleCommentId: string; mergeCommitOid: string };
    }[]>`
      select before_state, after_state
      from reconciliation_changes
      where reconciliation_run_id = ${changedRun} and entity_kind = ${"SETTLEMENT"}
    `;
    expect(change.before_state).toMatchObject({
      settledLabelEventId: `actual-${snapshot.issues[0]!.id}`,
      settledRationaleCommentId: `rationale-${snapshot.issues[0]!.id}`,
      mergeCommitOid: snapshot.issues[0]!.closingPullRequests[0]!.mergeCommitOid,
    });
    expect(change.after_state).toMatchObject({
      settledLabelEventId: "replacement-actual-event",
      settledRationaleCommentId: "replacement-rationale-comment",
      mergeCommitOid: "f".repeat(40),
    });
  });

  it("converges real PostgreSQL materialization across reordered GraphQL snapshots", async () => {
    const tokenEncryptionKey = Buffer.alloc(32, 7).toString("base64url");
    const sponsorLogin = `reconciliation-sponsor-${nextExternalId()}`;
    const contributorLogin = `reconciliation-contributor-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    await sql`
      update users
      set encrypted_oauth_token = ${Buffer.from(encryptToken("reconciliation-token", tokenEncryptionKey), "utf8")}
      where id = ${sponsorId}
    `;
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string; github_repository_id: number | string }[]>`
      select owner_name, github_repository_id from registered_repositories where id = ${repositoryId}
    `;
    const repositoryGitHubId = Number(repository.github_repository_id);
    const changedIssueId = nextExternalId();
    const changedPullRequestId = nextExternalId();
    const obsoleteIssueId = nextExternalId();
    const obsoletePullRequestId = nextExternalId();
    const addedIssueId = nextExternalId();
    const addedPullRequestId = nextExternalId();
    const staleSnapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      githubRepositoryId: Number(repository.github_repository_id),
      sponsorId,
      contributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/5",
      githubIssueId: changedIssueId,
      githubPullRequestId: changedPullRequestId,
    });
    const obsoleteIssue = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      githubRepositoryId: Number(repository.github_repository_id),
      sponsorId,
      contributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/5",
      githubIssueId: obsoleteIssueId,
      githubPullRequestId: obsoletePullRequestId,
    }).issues[0]!;
    obsoleteIssue.number = 2;
    obsoleteIssue.title = "An obsolete materialized issue";
    obsoleteIssue.url = "https://github.com/example/materialized/issues/2";
    obsoleteIssue.closingPullRequests[0]!.number = 12;
    obsoleteIssue.closingPullRequests[0]!.title = "An obsolete materialized pull request";
    obsoleteIssue.closingPullRequests[0]!.url = "https://github.com/example/materialized/pull/12";
    staleSnapshot.issues.push(obsoleteIssue);

    const store = new PostgresFoldStore(sql, tokenEncryptionKey);
    const staleRunId = await store.beginRun(repositoryId);
    await expect(store.materialize({
      repositoryId,
      runId: staleRunId,
      fold: foldRepository(staleSnapshot),
    })).resolves.toEqual({ adds: 2, changes: 0, removals: 0 });

    const snapshots: AuthoritativeReconciliationSnapshot[] = [
      {
        issues: [
          authoritativeIssue({ id: changedIssueId, number: 1, ownerLogin: sponsorLogin }),
          authoritativeIssue({ id: addedIssueId, number: 3, ownerLogin: sponsorLogin }),
        ],
        closingPullRequests: new Map([
          [1, [authoritativePullRequest({
            id: changedPullRequestId,
            number: 11,
            authorLogin: contributorLogin,
            authorGitHubUserId: await githubUserIdOf(sql, contributorId),
            repositoryGitHubId,
            repositoryNameWithOwner: repository.owner_name,
          })]],
          [3, [authoritativePullRequest({
            id: addedPullRequestId,
            number: 13,
            authorLogin: contributorLogin,
            authorGitHubUserId: await githubUserIdOf(sql, contributorId),
            repositoryGitHubId,
            repositoryNameWithOwner: repository.owner_name,
          })]],
        ]),
      },
      {
        issues: [
          authoritativeIssue({ id: addedIssueId, number: 3, ownerLogin: sponsorLogin }),
          authoritativeIssue({ id: changedIssueId, number: 1, ownerLogin: sponsorLogin }),
        ],
        closingPullRequests: new Map([
          [3, [authoritativePullRequest({
            id: addedPullRequestId,
            number: 13,
            authorLogin: contributorLogin,
            authorGitHubUserId: await githubUserIdOf(sql, contributorId),
            repositoryGitHubId,
            repositoryNameWithOwner: repository.owner_name,
          })]],
          [1, [authoritativePullRequest({
            id: changedPullRequestId,
            number: 11,
            authorLogin: contributorLogin,
            authorGitHubUserId: await githubUserIdOf(sql, contributorId),
            repositoryGitHubId,
            repositoryNameWithOwner: repository.owner_name,
          })]],
        ]),
      },
    ];
    let snapshotIndex = 0;
    const github: ReconciliationGateway = {
      getRepositoryById: verifiedRepositoryAt(repository.owner_name),
      listIssues: async () => {
        const snapshot = snapshots[snapshotIndex];
        snapshotIndex += 1;
        if (snapshot === undefined) {
          throw new Error("No authoritative reconciliation snapshot remained.");
        }
        return snapshot.issues.map((issue) => ({
          ...issue, closingPullRequests: snapshot.closingPullRequests.get(issue.number) ?? [],
        }));
      },
      getPullRequestReviews: async () => [],
      getPullRequestDiff: async (_repository, pullRequestNumber) => (
        pullRequestNumber === 11 ? "materialized diff" : "added materialized diff"
      ),
    };

    const first = await reconcileRepository({ store, github }, repositoryId);
    const canonicalStateAfterFirstRun = await reconciliationMaterializationState(repositoryId);
    const second = await reconcileRepository({ store, github }, repositoryId);

    expect(first).toMatchObject({ adds: 1, changes: 1, removals: 1 });
    expect(canonicalStateAfterFirstRun.issues.map((issue) => Number(issue.github_issue_id))).toEqual([
      changedIssueId,
      addedIssueId,
    ]);
    expect(second).toMatchObject({ adds: 0, changes: 0, removals: 0 });
    await expect(reconciliationMaterializationState(repositoryId)).resolves.toEqual(canonicalStateAfterFirstRun);
  });

  it("serializes a repository before snapshot work and releases the cross-process lock on success or error", async () => {
    const repositoryId = await insertRepository(sql, await insertUser(sql));
    const firstWorker = new PostgresFoldStore(sql);
    const secondWorker = new PostgresFoldStore(sql);
    let releaseOlder!: () => void;
    let olderStarted!: () => void;
    const started = new Promise<void>((resolve) => { olderStarted = resolve; });
    const holdOlder = new Promise<void>((resolve) => { releaseOlder = resolve; });
    const order: string[] = [];

    const older = firstWorker.withRepositoryReconciliation(repositoryId, async () => {
      order.push("older-snapshot-started");
      olderStarted();
      await holdOlder;
      order.push("older-materialized");
    });
    await started;
    const newer = secondWorker.withRepositoryReconciliation(repositoryId, async () => {
      order.push("newer-snapshot-started");
      order.push("newer-materialized");
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(order).toEqual(["older-snapshot-started"]);

    releaseOlder();
    await Promise.all([older, newer]);
    expect(order).toEqual([
      "older-snapshot-started",
      "older-materialized",
      "newer-snapshot-started",
      "newer-materialized",
    ]);

    await expect(firstWorker.withRepositoryReconciliation(repositoryId, async () => {
      throw new Error("expected worker failure");
    })).rejects.toThrow("expected worker failure");
    await expect(secondWorker.withRepositoryReconciliation(repositoryId, async () => "lock-released"))
      .resolves.toBe("lock-released");
  });

  it("keeps the shared pool available while a full cohort of repository reconciliations waits", async () => {
    const sharedPoolCapacity = sql.options.max;
    expect(sharedPoolCapacity).toBe(10);
    const tokenEncryptionKey = Buffer.alloc(32, 15).toString("base64url");
    const sponsorLogin = `pool-sponsor-${nextExternalId()}`;
    const contributorLogin = `pool-contributor-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    await sql`
      update users
      set encrypted_oauth_token = ${Buffer.from(encryptToken("pool-token", tokenEncryptionKey), "utf8")}
      where id = ${sponsorId}
    `;
    const githubRepositoryId = nextExternalId();
    const repositoryId = await insertRepository(sql, sponsorId, githubRepositoryId);
    const [repository] = await sql<{ owner_name: string; github_repository_id: number | string }[]>`
      select owner_name, github_repository_id from registered_repositories where id = ${repositoryId}
    `;
    const githubIssueId = nextExternalId();
    const githubPullRequestId = nextExternalId();
    const runOrder: string[] = [];
    const pointsByRun = new Map<string, number>();
    let activeSnapshotFetches = 0;
    let maximumActiveSnapshotFetches = 0;
    let releaseOwnerFetch!: () => void;
    let markOwnerFetchStarted!: () => void;
    const ownerFetchStarted = new Promise<void>((resolve) => { markOwnerFetchStarted = resolve; });
    const holdOwnerFetch = new Promise<void>((resolve) => { releaseOwnerFetch = resolve; });

    const sponsorGitHubUserId = await githubUserIdOf(sql, sponsorId);
    const contributorGitHubUserId = await githubUserIdOf(sql, contributorId);
    const trackedGateway = (
      runName: string,
      points: number,
      hold: Promise<void> | undefined,
    ): ReconciliationGateway => {
      pointsByRun.set(runName, points);
      const snapshot = materializationSnapshot({
        repositoryId,
        ownerName: repository.owner_name,
        githubRepositoryId: Number(repository.github_repository_id),
        sponsorId,
        contributorId,
        sponsorGitHubUserId,
        contributorGitHubUserId,
        sponsorLogin,
        contributorLogin,
        issueLabels: ["M"],
        actualLabel: `delivered/${points}`,
        githubIssueId,
        githubPullRequestId,
      });
      const gateway = gatewayForSnapshot(snapshot);
      return {
        ...gateway,
        async listIssues(reference) {
          runOrder.push(runName);
          activeSnapshotFetches += 1;
          maximumActiveSnapshotFetches = Math.max(maximumActiveSnapshotFetches, activeSnapshotFetches);
          try {
            if (hold !== undefined) {
              markOwnerFetchStarted();
              await hold;
            }
            return await gateway.listIssues(reference);
          } finally {
            activeSnapshotFetches -= 1;
          }
        },
      };
    };

    const ownerStore = new PostgresFoldStore(sql, tokenEncryptionKey);
    const ownerGateway = trackedGateway("owner", 1, holdOwnerFetch);
    const delivery = {
      deliveryId: `delivery-pool-contention-${nextExternalId()}`,
      event: "pull_request" as const,
      action: "closed",
      repositoryGitHubId: githubRepositoryId,
      repositoryFullName: repository.owner_name,
    };
    const ownerRun = processWebhook({
      store: ownerStore,
      reconcileRepository: (id) => reconcileRepository({ store: ownerStore, github: ownerGateway }, id),
      leaseHeartbeatIntervalMs: 25,
    }, delivery);
    await ownerFetchStarted;

    const observer = postgres(process.env.DATABASE_URL!, { max: 1 });
    const [initialLease] = await observer<{ lease_expires_at: string }[]>`
      select lease_expires_at::text
      from webhook_deliveries
      where github_delivery_id = ${delivery.deliveryId}
    `;
    const waiterRuns = Array.from({ length: sharedPoolCapacity }, (_, index) => {
      const points = index + 1;
      const waiterStore = new PostgresFoldStore(sql, tokenEncryptionKey);
      return reconcileRepository({
        store: waiterStore,
        github: trackedGateway(`waiter-${points}`, points, undefined),
      }, repositoryId);
    });
    const reconciliationCleanup = Promise.allSettled([ownerRun, ...waiterRuns]);
    const ordinaryQuery = sql<{ value: number }[]>`select 1::integer as value`;

    try {
      // Synchronize deterministically with the former blocking implementation. The
      // nonblocking coordinator never creates an ungranted advisory lock, so this
      // bounded probe simply expires while its callers wait outside the pool.
      const blockingWaitersDetected = await conditionWithin(async () => {
        const [locks] = await observer<{ waiting: number }[]>`
          select count(*)::integer as waiting
          from pg_locks
          where locktype = 'advisory' and granted = false
        `;
        return locks.waiting >= sharedPoolCapacity - 1;
      }, 750);

      expect(runOrder).toEqual(["owner"]);
      await expect(resolveWithin(ordinaryQuery, 750)).resolves.toEqual([{ value: 1 }]);
      expect(blockingWaitersDetected).toBe(false);
      await expect(conditionWithin(async () => {
        const [lease] = await observer<{ renewed: boolean }[]>`
          select lease_expires_at > ${initialLease.lease_expires_at}::timestamptz as renewed
          from webhook_deliveries
          where github_delivery_id = ${delivery.deliveryId}
        `;
        return lease.renewed;
      }, 750)).resolves.toBe(true);
    } finally {
      releaseOwnerFetch();
      await observer`
        select pg_cancel_backend(pid)
        from pg_locks
        where locktype = 'advisory'
          and granted = false
          and pid <> pg_backend_pid()
      `;
      await Promise.all([reconciliationCleanup, ordinaryQuery]);
      await observer.end();
    }

    await expect(ownerRun).resolves.toEqual({ status: "PROCESSED" });
    await expect(Promise.all(waiterRuns)).resolves.toHaveLength(sharedPoolCapacity);
    expect(runOrder).toHaveLength(sharedPoolCapacity + 1);
    expect(new Set(runOrder).size).toBe(sharedPoolCapacity + 1);
    expect(maximumActiveSnapshotFetches).toBe(1);
    const finalRun = runOrder.at(-1);
    expect(finalRun).toBeDefined();
    const [settlement] = await sql<{ settled_points: number }[]>`
      select settlements.settled_points
      from settlements
      join issues on issues.id = settlements.issue_id
      where issues.repository_id = ${repositoryId}
    `;
    expect(settlement.settled_points).toBe(pointsByRun.get(finalRun!));

    await expect(ownerStore.withRepositoryReconciliation(repositoryId, async () => {
      throw new Error("expected saturated-worker failure");
    })).rejects.toThrow("expected saturated-worker failure");
    await expect(ownerStore.withRepositoryReconciliation(repositoryId, async () => "released-after-error"))
      .resolves.toBe("released-after-error");
  });

  const workPoolReadBoundMs = 30_000;
  const workPoolCleanupTimeoutSeconds = 5;

  it("keeps the work pool available while distinct repositories hold reconciliation locks", async () => {
    const sponsorId = await insertUser(sql);
    const repositoryIds = [
      await insertRepository(sql, sponsorId),
      await insertRepository(sql, sponsorId),
    ];
    // A work pool small enough that a coordinator drawing from it would consume
    // every connection the reconciliations it protects still need.
    const workSql = postgres(process.env.DATABASE_URL!, { max: 2 });
    const interactions: string[] = [];
    let holders = 0;
    let markEveryLockHeld!: () => void;
    const everyLockHeld = new Promise<void>((resolve) => { markEveryLockHeld = resolve; });
    let markDashboardRead!: () => void;
    const dashboardReadDone = new Promise<void>((resolve) => { markDashboardRead = resolve; });

    try {
      const coordinated = repositoryIds.map((repositoryId, index) => {
        const store = new PostgresFoldStore(workSql);
        return store.withRepositoryReconciliation(repositoryId, async () => {
          interactions.push(`holder-${index}-entered`);
          holders += 1;
          if (holders === repositoryIds.length) {
            markEveryLockHeld();
          }
          await everyLockHeld;
          // Every lock is held, and no holder touches the work pool until the
          // ordinary read has been served by it.
          await dashboardReadDone;
          const [row] = await workSql<{ value: number }[]>`select ${index}::integer as value`;
          interactions.push(`holder-${index}-queried`);
          return row.value;
        });
      });

      await everyLockHeld;
      // A work pool a coordinator has drained never answers, so an unbounded
      // read would stall until the suite's own timeout, which names the case
      // and nothing else. The bound is an escape hatch rather than a speed
      // assertion: the starvation this pins lasts as long as the locks do,
      // while a pool with a connection to spare answers immediately.
      const dashboardRead = await resolveWithin(
        workSql<{ value: number }[]>`select 7::integer as value`,
        workPoolReadBoundMs,
        `A work-pool read with reconciliation locks held (${interactions.join(", ")})`,
      );
      interactions.push("dashboard-read");
      markDashboardRead();

      await expect(Promise.all(coordinated)).resolves.toEqual([0, 1]);
      // The pool answered while both locks were held and before either holder
      // had used it, so neither of its two connections was in a coordinator's
      // hands.
      expect(dashboardRead).toEqual([{ value: 7 }]);
    } finally {
      // Holders stranded by a read that never returned would keep an unbounded
      // end() waiting, replacing the named failure with a bare suite timeout.
      await workSql.end({ timeout: workPoolCleanupTimeoutSeconds });
    }
  });

  it("bounds reconciliation coordination at no less than the work pool's capacity", () => {
    const sharedPoolCapacity = sql.options.max;
    // A coordinator used to hold one of the work pool's own connections, so the
    // work pool's capacity is the coordinator concurrency the isolated client has
    // to keep serving.
    expect(RECONCILIATION_COORDINATION_POOL_MAX).toBeGreaterThanOrEqual(sharedPoolCapacity);
    expect(getCoordinationSql().options.max).toBeGreaterThanOrEqual(sharedPoolCapacity);
  });

  it("holds locks for as many distinct repositories as the work pool could serve", async () => {
    const sharedPoolCapacity = sql.options.max;
    const sponsorId = await insertUser(sql);
    const repositoryIds: string[] = [];
    for (let index = 0; index < sharedPoolCapacity; index += 1) {
      repositoryIds.push(await insertRepository(sql, sponsorId));
    }
    const entered: string[] = [];
    let markEveryLockHeld!: () => void;
    const everyLockHeld = new Promise<void>((resolve) => { markEveryLockHeld = resolve; });
    let releaseHolders!: () => void;
    const holdersReleased = new Promise<void>((resolve) => { releaseHolders = resolve; });

    const coordinated = repositoryIds.map((repositoryId, index) => {
      const store = new PostgresFoldStore(sql);
      return store.withRepositoryReconciliation(repositoryId, async () => {
        entered.push(`holder-${index}`);
        if (entered.length === repositoryIds.length) {
          markEveryLockHeld();
        }
        await holdersReleased;
        return index;
      });
    });
    // A coordinator that is refused a connection never enters, so waiting only on
    // the barrier would report a refusal as a suite timeout. Racing the first
    // refusal against it lets the refusal itself be the failure.
    const firstRefusal = new Promise<void>((resolve) => {
      for (const coordination of coordinated) {
        coordination.catch(() => { resolve(); });
      }
    });

    try {
      await Promise.race([everyLockHeld, firstRefusal]);
    } finally {
      releaseHolders();
    }

    const outcomes = await Promise.allSettled(coordinated);
    const refusals = outcomes.flatMap((outcome) =>
      outcome.status === "rejected" ? [(outcome.reason as Error).message] : []);
    expect(refusals).toEqual([]);
    expect(entered).toHaveLength(sharedPoolCapacity);
    expect(outcomes.map((outcome) => outcome.status === "fulfilled" ? outcome.value : outcome.reason))
      .toEqual(repositoryIds.map((_repositoryId, index) => index));
  });

  it("keeps a slow older reconciliation from overwriting the newer authoritative snapshot", async () => {
    const tokenEncryptionKey = Buffer.alloc(32, 10).toString("base64url");
    const sponsorLogin = `concurrency-sponsor-${nextExternalId()}`;
    const contributorLogin = `concurrency-contributor-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    await sql`
      update users
      set encrypted_oauth_token = ${Buffer.from(encryptToken("concurrency-token", tokenEncryptionKey), "utf8")}
      where id = ${sponsorId}
    `;
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string; github_repository_id: number | string }[]>`
      select owner_name, github_repository_id from registered_repositories where id = ${repositoryId}
    `;
    const githubIssueId = nextExternalId();
    const githubPullRequestId = nextExternalId();
    const olderSnapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      githubRepositoryId: Number(repository.github_repository_id),
      sponsorId,
      contributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/5",
      githubIssueId,
      githubPullRequestId,
    });
    const newerSnapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      githubRepositoryId: Number(repository.github_repository_id),
      sponsorId,
      contributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/7",
      githubIssueId,
      githubPullRequestId,
    });
    const olderGatewayBase = gatewayForSnapshot(olderSnapshot);
    const newerGatewayBase = gatewayForSnapshot(newerSnapshot);
    let releaseOlderFetch!: () => void;
    let markOlderFetchStarted!: () => void;
    const olderFetchStarted = new Promise<void>((resolve) => { markOlderFetchStarted = resolve; });
    const holdOlderFetch = new Promise<void>((resolve) => { releaseOlderFetch = resolve; });
    const order: string[] = [];
    const olderGateway: ReconciliationGateway = {
      ...olderGatewayBase,
      async listIssues(reference) {
        order.push("older-fetch-started");
        markOlderFetchStarted();
        await holdOlderFetch;
        order.push("older-fetch-completed");
        return olderGatewayBase.listIssues(reference);
      },
    };
    const newerGateway: ReconciliationGateway = {
      ...newerGatewayBase,
      async listIssues(reference) {
        order.push("newer-fetch-started");
        return newerGatewayBase.listIssues(reference);
      },
    };
    const olderWorker = new PostgresFoldStore(sql, tokenEncryptionKey);
    const newerWorker = new PostgresFoldStore(sql, tokenEncryptionKey);

    const olderRun = reconcileRepository({ store: olderWorker, github: olderGateway }, repositoryId);
    await olderFetchStarted;
    const newerRun = reconcileRepository({ store: newerWorker, github: newerGateway }, repositoryId);
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(order).toEqual(["older-fetch-started"]);

    releaseOlderFetch();
    const [olderResult, newerResult] = await Promise.all([olderRun, newerRun]);

    expect(olderResult).toMatchObject({ adds: 1, changes: 0, removals: 0 });
    expect(newerResult).toMatchObject({ adds: 0, changes: 1, removals: 0 });
    expect(order).toEqual(["older-fetch-started", "older-fetch-completed", "newer-fetch-started"]);
    await expect(sql`
      select settlements.settled_points, settlements.credits, issues.settled_label
      from settlements join issues on issues.id = settlements.issue_id
      where issues.repository_id = ${repositoryId}
    `).resolves.toEqual([{ settled_points: 7, credits: 7, settled_label: "delivered/7" }]);
  });

  it("preserves historically eligible settlement and self-work facts after later sanctions", async () => {
    const tokenEncryptionKey = Buffer.alloc(32, 11).toString("base64url");
    const sponsorLogin = `history-sponsor-${nextExternalId()}`;
    const contributorLogin = `history-contributor-${nextExternalId()}`;
    const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
    const contributorId = await insertUserWithLogin(sql, contributorLogin);
    const moderatorId = await insertUser(sql);
    await sql`
      update users
      set encrypted_oauth_token = ${Buffer.from(encryptToken("history-token", tokenEncryptionKey), "utf8")}
      where id = ${sponsorId}
    `;
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string; github_repository_id: number | string }[]>`
      select owner_name, github_repository_id from registered_repositories where id = ${repositoryId}
    `;
    const outsiderSnapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      githubRepositoryId: Number(repository.github_repository_id),
      sponsorId,
      contributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      githubIssueId: nextExternalId(),
      githubPullRequestId: nextExternalId(),
    });
    const selfWorkSnapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      githubRepositoryId: Number(repository.github_repository_id),
      sponsorId,
      contributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
      sponsorLogin,
      contributorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/7",
      githubIssueId: nextExternalId(),
      githubPullRequestId: nextExternalId(),
    });
    selfWorkSnapshot.issues[0]!.number = 2;
    selfWorkSnapshot.issues[0]!.closingPullRequests[0]!.number = 12;
    selfWorkSnapshot.issues[0]!.closingPullRequests[0]!.authorLogin = sponsorLogin;
    selfWorkSnapshot.issues[0]!.closingPullRequests[0]!.authorGitHubUserId = await githubUserIdOf(sql, sponsorId);
    outsiderSnapshot.issues.push(selfWorkSnapshot.issues[0]!);

    const store = new PostgresFoldStore(sql, tokenEncryptionKey);
    const initialRun = await store.beginRun(repositoryId);
    await store.materialize({ repositoryId, runId: initialRun, fold: foldRepository(outsiderSnapshot) });
    const factsBefore = await historicalRepositoryFacts(repositoryId, [sponsorId, contributorId]);

    for (const [targetId, newState] of [[contributorId, "BANNED"], [sponsorId, "RECALIBRATING"]] as const) {
      await sql`
        insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason, created_at)
        values (${targetId}, ${moderatorId}, ${"ACTIVE"}, ${newState}, ${"Sanction after the recorded merge"},
          ${"2026-09-02T00:00:00.000Z"})
      `;
      await sql`update users set enforcement_state = ${newState} where id = ${targetId}`;
    }

    await expect(reconcileRepository({ store, github: gatewayForSnapshot(outsiderSnapshot) }, repositoryId))
      .resolves.toMatchObject({ adds: 0, changes: 0, removals: 0 });
    await expect(historicalRepositoryFacts(repositoryId, [sponsorId, contributorId])).resolves.toEqual(factsBefore);
  });

  it.each(["RECALIBRATING", "BANNED"] as const)(
    "keeps work merged while the sponsor is %s ineligible",
    async (state) => {
      const tokenEncryptionKey = Buffer.alloc(32, state === "BANNED" ? 13 : 12).toString("base64url");
      const sponsorLogin = `ineligible-sponsor-${state.toLowerCase()}-${nextExternalId()}`;
      const contributorLogin = `ineligible-contributor-${nextExternalId()}`;
      const sponsorId = await insertUserWithLogin(sql, sponsorLogin);
      const contributorId = await insertUserWithLogin(sql, contributorLogin);
      const moderatorId = await insertUser(sql);
      await sql`
        update users
        set encrypted_oauth_token = ${Buffer.from(encryptToken("ineligible-token", tokenEncryptionKey), "utf8")},
            enforcement_state = ${state}
        where id = ${sponsorId}
      `;
      await sql`
        insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason, created_at)
        values (${sponsorId}, ${moderatorId}, ${"ACTIVE"}, ${state}, ${"Sanction before merge"},
          ${"2026-08-31T00:00:00.000Z"})
      `;
      const repositoryId = await insertRepository(sql, sponsorId);
      const [repository] = await sql<{ owner_name: string; github_repository_id: number | string }[]>`
        select owner_name, github_repository_id from registered_repositories where id = ${repositoryId}
      `;
      const snapshot = materializationSnapshot({
        repositoryId,
        ownerName: repository.owner_name,
        githubRepositoryId: Number(repository.github_repository_id),
        sponsorId,
        contributorId,
        sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
        contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
        sponsorLogin,
        contributorLogin,
        issueLabels: ["M"],
        actualLabel: "delivered/6",
        githubIssueId: nextExternalId(),
        githubPullRequestId: nextExternalId(),
      });
      const store = new PostgresFoldStore(sql, tokenEncryptionKey);

      await expect(reconcileRepository({ store, github: gatewayForSnapshot(snapshot) }, repositoryId))
        .resolves.toMatchObject({ adds: 0, changes: 0, removals: 0 });
      await expect(sql`select id from settlements where debtor_id = ${sponsorId}`).resolves.toEqual([]);
      await expect(sql`select id from self_work_calibrations where user_id = ${sponsorId}`).resolves.toEqual([]);
    },
  );

  it("stores rejected settlement evidence with its closing pull request and removes it when evidence is accepted", async () => {
    const sponsorId = await insertUserWithLogin(sql, `rejected-sponsor-${nextExternalId()}`);
    const contributorId = await insertUserWithLogin(sql, `rejected-contributor-${nextExternalId()}`);
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string; github_repository_id: number | string }[]>`
      select owner_name, github_repository_id from registered_repositories where id = ${repositoryId}
    `;
    const githubIssueId = nextExternalId();
    const githubPullRequestId = nextExternalId();
    const acceptedSnapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      githubRepositoryId: Number(repository.github_repository_id),
      sponsorId,
      contributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
      githubIssueId,
      githubPullRequestId,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
    });
    const rejectedSnapshot = structuredClone(acceptedSnapshot);
    rejectedSnapshot.issues[0]!.comments[0]!.createdAt = "2026-09-01T13:00:00.000Z";
    const rejectedState = {
      githubIssueId,
      kind: "SETTLEMENT_EVIDENCE_REJECTED",
      githubPullRequestId,
      reason: "No rationale comment by `materialization-sponsor` naming `delivered/6` was posted between fifteen minutes before the label at 2026-09-01T11:00:00.000Z and fifteen minutes after the merge at 2026-09-01T12:00:00.000Z.",
    };
    const store = new PostgresFoldStore(sql);
    const rejectedFold = foldRepository(rejectedSnapshot);
    const addRun = await store.beginRun(repositoryId);
    await expect(store.materialize({ repositoryId, runId: addRun, fold: rejectedFold }))
      .resolves.toEqual({ adds: 2, changes: 0, removals: 0 });
    const state = await reconciliationMaterializationState(repositoryId);
    expect(state.unwritableClosures).toEqual([{
      github_issue_id: String(githubIssueId),
      kind: rejectedState.kind,
      github_pull_request_id: String(githubPullRequestId),
      reason: rejectedState.reason,
    }]);

    await sql`
      update unwritable_closures
      set kind = 'NO_CLOSING_PULL_REQUEST', pull_request_id = null
      where issue_id = (select id from issues where github_issue_id = ${githubIssueId})
    `;
    const repairRun = await store.beginRun(repositoryId);
    await expect(store.materialize({ repositoryId, runId: repairRun, fold: rejectedFold }))
      .resolves.toEqual({ adds: 0, changes: 1, removals: 0 });
    expect((await reconciliationMaterializationState(repositoryId)).unwritableClosures)
      .toEqual(state.unwritableClosures);

    const repeatRun = await store.beginRun(repositoryId);
    await expect(store.materialize({ repositoryId, runId: repeatRun, fold: rejectedFold }))
      .resolves.toEqual({ adds: 0, changes: 0, removals: 0 });

    const acceptedRun = await store.beginRun(repositoryId);
    await expect(store.materialize({ repositoryId, runId: acceptedRun, fold: foldRepository(acceptedSnapshot) }))
      .resolves.toEqual({ adds: 0, changes: 1, removals: 1 });
    expect((await reconciliationMaterializationState(repositoryId)).unwritableClosures).toEqual([]);
    const changes = await sql`
      select change_kind, before_state, after_state
      from reconciliation_changes
      where reconciliation_run_id in (${addRun}, ${repairRun}, ${repeatRun}, ${acceptedRun})
        and entity_kind = 'UNWRITABLE_CLOSURE'
      order by created_at, id
    `;
    expect(changes).toEqual([
      { change_kind: "ADD", before_state: null, after_state: rejectedState },
      {
        change_kind: "CHANGE",
        before_state: { ...rejectedState, kind: "NO_CLOSING_PULL_REQUEST", githubPullRequestId: null },
        after_state: rejectedState,
      },
      { change_kind: "REMOVE", before_state: rejectedState, after_state: null },
    ]);
  });

  it("records deterministic add, change, and removal provenance for self-work and hand closures", async () => {
    const selfWorkSponsorLogin = `self-work-sponsor-${nextExternalId()}`;
    const selfWorkSponsorId = await insertUserWithLogin(sql, selfWorkSponsorLogin);
    const selfWorkContributorId = await insertUserWithLogin(sql, `self-work-contributor-${nextExternalId()}`);
    const selfWorkRepositoryId = await insertRepository(sql, selfWorkSponsorId);
    const [selfWorkRepository] = await sql<{ owner_name: string; github_repository_id: number | string }[]>`
      select owner_name, github_repository_id from registered_repositories where id = ${selfWorkRepositoryId}
    `;
    const store = new PostgresFoldStore(sql);
    const selfWorkSnapshot = materializationSnapshot({
      repositoryId: selfWorkRepositoryId,
      ownerName: selfWorkRepository.owner_name,
      githubRepositoryId: Number(selfWorkRepository.github_repository_id),
      sponsorId: selfWorkSponsorId,
      contributorId: selfWorkContributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, selfWorkSponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, selfWorkContributorId),
      sponsorLogin: selfWorkSponsorLogin,
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      githubIssueId: nextExternalId(),
      githubPullRequestId: nextExternalId(),
    });
    selfWorkSnapshot.issues[0]!.closingPullRequests[0]!.authorLogin = selfWorkSponsorLogin;
    selfWorkSnapshot.issues[0]!.closingPullRequests[0]!.authorGitHubUserId = await githubUserIdOf(sql, selfWorkSponsorId);

    const selfWorkAddRun = await store.beginRun(selfWorkRepositoryId);
    await expect(store.materialize({
      repositoryId: selfWorkRepositoryId,
      runId: selfWorkAddRun,
      fold: foldRepository(selfWorkSnapshot),
    })).resolves.toEqual({ adds: 1, changes: 0, removals: 0 });

    const selfWorkChangedSnapshot = structuredClone(selfWorkSnapshot);
    const changedIssue = selfWorkChangedSnapshot.issues[0]!;
    changedIssue.labels = changedIssue.labels.map((label) => label === "delivered/6" ? "delivered/7" : label);
    const actualEvent = changedIssue.history.find((event) => event.kind === "LABELED" && event.label === "delivered/6");
    if (actualEvent === undefined || actualEvent.kind !== "LABELED") {
      throw new Error("Expected actual label history fixture.");
    }
    actualEvent.label = "delivered/7";
    changedIssue.comments[0]!.body = "Settled as delivered/7.";
    const selfWorkChangeRun = await store.beginRun(selfWorkRepositoryId);
    await expect(store.materialize({
      repositoryId: selfWorkRepositoryId,
      runId: selfWorkChangeRun,
      fold: foldRepository(selfWorkChangedSnapshot),
    })).resolves.toEqual({ adds: 0, changes: 1, removals: 0 });

    const selfWorkRemoveRun = await store.beginRun(selfWorkRepositoryId);
    await expect(store.materialize({
      repositoryId: selfWorkRepositoryId,
      runId: selfWorkRemoveRun,
      fold: foldRepository({ ...selfWorkChangedSnapshot, issues: [] }),
    })).resolves.toEqual({ adds: 0, changes: 0, removals: 1 });

    const selfWorkChanges = await sql<{
      entity_kind: string;
      change_kind: string;
      before_state: { actualPoints?: number } | null;
      after_state: { actualPoints?: number } | null;
    }[]>`
      select entity_kind, change_kind, before_state, after_state
      from reconciliation_changes
      where reconciliation_run_id in (${selfWorkAddRun}, ${selfWorkChangeRun}, ${selfWorkRemoveRun})
      order by created_at, id
    `;
    expect(selfWorkChanges).toEqual([
      {
        entity_kind: "SELF_WORK_CALIBRATION",
        change_kind: "ADD",
        before_state: null,
        after_state: expect.objectContaining({ actualPoints: 6 }),
      },
      {
        entity_kind: "SELF_WORK_CALIBRATION",
        change_kind: "CHANGE",
        before_state: expect.objectContaining({ actualPoints: 6 }),
        after_state: expect.objectContaining({ actualPoints: 7 }),
      },
      {
        entity_kind: "SELF_WORK_CALIBRATION",
        change_kind: "REMOVE",
        before_state: expect.objectContaining({ actualPoints: 7 }),
        after_state: null,
      },
    ]);

    const closureSponsorId = await insertUserWithLogin(sql, `closure-sponsor-${nextExternalId()}`);
    const closureContributorId = await insertUserWithLogin(sql, `closure-contributor-${nextExternalId()}`);
    const closureRepositoryId = await insertRepository(sql, closureSponsorId);
    const [closureRepository] = await sql<{ owner_name: string; github_repository_id: number | string }[]>`
      select owner_name, github_repository_id from registered_repositories where id = ${closureRepositoryId}
    `;
    const closureSnapshot = materializationSnapshot({
      repositoryId: closureRepositoryId,
      ownerName: closureRepository.owner_name,
      githubRepositoryId: Number(closureRepository.github_repository_id),
      sponsorId: closureSponsorId,
      contributorId: closureContributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, closureSponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, closureContributorId),
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      githubIssueId: nextExternalId(),
      githubPullRequestId: nextExternalId(),
    });
    closureSnapshot.issues[0]!.closingPullRequests = [];
    const closureAddFold = foldRepository(closureSnapshot);
    const closureAddRun = await store.beginRun(closureRepositoryId);
    await expect(store.materialize({
      repositoryId: closureRepositoryId,
      runId: closureAddRun,
      fold: closureAddFold,
    })).resolves.toEqual({ adds: 1, changes: 0, removals: 0 });

    const closureChangeFold = structuredClone(closureAddFold);
    closureChangeFold.unwritableClosures[0]!.reason = "No authoritative closing PR remains after refresh.";
    const closureChangeRun = await store.beginRun(closureRepositoryId);
    await expect(store.materialize({
      repositoryId: closureRepositoryId,
      runId: closureChangeRun,
      fold: closureChangeFold,
    })).resolves.toEqual({ adds: 0, changes: 1, removals: 0 });

    const closureRemoveFold = structuredClone(closureChangeFold);
    closureRemoveFold.unwritableClosures = [];
    const closureRemoveRun = await store.beginRun(closureRepositoryId);
    await expect(store.materialize({
      repositoryId: closureRepositoryId,
      runId: closureRemoveRun,
      fold: closureRemoveFold,
    })).resolves.toEqual({ adds: 0, changes: 0, removals: 1 });

    const closureChanges = await sql<{
      entity_kind: string;
      change_kind: string;
      before_state: { reason?: string } | null;
      after_state: { reason?: string } | null;
    }[]>`
      select entity_kind, change_kind, before_state, after_state
      from reconciliation_changes
      where reconciliation_run_id in (${closureAddRun}, ${closureChangeRun}, ${closureRemoveRun})
      order by created_at, id
    `;
    expect(closureChanges).toEqual([
      {
        entity_kind: "UNWRITABLE_CLOSURE",
        change_kind: "ADD",
        before_state: null,
        after_state: expect.objectContaining({ reason: "No merged GitHub GraphQL closing pull request was found." }),
      },
      {
        entity_kind: "UNWRITABLE_CLOSURE",
        change_kind: "CHANGE",
        before_state: expect.objectContaining({ reason: "No merged GitHub GraphQL closing pull request was found." }),
        after_state: expect.objectContaining({ reason: "No authoritative closing PR remains after refresh." }),
      },
      {
        entity_kind: "UNWRITABLE_CLOSURE",
        change_kind: "REMOVE",
        before_state: expect.objectContaining({ reason: "No authoritative closing PR remains after refresh." }),
        after_state: null,
      },
    ]);
  });

  it("materializes a cross-repository closure with no pull request row behind it", async () => {
    const sponsorId = await insertUser(sql);
    const contributorId = await insertUser(sql);
    const repositoryId = await insertRepository(sql, sponsorId);
    const [repository] = await sql<{ owner_name: string; github_repository_id: number | string }[]>`
      select owner_name, github_repository_id from registered_repositories where id = ${repositoryId}
    `;
    const githubIssueId = nextExternalId();
    const githubPullRequestId = nextExternalId();
    const snapshot = materializationSnapshot({
      repositoryId,
      ownerName: repository.owner_name,
      githubRepositoryId: Number(repository.github_repository_id),
      sponsorId,
      contributorId,
      sponsorGitHubUserId: await githubUserIdOf(sql, sponsorId),
      contributorGitHubUserId: await githubUserIdOf(sql, contributorId),
      issueLabels: ["M"],
      actualLabel: "delivered/6",
      githubIssueId,
      githubPullRequestId,
    });
    const closingPullRequest = snapshot.issues[0]!.closingPullRequests[0]!;
    closingPullRequest.repositoryGitHubId = Number(repository.github_repository_id) + 1;
    closingPullRequest.repositoryNameWithOwner = "other/fork";

    const store = new PostgresFoldStore(sql);
    const runId = await store.beginRun(repositoryId);
    await expect(store.materialize({
      repositoryId,
      runId,
      fold: foldRepository(snapshot),
    })).resolves.toEqual({ adds: 1, changes: 0, removals: 0 });

    // The foreign pull request is never materialized, so the closure has no row
    // to point at and nothing may be credited from it.
    const [closure] = await sql<{ id: string; kind: string; pull_request_id: string | null; reason: string }[]>`
      select unwritable_closures.id, unwritable_closures.kind::text, unwritable_closures.pull_request_id,
        unwritable_closures.reason
      from unwritable_closures
      join issues on issues.id = unwritable_closures.issue_id
      where issues.github_issue_id = ${githubIssueId}
    `;
    expect(closure).toMatchObject({
      kind: "CROSS_REPOSITORY_CLOSING_PULL_REQUEST",
      pull_request_id: null,
      reason: `Closing pull request 11 belongs to other/fork, not the registered repository ${repository.owner_name}.`,
    });
    await expect(sql`
      select count(*)::integer as count from pull_requests
      where github_pull_request_id = ${githubPullRequestId}
    `).resolves.toEqual([{ count: 0 }]);
    await expect(sql`
      select count(*)::integer as count from settlements
      join issues on issues.id = settlements.issue_id
      where issues.github_issue_id = ${githubIssueId}
    `).resolves.toEqual([{ count: 0 }]);
    await expect(sql`
      select count(*)::integer as count from ledger_entries
      join settlements on settlements.id = ledger_entries.settlement_id
      join issues on issues.id = settlements.issue_id
      where issues.github_issue_id = ${githubIssueId}
    `).resolves.toEqual([{ count: 0 }]);

    // Reads through getSql(), the same pool this suite holds.
    const projected = (await listUnwritableClosures()).find(({ id }) => id === closure.id);
    expect(projected).toMatchObject({
      kind: "CROSS_REPOSITORY_CLOSING_PULL_REQUEST",
      pullRequest: null,
      settlementId: null,
      repositoryName: repository.owner_name,
    });
  });

  it("keeps a fresh PENDING delivery deduplicated after interruption and reclaims it when its lease is stale", async () => {
    const store = new PostgresFoldStore(sql);
    const delivery = {
      deliveryId: "delivery-stale-reclaim",
      event: "pull_request" as const,
      action: "closed",
      repositoryGitHubId: nextExternalId(),
      repositoryFullName: "octo/example",
    };

    const first = expectClaimedLease(await store.claimDelivery(delivery));
    await expect(store.claimDelivery(delivery)).resolves.toEqual({ status: "DUPLICATE" });

    await sql`
      update webhook_deliveries
      set lease_expires_at = now() - interval '1 second'
      where github_delivery_id = ${delivery.deliveryId}
    `;
    const reclaimed = expectClaimedLease(await store.claimDelivery(delivery));
    expect(reclaimed.leaseToken).not.toBe(first.leaseToken);

    const [record] = await sql<{ processing_state: string; attempt_count: number }[]>`
      select processing_state, attempt_count from webhook_deliveries
      where github_delivery_id = ${delivery.deliveryId}
    `;
    expect(record).toEqual({ processing_state: "PENDING", attempt_count: 2 });
  });

  it("allows only the current delivery lease owner to complete a webhook", async () => {
    const store = new PostgresFoldStore(sql);
    const delivery = {
      deliveryId: "delivery-owner-check",
      event: "pull_request" as const,
      action: "closed",
      repositoryGitHubId: nextExternalId(),
      repositoryFullName: "octo/example",
    };

    const first = expectClaimedLease(await store.claimDelivery(delivery));
    await sql`
      update webhook_deliveries
      set lease_expires_at = now() - interval '1 second'
      where github_delivery_id = ${delivery.deliveryId}
    `;
    const replacement = expectClaimedLease(await store.claimDelivery(delivery));

    await expect(store.markProcessed(delivery.deliveryId, first.leaseToken)).resolves.toBe(false);
    await expect(store.markProcessed(delivery.deliveryId, replacement.leaseToken)).resolves.toBe(true);

    const [record] = await sql<{ processing_state: string }[]>`
      select processing_state from webhook_deliveries
      where github_delivery_id = ${delivery.deliveryId}
    `;
    expect(record).toEqual({ processing_state: "PROCESSED" });
  });

  it("renews only the current webhook lease far enough to cover continued reconciliation", async () => {
    const store = new PostgresFoldStore(sql);
    const delivery = {
      deliveryId: "delivery-renewal",
      event: "pull_request" as const,
      action: "closed",
      repositoryGitHubId: nextExternalId(),
      repositoryFullName: "octo/example",
    };
    const claim = expectClaimedLease(await store.claimDelivery(delivery));

    await expect(
      store.renewDeliveryLease(delivery.deliveryId, "00000000-0000-4000-8000-000000000099"),
    ).resolves.toBe(false);
    await expect(store.renewDeliveryLease(delivery.deliveryId, claim.leaseToken)).resolves.toBe(true);

    const [record] = await sql<{ renewed: boolean }[]>`
      select lease_expires_at > now() + interval '4 minutes' as renewed
      from webhook_deliveries
      where github_delivery_id = ${delivery.deliveryId}
    `;
    expect(record).toEqual({ renewed: true });
  });

  it("reclaims a failed delivery only through a new lease and persists a sanitized failure", async () => {
    const store = new PostgresFoldStore(sql);
    const delivery = {
      deliveryId: "delivery-retryable",
      event: "pull_request" as const,
      action: "closed",
      repositoryGitHubId: nextExternalId(),
      repositoryFullName: "octo/example",
    };

    const first = expectClaimedLease(await store.claimDelivery(delivery));
    await expect(
      store.markFailed(delivery.deliveryId, first.leaseToken, "connection string must never be saved"),
    ).resolves.toBe(true);
    const retry = expectClaimedLease(await store.claimDelivery(delivery));
    await expect(store.markProcessed(delivery.deliveryId, retry.leaseToken)).resolves.toBe(true);
    await expect(store.claimDelivery(delivery)).resolves.toEqual({ status: "DUPLICATE" });

    const [record] = await sql<{ processing_state: string; error_message: string | null }[]>`
      select processing_state, error_message from webhook_deliveries
      where github_delivery_id = ${delivery.deliveryId}
    `;
    expect(record).toEqual({ processing_state: "PROCESSED", error_message: null });
  });

  it("keeps at most one API token per account", async () => {
    const userId = await insertUser(sql);
    await insertApiToken(sql, userId, "one-token-per-account-first");

    await expect(
      insertApiToken(sql, userId, "one-token-per-account-second"),
    ).rejects.toMatchObject({ code: "23505" });

    const [record] = await sql<{ count: number }[]>`
      select count(*)::integer as count from api_tokens where user_id = ${userId}
    `;
    expect(record).toEqual({ count: 1 });
  });

  it("refuses to hand the same API token hash to two accounts", async () => {
    const firstUserId = await insertUser(sql);
    const secondUserId = await insertUser(sql);
    await insertApiToken(sql, firstUserId, "shared-token-hash");

    await expect(insertApiToken(sql, secondUserId, "shared-token-hash")).rejects.toMatchObject({
      code: "23505",
    });

    const [record] = await sql<{ count: number }[]>`
      select count(*)::integer as count from api_tokens where user_id = ${secondUserId}
    `;
    expect(record).toEqual({ count: 0 });
  });

  it("refuses to delete an account that still holds an API token", async () => {
    const userId = await insertUser(sql);
    await insertApiToken(sql, userId, "outlives-its-account");

    await expect(sql`delete from users where id = ${userId}`).rejects.toMatchObject({
      code: "23503",
    });

    const [record] = await sql<{ count: number }[]>`
      select count(*)::integer as count from api_tokens where user_id = ${userId}
    `;
    expect(record).toEqual({ count: 1 });
  });

  it("stores only an account, its token hash and a creation time", async () => {
    const userId = await insertUser(sql);
    await insertApiToken(sql, userId, "column-shape");

    const [record] = await sql<
      { user_id: string; token_hash: Uint8Array; created_at: Date }[]
    >`
      select user_id, token_hash, created_at from api_tokens where user_id = ${userId}
    `;
    expect(record.user_id).toBe(userId);
    expect(Buffer.from(record.token_hash)).toEqual(apiTokenHash("column-shape"));
    expect(record.created_at).toBeInstanceOf(Date);

    const columns = await sql<{ column_name: string; is_nullable: string }[]>`
      select column_name, is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'api_tokens'
      order by column_name
    `;
    expect(columns).toEqual([
      { column_name: "created_at", is_nullable: "NO" },
      { column_name: "id", is_nullable: "NO" },
      { column_name: "token_hash", is_nullable: "NO" },
      { column_name: "user_id", is_nullable: "NO" },
    ]);
  });

  it("refuses an API token hash that is not a whole SHA-256 digest", async () => {
    const userId = await insertUser(sql);

    await expect(sql`
      insert into api_tokens (user_id, token_hash)
      values (${userId}, ${Buffer.alloc(16)})
    `).rejects.toMatchObject({ code: "23514" });
    await expect(sql`
      insert into api_tokens (user_id, token_hash)
      values (${userId}, ${Buffer.alloc(0)})
    `).rejects.toMatchObject({ code: "23514" });

    const [record] = await sql<{ count: number }[]>`
      select count(*)::integer as count from api_tokens where user_id = ${userId}
    `;
    expect(record).toEqual({ count: 0 });
  });

  it("resolves the account behind an issued API token", async () => {
    const userId = await insertUser(sql);
    const store = new PostgresApiTokenStore(sql);
    const tokenHash = apiTokenHash("store-resolves-account");

    await store.issueToken(userId, tokenHash);

    await expect(store.findAccountByTokenHash(tokenHash)).resolves.toEqual({
      id: userId,
      role: "MEMBER",
      enforcementState: "ACTIVE",
    });
  });

  it("revokes the previous API token when an account issues a second one", async () => {
    const userId = await insertUser(sql);
    const store = new PostgresApiTokenStore(sql);
    const revokedHash = apiTokenHash("regeneration-revokes-first");
    const currentHash = apiTokenHash("regeneration-issues-second");

    await store.issueToken(userId, revokedHash);
    await store.issueToken(userId, currentHash);

    await expect(store.findAccountByTokenHash(revokedHash)).resolves.toBeNull();
    await expect(store.findAccountByTokenHash(currentHash)).resolves.toEqual({
      id: userId,
      role: "MEMBER",
      enforcementState: "ACTIVE",
    });

    const [record] = await sql<{ count: number }[]>`
      select count(*)::integer as count from api_tokens where user_id = ${userId}
    `;
    expect(record).toEqual({ count: 1 });
  });

  it("replaces an account's API token in a single statement", async () => {
    const userId = await insertUser(sql);
    const statements: string[] = [];
    const recordingSql = ((strings: TemplateStringsArray, ...values: never[]) => {
      statements.push(strings.join("?"));
      return sql(strings, ...values);
    }) as unknown as Sql;
    const store = new PostgresApiTokenStore(recordingSql);
    const revokedHash = apiTokenHash("single-statement-first");
    const currentHash = apiTokenHash("single-statement-second");

    await store.issueToken(userId, revokedHash);
    statements.length = 0;
    await store.issueToken(userId, currentHash);

    expect(statements).toHaveLength(1);
    await expect(store.findAccountByTokenHash(revokedHash)).resolves.toBeNull();
    await expect(store.findAccountByTokenHash(currentHash)).resolves.not.toBeNull();
  });

  it("resolves no account for an API token hash that was never issued", async () => {
    const store = new PostgresApiTokenStore(sql);

    await expect(
      store.findAccountByTokenHash(apiTokenHash("never-issued")),
    ).resolves.toBeNull();
  });

  it("resolves the stored role and enforcement state rather than the defaults", async () => {
    const userId = await insertUser(sql);
    await sql`
      update users set role = 'MODERATOR', enforcement_state = 'UNDER_AUDIT'
      where id = ${userId}
    `;
    const store = new PostgresApiTokenStore(sql);
    const tokenHash = apiTokenHash("store-resolves-moderator");

    await store.issueToken(userId, tokenHash);

    await expect(store.findAccountByTokenHash(tokenHash)).resolves.toEqual({
      id: userId,
      role: "MODERATOR",
      enforcementState: "UNDER_AUDIT",
    });
  });

  it("resolves an account without carrying any token material back", async () => {
    const userId = await insertUser(sql);
    const store = new PostgresApiTokenStore(sql);
    const tokenHash = apiTokenHash("store-returns-no-token-material");

    await store.issueToken(userId, tokenHash);
    const account = await store.findAccountByTokenHash(tokenHash);

    expect(Object.keys(account ?? {}).sort()).toEqual(["enforcementState", "id", "role"]);
    const resolvedValues: unknown[] = Object.values(account ?? {});
    expect(resolvedValues.some((value) => value instanceof Uint8Array)).toBe(false);
    expect(JSON.stringify(account)).not.toContain(tokenHash.toString("hex"));
  });

  it("reports no API token summary before an account has issued one", async () => {
    const userId = await insertUser(sql);
    const store = new PostgresApiTokenStore(sql);

    await expect(store.getTokenSummary(userId)).resolves.toBeNull();
  });

  it("summarizes the current API token and moves the summary on regeneration", async () => {
    const userId = await insertUser(sql);
    const store = new PostgresApiTokenStore(sql);

    const issued = await store.issueToken(userId, apiTokenHash("summary-first"));
    expect(issued.createdAt).toBeInstanceOf(Date);
    const summary = await store.getTokenSummary(userId);
    expect(summary?.createdAt).toBeInstanceOf(Date);
    expect(summary).toEqual({ createdAt: issued.createdAt });

    const [backdated] = await sql<{ created_at: Date }[]>`
      update api_tokens set created_at = now() - interval '1 hour' where user_id = ${userId}
      returning created_at
    `;
    const reissued = await store.issueToken(userId, apiTokenHash("summary-second"));
    await expect(store.getTokenSummary(userId)).resolves.toEqual({ createdAt: reissued.createdAt });
    expect(reissued.createdAt.getTime()).toBeGreaterThan(backdated.created_at.getTime());
  });
});

function nextExternalId(): number {
  externalId += 1;
  return externalId;
}

async function resolveWithin<T>(
  promise: PromiseLike<T>,
  timeoutMs: number,
  operation = "Operation",
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${operation} exceeded ${timeoutMs}ms.`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

async function conditionWithin(
  condition: () => Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  if (await condition()) {
    return true;
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    if (await condition()) {
      return true;
    }
  }
  return false;
}

function expectClaimedLease(
  claim: Awaited<ReturnType<PostgresFoldStore["claimDelivery"]>>,
): { status: "CLAIMED"; leaseToken: string } {
  expect(claim).toEqual({ status: "CLAIMED", leaseToken: expect.any(String) });
  if (claim.status !== "CLAIMED") {
    throw new Error("Expected a claimed webhook delivery lease.");
  }
  return claim;
}

async function insertUser(client: QueryableSql, githubUserId = nextExternalId()): Promise<string> {
  const [user] = await client<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${`member-${githubUserId}`})
    returning id
  `;
  return user.id;
}

function apiTokenHash(label: string): Buffer {
  return createHash("sha256").update(label).digest();
}

async function insertApiToken(
  client: QueryableSql,
  userId: string,
  label: string,
): Promise<void> {
  await client`
    insert into api_tokens (user_id, token_hash)
    values (${userId}, ${apiTokenHash(label)})
  `;
}

async function insertRepository(
  client: QueryableSql,
  sponsorId: string,
  githubRepositoryId = nextExternalId(),
): Promise<string> {
  return insertRepositoryWithDifficultyScheme(
    client,
    sponsorId,
    validDifficultyScheme(),
    githubRepositoryId,
  );
}

async function insertRepositoryWithDifficultyScheme(
  client: QueryableSql,
  sponsorId: string,
  difficultyScheme: unknown,
  githubRepositoryId = nextExternalId(),
): Promise<string> {
  const encodedDifficultyScheme =
    difficultyScheme === null
      ? null
      : client.json(difficultyScheme as Parameters<typeof client.json>[0]);
  const [repository] = await client<{ id: string }[]>`
    insert into registered_repositories (
      github_repository_id,
      owner_name,
      sponsor_id,
      visibility,
      github_webhook_id,
      difficulty_scheme
    )
    values (
      ${githubRepositoryId},
      ${`owner-${githubRepositoryId}/repository-${githubRepositoryId}`},
      ${sponsorId},
      ${"PUBLIC"},
      ${nextExternalId()},
      ${encodedDifficultyScheme}::jsonb
    )
    returning id
  `;
  return repository.id;
}

async function insertSchemelessRepository(client: QueryableSql, ownerName: string): Promise<void> {
  const sponsorId = await insertUser(client);
  await client`
    insert into registered_repositories (
      github_repository_id,
      owner_name,
      sponsor_id,
      visibility,
      github_webhook_id
    )
    values (
      ${nextExternalId()},
      ${ownerName},
      ${sponsorId},
      ${"PUBLIC"},
      ${nextExternalId()}
    )
  `;
}

function difficultySchemePreconditionMessage(count: number, ...ownerNames: string[]): string {
  return (
    `Repository difficulty scheme precondition failed: ${count} repository(ies) predate the ` +
    `difficulty scheme. Repositories: ${ownerNames.join(", ")}. Give each repository a difficulty ` +
    `scheme by adding the difficulty_scheme column and backfilling it by hand, or remove the legacy ` +
    `repositories, before upgrading.`
  );
}


async function insertIssue(
  client: QueryableSql,
  options: { comparisonPoints?: number; reservePoints?: number } = {},
): Promise<{ id: string; sponsorId: string; repositoryId: string }> {
  const sponsorId = await insertUser(client);
  const repositoryId = await insertRepository(client, sponsorId);
  const githubIssueId = nextExternalId();
  const [issue] = await client<{ id: string }[]>`
    insert into issues (
      github_issue_id,
      repository_id,
      issue_number,
      title,
      body,
      url,
      state,
      opening_label,
      opening_comparison_points,
      opening_reserve_points
    )
    values (
      ${githubIssueId},
      ${repositoryId},
      ${nextExternalId()},
      ${"An eligible issue"},
      ${"Issue evidence"},
      ${`https://github.com/example/repository/issues/${githubIssueId}`},
      ${"OPEN"},
      ${"size/M"},
      ${options.comparisonPoints ?? 5},
      ${options.reservePoints ?? 5}
    )
    returning id
  `;
  return { id: issue.id, sponsorId, repositoryId };
}

async function insertPullRequest(
  client: QueryableSql,
): Promise<{ id: string; issueId: string; sponsorId: string; repositoryId: string }> {
  const issue = await insertIssue(client);
  const contributorId = await insertUser(client);
  const githubPullRequestId = nextExternalId();
  const [pullRequest] = await client<{ id: string }[]>`
    insert into pull_requests (
      github_pull_request_id,
      repository_id,
      issue_id,
      pull_request_number,
      url,
      title,
      body,
      author_id,
      state,
      merged_at
    )
    values (
      ${githubPullRequestId},
      ${issue.repositoryId},
      ${issue.id},
      ${nextExternalId()},
      ${`https://github.com/example/repository/pull/${githubPullRequestId}`},
      ${"A merged contribution"},
      ${"Pull request evidence"},
      ${contributorId},
      ${"MERGED"},
      now()
    )
    returning id
  `;
  await client`
    insert into pull_request_issues (pull_request_id, issue_id, repository_id)
    values (${pullRequest.id}, ${issue.id}, ${issue.repositoryId})
  `;
  return {
    id: pullRequest.id,
    issueId: issue.id,
    sponsorId: issue.sponsorId,
    repositoryId: issue.repositoryId,
  };
}

async function insertSiblingIssue(client: QueryableSql, issueId: string): Promise<string> {
  const [source] = await client<{ repository_id: string }[]>`
    select repository_id from issues where id = ${issueId}
  `;
  const githubIssueId = nextExternalId();
  const [issue] = await client<{ id: string }[]>`
    insert into issues (
      github_issue_id, repository_id, issue_number, title, body, url, state,
      opening_label, opening_comparison_points, opening_reserve_points
    )
    values (
      ${githubIssueId}, ${source.repository_id}, ${nextExternalId()}, ${"A sibling issue"}, ${"Issue evidence"},
      ${`https://github.com/example/repository/issues/${githubIssueId}`}, ${"CLOSED"}, ${"size/M"}, 5, 5
    )
    returning id
  `;
  return issue.id;
}

async function insertIdentity(
  client: QueryableSql,
  githubLogin: string,
  githubUserId = nextExternalId(),
): Promise<{ id: string; githubUserId: number }> {
  const [user] = await client<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${githubLogin})
    returning id
  `;
  return { id: user.id, githubUserId };
}

async function insertUserWithLogin(client: QueryableSql, githubLogin: string): Promise<string> {
  return (await insertIdentity(client, githubLogin)).id;
}

async function insertUnclaimedIdentitySettlement(
  client: QueryableSql,
  pullRequest: { id: string; issueId: string; sponsorId: string },
  githubUserId: number,
  githubLogin: string,
): Promise<void> {
  await client`
    insert into settlements (
      pull_request_id, issue_id, creditor_id, creditor_github_login, creditor_github_user_id, debtor_id,
      opening_comparison_points, settled_points, review_rounds, credits, proof_sha256, status
    )
    values (
      ${pullRequest.id}, ${pullRequest.issueId}, null, ${githubLogin}, ${githubUserId}, ${pullRequest.sponsorId},
      5, 6, 0, 6, ${"a".repeat(64)}, ${"UNCLAIMED"}
    )
  `;
}

async function githubUserIdOf(client: QueryableSql, userId: string): Promise<number> {
  const [row] = await client<{ github_user_id: number | string }[]>`
    select github_user_id from users where id = ${userId}
  `;
  return Number(row.github_user_id);
}

function materializationSnapshot(input: {
  repositoryId: string;
  ownerName: string;
  /**
   * registered_repositories.github_repository_id of the repository being folded.
   * A test that reconciles for real reads it from the row it registered: the
   * store supplies the same id, and a fixture that invents one folds every
   * closing pull request as foreign.
   */
  githubRepositoryId: number;
  sponsorId: string;
  contributorId: string;
  sponsorGitHubUserId: number;
  contributorGitHubUserId: number;
  sponsorLogin?: string;
  contributorLogin?: string;
  issueLabels: string[];
  actualLabel: string;
  githubIssueId?: number;
  githubPullRequestId?: number;
}): RepositoryFoldSnapshot {
  const sponsorLogin = input.sponsorLogin ?? "materialization-sponsor";
  const contributorLogin = input.contributorLogin ?? "materialization-contributor";
  const githubIssueId = input.githubIssueId ?? 9_000_000;
  const githubPullRequestId = input.githubPullRequestId ?? 9_000_001;
  return {
    repository: {
      id: input.repositoryId,
      githubRepositoryId: input.githubRepositoryId,
      ownerName: input.ownerName,
      active: true,
      sponsor: { id: input.sponsorId, githubUserId: input.sponsorGitHubUserId, githubLogin: sponsorLogin, enforcementState: "ACTIVE" },
      difficultyScheme: validDifficultyScheme(),
    },
    users: [
      { id: input.sponsorId, githubUserId: input.sponsorGitHubUserId, githubLogin: sponsorLogin, enforcementState: "ACTIVE" },
      { id: input.contributorId, githubUserId: input.contributorGitHubUserId, githubLogin: contributorLogin, enforcementState: "ACTIVE" },
    ],
    issues: [
      {
        id: githubIssueId,
        number: 1,
        title: "A materialized issue",
        body: "Issue body",
        url: "https://github.com/example/materialized/issues/1",
        state: "CLOSED",
        createdAt: "2026-09-01T08:00:00.000Z",
        authorLogin: sponsorLogin,
        labels: [...input.issueLabels, input.actualLabel],
        claimAssigneeGitHubLogin: contributorLogin,
        history: [
          {
            kind: "LABELED",
            id: `opening-${githubIssueId}`,
            actorLogin: sponsorLogin,
            label: input.issueLabels[0] ?? "M",
            createdAt: "2026-09-01T08:01:00.000Z",
          },
          {
            kind: "ASSIGNED",
            id: `assigned-${githubIssueId}`,
            actorLogin: sponsorLogin,
            assigneeLogin: contributorLogin,
            createdAt: "2026-09-01T09:00:00.000Z",
          },
          {
            kind: "LABELED",
            id: `actual-${githubIssueId}`,
            actorLogin: sponsorLogin,
            label: input.actualLabel,
            createdAt: "2026-09-01T11:00:00.000Z",
          },
        ],
        comments: [{
          id: `rationale-${githubIssueId}`,
          databaseId: githubIssueId + 20_000_000,
          authorLogin: sponsorLogin,
          body: `Settled as ${input.actualLabel}.`,
          createdAt: "2026-09-01T11:30:00.000Z",
          lastEditedAt: null,
        }],
        closingPullRequests: [
          {
            id: githubPullRequestId,
            number: 11,
            title: "A materialized pull request",
            body: "Pull request body",
            url: "https://github.com/example/materialized/pull/11",
            state: "MERGED",
            mergedAt: "2026-09-01T12:00:00.000Z",
            mergeCommitOid: githubPullRequestId.toString(16).padStart(40, "0"),
            finalCommitAt: "2026-09-01T10:00:00.000Z",
            authorLogin: contributorLogin,
            authorGitHubUserId: input.contributorGitHubUserId,
            repositoryGitHubId: input.githubRepositoryId,
            repositoryNameWithOwner: input.ownerName,
            reviews: [],
            rawDiff: "materialized diff",
          },
        ],
      },
    ],
  };
}

type AuthoritativeReconciliationSnapshot = {
  issues: GitHubIssue[];
  closingPullRequests: Map<number, GitHubPullRequest[]>;
};

function authoritativeIssue(input: { id: number; number: number; ownerLogin: string }): GitHubIssue {
  return {
    id: input.id,
    number: input.number,
    title: `Reconciled issue ${input.number}`,
    body: `Reconciled issue ${input.number} body`,
    url: `https://github.com/example/materialized/issues/${input.number}`,
    state: "CLOSED",
    createdAt: "2026-09-01T08:00:00.000Z",
    authorLogin: input.ownerLogin,
    labels: ["M", "delivered/6"],
    claimAssigneeGitHubLogin: null,
    closingPullRequests: [],
    history: [
      { kind: "LABELED", id: `opening-${input.id}`, actorLogin: input.ownerLogin, label: "M", createdAt: "2026-09-01T08:01:00.000Z" },
      { kind: "LABELED", id: `actual-${input.id}`, actorLogin: input.ownerLogin, label: "delivered/6", createdAt: "2026-09-01T11:00:00.000Z" },
    ],
    comments: [{
      id: `rationale-${input.id}`,
      databaseId: input.id + 20_000_000,
      authorLogin: input.ownerLogin,
      body: "Settled as delivered/6.",
      createdAt: "2026-09-01T11:30:00.000Z",
      lastEditedAt: null,
    }],
  };
}

function authoritativePullRequest(input: {
  id: number;
  number: number;
  authorLogin: string;
  authorGitHubUserId?: number;
  repositoryGitHubId: number;
  repositoryNameWithOwner: string;
}): GitHubPullRequest {
  return {
    id: input.id,
    number: input.number,
    title: `Reconciled pull request ${input.number}`,
    body: `Reconciled pull request ${input.number} body`,
    url: `https://github.com/example/materialized/pull/${input.number}`,
    state: "MERGED",
    mergedAt: "2026-09-01T12:00:00.000Z",
    mergeCommitOid: input.id.toString(16).padStart(40, "0"),
    finalCommitAt: "2026-09-01T10:00:00.000Z",
    authorLogin: input.authorLogin,
    authorGitHubUserId: input.authorGitHubUserId ?? null,
    repositoryGitHubId: input.repositoryGitHubId,
    repositoryNameWithOwner: input.repositoryNameWithOwner,
  };
}

async function reconciliationMaterializationState(repositoryId: string) {
  const [issues, pullRequests, settlements, reviewRounds, issueLinks, unwritableClosures] = await Promise.all([
    sql<{
      github_issue_id: number | string;
      issue_number: number | string;
      title: string;
      state: string;
      opening_label: string;
      opening_comparison_points: number | string;
      opening_reserve_points: number | string;
    }[]>`
      select
        github_issue_id, issue_number, title, state, opening_label,
        opening_comparison_points, opening_reserve_points
      from issues
      where repository_id = ${repositoryId}
      order by github_issue_id
    `,
    sql<{
      github_pull_request_id: number | string;
      pull_request_number: number | string;
      title: string;
      state: string;
      proof_sha256: string | null;
    }[]>`
      select
        github_pull_request_id, pull_request_number, title, state,
        proof_sha256
      from pull_requests
      where repository_id = ${repositoryId}
      order by github_pull_request_id
    `,
    sql<{
      github_issue_id: number | string;
      github_pull_request_id: number | string;
      creditor_id: string | null;
      creditor_github_login: string | null;
      creditor_github_user_id: number | string | null;
      debtor_id: string;
      opening_comparison_points: number | string;
      settled_points: number | string | null;
      review_rounds: number | string;
      credits: number | string;
      proof_sha256: string;
      status: string;
    }[]>`
      select
        issues.github_issue_id,
        pull_requests.github_pull_request_id,
        settlements.creditor_id,
        settlements.creditor_github_login,
        settlements.creditor_github_user_id,
        settlements.debtor_id,
        settlements.opening_comparison_points,
        settlements.settled_points,
        settlements.review_rounds,
        settlements.credits,
        settlements.proof_sha256,
        settlements.status
      from settlements
      join issues on issues.id = settlements.issue_id
      join pull_requests on pull_requests.id = settlements.pull_request_id
      where issues.repository_id = ${repositoryId}
      order by issues.github_issue_id, pull_requests.github_pull_request_id
    `,
    sql<{
      github_pull_request_id: number | string;
      github_review_id: number | string;
      submitted_at: string;
    }[]>`
      select pull_requests.github_pull_request_id, review_rounds.github_review_id, review_rounds.submitted_at
      from review_rounds
      join pull_requests on pull_requests.id = review_rounds.pull_request_id
      where pull_requests.repository_id = ${repositoryId}
      order by pull_requests.github_pull_request_id, review_rounds.github_review_id
    `,
    sql<{
      github_issue_id: number | string;
      github_pull_request_id: number | string;
    }[]>`
      select issues.github_issue_id, pull_requests.github_pull_request_id
      from pull_request_issues
      join issues on issues.id = pull_request_issues.issue_id
      join pull_requests on pull_requests.id = pull_request_issues.pull_request_id
      where pull_request_issues.repository_id = ${repositoryId}
      order by issues.github_issue_id, pull_requests.github_pull_request_id
    `,
    sql<{
      github_issue_id: number | string;
      kind: string;
      github_pull_request_id: number | string | null;
      reason: string;
    }[]>`
      select issues.github_issue_id, unwritable_closures.kind::text,
        pull_requests.github_pull_request_id, unwritable_closures.reason
      from unwritable_closures
      join issues on issues.id = unwritable_closures.issue_id
      left join pull_requests on pull_requests.id = unwritable_closures.pull_request_id
      where issues.repository_id = ${repositoryId}
      order by issues.github_issue_id
    `,
  ]);
  return { issues, pullRequests, settlements, reviewRounds, issueLinks, unwritableClosures };
}

function gatewayForSnapshot(snapshot: RepositoryFoldSnapshot): ReconciliationGateway {
  const issues: GitHubIssue[] = snapshot.issues.map((issue) => ({
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    url: issue.url,
    state: issue.state,
    createdAt: issue.createdAt,
    authorLogin: issue.authorLogin,
    labels: issue.labels,
    claimAssigneeGitHubLogin: issue.claimAssigneeGitHubLogin ?? null,
    history: issue.history,
    comments: issue.comments,
    closingPullRequests: issue.closingPullRequests.map((pullRequest): GitHubPullRequest => ({
      id: pullRequest.id,
      number: pullRequest.number,
      title: pullRequest.title,
      body: pullRequest.body,
      url: pullRequest.url,
      state: pullRequest.state,
      mergedAt: pullRequest.mergedAt,
      mergeCommitOid: pullRequest.mergeCommitOid,
      finalCommitAt: pullRequest.finalCommitAt,
      authorLogin: pullRequest.authorLogin,
      authorGitHubUserId: pullRequest.authorGitHubUserId,
      repositoryGitHubId: pullRequest.repositoryGitHubId,
      repositoryNameWithOwner: pullRequest.repositoryNameWithOwner,
    })),
  }));
  const evidenceByPullRequest = new Map(snapshot.issues.flatMap((issue) => (
    issue.closingPullRequests.map((pullRequest) => [pullRequest.number, pullRequest] as const)
  )));
  return {
    getRepositoryById: verifiedRepositoryAt(snapshot.repository.ownerName),
    listIssues: async () => issues,
    getPullRequestReviews: async (_repository, pullRequestNumber) => (
      evidenceByPullRequest.get(pullRequestNumber)?.reviews ?? []
    ),
    getPullRequestDiff: async (_repository, pullRequestNumber) => (
      evidenceByPullRequest.get(pullRequestNumber)?.rawDiff ?? ""
    ),
  };
}

async function historicalRepositoryFacts(repositoryId: string, accountIds: string[]) {
  const [issues, settlements, calibrations, ledger, balances] = await Promise.all([
    sql`
      select
        id, opening_label, opening_comparison_points, opening_reserve_points,
        opening_source_event_id, opening_source_actor_login, opening_source_at,
        settled_label, settled_points, settled_label_event_id, settled_label_actor_login,
        settled_label_applied_at, settled_rationale_comment_id,
        settled_rationale_actor_login, settled_rationale_commented_at
      from issues where repository_id = ${repositoryId} order by github_issue_id
    `,
    sql`
      select
        settlements.id, settlements.issue_id, settlements.pull_request_id,
        settlements.creditor_id, settlements.debtor_id, settlements.opening_comparison_points,
        settlements.settled_points, settlements.review_rounds, settlements.credits,
        settlements.proof_sha256, settlements.status, pull_requests.merge_commit_oid,
        pull_requests.merged_at
      from settlements
      join issues on issues.id = settlements.issue_id
      join pull_requests on pull_requests.id = settlements.pull_request_id
      where issues.repository_id = ${repositoryId}
      order by settlements.id
    `,
    sql`
      select
        self_work_calibrations.id, self_work_calibrations.issue_id,
        self_work_calibrations.pull_request_id, self_work_calibrations.user_id,
        self_work_calibrations.opening_comparison_points, self_work_calibrations.actual_points,
        pull_requests.proof_sha256, pull_requests.merge_commit_oid, pull_requests.merged_at
      from self_work_calibrations
      join issues on issues.id = self_work_calibrations.issue_id
      join pull_requests on pull_requests.id = self_work_calibrations.pull_request_id
      where issues.repository_id = ${repositoryId}
      order by self_work_calibrations.id
    `,
    sql`
      select ledger_entries.settlement_id, ledger_entries.account_id, ledger_entries.amount
      from ledger_entries
      join settlements on settlements.id = ledger_entries.settlement_id
      join issues on issues.id = settlements.issue_id
      where issues.repository_id = ${repositoryId}
      order by ledger_entries.settlement_id, ledger_entries.account_id
    `,
    sql`
      select account_id, balance from balances
      where account_id::text = any(${sql.array(accountIds)})
      order by account_id
    `,
  ]);
  return { issues, settlements, calibrations, ledger, balances };
}

async function insertSettledRecord(proofFingerprint: string): Promise<{
  creditorId: string;
  debtorId: string;
}> {
  return withTransaction(async (transactionSql) => {
    const pullRequest = await insertPullRequest(transactionSql);
    const creditorId = await insertUser(transactionSql);
    const [settlement] = await transactionSql<{ creditor_id: string; debtor_id: string }[]>`
      insert into settlements (
        pull_request_id,
        issue_id,
        creditor_id,
        debtor_id,
        opening_comparison_points,
        settled_points,
        review_rounds,
        credits,
        proof_sha256,
        status
      )
      values (
        ${pullRequest.id},
        ${pullRequest.issueId},
        ${creditorId},
        ${pullRequest.sponsorId},
        5,
        6,
        2,
        4,
        ${proofFingerprint},
        ${"SETTLED"}
      )
      returning creditor_id, debtor_id
    `;
    return { creditorId: settlement.creditor_id, debtorId: settlement.debtor_id };
  });
}

async function insertUnsettledRecord(proofFingerprint: string): Promise<{ debtorId: string }> {
  return withTransaction(async (transactionSql) => {
    const pullRequest = await insertPullRequest(transactionSql);
    const creditorId = await insertUser(transactionSql);
    const [settlement] = await transactionSql<{ debtor_id: string }[]>`
      insert into settlements (
        pull_request_id,
        issue_id,
        creditor_id,
        debtor_id,
        opening_comparison_points,
        settled_points,
        review_rounds,
        credits,
        proof_sha256,
        status
      )
      values (
        ${pullRequest.id},
        ${pullRequest.issueId},
        ${creditorId},
        ${pullRequest.sponsorId},
        5,
        null,
        0,
        0,
        ${proofFingerprint},
        ${"UNSETTLED"}
      )
      returning debtor_id
    `;
    return { debtorId: settlement.debtor_id };
  });
}

async function updateOriginalOpeningDifficulty(client: Sql, issueId: string): Promise<void> {
  await client`
    update issues
    set opening_comparison_points = 6
    where id = ${issueId}
  `;
}

async function sumLedgerEntries(client: Sql): Promise<number> {
  const [result] = await client<{ total: number }[]>`
    select coalesce(sum(amount), 0)::integer as total from ledger_entries
  `;
  return result.total;
}
