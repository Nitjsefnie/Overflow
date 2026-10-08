import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { DELETED_ACCOUNT_LOGIN, deleteAccount } from "@/lib/accounts/deletion";
import { exportAccount, formatAccountExport } from "@/lib/accounts/export";
import { findLiveAccountIdentity } from "@/lib/accounts/self-service";
import { createAccountExportPostHandler } from "@/app/api/account/export/route";
import { createAccountDeleteHandler } from "@/app/api/account/route";
import { guardedRequests, useTrustedOrigin } from "../support/trusted-origin";
import { startPostgresContainer } from "../support/postgres-container";

useTrustedOrigin();
const exportRequests = guardedRequests("/api/account/export");
const deleteRequests = guardedRequests("/api/account");
let sql: Sql;
let container: StartedTestContainer;
const originalDatabaseUrl = process.env.DATABASE_URL;
let nextId = 99_000_000;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "account_self_service_test", user: "account_self_service_test", password: "account_self_service_test" });
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
  // The route modules imported above are bound to the real database client;
  // drop them so a later file in a shared worker loads them under its mocks.
  vi.resetModules();
});

async function insertUser(login: string) {
  const githubUserId = ++nextId;
  const [row] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, avatar_url)
    values (${githubUserId}, ${login}, 'https://example.test/avatar') returning id
  `;
  return { id: row!.id, githubUserId };
}

describe("self-service account data on Postgres", () => {
  it("finds only a live user's internal UUID, rejects malformed ids, and returns null for unknown ids", async () => {
    const live = await insertUser("lookup-live");
    const removed = await insertUser("lookup-removed");
    await deleteAccount(sql, removed.githubUserId, { confirm: true });
    expect(await findLiveAccountIdentity(sql, live.id)).toEqual({ githubUserId: live.githubUserId, githubLogin: "lookup-live" });
    expect(await findLiveAccountIdentity(sql, removed.id)).toBeNull();
    expect(await findLiveAccountIdentity(sql, randomUUID())).toBeNull();
    await expect(findLiveAccountIdentity(sql, "not-a-uuid")).rejects.toMatchObject({ code: "22P02" });
  });

  it("exports through the real handler and deletes to the CLI's pseudonymised row state", async () => {
    const account = await insertUser("route-owner");
    await sql`
      update users set encrypted_oauth_token = ${Buffer.from("fixture-oauth-token")}
      where id = ${account.id}
    `;
    const [beforeDeletion] = await sql<{ encrypted_oauth_token: Buffer | null }[]>`
      select encrypted_oauth_token from users where id = ${account.id}
    `;
    expect(beforeDeletion!.encrypted_oauth_token).toEqual(Buffer.from("fixture-oauth-token"));
    const getSession = async () => ({ user: { id: account.id, authenticatedAt: Date.now() / 1000 } });
    const exportResponse = await createAccountExportPostHandler({ getSession, getSql: () => sql })(exportRequests.json({}));
    const directDocument = await exportAccount(sql, account.githubUserId);
    expect(exportResponse.status).toBe(200);
    const body = await exportResponse.text();
    const exportedAt = (JSON.parse(body) as { exportedAt: string }).exportedAt;
    expect(Number.isNaN(Date.parse(exportedAt))).toBe(false);
    expect(body).toBe(formatAccountExport({ ...directDocument!, exportedAt }));

    const endSession = vi.fn(async () => undefined);
    const deletionResponse = await createAccountDeleteHandler({ getSession, getSql: () => sql, endSession })(deleteRequests.json({ confirmLogin: " ROUTE-OWNER " }, "DELETE"));
    expect(deletionResponse.status).toBe(200);
    await expect(deletionResponse.json()).resolves.toEqual({ deleted: true });
    expect(endSession).toHaveBeenCalledTimes(1);
    const [row] = await sql<{ github_login: string; avatar_url: string | null; encrypted_oauth_token: Buffer | null; deleted_at: Date | null }[]>`
      select github_login, avatar_url, encrypted_oauth_token, deleted_at from users where id = ${account.id}
    `;
    expect(row).toEqual({ github_login: DELETED_ACCOUNT_LOGIN, avatar_url: null, encrypted_oauth_token: null, deleted_at: expect.any(Date) });
    expect(await findLiveAccountIdentity(sql, account.id)).toBeNull();
  });

  it("exports account.avatarUrl as a stable null, whatever the row carries (issue 1075 deprecation window)", async () => {
    // The row is seeded through raw SQL with an avatar value — the pre-1075
    // shape the migration nulls — so the pin holds even against a row that
    // still carries one when the export runs: the key stays for shape
    // compatibility (API.md deprecations), and its value is constant null.
    const account = await insertUser("export-no-avatar");
    const document = await exportAccount(sql, account.githubUserId);
    expect(document).not.toBeNull();
    expect(Object.hasOwn(document!.account, "avatarUrl")).toBe(true);
    expect(document!.account.avatarUrl).toBeNull();
  });
});
