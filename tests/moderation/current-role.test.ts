import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql, getSql } from "@/lib/db/client";
import type { UserRole } from "@/lib/db/types";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { mintApiToken } from "@/lib/security/api-token";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { GET as productionIssuesGet } from "@/app/api/issues/route";
import { GET as productionModeratorsGet } from "@/app/api/moderation/moderators/route";

// The role lookup every authorization gate trusts (issue 693). Route tests
// elsewhere inject a fake getCurrentRole, so this suite is the one place the
// production lookup answers against a real users table: directly, and through
// the production route exports, whose gates read it on each request.

const originalDatabaseUrl = process.env.DATABASE_URL;
let container: StartedTestContainer | undefined;
let sql: Sql;
let externalId = 6_930_000;

let memberId: string;
let moderatorId: string;
let deletedId: string;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "overflow_current_role",
    user: "overflow_current_role",
    password: "overflow_current_role",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql();
  await runMigrations();

  memberId = await insertUser("MEMBER");
  moderatorId = await insertUser("MODERATOR");
  // A pseudonymised account keeps its row and its role column; only
  // deleted_at says it is gone.
  deletedId = await insertUser("MODERATOR", { deleted: true });
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

describe("getCurrentUserRole against the users table", () => {
  it("answers each account's stored role", async () => {
    await expect(getCurrentUserRole(memberId, sql)).resolves.toBe("MEMBER");
    await expect(getCurrentUserRole(moderatorId, sql)).resolves.toBe("MODERATOR");
  });

  it("answers null for a soft-deleted account, whatever role its row still carries", async () => {
    await expect(getCurrentUserRole(deletedId, sql)).resolves.toBeNull();
  });

  it("answers null for an id no account has", async () => {
    await expect(getCurrentUserRole(randomUUID(), sql)).resolves.toBeNull();
  });
});

describe("the production route gates read the role from the database", () => {
  it("admits a member to a member route and refuses a soft-deleted account there", async () => {
    const admitted = await productionIssuesGet(await bearerRequest("/api/issues", memberId));
    expect(admitted.status).toBe(200);
    expect(Array.isArray(await admitted.json())).toBe(true);

    const refused = await productionIssuesGet(await bearerRequest("/api/issues", deletedId));
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("FORBIDDEN");
  });

  it("refuses a member on a moderator route and admits a moderator", async () => {
    const refused = await productionModeratorsGet(
      await bearerRequest("/api/moderation/moderators", memberId),
    );
    expect(refused.status).toBe(403);
    expect((await refused.json()).error.code).toBe("FORBIDDEN");

    const admitted = await productionModeratorsGet(
      await bearerRequest("/api/moderation/moderators", moderatorId),
    );
    expect(admitted.status).toBe(200);
    const { moderators } = (await admitted.json()) as { moderators: { accountId: string }[] };
    const listed = moderators.map((moderator) => moderator.accountId);
    expect(listed).toContain(moderatorId);
    expect(listed).not.toContain(memberId);
  });
});

async function insertUser(role: UserRole, options: { deleted?: boolean } = {}): Promise<string> {
  externalId += 1;
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, role, deleted_at)
    values (
      ${externalId}, ${`current-role-${externalId}`}, ${role},
      ${options.deleted === true ? sql`now()` : null}
    )
    returning id
  `;
  return user.id;
}

/**
 * A request carrying a freshly issued API token for the account, so the
 * route resolves the credential through its production token store and no
 * session is faked at all.
 */
async function bearerRequest(path: string, userId: string): Promise<Request> {
  const { token, tokenHash } = mintApiToken();
  await new PostgresApiTokenStore(sql).issueToken(userId, tokenHash);
  return new Request(`http://overflow.test${path}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}
