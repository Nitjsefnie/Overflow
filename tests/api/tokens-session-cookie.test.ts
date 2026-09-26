import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { encode } from "next-auth/jwt";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql } from "@/lib/db/client";

/**
 * `POST /api/tokens` as a scripted HTTP client sends it: a real Auth.js
 * session cookie, an `Origin` equal to `APP_URL`'s origin and a JSON content
 * type. Those three headers are everything a client holding only the cookie
 * can produce, so they must not be enough to mint — minting also needs a
 * GitHub sign-in within the last ten minutes, recorded in the JWT by the OAuth
 * callback.
 *
 * Nothing of Auth.js is mocked: the cookie is encrypted with `encode` from
 * `next-auth/jwt` (a verbatim re-export of the installed @auth/core) and the
 * production route decodes it through the app's real `auth()`. Only Next's
 * request context (`next/headers`) is stubbed, because there is no request
 * outside a Next server; it hands `auth()` the headers of the request under
 * test. The token store is the real one, against a disposable database.
 */

// Dynamic route imports retain this file's graph until it is cleared.
afterAll(() => { vi.resetModules(); });

const requestContext = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("next/headers", () => ({
  headers: async () => requestContext.headers,
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));

const appUrl = "http://overflow.test";
const sessionCookieName = "authjs.session-token";
const authSecret = "tokens-session-cookie-test-secret-not-for-production";
/** Every instant in this file is read from this pinned clock, never the wall clock. */
const now = new Date("2026-09-26T12:00:00.000Z");
const nowSeconds = now.getTime() / 1000;

const originalDatabaseUrl = process.env.DATABASE_URL;
let container: StartedTestContainer | undefined;
let sql: Sql | undefined;
let userId = "";
let route: typeof import("@/app/api/tokens/route") | undefined;
let databaseClient: typeof import("@/lib/db/client") | undefined;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "overflow_token_session",
    user: "overflow_token_session",
    password: "overflow_token_session",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  await runMigrations();
  sql = postgres(started.databaseUrl, { max: 1 });
  const [user] = await sql<{ id: string }[]>`
    insert into users (github_user_id, github_login)
    values (7640200, 'token-session-cookie')
    returning id
  `;
  userId = user.id;

  vi.stubEnv("AUTH_SECRET", authSecret);
  vi.stubEnv("AUTH_URL", appUrl);
  vi.stubEnv("AUTH_TRUST_HOST", "true");
  vi.stubEnv("APP_URL", appUrl);
  // A fresh graph, so @/auth reads this environment when the route first loads
  // it and the route's database client is the one closed below.
  vi.resetModules();
  route = await import("@/app/api/tokens/route");
  databaseClient = await import("@/lib/db/client");
});

afterAll(async () => {
  vi.unstubAllEnvs();
  // Two module graphs, two pools: the migration ran on this file's static
  // client, the route on the one loaded after the reset.
  await databaseClient?.closeSql();
  await closeSql();
  await sql?.end();
  await container?.stop();
  if (originalDatabaseUrl === undefined) {
    delete process.env.DATABASE_URL;
  } else {
    process.env.DATABASE_URL = originalDatabaseUrl;
  }
});

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"], now });
  await sql!`delete from api_tokens where user_id = ${userId}`;
});

afterEach(() => {
  vi.useRealTimers();
});

async function sessionCookie(claims: Record<string, unknown>): Promise<string> {
  const value = await encode({
    token: { sub: userId, userId, role: "MEMBER", ...claims },
    secret: authSecret,
    salt: sessionCookieName,
  });
  return `${sessionCookieName}=${value}`;
}

/** Exactly what a command-line client holding the cookie sends. */
async function scriptedMint(cookie: string): Promise<Response> {
  const request = new Request(`${appUrl}/api/tokens`, {
    method: "POST",
    headers: { cookie, origin: appUrl, "content-type": "application/json" },
  });
  requestContext.headers = new Headers(request.headers);
  return route!.POST(request);
}

async function storedTokenCount(): Promise<number> {
  const [row] = await sql!<{ count: number }[]>`
    select count(*)::int as count from api_tokens where user_id = ${userId}
  `;
  return row.count;
}

describe("POST /api/tokens with only a session cookie", () => {
  it.each([
    { label: "a GitHub sign-in older than ten minutes", claims: { authenticatedAt: nowSeconds - 10 * 60 - 1 } },
    { label: "no recorded GitHub sign-in", claims: {} },
  ])("refuses a cookie carrying $label and stores no token", async ({ claims }) => {
    const response = await scriptedMint(await sessionCookie(claims));

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({
      error: {
        code: "REAUTHENTICATION_REQUIRED",
        message: "Confirm your GitHub sign-in to issue an API token.",
      },
    });
    await expect(storedTokenCount()).resolves.toBe(0);
  });

  it("mints for the same request when the cookie carries a sign-in from a minute ago", async () => {
    const response = await scriptedMint(await sessionCookie({ authenticatedAt: nowSeconds - 60 }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ token: expect.stringMatching(/^ovf_/) });
    await expect(storedTokenCount()).resolves.toBe(1);
  });
});
