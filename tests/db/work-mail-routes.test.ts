import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { closeSql, getSql } from "@/lib/db/client";
import { createWorkMailGetHandler, createWorkMailPostHandler, type WorkMailRouteDependencies } from "@/app/api/account/work-mail/route";
import { createWorkMailConfirmPostHandler } from "@/app/api/account/work-mail/confirm/route";
import { createWorkMailUnsubscribePostHandler } from "@/app/api/work-mail/unsubscribe/route";
import { PostgresWorkMailStore } from "@/lib/accounts/work-mail-store";
import { buildDigestMessage } from "@/lib/accounts/work-mail-transport";
import { mintUnsubscribeToken } from "@/lib/accounts/work-mail-unsubscribe";
import { startPostgresContainer } from "../support/postgres-container";
import { recordingTransport } from "../support/work-mail-recording-transport";
import { guardedRequests, trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";

let sql: Sql;
let container: StartedTestContainer;
const original = process.env.OVERFLOW_DATABASE_URL;
const tokenKey = randomBytes(32).toString("base64url");

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "work_mail_routes", user: "work_mail_routes" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();
});
afterAll(async () => {
  await closeSql(); await container?.stop();
  if (original === undefined) delete process.env.OVERFLOW_DATABASE_URL; else process.env.OVERFLOW_DATABASE_URL = original;
});
useTrustedOrigin();

describe("the work-mail routes over the real store", () => {
  it("confirms through the mailed link, then the digest's one-click link removes the subscription", async () => {
    vi.stubEnv("OVERFLOW_TOKEN_ENCRYPTION_KEY", tokenKey);
    const [user] = await sql<{ id: string }[]>`insert into users (github_user_id, github_login) values (8500001, 'routes') returning id`;
    const transport = recordingTransport();
    const dependencies: WorkMailRouteDependencies = {
      getSession: async () => ({ user: { id: user!.id } }),
      getSql: () => sql,
      createStore: (client) => new PostgresWorkMailStore(client, tokenKey),
      readConfig: () => ({ enabled: true, from: "work@mail.example.org", dailyLimit: 10,
        smtp: { host: "smtp.mail.example.org", port: 465, username: "sender", password: "pw" } }),
      createTransport: () => transport,
    };
    const requests = guardedRequests("/api/account/work-mail");
    expect((await createWorkMailPostHandler(dependencies)(requests.json({ address: "ada@example.net" }))).status).toBe(202);
    await vi.waitFor(() => expect(transport.sent).toHaveLength(1));

    const prefix = `${trustedOrigin}/dashboard#work-mail-confirm=`;
    const link = transport.sent[0]!.content.split("\r\n").find((line) => line.startsWith(prefix))!;
    const confirm = guardedRequests("/api/account/work-mail/confirm").json({ token: link.slice(prefix.length) });
    expect((await createWorkMailConfirmPostHandler(dependencies)(confirm)).status).toBe(200);
    const read = async () => (await (await createWorkMailGetHandler(dependencies)()).json()) as { subscription: { confirmed: boolean } | null };
    expect((await read()).subscription?.confirmed).toBe(true);

    const [row] = await sql<{ id: string }[]>`select id from contributor_work_mail_subscriptions where user_id = ${user!.id}`;
    const digest = buildDigestMessage({ from: "work@mail.example.org", to: "ada@example.net", origin: trustedOrigin, count: 1,
      unsubscribeToken: mintUnsubscribeToken(row!.id) });
    const target = /^List-Unsubscribe: <(.+)>$/m.exec(digest.content.replaceAll("\r\n", "\n"))![1]!;
    const unsubscribe = createWorkMailUnsubscribePostHandler({
      deleteSubscriptionById: (id) => new PostgresWorkMailStore(sql, tokenKey).deleteSubscriptionById(id),
    });
    expect((await unsubscribe(new Request(target, { method: "POST", body: "List-Unsubscribe=One-Click",
      headers: { "content-type": "application/x-www-form-urlencoded" } }))).status).toBe(200);
    expect((await read()).subscription).toBeNull();
  });
});
