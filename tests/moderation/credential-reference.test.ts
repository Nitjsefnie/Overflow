import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { requestHost, trustedOrigin, useTrustedOrigin } from "../support/trusted-origin";
import { closeSql, getSql } from "@/lib/db/client";
import { getCurrentUserRole } from "@/lib/moderation/current-role";
import { PostgresModerationStore } from "@/lib/moderation/postgres-store";
import { createModeratorPostHandler } from "@/app/api/moderation/moderators/route";
import {
  AccountModerationService,
  type CalibrationCohortSnapshot,
} from "@/lib/moderation/service";
import { mintApiToken } from "@/lib/security/api-token";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";

// Issue 682, task 2: the credential the moderator gate resolved is what the
// privileged-action rows record — ("session", NULL) behind a cookie session,
// ("token", api_tokens.id) behind a bearer token, and (NULL, NULL) for a
// writer with no HTTP request behind it. The rows are also proved to carry no
// credential secret: not the bearer token, not its SHA-256 digest, not the
// session cookie value.
useTrustedOrigin();

const originalDatabaseUrl = process.env.DATABASE_URL;
let container: StartedTestContainer | undefined;
let sql: ReturnType<typeof getSql>;
let githubUserId = 941_000;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "overflow_credential_reference",
    user: "overflow_credential_reference",
    password: "overflow_credential_reference",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  sql = getSql();
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

let sequence = 0;
const cookieValue = "authjs.session-token=seed-session-cookie-value";

