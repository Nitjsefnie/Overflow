import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { closeSql } from "@/lib/db/client";
import { PostgresRepositoryStore } from "@/lib/repositories/postgres-store";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { guardedRequests, useTrustedOrigin } from "../support/trusted-origin";

vi.hoisted(() => { vi.resetModules(); });
const session = vi.hoisted(() => ({ userId: "" }));
vi.mock("@/auth", () => ({ auth: async () => ({ user: { id: session.userId, role: "MEMBER" } }) }));
useTrustedOrigin();
const { json } = guardedRequests("/api/repositories");
let container: StartedTestContainer | undefined;
let sql: Sql;
const originalDatabaseUrl = process.env.OVERFLOW_DATABASE_URL;

beforeAll(async () => {
  const started = await startPostgresContainer({ database: "registration_wiring", user: "registration_wiring" });
  container = started.container;
  process.env.OVERFLOW_DATABASE_URL = started.databaseUrl;
  await runMigrations();
  sql = postgres(started.databaseUrl);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
afterAll(async () => {
  await closeSql();
  await sql?.end();
  await container?.stop();
  if (originalDatabaseUrl === undefined) delete process.env.OVERFLOW_DATABASE_URL;
  else process.env.OVERFLOW_DATABASE_URL = originalDatabaseUrl;
  vi.doUnmock("@/auth");
  vi.resetModules();
});

it("the production POST records a scope refusal in PostgreSQL", async () => {
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (68170001, 'count-wiring') returning id
  `;
  session.userId = user!.id;
  vi.spyOn(PostgresRepositoryStore.prototype, "getGitHubAccessToken").mockResolvedValue("example");
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
  const { POST } = await import("@/app/api/repositories/route");
  const response = await POST(json({
    repositoryUrl: "https://github.com/octo/project", openingName: "Scope", actualName: "Delivered",
    openingLabels: [{ label: "size/S", comparisonPoints: 2, reservePoints: 2 }],
    actualLabels: Array.from({ length: 10 }, (_, i) => ({ label: `done/${i + 1}`, points: i + 1 })),
  }));

  expect(response.status).toBe(403);
  expect(fetch).toHaveBeenCalledOnce();
  expect(await sql`select kind, attempts from registration_attempt_counts`).toEqual([
    { kind: "WEBHOOK_SCOPE_MISSING", attempts: 1 },
  ]);
});

it.each([
  ["invalid repository URL", 68170002, { repositoryUrl: "not-a-repository" }],
  ["empty opening catalog", 68170003, { openingLabels: [] }],
])("does not count %s when the production scope probe refuses first", async (_name, githubId, override) => {
  await sql`truncate registration_attempt_counts`;
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login) values (${githubId}, ${`wiring-${githubId}`}) returning id
  `;
  session.userId = user!.id;
  vi.spyOn(PostgresRepositoryStore.prototype, "getGitHubAccessToken").mockResolvedValue("example");
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
  const { POST } = await import("@/app/api/repositories/route");
  const valid = {
    repositoryUrl: "https://github.com/octo/project", openingName: "Scope", actualName: "Delivered",
    openingLabels: [{ label: "size/S", comparisonPoints: 2, reservePoints: 2 }],
    actualLabels: Array.from({ length: 10 }, (_, i) => ({ label: `done/${i + 1}`, points: i + 1 })),
  };
  const baseline = await POST(json(valid));
  expect(baseline.status).toBe(403);
  expect(await sql`select kind, attempts from registration_attempt_counts`).toEqual([
    { kind: "WEBHOOK_SCOPE_MISSING", attempts: 1 },
  ]);
  await sql`truncate registration_attempt_counts`;

  const response = await POST(json({ ...valid, ...override }));
  expect(response.status).toBe(baseline.status);
  expect(await response.json()).toEqual(await baseline.json());
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(await sql`select kind, attempts from registration_attempt_counts`).toEqual([]);
});
