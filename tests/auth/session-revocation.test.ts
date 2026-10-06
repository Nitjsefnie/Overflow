import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import postgres, { type Sql } from "postgres";
import type { StartedTestContainer } from "testcontainers";
import { randomUUID } from "node:crypto";
import { decode, encode } from "next-auth/jwt";
import { runMigrations } from "../../scripts/migrate";
import { startPostgresContainer } from "../support/postgres-container";
import { closeSql } from "@/lib/db/client";
import { revokeAccountSessions } from "@/lib/auth/session-guard";

/**
 * Session revocation and the absolute lifetime, end to end (issue 1043): the
 * real `GET`/`POST` handlers exported from `src/auth.ts` are driven with real
 * `Request` objects against a disposable database — nothing of Auth.js is
 * mocked, and GitHub's endpoints are stubbed only where a test signs in.
 *
 * The cookie is minted the way `scripts/seed-board-benchmark.ts` mints the
 * benchmark cookie (the issue's reproduction mints it the same way), encoded
 * with the app's own AUTH_SECRET, so each leg proves what a holder of a
 * copied cookie can actually get:
 *
 * - a stamped token whose account row is LIVE resolves, and the row's login
 *   names it — the pre-existing refresh behaviour, still intact;
 * - bumping the account's `session_epoch` (the operator one-liner, or the
 *   sign-out handler) kills every cookie the account holds, at its next
 *   refresh, without touching any other account;
 * - a cookie whose sign-in instant is at or past the 30-day absolute bound
 *   resolves to nothing, however often it was used in between;
 * - a pre-fix token carrying no epoch claim is dead at its first refresh;
 * - an account row that is gone entirely keeps today's MISSING pass-through
 *   (the epoch closes the revocation gap, not the stale-row gap).
 */

// Dynamic route imports retain this file's mocks until the graph is cleared.
afterAll(() => { vi.resetModules(); });

const requestContext = vi.hoisted(() => ({ headers: new Headers() }));

vi.mock("next/headers", () => ({
  headers: async () => requestContext.headers,
  cookies: async () => ({ get: () => undefined, set: () => undefined }),
}));

const appUrl = "http://overflow.test";
const sessionCookieName = "authjs.session-token";
const authSecret = "session-revocation-test-secret-not-for-production";
/** 43 base64url characters — the same 32-byte shape the deployment key has. */
const tokenEncryptionKey = "session-revocation-test-key-AAAAAAAAAAA";
const sessionCookieSalt = sessionCookieName;
const DAY_SECONDS = 24 * 60 * 60;

/** Every instant in this file is read from this pinned clock, never the wall clock. */
const now = new Date("2026-09-26T12:00:00.000Z");
const nowSeconds = now.getTime() / 1000;

const originalDatabaseUrl = process.env.DATABASE_URL;
const originalAuthUrl = process.env.AUTH_URL;
const originalNextAuthUrl = process.env.NEXTAUTH_URL;
let container: StartedTestContainer | undefined;
let sql: Sql | undefined;
let nextGithubUserId = 76_403_000;
let authRoute: typeof import("@/app/api/auth/[...nextauth]/route") | undefined;
let databaseClient: typeof import("@/lib/db/client") | undefined;

beforeAll(async () => {
  const started = await startPostgresContainer({
    database: "session_revocation",
    user: "session_revocation",
    password: "session_revocation",
  });
  container = started.container;
  process.env.DATABASE_URL = started.databaseUrl;
  await runMigrations();
  sql = postgres(started.databaseUrl, { max: 1 });

  vi.stubEnv("AUTH_SECRET", authSecret);
  vi.stubEnv("AUTH_GITHUB_ID", "session-revocation-client-id");
  vi.stubEnv("AUTH_GITHUB_SECRET", "session-revocation-client-secret");
  vi.stubEnv("AUTH_TRUST_HOST", "true");
  vi.stubEnv("APP_URL", appUrl);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", tokenEncryptionKey);
  // A non-matching moderator id keeps every seeded account's MEMBER role
  // deterministic.
  vi.stubEnv("MODERATOR_GITHUB_USER_IDS", "1");
  delete process.env.AUTH_URL;
  delete process.env.NEXTAUTH_URL;

  // A fresh graph, so @/auth reads this environment when the route first
  // loads it and the route's database client is the one closed below.
  vi.resetModules();
  authRoute = await import("@/app/api/auth/[...nextauth]/route");
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
  if (originalAuthUrl === undefined) {
    delete process.env.AUTH_URL;
  } else {
    process.env.AUTH_URL = originalAuthUrl;
  }
  if (originalNextAuthUrl === undefined) {
    delete process.env.NEXTAUTH_URL;
  } else {
    process.env.NEXTAUTH_URL = originalNextAuthUrl;
  }
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"], now });
});

