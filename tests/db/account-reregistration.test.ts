import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { materializeRepositoryFixture } from "../support/materialized-repository";
import { startPostgresContainer } from "../support/postgres-container";
import { deleteAccount } from "@/lib/accounts/deletion";
import { findSessionAccountState, upsertGitHubAccount } from "@/lib/auth/account-store";
import { getCurrentUserRole } from "@/lib/moderation/current-role";

let sql: Sql;
let container: StartedTestContainer;
const originalDatabaseUrl = process.env.DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "account_reregistration_test",
    user: "account_reregistration_test",
    password: "account_reregistration_test",
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

const reRegisteredToken = Buffer.from("re-registered-oauth-token-bytes", "utf8");

/** The row's identity state, for the restoration assertions. */
async function identityRow(userId: string): Promise<{
  deleted_at: Date | null;
  github_login: string;
  avatar_url: string | null;
  encrypted_oauth_token: Buffer | null;
}> {
  const [row] = await sql<{
    deleted_at: Date | null;
    github_login: string;
    avatar_url: string | null;
    encrypted_oauth_token: Buffer | null;
  }[]>`
    select deleted_at, github_login, avatar_url, encrypted_oauth_token
    from users where id = ${userId}
  `;
  return row!;
}

/** The settlement's creditor for the fixture repository. */
async function settlementCreditor(repositoryId: string): Promise<{ settlementId: string; creditorId: string }> {
  const [row] = await sql<{ settlement_id: string; creditor_id: string }[]>`
    select settlements.id as settlement_id, settlements.creditor_id
    from settlements
    join pull_requests on pull_requests.id = settlements.pull_request_id
    where pull_requests.repository_id = ${repositoryId}
  `;
  return { settlementId: row!.settlement_id, creditorId: row!.creditor_id };
}

