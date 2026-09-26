import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { encryptToken } from "@/lib/security/token-cipher";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { PostgresForgeIdentityStore } from "@/lib/forge/postgres-identities-store";
import { validDifficultyScheme } from "../support/difficulty-scheme";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";
import { DELETED_ACCOUNT_LOGIN, deleteAccount } from "@/lib/accounts/deletion";
import { exportAccount, userForeignKeyExports, type AccountExport } from "@/lib/accounts/export";

let sql: Sql;
// 32 raw bytes, base64url: a real key so the forge credential round-trips.
const TEST_ENCRYPTION_KEY = Buffer.from("0123456789abcdef0123456789abcdef").toString("base64url");
let container: StartedTestContainer;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "account_deletion_test",
    user: "account_deletion_test",
    password: "account_deletion_test",
  });
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

// ---------------------------------------------------------------------------
// Seeding. Every case seeds its own rows through a counter, so the cases stay
// order-independent inside the one file database: forge identity triples and
// API token hashes are unique-constrained across the whole schema, and each
// case must never collide with another case's rows.
// ---------------------------------------------------------------------------

let seedCounter = 0;

function nextSeedNumber(): number {
  seedCounter += 1;
  return seedCounter;
}

function tokenHash(seed: number): Buffer {
  return createHash("sha256").update(`api-token-${seed}`).digest();
}

async function insertUser(login: string): Promise<{ id: string; githubUserId: number }> {
  const githubUserId = 9_500_000 + nextSeedNumber();
  const [row] = await sql<{ id: string; github_user_id: string }[]>`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${login}) returning id, github_user_id
  `;
  return { id: row!.id, githubUserId: Number(row!.github_user_id) };
}

async function userById(id: string): Promise<{ id: string; githubUserId: number }> {
  const [row] = await sql<{ id: string; github_user_id: string }[]>`
    select id, github_user_id from users where id = ${id}
  `;
  return { id: row!.id, githubUserId: Number(row!.github_user_id) };
}

type FixtureAccounts = {
  contributor: { id: string; githubUserId: number };
  sponsor: { id: string; githubUserId: number };
  settlementId: string;
  ownerName: string;
  contributorPullRequestGithubId: string;
};

/**
 * The fixture users (verified fact 20): the contributor is the settlement's
 * creditor, the sponsor its debtor; the contributor authored one of the two
 * fixture pull requests.
 */
async function fixtureAccounts(repositoryId: string): Promise<FixtureAccounts> {
  const [row] = await sql<{ settlement_id: string; creditor_id: string; debtor_id: string; owner_name: string }[]>`
    select settlements.id as settlement_id, settlements.creditor_id, settlements.debtor_id,
           repositories.owner_name
    from settlements
    join pull_requests on pull_requests.id = settlements.pull_request_id
    join registered_repositories as repositories on repositories.id = pull_requests.repository_id
    where pull_requests.repository_id = ${repositoryId}
  `;
  const [pullRequest] = await sql<{ github_pull_request_id: string }[]>`
    select github_pull_request_id from pull_requests
    where repository_id = ${repositoryId} and author_id = ${row!.creditor_id}
  `;
  return {
    contributor: await userById(row!.creditor_id),
    sponsor: await userById(row!.debtor_id),
    settlementId: row!.settlement_id,
    ownerName: row!.owner_name,
    contributorPullRequestGithubId: pullRequest!.github_pull_request_id,
  };
}

/**
 * A forge identity row for one user on its own instance, so the unique
 * (provider, instance_url, forge_user_id) triple never collides across cases.
 */