// Workers are reused across files (isolate: false): the pinned clock and any global
// stub belong to this file alone — a stub left installed would leak into every later
// file this worker runs (issue 753).
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Seeds one live account and returns its row id and GitHub identity. */
async function seedUser(): Promise<{ id: string; githubUserId: number; login: string }> {
  const githubUserId = nextGithubUserId;
  nextGithubUserId += 1;
  const login = `revoke-user-${githubUserId}`;
  await sql!`
    insert into users (github_user_id, github_login)
    values (${githubUserId}, ${login})
  `;
  const [row] = await sql!<{ id: string }[]>`
    select id from users where github_user_id = ${githubUserId}
  `;
  return { id: row!.id, githubUserId, login };
}

async function rowSessionEpoch(userId: string): Promise<number> {
  const [row] = await sql!<{ session_epoch: number }[]>`
    select session_epoch from users where id = ${userId}
  `;
  return row!.session_epoch;
}

type MintOverrides = {
  authenticatedAt?: number;
  /** Omit for the row's current epoch; `undefined` mints a pre-fix token with no claim. */
  sessionEpoch?: number | undefined;
};

/**
 * Mints the cookie the way the benchmark seed does: the claims the sign-in
 * writes, encoded with the app's own AUTH_SECRET under the production cookie
 * name. Defaults to a freshly-signed-in MEMBER stamped with the account's
 * current epoch, 0.
 */
async function mintSessionCookie(user: { id: string; login: string }, overrides: MintOverrides = {}): Promise<string> {
  const epoch = "sessionEpoch" in overrides ? overrides.sessionEpoch : 0;
  const value = await encode({
    token: {
      sub: user.id,
      userId: user.id,
      name: user.login,
      role: "MEMBER",
      canAdministerWebhooks: false,
      authenticatedAt: overrides.authenticatedAt ?? nowSeconds,
      ...(epoch === undefined ? {} : { sessionEpoch: epoch }),
    },
    secret: authSecret,
    salt: sessionCookieSalt,
    maxAge: 30 * DAY_SECONDS,
  });
  return value;
}

/** Folds every Set-Cookie a response sent into the jar, newest value wins. */
function mergeSetCookies(jar: Map<string, string>, response: Response): void {
  for (const rawCookie of response.headers.getSetCookie()) {
    const pair = rawCookie.split(";")[0]!;
    const equals = pair.indexOf("=");
    jar.set(pair.slice(0, equals).trim(), pair.slice(equals + 1).trim());
  }
}

function cookieHeader(jar: Map<string, string>): string {
  return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
}

/** Drives the real handler with the jar's cookies, as the browser would send them. */
async function driveAuthHandler(
  method: "GET" | "POST",
  url: string,
  jar: Map<string, string>,
  body?: URLSearchParams,
): Promise<Response> {
  const headers: Record<string, string> = { cookie: cookieHeader(jar) };
  if (body !== undefined) {
    headers["content-type"] = "application/x-www-form-urlencoded";
  }
  const request = new Request(url, { method, headers, ...(body === undefined ? {} : { body }) });
  requestContext.headers = new Headers(request.headers);
  // next-auth's handler types name a NextRequest; @auth/core itself reads a
  // standard Request, and the runtime contract is the standard one.
  return method === "POST" ? authRoute!.POST(request as never) : authRoute!.GET(request as never);
}

interface SessionBody {
  user?: { id?: string; name?: string; role?: string };
}

/** Reads the session route with the jar's cookies and returns its JSON body. */
async function readSession(jar: Map<string, string>): Promise<SessionBody | null> {
  const response = await driveAuthHandler("GET", `${appUrl}/api/auth/session`, jar);
  expect(response.status).toBe(200);
  return (await response.json()) as SessionBody | null;
}