async function insertUser(role: "MEMBER" | "MODERATOR"): Promise<string> {
  sequence += 1;
  githubUserId += 1;
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, role)
    values (${githubUserId}, ${`credential-ref-${sequence}`}, ${role}) returning id
  `;
  return user.id;
}

/** Mints a real bearer token for the account and returns the plaintext and its api_tokens id. */
async function mintTokenFor(userId: string): Promise<{ token: string; tokenId: string }> {
  const { token, tokenHash } = mintApiToken();
  await new PostgresApiTokenStore(sql).issueToken(userId, tokenHash);
  const [row] = await sql<{ id: string }[]>`select id from api_tokens where user_id = ${userId}`;
  return { token, tokenId: row.id };
}

function moderatorRouteHandler(options: { moderatorId: string | null }) {
  return createModeratorPostHandler({
    getSession: async () => (options.moderatorId === null ? null : { user: { id: options.moderatorId } }),
    findAccountByTokenHash: (hash) => new PostgresApiTokenStore(sql).findAccountByTokenHash(hash),
    getCurrentRole: getCurrentUserRole,
    createService: async () => new AccountModerationService(new PostgresModerationStore(sql)),
  });
}

function roleGrantRequest(targetAccountId: string, headers: Record<string, string>): Request {
  return new Request(new URL("/api/moderation/moderators", requestHost), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ targetAccountId, moderator: true }),
  });
}

async function roleChangeCredentialRow(actorId: string, targetAccountId: string) {
  const [row] = await sql<{ credential_kind: string | null; credential_token_id: string | null }[]>`
    select credential_kind, credential_token_id
    from moderator_role_changes
    where actor_id = ${actorId} and target_account_id = ${targetAccountId}
  `;
  expect(row).toBeDefined();
  return row;
}

function cohortFixture(targetAccountId: string): CalibrationCohortSnapshot {
  return {
    targetAccountId,
    repositoryId: null,
    sampleStartedAt: "2026-01-01T00:00:00.000Z",
    sampleEndedAt: "2026-02-01T00:00:00.000Z",
    selfWorkPairs: [],
    // The audit row's settled_sample_size check requires a positive sample, but
    // no pair content is validated — the snapshot is evidence this test never
    // evaluates, so one inert pair satisfies the check.
    outsiderSettlementPairs: [
      {
        githubRepositoryId: 1,
        githubIssueId: 1,
        githubPullRequestId: 1,
        mergedAt: "2026-01-15T00:00:00.000Z",
        proofSha256: "0".repeat(64),
        offeredDifficulty: 5,
        settledDifficulty: 5,
      },
    ],
    comparison: {
      selfWork: { count: 0, meanDelta: 0, medianDelta: 0 },
      outsider: { count: 0, meanDelta: 0, medianDelta: 0 },
      differenceBetweenMeans: null,
    },
  };
}

async function openAuditWithCredential(
  actorId: string,
  targetAccountId: string,
  credential?: { kind: "session" } | { kind: "token"; tokenId: string },
): Promise<void> {
  const opened = await new PostgresModerationStore(sql).openAccountAudit({
    actorId,
    targetAccountId,
    repositoryId: null,
    reason: "The credential behind this audit must be recorded.",
    cohort: cohortFixture(targetAccountId),
    credential,
  });
  expect(opened.kind).toBe("ok");
}

describe("the credential recorded on privileged-action rows", () => {
  it("records the bearer token's issuance id on a role granted through the moderator route", async () => {
    const moderatorId = await insertUser("MODERATOR");
    const targetId = await insertUser("MEMBER");
    const { token, tokenId } = await mintTokenFor(moderatorId);

    const response = await moderatorRouteHandler({ moderatorId: null })(
      roleGrantRequest(targetId, { authorization: `Bearer ${token}` }),
    );

    expect(response.status).toBe(200);
    expect(await roleChangeCredentialRow(moderatorId, targetId)).toEqual({
      credential_kind: "token",
      credential_token_id: tokenId,
    });

    // The row names the credential that authorized the action, and none of its
    // secret material: neither the plaintext bearer token nor its SHA-256 hex.
    const [stored] = await sql<{ row: Record<string, unknown> }[]>`
      select to_jsonb(t) as row
      from moderator_role_changes t
      where actor_id = ${moderatorId} and target_account_id = ${targetId}
    `;
    const serialized = JSON.stringify(stored.row);
    const digest = createHash("sha256").update(token, "utf8").digest("hex");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(digest);
    expect(serialized).not.toContain(cookieValue);
  });

  it("records the session credential on a role granted through a cookie session", async () => {
    const moderatorId = await insertUser("MODERATOR");
    const targetId = await insertUser("MEMBER");

    const response = await moderatorRouteHandler({ moderatorId })(
      roleGrantRequest(targetId, { origin: trustedOrigin, cookie: cookieValue }),
    );

    expect(response.status).toBe(200);
    expect(await roleChangeCredentialRow(moderatorId, targetId)).toEqual({
      credential_kind: "session",
      credential_token_id: null,
    });

    // The cookie the session request carried never reaches the row either.
    const [stored] = await sql<{ row: Record<string, unknown> }[]>`
      select to_jsonb(t) as row
      from moderator_role_changes t
      where actor_id = ${moderatorId} and target_account_id = ${targetId}
    `;
    const serialized = JSON.stringify(stored.row);
    expect(serialized).not.toContain(cookieValue);
    expect(serialized).not.toContain("authjs.session-token");
  });

  it("records a token credential on the moderation event an opened audit writes", async () => {
    const moderatorId = await insertUser("MODERATOR");
    const targetId = await insertUser("MEMBER");
    const { token, tokenId } = await mintTokenFor(moderatorId);

    await openAuditWithCredential(moderatorId, targetId, { kind: "token", tokenId });

    const [row] = await sql<{ credential_kind: string | null; credential_token_id: string | null }[]>`
      select credential_kind, credential_token_id
      from moderation_events
      where target_user_id = ${targetId}
    `;
    expect(row).toEqual({ credential_kind: "token", credential_token_id: tokenId });

    const [stored] = await sql<{ row: Record<string, unknown> }[]>`
      select to_jsonb(t) as row from moderation_events t where target_user_id = ${targetId}
    `;
    const serialized = JSON.stringify(stored.row);
    const digest = createHash("sha256").update(token, "utf8").digest("hex");
    expect(serialized).not.toContain(token);
    expect(serialized).not.toContain(digest);
    expect(serialized).not.toContain(cookieValue);
  });

  it("records a session credential on the moderation event an opened audit writes", async () => {
    const moderatorId = await insertUser("MODERATOR");
    const targetId = await insertUser("MEMBER");

    await openAuditWithCredential(moderatorId, targetId, { kind: "session" });

    const [row] = await sql<{ credential_kind: string | null; credential_token_id: string | null }[]>`
      select credential_kind, credential_token_id
      from moderation_events
      where target_user_id = ${targetId}
    `;
    expect(row).toEqual({ credential_kind: "session", credential_token_id: null });
  });

  it("writes a null credential for a writer with no HTTP request behind it", async () => {
    const moderatorId = await insertUser("MODERATOR");
    const targetId = await insertUser("MEMBER");

    await openAuditWithCredential(moderatorId, targetId);

    const [row] = await sql<{ credential_kind: string | null; credential_token_id: string | null }[]>`
      select credential_kind, credential_token_id
      from moderation_events
      where target_user_id = ${targetId}
    `;
    expect(row).toEqual({ credential_kind: null, credential_token_id: null });
  });
});