async function insertForgeIdentity(
  userId: string,
  options: { forgeUserId?: number } = {},
): Promise<{ instanceUrl: string; forgeUserId: number }> {
  const forgeUserId = options.forgeUserId ?? 7000 + nextSeedNumber();
  const instanceUrl = `https://gitlab-${nextSeedNumber()}-${forgeUserId}.example.com`;
  await sql`
    insert into user_forge_identities
      (user_id, provider, instance_url, forge_user_id, forge_login, encrypted_token)
    values (
      ${userId}, 'gitlab', ${instanceUrl}, ${forgeUserId}, 'gl-user',
      ${Buffer.from(encryptToken("gitlab-pat-bytes", TEST_ENCRYPTION_KEY), "utf8")}
    )
  `;
  return { instanceUrl, forgeUserId };
}

async function insertApiToken(userId: string, seed: number): Promise<Buffer> {
  const hash = tokenHash(seed);
  await sql`insert into api_tokens (user_id, token_hash) values (${userId}, ${hash})`;
  return hash;
}

/**
 * The full deletion candidate: a fixture contributor carrying an avatar and
 * OAuth token, an API token, a GitLab identity, and one moderation event on
 * each side of the contributor/sponsor pair.
 */
async function seedDeletionCandidate(options: { forgeUserId?: number } = {}) {
  const fixture = await materializeRepositoryFixture(sql);
  const accounts = await fixtureAccounts(fixture.repositoryId);
  const contributor = accounts.contributor;
  await sql`
    update users
    set avatar_url = ${`https://avatars.example/${contributor.githubUserId}`},
        encrypted_oauth_token = ${Buffer.from("github-oauth-token-bytes", "utf8")}
    where id = ${contributor.id}
  `;
  const apiTokenHash = await insertApiToken(contributor.id, nextSeedNumber());
  const forge = await insertForgeIdentity(contributor.id, options);
  await sql`
    insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason)
    values (${contributor.id}, ${accounts.sponsor.id}, 'ACTIVE', 'UNDER_AUDIT', 'audit opened'),
           (${accounts.sponsor.id}, ${contributor.id}, 'UNDER_AUDIT', 'ACTIVE', 'audit reversed')
  `;
  return { ...accounts, apiTokenHash, ...forge, repositoryId: fixture.repositoryId };
}

/** One table row as jsonb, by primary key. */
async function rowJson(table: string, id: string): Promise<Record<string, unknown>> {
  const [row] = await sql.unsafe<Record<string, unknown>[]>(
    `select to_jsonb(t) as row from ${table} as t where t.id = $1`,
    [id],
  );
  return row!.row as Record<string, unknown>;
}

async function usersRow(userId: string): Promise<Record<string, unknown>> {
  return rowJson("users", userId);
}

/** Collects every key in a JSON document, for the secret-key scan. */
function collectKeys(value: unknown, into: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      into.push(key);
      collectKeys(item, into);
    }
  }
  return into;
}

function sectionAt(document: AccountExport, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (accumulator, key) => (accumulator as Record<string, unknown>)[key],
    document,
  );
}

describe("account deletion as pseudonymisation", () => {
  it("case 1: deleting scrubs the secrets and keeps the ledger, events and identity triple", async () => {
    const seed = await seedDeletionCandidate();
    const contributor = seed.contributor;
    const settlementBefore = await rowJson("settlements", seed.settlementId);
    const eventsBefore = await sql<Record<string, unknown>[]>`
      select to_jsonb(t) as row from moderation_events as t
      where t.target_user_id = ${contributor.id} or t.actor_id = ${contributor.id}
      order by t.created_at, t.id
    `;

    const outcome = await deleteAccount(sql, contributor.githubUserId, { confirm: true });

    expect(outcome).toStrictEqual({
      kind: "DELETED",
      githubUserId: contributor.githubUserId,
      accountId: contributor.id,
      alreadyDeleted: false,
      deletedAt: expect.any(String),
      removedApiTokens: 1,
      scrubbedForgeIdentities: 1,
    });

    // The users row survives under its keys; its identity fields do not.
    const [user] = await sql<{
      id: string;
      github_user_id: string;
      github_login: string;
      avatar_url: string | null;
      encrypted_oauth_token: Buffer | null;
      deleted_at: Date | null;
    }[]>`
      select id, github_user_id, github_login, avatar_url, encrypted_oauth_token, deleted_at
      from users where id = ${contributor.id}
    `;
    expect(user!.id).toBe(contributor.id);
    expect(Number(user!.github_user_id)).toBe(contributor.githubUserId);
    expect(user!.github_login).toBe(DELETED_ACCOUNT_LOGIN);
    expect(user!.avatar_url).toBeNull();
    expect(user!.encrypted_oauth_token).toBeNull();
    expect(user!.deleted_at).not.toBeNull();

    // The API token is gone, and its hash no longer authenticates anything.
    const [tokenCount] = await sql<{ count: number }[]>`
      select count(*)::int as count from api_tokens where user_id = ${contributor.id}
    `;
    expect(tokenCount!.count).toBe(0);
    expect(await new PostgresApiTokenStore(sql).findAccountByTokenHash(seed.apiTokenHash)).toBeNull();

    // The forge row keeps its triple and loses its credential.
    const [identity] = await sql<{
      forge_user_id: string;
      instance_url: string;
      provider: string;
      encrypted_token: Buffer | null;
      forge_login: string;
      token_failed_at: Date | null;
    }[]>`
      select forge_user_id, instance_url, provider, encrypted_token, forge_login, token_failed_at
      from user_forge_identities where user_id = ${contributor.id}
    `;
    expect(identity).toBeDefined();
    expect(Number(identity!.forge_user_id)).toBe(seed.forgeUserId);
    expect(identity!.instance_url).toBe(seed.instanceUrl);
    expect(identity!.provider).toBe("gitlab");
    expect(identity!.encrypted_token).toBeNull();
    expect(identity!.forge_login).toBe(DELETED_ACCOUNT_LOGIN);
    expect(identity!.token_failed_at).not.toBeNull();

    // The settlement the contributor is credited on is untouched, byte for byte.
    expect(await rowJson("settlements", seed.settlementId)).toEqual(settlementBefore);

    // Both moderation events survive unchanged, and no others appeared.
    const eventsAfter = await sql<Record<string, unknown>[]>`
      select to_jsonb(t) as row from moderation_events as t
      where t.target_user_id = ${contributor.id} or t.actor_id = ${contributor.id}
      order by t.created_at, t.id
    `;
    expect(eventsAfter).toEqual(eventsBefore);
    const [eventCount] = await sql<{ count: number }[]>`
      select count(*)::int as count from moderation_events
      where target_user_id = ${contributor.id} or actor_id = ${contributor.id}
    `;
    expect(eventCount!.count).toBe(2);
  });

  it("case 2: keeps GitLab authorship resolvable through the identity triple", async () => {
    const sponsor = await insertUser("gl-repo-sponsor");
    const contributor = await insertUser("gl-contributor");
    const { instanceUrl } = await insertForgeIdentity(contributor.id, { forgeUserId: 777 });
    const [repository] = await sql<{ id: string }[]>`
      insert into registered_repositories (
        github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id,
        difficulty_scheme, provider, instance_url, forge_project_id
      ) values (
        ${9_600_000 + nextSeedNumber()}, ${`gl-owner/gl-repo-${seedCounter}`}, ${sponsor.id}, 'PUBLIC',
        null, ${sql.json(validDifficultyScheme())}, 'gitlab', ${instanceUrl}, 888
      ) returning id
    `;

    const outcome = await deleteAccount(sql, contributor.githubUserId, { confirm: true });
    expect(outcome.kind).toBe("DELETED");

    const identities = await new PostgresFoldStore(sql).findForgeIdentitiesByForgeUserIds(
      repository!.id,
      [777],
    );
    expect(identities).toHaveLength(1);
    expect(identities[0]!.user.id).toBe(contributor.id);
    expect(identities[0]!.forgeUserId).toBe(777);
  });

  it("case 3: leaves no usable forge credential behind", async () => {
    const seed = await seedDeletionCandidate();
    const store = new PostgresForgeIdentityStore(sql, TEST_ENCRYPTION_KEY);
    // The credential resolves before deletion, so the null afterwards is the
    // scrub's work and not an absent identity.
    expect(await store.getForgeToken(seed.contributor.id, seed.instanceUrl)).not.toBeNull();

    await deleteAccount(sql, seed.contributor.githubUserId, { confirm: true });

    // A scrubbed (null) token must resolve as null, not throw.
    await expect(store.getForgeToken(seed.contributor.id, seed.instanceUrl)).resolves.toBeNull();
  });

  it("case 4: is idempotent — a second deletion keeps the original stamps", async () => {
    const seed = await seedDeletionCandidate();
    const first = await deleteAccount(sql, seed.contributor.githubUserId, { confirm: true });
    expect(first.kind).toBe("DELETED");

    // Replace both kept stamps with fixed past timestamps, so the second run
    // proves it preserves them rather than merely being later than them.
    await sql`
      update users set deleted_at = '2020-06-01T12:00:00+00:00' where id = ${seed.contributor.id}
    `;
    await sql`
      update user_forge_identities set token_failed_at = '2021-01-01T00:00:00+00:00'
      where user_id = ${seed.contributor.id}
    `;

    const second = await deleteAccount(sql, seed.contributor.githubUserId, { confirm: true });
    expect(second).toStrictEqual({
      kind: "DELETED",
      githubUserId: seed.contributor.githubUserId,
      accountId: seed.contributor.id,
      alreadyDeleted: true,
      deletedAt: "2020-06-01T12:00:00.000Z",
      removedApiTokens: 0,
      scrubbedForgeIdentities: 1,
    });
    const [identity] = await sql<{ token_failed_at: Date }[]>`
      select token_failed_at from user_forge_identities where user_id = ${seed.contributor.id}
    `;
    expect(identity!.token_failed_at.toISOString()).toBe("2021-01-01T00:00:00.000Z");
  });

  it("case 5: a dry run returns PLANNED and writes nothing", async () => {
    const user = await insertUser("dry-run-contributor");
    await sql`
      update users set avatar_url = 'https://avatars.example/dry', encrypted_oauth_token = ${Buffer.from("dry-run-token")}
      where id = ${user.id}
    `;
    await insertApiToken(user.id, nextSeedNumber());
    await insertForgeIdentity(user.id);
    const before = {
      user: await usersRow(user.id),
      tokens: await sql<Record<string, unknown>[]>`
        select to_jsonb(t) as row from api_tokens as t where t.user_id = ${user.id} order by t.created_at
      `,
      identities: await sql<Record<string, unknown>[]>`
        select to_jsonb(t) as row from user_forge_identities as t where t.user_id = ${user.id} order by t.created_at, t.id
      `,
    };

    const outcome = await deleteAccount(sql, user.githubUserId, { confirm: false });

    expect(outcome).toStrictEqual({
      kind: "PLANNED",
      githubUserId: user.githubUserId,
      accountId: user.id,
      alreadyDeleted: false,
      wouldRemoveApiToken: true,
      wouldScrubForgeIdentities: 1,
      wouldClear: ["github_login", "avatar_url", "encrypted_oauth_token"],
    });
    expect(await usersRow(user.id)).toEqual(before.user);
    expect(
      await sql<Record<string, unknown>[]>`
        select to_jsonb(t) as row from api_tokens as t where t.user_id = ${user.id} order by t.created_at
      `,
    ).toEqual(before.tokens);
    expect(
      await sql<Record<string, unknown>[]>`
        select to_jsonb(t) as row from user_forge_identities as t where t.user_id = ${user.id} order by t.created_at, t.id
      `,
    ).toEqual(before.identities);
  });

  it("case 6: refuses a sponsor until every registration is unregistered", async () => {
    const blockedSeed = await seedDeletionCandidate();
    const sponsor = blockedSeed.sponsor;
    // Baselines BEFORE the refused call, so the "unchanged" assertions below
    // compare against the true pre-call state.
    const sponsorBefore = await usersRow(sponsor.id);
    const registrationBefore = await rowJson("registered_repositories", blockedSeed.repositoryId);

    const outcome = await deleteAccount(sql, sponsor.githubUserId, { confirm: true });
    expect(outcome.kind).toBe("SPONSOR_BLOCKED");
    if (outcome.kind === "SPONSOR_BLOCKED") {
      expect(outcome.repositories).toEqual([
        { ownerName: blockedSeed.ownerName, provider: "github", instanceUrl: null },
      ]);
    }
    // The refusal writes nothing to the sponsor's row or registration.
    expect(await usersRow(sponsor.id)).toEqual(sponsorBefore);
    expect(await rowJson("registered_repositories", blockedSeed.repositoryId)).toEqual(registrationBefore);

    // The blocker check runs for a dry run too: a sponsor cannot even plan
    // a deletion while a registration is live.
    const dryRun = await deleteAccount(sql, sponsor.githubUserId, { confirm: false });
    expect(dryRun.kind).toBe("SPONSOR_BLOCKED");
    expect(await usersRow(sponsor.id)).toEqual(sponsorBefore);

    // A moderation-deactivated registration (active=false, unregistered_at
    // null) still blocks: it can be reactivated by moderation.
    const deactivatedSeed = await seedDeletionCandidate();
    await sql`update registered_repositories set active = false where id = ${deactivatedSeed.repositoryId}`;
    const deactivated = await deleteAccount(sql, deactivatedSeed.sponsor.githubUserId, { confirm: true });
    expect(deactivated.kind).toBe("SPONSOR_BLOCKED");

    // Unregistration (not mere deactivation) unblocks the first sponsor.
    await sql`
      update registered_repositories set active = false, unregistered_at = now()
      where sponsor_id = ${sponsor.id}
    `;
    const after = await deleteAccount(sql, sponsor.githubUserId, { confirm: true });
    expect(after).toMatchObject({ kind: "DELETED", alreadyDeleted: false, removedApiTokens: 0, scrubbedForgeIdentities: 0 });
  });

  it("case 7: an unknown account is reported and left alone", async () => {
    expect(await deleteAccount(sql, 9_876_543_210, { confirm: true })).toStrictEqual({
      kind: "UNKNOWN_ACCOUNT",
      githubUserId: 9_876_543_210,
    });
  });

  it("case 8: exports the account before and after deletion without any secret material", async () => {
    const seed = await seedDeletionCandidate({ forgeUserId: 777 });
    const contributor = seed.contributor;

    const document = await exportAccount(sql, contributor.githubUserId);
    expect(document).not.toBeNull();
    const exported = document!;
    expect(exported.formatVersion).toBe(1);
    expect(new Date(exported.exportedAt).toISOString()).toEqual(exported.exportedAt);
    expect(exported.account.githubLogin).toBe(`contributor-${contributor.githubUserId}`);
    expect(exported.account.githubUserId).toBe(contributor.githubUserId);
    expect(exported.account.hasStoredGitHubToken).toBe(true);

    expect(exported.apiToken).not.toBeNull();
    expect(new Date(exported.apiToken!.createdAt).toISOString()).toEqual(exported.apiToken!.createdAt);

    expect(exported.forgeIdentities).toHaveLength(1);
    expect(exported.forgeIdentities[0]!.forgeUserId).toBe(777);
    expect(exported.forgeIdentities[0]!.hasStoredToken).toBe(true);
    expect(typeof exported.forgeIdentities[0]!.forgeUserId).toBe("number");

    expect(exported.settlements.asCreditor).toHaveLength(1);
    expect(exported.moderationEvents.asTarget).toHaveLength(1);
    expect(exported.authoredPullRequests).toHaveLength(1);
    expect(Number(exported.authoredPullRequests[0]!.github_pull_request_id)).toBe(
      Number(seed.contributorPullRequestGithubId),
    );

    // No seeded secret bytes anywhere, in either encoding.
    const serialized = JSON.stringify(exported);
    const secretBytes = [
      Buffer.from("github-oauth-token-bytes", "utf8"),
      seed.apiTokenHash,
      Buffer.from(encryptToken("gitlab-pat-bytes", TEST_ENCRYPTION_KEY), "utf8"),
    ];
    for (const bytes of secretBytes) {
      expect(serialized).not.toContain(bytes.toString("utf8"));
      expect(serialized.toLowerCase()).not.toContain(bytes.toString("hex"));
    }
    // And no secret-bearing key of any shape.
    expect(collectKeys(exported).join(" ")).not.toMatch(/encrypted|token_hash|secret/i);

    // The sponsor's export lists its registration with the explicit,
    // secret-free column set.
    const sponsorDocument = await exportAccount(sql, seed.sponsor.githubUserId);
    expect(sponsorDocument).not.toBeNull();
    expect(sponsorDocument!.sponsoredRepositories).toHaveLength(1);
    expect(Object.keys(sponsorDocument!.sponsoredRepositories[0]!).sort()).toEqual([
      "active", "createdAt", "id", "instanceUrl", "ownerName", "provider", "unregisteredAt",
    ]);
    expect(sponsorDocument!.sponsoredRepositories[0]!.ownerName).toBe(seed.ownerName);

    // After deletion the export still works, with the secrets gone.
    await deleteAccount(sql, contributor.githubUserId, { confirm: true });
    const afterDeletion = await exportAccount(sql, contributor.githubUserId);
    expect(afterDeletion).not.toBeNull();
    expect(afterDeletion!.account.deletedAt).not.toBeNull();
    expect(afterDeletion!.account.hasStoredGitHubToken).toBe(false);
    expect(afterDeletion!.apiToken).toBeNull();

    expect(await exportAccount(sql, 9_876_543_210)).toBeNull();
  });

  it("case 9: the export covers every foreign key to users", async () => {
    // One user seeded against every referencing table, one row per (table,
    // column) pair wherever the constraints allow.
    const exporter = await insertUser("export-user");
    const other = await insertUser("export-other");
    const [repository] = await sql<{ id: string }[]>`
      insert into registered_repositories (
        github_repository_id, owner_name, sponsor_id, visibility, github_webhook_id, difficulty_scheme
      ) values (
        ${9_700_000 + nextSeedNumber()}, ${`export-owner/repo-${seedCounter}`}, ${exporter.id}, 'PUBLIC',
        ${9_700_100 + nextSeedNumber()}, ${sql.json(validDifficultyScheme())}
      ) returning id
    `;
    const repositoryId = repository!.id;
    const [issue] = await sql<{ id: string }[]>`
      insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state,
                          opening_label, opening_comparison_points, opening_reserve_points)
      values (${9_700_200 + nextSeedNumber()}, ${repositoryId}, 1, 'Export fixture', '',
              'https://example.test/issue', 'CLOSED', 'M', 5, 5)
      returning id
    `;
    const issueId = issue!.id;
    const [pullRequest] = await sql<{ id: string }[]>`
      insert into pull_requests (github_pull_request_id, repository_id, issue_id, pull_request_number,
                                 url, title, body, author_id, state, merged_at)
      values (${9_700_300 + nextSeedNumber()}, ${repositoryId}, ${issueId}, 1,
              'https://example.test/pr', 'Export fixture', '', ${exporter.id}, 'MERGED', now())
      returning id
    `;
    const pullRequestId = pullRequest!.id;
    // Settlements and self-work calibrations reference the (pull request,
    // issue) pair through pull_request_issues, which also carries the
    // repository for its own composite foreign keys.
    await sql`
      insert into pull_request_issues (pull_request_id, issue_id, repository_id)
      values (${pullRequestId}, ${issueId}, ${repositoryId})
    `;
    const [settlement] = await sql<{ id: string }[]>`
      insert into settlements (pull_request_id, issue_id, creditor_id, debtor_id,
                               opening_comparison_points, settled_points, review_rounds, credits,
                               proof_sha256, status)
      values (${pullRequestId}, ${issueId}, ${exporter.id}, ${other.id}, 5, 6, 0, 6,
              ${createHash("sha256").update(`proof-${seedCounter}`).digest("hex")}, 'SETTLED')
      returning id
    `;
    const settlementId = settlement!.id;
    // A second settlement on its own pull request puts the export user on the
    // DEBTOR side too, so the settlements.asDebtor section is seeded.
    const [issue2] = await sql<{ id: string }[]>`
      insert into issues (github_issue_id, repository_id, issue_number, title, body, url, state,
                          opening_label, opening_comparison_points, opening_reserve_points)
      values (${9_700_400 + nextSeedNumber()}, ${repositoryId}, 2, 'Export fixture two', '',
              'https://example.test/issue-2', 'CLOSED', 'M', 5, 5)
      returning id
    `;
    const issue2Id = issue2!.id;
    const [pullRequest2] = await sql<{ id: string }[]>`
      insert into pull_requests (github_pull_request_id, repository_id, issue_id, pull_request_number,
                                 url, title, body, author_id, state, merged_at)
      values (${9_700_500 + nextSeedNumber()}, ${repositoryId}, ${issue2Id}, 2,
              'https://example.test/pr-2', 'Export fixture two', '', ${other.id}, 'MERGED', now())
      returning id
    `;
    await sql`
      insert into pull_request_issues (pull_request_id, issue_id, repository_id)
      values (${pullRequest2!.id}, ${issue2Id}, ${repositoryId})
    `;
    await sql`
      insert into settlements (pull_request_id, issue_id, creditor_id, debtor_id,
                               opening_comparison_points, settled_points, review_rounds, credits,
                               proof_sha256, status)
      values (${pullRequest2!.id}, ${issue2Id}, ${other.id}, ${exporter.id}, 5, 6, 0, 6,
              ${createHash("sha256").update(`proof-2-${seedCounter}`).digest("hex")}, 'SETTLED')
    `;
    await sql`
      insert into self_work_calibrations (pull_request_id, issue_id, user_id, opening_comparison_points, actual_points)
      values (${pullRequestId}, ${issueId}, ${exporter.id}, 5, 6)
    `;
    await insertApiToken(exporter.id, nextSeedNumber());
    await insertForgeIdentity(exporter.id);
    const [audit] = await sql<{ id: string }[]>`
      insert into calibration_audits (account_id, reporter_id, moderator_id, rationale,
                                      sample_started_at, sample_ended_at, settled_sample_size)
      values (${exporter.id}, ${other.id}, ${exporter.id}, 'export fixture audit',
              '2026-09-01', '2026-09-02', 3)
      returning id
    `;
    const auditId = audit!.id;
    // The reversed roles cover the reporter pair with a row of the export
    // user's own: the exporter reported an audit on the other account.
    await sql`
      insert into calibration_audits (account_id, reporter_id, rationale,
                                      sample_started_at, sample_ended_at, settled_sample_size)
      values (${other.id}, ${exporter.id}, 'export fixture reverse audit',
              '2026-09-03', '2026-09-04', 2)
    `;
    const [targetEvent] = await sql<{ id: string }[]>`
      insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason)
      values (${exporter.id}, ${other.id}, 'ACTIVE', 'UNDER_AUDIT', 'export fixture target')
      returning id
    `;
    await sql`
      insert into moderation_events (target_user_id, actor_id, prior_state, new_state, reason)
      values (${other.id}, ${exporter.id}, 'UNDER_AUDIT', 'ACTIVE', 'export fixture actor')
    `;
    await sql`
      insert into moderator_role_changes (target_account_id, actor_id, new_role)
      values (${exporter.id}, ${other.id}, 'MEMBER'), (${other.id}, ${exporter.id}, 'MEMBER')
    `;
    await sql`
      insert into settlement_override_requests (issue_id, requester_id, reason)
      values (${issueId}, ${exporter.id}, 'export fixture open')
    `;
    await sql`
      insert into settlement_override_requests (issue_id, requester_id, reason, state, decided_by_id,
                                                decision_reason, decided_at)
      values (${issueId}, ${other.id}, 'export fixture declined', 'DECLINED', ${exporter.id},
              'declined by fixture', now())
    `;
    await sql`
      insert into reconciliation_runs (requested_by_user_id, status, started_at)
      values (${exporter.id}, 'COMPLETED', '2026-09-01T00:00:00Z')
    `;
    await sql`
      insert into reconciliation_runs (requested_by_user_id, status, started_at, graphql_cost,
                                       graphql_cost_sponsor_id, graphql_observed_responses,
                                       graphql_unmeasured_responses)
      values (null, 'COMPLETED', '2026-09-02T00:00:00Z', 5, ${exporter.id}, 2, 0)
    `;
    await sql`
      insert into repository_reconciliation_usage (sponsor_id, repository_id, debt, measured_at, rate_per_second)
      values (${exporter.id}, ${repositoryId}, 1.5, '2026-09-01T00:00:00Z', 0.5)
    `;
    const [adjustment] = await sql<{ id: string }[]>`
      insert into moderation_credit_adjustments (moderation_event_id, calibration_audit_id,
                                                 target_account_id, gap_per_pair, pair_count,
                                                 total_amount, reason)
      values (${targetEvent!.id}, ${auditId}, ${exporter.id}, 0.5, 1, 2, 'export fixture adjustment')
      returning id
    `;
    await sql`
      insert into moderation_credit_adjustment_lines (adjustment_id, settlement_id, creditor_id, amount)
      values (${adjustment!.id}, ${settlementId}, ${exporter.id}, 2)
    `;

    const document = await exportAccount(sql, exporter.githubUserId);
    expect(document).not.toBeNull();
    const exported = document!;

    // The declared coverage equals the catalogue's foreign keys to users.
    const catalogPairs = (await sql<{ pair: string }[]>`
      select c.conrelid::regclass::text || '.' || a.attname as pair
      from pg_constraint c
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any(c.conkey)
      where c.contype = 'f' and c.confrelid = 'users'::regclass
      order by 1
    `).map((row) => row.pair).sort();
    const declaredPairs = userForeignKeyExports
      .map((entry) => `${entry.table}.${entry.column}`)
      .sort();
    expect(declaredPairs).toEqual(catalogPairs);

    // Every seeded row appears in its declared section, complete and in order.
    for (const entry of userForeignKeyExports) {
      if (entry.kind !== "jsonb") continue;
      const expected = await sql.unsafe<Record<string, unknown>[]>(
        // Same constant identifiers the export module itself interpolates.
        `select to_jsonb(t) as row from ${entry.table} as t` +
        ` where t.${entry.column} = $1` +
        ` order by ${entry.orderBy.map((column) => `"${column}"`).join(", ")}`,
        [exporter.id],
      );
      // An empty seed could only ever match an empty expectation, so each
      // section must hold at least the row this case planted.
      expect(expected.length, `section ${entry.path} is seeded`).toBeGreaterThan(0);
      expect(sectionAt(exported, entry.path), `section ${entry.path}`).toEqual(
        expected.map((row) => row.row),
      );
    }

    // The explicit sections carry their seeded rows too, secrets as booleans.
    expect(exported.sponsoredRepositories).toHaveLength(1);
    expect(exported.sponsoredRepositories[0]!.id).toBe(repositoryId);
    expect(exported.forgeIdentities).toHaveLength(1);
    expect(exported.forgeIdentities[0]!.hasStoredToken).toBe(true);
    expect(exported.apiToken).not.toBeNull();
  });
});
