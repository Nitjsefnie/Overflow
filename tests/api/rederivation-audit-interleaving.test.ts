import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { runMigrations } from "../../scripts/migrate";
import { createRederivationPostHandler } from "@/app/api/moderation/rederivation/route";
import { closeSql, getSql } from "@/lib/db/client";
import { PostgresFoldStore } from "@/lib/fold/postgres-store";
import { RepositoryRederivationService } from "@/lib/moderation/rederivation-service";
import { mintApiToken } from "@/lib/security/api-token";
import { PostgresApiTokenStore } from "@/lib/tokens/postgres-store";
import { startPostgresContainer } from "../support/postgres-container";

// The queue write, the route and the gate all run for real here; only the
// interleaving itself is injected — a deactivation, or a read failure, landing
// after the queue write has committed and before the service's read-back.

vi.mock("@/auth", () => ({ auth: vi.fn().mockResolvedValue(null) }));
vi.hoisted(() => { vi.resetModules(); });

const clientAddress = "203.0.113.7";
let sql: Sql;
let container: StartedTestContainer | undefined;
let sequence = 999_682_000;
const originalDatabaseUrl = process.env.DATABASE_URL;

describe("the rederivation journal line survives a post-commit failure", () => {
  beforeAll(async () => {
    const started = await startPostgresContainer({
      database: "rederivation_audit_interleaving_test",
      user: "rederivation_audit_interleaving_test",
      password: "rederivation_audit_interleaving_test",
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
    vi.restoreAllMocks();
  });

  it.each(["deactivation", "read failure"] as const)(
    "keeps exactly one journal line when %s lands between the queue commit and the read-back",
    async (interleaving) => {
      const moderator = await moderatorWithToken();
      const repositoryId = await registeredRepository(moderator.userId);
      const store = new PostgresFoldStore(sql);
      let failReadAfterCommit: Error | null = null;
      const service = new RepositoryRederivationService({
        listRepositoryFoldRevisionCounts: (revision) => store.listRepositoryFoldRevisionCounts(revision),
        findRepositoryRederivationRequest: (id) =>
          failReadAfterCommit === null
            ? store.findRepositoryRederivationRequest(id)
            : Promise.reject(failReadAfterCommit),
        async requestRepositoryRederivation(id, at) {
          await store.requestRepositoryRederivation(id, at);
          if (interleaving === "deactivation") {
            await sql`update registered_repositories set active = false where id = ${id}`;
          } else {
            failReadAfterCommit = new Error("post-commit connection failure");
          }
        },
      });
      const info = vi.spyOn(console, "info").mockImplementation(() => {});
      try {
        const response = await createRederivationPostHandler({
          getSession: async () => null,
          findAccountByTokenHash: (hash) => moderator.tokens.findAccountByTokenHash(hash),
          getCurrentRole: async () => "MODERATOR",
          createService: async () => service,
        })(postRederivation(moderator.token, repositoryId));

        // The route's answers are unchanged: the interleaved failure still maps
        // onto the status it produced before the journal line moved.
        expect(response.status).toBe(interleaving === "deactivation" ? 404 : 500);

        // The queue write stayed committed...
        const [job] = await sql<{ rederivation_requested_at: Date | null; rederivation_generation: number }[]>`
          select rederivation_requested_at, rederivation_generation
          from repository_reconciliation_jobs where repository_id = ${repositoryId}
        `;
        expect(job.rederivation_requested_at).not.toBeNull();
        expect(Number(job.rederivation_generation)).toBe(1);

        // ...and the committed action still wrote its exactly-one journal line.
        expect(privilegedLines(info)).toEqual([
          [
            "Privileged action",
            {
              action: "repository.rederivation-request",
              actorId: moderator.userId,
              credential: { kind: "token", tokenId: moderator.tokenId },
              clientAddress,
              clientAddressVerified: false,
              subject: { repositoryId },
            },
          ],
        ]);
      } finally {
        info.mockRestore();
      }
    },
  );

  it("writes no journal line when the repository is not found before the commit", async () => {
    const moderator = await moderatorWithToken();
    const absentRepositoryId = "00000000-0000-4000-8000-0000000000fe";
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const response = await createRederivationPostHandler({
        getSession: async () => null,
        findAccountByTokenHash: (hash) => moderator.tokens.findAccountByTokenHash(hash),
        getCurrentRole: async () => "MODERATOR",
        createService: async () => new RepositoryRederivationService(new PostgresFoldStore(sql)),
      })(postRederivation(moderator.token, absentRepositoryId));

      expect(response.status).toBe(404);
      expect(await jobRows(absentRepositoryId)).toEqual([]);
      expect(privilegedLines(info)).toEqual([]);
    } finally {
      info.mockRestore();
    }
  });

  it("writes no journal line when the gate refuses a demoted moderator", async () => {
    const moderator = await moderatorWithToken();
    const repositoryId = await registeredRepository(moderator.userId);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const response = await createRederivationPostHandler({
        getSession: async () => null,
        findAccountByTokenHash: (hash) => moderator.tokens.findAccountByTokenHash(hash),
        getCurrentRole: async () => "MEMBER",
        createService: async () => new RepositoryRederivationService(new PostgresFoldStore(sql)),
      })(postRederivation(moderator.token, repositoryId));

      expect(response.status).toBe(403);
      expect(await jobRows(repositoryId)).toEqual([]);
      expect(privilegedLines(info)).toEqual([]);
    } finally {
      info.mockRestore();
    }
  });
});

function postRederivation(bearer: string, repositoryId: string): Request {
  return new Request("https://overflow.internal/api/moderation/rederivation", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${bearer}`,
      "x-real-ip": clientAddress,
    },
    body: JSON.stringify({ repositoryId }),
  });
}

function privilegedLines(info: { mock: { calls: unknown[][] } }): unknown[][] {
  return info.mock.calls.filter(([message]) => message === "Privileged action");
}

async function jobRows(repositoryId: string) {
  return sql`
    select rederivation_requested_at from repository_reconciliation_jobs
    where repository_id = ${repositoryId}
  `;
}

async function moderatorWithToken() {
  const githubUserId = ++sequence;
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login, role)
    values (${githubUserId}, ${`interleaving-${githubUserId}`}, 'MODERATOR') returning id
  `;
  const minted = mintApiToken();
  const tokens = new PostgresApiTokenStore(sql);
  await tokens.issueToken(user.id, minted.tokenHash);
  const [row] = await sql<{ id: string }[]>`
    select id from api_tokens where user_id = ${user.id}
  `;
  return { userId: user.id, tokenId: row.id, token: minted.token, tokens };
}

async function registeredRepository(sponsorId: string): Promise<string> {
  const githubRepositoryId = ++sequence;
  const [repository] = await sql<{ id: string }[]>`
    insert into registered_repositories
      (github_repository_id, owner_name, sponsor_id, visibility, difficulty_scheme)
    values (${githubRepositoryId}, ${`owner/repo-${githubRepositoryId}`}, ${sponsorId}, 'PUBLIC',
      ${sql.json({
        openingName: "Scope",
        actualName: "Delivered difficulty",
        openingLabels: [{ label: "size/M", comparisonPoints: 4, reservePoints: 4 }],
        actualLabels: Array.from({ length: 10 }, (_, index) => ({ label: `delivered/${index + 1}`, points: index + 1 })),
      })})
    returning id
  `;
  return repository.id;
}