describe("session revocation and absolute lifetime", () => {
  it("resolves a stamped token against its live row, named by the row's login", async () => {
    const user = await seedUser();
    const jar = new Map<string, string>([[sessionCookieName, await mintSessionCookie(user)]]);

    const session = await readSession(jar);
    expect(session?.user?.id).toBe(user.id);
    expect(session?.user?.name).toBe(user.login);
    expect(session?.user?.role).toBe("MEMBER");
  });

  it("kills the account's cookies once the row's session epoch is bumped", async () => {
    const user = await seedUser();
    const jar = new Map<string, string>([[sessionCookieName, await mintSessionCookie(user)]]);

    expect((await readSession(jar))?.user?.id).toBe(user.id);

    await revokeAccountSessions(user.id);

    await expect(readSession(jar)).resolves.toBeNull();
    expect(await rowSessionEpoch(user.id)).toBe(1);
  });

  it("lets a still-matching cookie refresh: the epoch claim rides on the re-issued cookie", async () => {
    const user = await seedUser();
    const jar = new Map<string, string>([[sessionCookieName, await mintSessionCookie(user)]]);

    expect((await readSession(jar))?.user?.id).toBe(user.id);
    mergeSetCookies(jar, await driveAuthHandler("GET", `${appUrl}/api/auth/session`, jar));

    const refreshed = await decode({ token: jar.get(sessionCookieName)!, secret: authSecret, salt: sessionCookieSalt });
    expect(refreshed?.sessionEpoch).toBe(0);
    expect(refreshed?.authenticatedAt).toBe(nowSeconds);
  });

  it("signing out bumps the row's epoch and the replayed pre-sign-out cookie is dead", async () => {
    const user = await seedUser();
    const jar = new Map<string, string>([[sessionCookieName, await mintSessionCookie(user)]]);
    expect((await readSession(jar))?.user?.id).toBe(user.id);

    const csrfResponse = await driveAuthHandler("GET", `${appUrl}/api/auth/csrf`, jar);
    expect(csrfResponse.status).toBe(200);
    const { csrfToken } = (await csrfResponse.json()) as { csrfToken: string };
    mergeSetCookies(jar, csrfResponse);

    const signOutResponse = await driveAuthHandler(
      "POST",
      `${appUrl}/api/auth/signout`,
      jar,
      new URLSearchParams({ csrfToken }),
    );
    // The built-in sign-out page's plain form post answers 302 — the redirect
    // the page follows; the signout action fires the event inside either way.
    expect(signOutResponse.status).toBe(302);

    // The sign-out handler bumped the account's epoch server-side.
    expect(await rowSessionEpoch(user.id)).toBe(1);

    // The issue's reproduction: replaying the pre-sign-out cookie must end
    // with no session.
    await expect(readSession(jar)).resolves.toBeNull();
  });

  it("ends a cookie whose sign-in instant is exactly 30 days old", async () => {
    const user = await seedUser();
    const jar = new Map<string, string>([[
      sessionCookieName,
      await mintSessionCookie(user, { authenticatedAt: nowSeconds - 30 * DAY_SECONDS }),
    ]]);

    await expect(readSession(jar)).resolves.toBeNull();
  });

  it("keeps a cookie whose sign-in instant is one second inside the 30-day window", async () => {
    const user = await seedUser();
    const jar = new Map<string, string>([[
      sessionCookieName,
      await mintSessionCookie(user, { authenticatedAt: nowSeconds - (30 * DAY_SECONDS - 1) }),
    ]]);

    const session = await readSession(jar);
    expect(session?.user?.id).toBe(user.id);
  });

  it("is dead at its first refresh: a pre-fix cookie carrying no epoch claim", async () => {
    const user = await seedUser();
    const jar = new Map<string, string>([[
      sessionCookieName,
      await mintSessionCookie(user, { sessionEpoch: undefined }),
    ]]);

    await expect(readSession(jar)).resolves.toBeNull();
  });

  it("keeps today's MISSING pass-through: a cookie whose account row is gone resolves", async () => {
    // The epoch mechanism closes the revocation gap. A row that is missing
    // entirely has no epoch to compare against, and keeps the stale-session
    // route the deletion gate already documents — this pin is the boundary of
    // the fix, not an oversight.
    const ghost = { id: randomUUID(), login: "ghost-login" };
    const jar = new Map<string, string>([[sessionCookieName, await mintSessionCookie(ghost)]]);

    const session = await readSession(jar);
    expect(session?.user?.id).toBe(ghost.id);
  });
});