describe("account re-registration after deletion", () => {
  it("case 1: a deleted account stops resolving and re-registers with its identity restored", async () => {
    // Seed through the sign-in upsert itself: a fresh insert, then the same
    // github id again exercises the on-conflict path the second upsert uses.
    const seeded = await upsertGitHubAccount({
      githubUserId: 9_900_001,
      login: "seeded-user",
      role: "MEMBER",
      encryptedAccessToken: Buffer.from("seeded-token-bytes", "utf8"),
    }, sql);

    expect(await getCurrentUserRole(seeded.id, sql)).toBe("MEMBER");
    // The snapshot the jwt refresh reads: the liveness state and, for a LIVE
    // row, the login the refreshed token must carry as its name.
    expect(await findSessionAccountState(seeded.id, sql)).toEqual({
      state: "LIVE",
      githubLogin: "seeded-user",
    });

    const outcome = await deleteAccount(sql, 9_900_001, { confirm: true });
    expect(outcome.kind).toBe("DELETED");

    expect(await getCurrentUserRole(seeded.id, sql)).toBeNull();
    expect(await findSessionAccountState(seeded.id, sql)).toEqual({ state: "DELETED", githubLogin: null });
    // An absent row keeps today's MISSING answer.
    expect(await findSessionAccountState(randomUUID(), sql)).toEqual({ state: "MISSING", githubLogin: null });

    const restored = await upsertGitHubAccount({
      githubUserId: 9_900_001,
      login: "octocat",
      role: "MEMBER",
      encryptedAccessToken: reRegisteredToken,
    }, sql);

    expect(restored.id).toBe(seeded.id);
    const row = await identityRow(seeded.id);
    expect(row.deleted_at).toBeNull();
    expect(row.github_login).toBe("octocat");
    // The avatar is not restored — sign-in no longer collects it (issue 1075) —
    // while the login and the token are: the on-conflict arm touches the
    // identity columns sign-in still owns, and the scrubbed-check holds with
    // the avatar nulled and the row live again.
    expect(row.avatar_url).toBeNull();
    expect(row.encrypted_oauth_token).toEqual(reRegisteredToken);
    expect(await getCurrentUserRole(seeded.id, sql)).toBe("MEMBER");
  });

  it("case 2: the settlement keeps its creditor through delete and re-registration", async () => {
    const fixture = await materializeRepositoryFixture(sql);
    const { settlementId, creditorId } = await settlementCreditor(fixture.repositoryId);
    const [githubId] = await sql<{ github_user_id: string }[]>`
      select github_user_id from users where id = ${creditorId}
    `;
    const creditorGithubId = Number(githubId!.github_user_id);

    await deleteAccount(sql, creditorGithubId, { confirm: true });
    expect((await settlementCreditor(fixture.repositoryId)).creditorId).toBe(creditorId);

    await upsertGitHubAccount({
      githubUserId: creditorGithubId,
      login: "octocat",
      role: "MEMBER",
      encryptedAccessToken: reRegisteredToken,
    }, sql);

    expect((await settlementCreditor(fixture.repositoryId)).creditorId).toBe(creditorId);
    expect(await findSessionAccountState(creditorId, sql)).toEqual({
      state: "LIVE",
      githubLogin: "octocat",
    });
    // The settlement row itself is untouched by both writes.
    const [settlement] = await sql<{ creditor_id: string }[]>`
      select creditor_id from settlements where id = ${settlementId}
    `;
    expect(settlement!.creditor_id).toBe(creditorId);
  });

  it("case 3: a deleted row still carrying MODERATOR re-signs in as MEMBER", async () => {
    const seeded = await upsertGitHubAccount({
      githubUserId: 9_900_002,
      login: "deleted-moderator",
      role: "MODERATOR",
      encryptedAccessToken: Buffer.from("deleted-moderator-token-bytes", "utf8"),
    }, sql);
    const outcome = await deleteAccount(sql, 9_900_002, { confirm: true });
    expect(outcome.kind).toBe("DELETED");

    // The pre-fix shape: rows deleted before the reset shipped kept their
    // MODERATOR role. Planted directly, so the case holds for them too.
    await sql`update users set role = 'MODERATOR' where id = ${seeded.id}`;

    const restored = await upsertGitHubAccount({
      githubUserId: 9_900_002,
      login: "octocat",
      role: "MEMBER",
      encryptedAccessToken: reRegisteredToken,
    }, sql);

    expect(restored.id).toBe(seeded.id);
    // The stored role of a deleted row is not a floor: re-sign-in after
    // deletion comes back MEMBER unless the resolved sign-in role (the
    // MODERATOR_GITHUB_USER_IDS floor) is MODERATOR.
    expect(restored.role).toBe("MEMBER");
    const [row] = await sql<{ role: string; deleted_at: Date | null }[]>`
      select role, deleted_at from users where id = ${seeded.id}
    `;
    expect(row!.role).toBe("MEMBER");
    expect(row!.deleted_at).toBeNull();
  });

  it("case 4: a configured-moderator id re-signs in after deletion as MODERATOR", async () => {
    const seeded = await upsertGitHubAccount({
      githubUserId: 9_900_003,
      login: "configured-moderator",
      role: "MEMBER",
      encryptedAccessToken: Buffer.from("configured-moderator-token-bytes", "utf8"),
    }, sql);
    const outcome = await deleteAccount(sql, 9_900_003, { confirm: true });
    expect(outcome.kind).toBe("DELETED");

    // The MODERATOR_GITHUB_USER_IDS floor re-applies at sign-in: this is the
    // role upsertGitHubIdentity resolves for a configured id, regardless of
    // the deleted row's stored role.
    const restored = await upsertGitHubAccount({
      githubUserId: 9_900_003,
      login: "octocat",
      role: "MODERATOR",
      encryptedAccessToken: reRegisteredToken,
    }, sql);

    expect(restored.id).toBe(seeded.id);
    expect(restored.role).toBe("MODERATOR");
  });
});
